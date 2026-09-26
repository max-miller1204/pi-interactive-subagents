import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import {
	canonicalLaunch,
	type LaunchContext,
	type LaunchPlan,
	piArgs,
	piInvocation,
	renderLaunchScript,
	systemPrompt,
} from "./launch.ts";
import { processAlive } from "./process.ts";
import { writeRunBackend } from "./run-backend.ts";
import {
	Launch,
	LaunchState,
	parseStrict,
	RegistryRecord,
	RunSpec,
	writeJsonAtomic,
} from "./schema.ts";
import { parentSessionPath, writeChildSession } from "./session-file.ts";
import type { WidgetBackend } from "./widget-client.ts";
import type { startSupervisor } from "./widget-supervisor.ts";

export interface WidgetStartedRun {
	runDir: string;
	spec: RunSpec;
	backend: WidgetBackend;
}

export type WidgetLaunchContext = Omit<
	LaunchContext,
	"tmux" | "liveColumnPanes" | "commit"
> & {
	rpcChild: boolean;
	startSupervisor: typeof startSupervisor;
	commit(run: WidgetStartedRun): void;
};

export async function launchWidgetRun(
	plan: LaunchPlan,
	context: WidgetLaunchContext,
): Promise<WidgetStartedRun> {
	if (context.mode !== "tui" && !(context.mode === "rpc" && context.rpcChild))
		throw new Error("Subagents need the interactive Pi TUI.");
	if (context.spawnerSessionFile === undefined)
		throw new Error(
			"Subagents need a saved Pi session. Do not use --no-session.",
		);
	const name = plan.launch.name;
	context.reserve(name);
	let runDir: string | undefined;
	let newSession: string | undefined;
	let backend: WidgetBackend | undefined;
	let supervisorAttempted = false;
	try {
		if (context.isDisposed())
			throw new Error("Pi replaced the session during widget launch.");
		const runId = parseStrict(
			RunSpec.properties.runId,
			context.runId,
			"launch run id",
		);
		const ownExtensionPath = realpathSync(context.ownExtensionPath);
		const draft = canonicalLaunch(plan, ownExtensionPath);
		const directory = join(realpathSync(context.ownerDir), runId);
		const sessionDir = realpathSync(context.sessionDir);
		const parentSession = parentSessionPath(context.spawnerSessionFile);
		if (
			plan.kind === "spawn" &&
			draft.session === "fork" &&
			plan.entries === undefined
		)
			throw new Error("A fork launch requires session entries.");
		if (
			draft.session === "standalone" &&
			plan.entries !== undefined &&
			plan.entries.length > 0
		)
			throw new Error("A standalone launch cannot copy session entries.");
		const metadata = parseStrict(
			Type.Omit(RunSpec, ["launch"]),
			{
				v: 1,
				runId,
				ownerKey: context.ownerKey,
				owner: context.owner,
				startedAt: Date.now(),
				kind: plan.kind,
				spawnerSessionId: context.spawnerSessionId,
				spawnerSessionFile: parentSession,
				initialPrompt: plan.initialPrompt,
			},
			"run spec",
		);
		const candidateSessionFile =
			plan.kind === "spawn"
				? join(
						sessionDir,
						`${new Date().toISOString().replace(/[:.]/g, "-")}_00000000-0000-0000-0000-000000000000.jsonl`,
					)
				: realpathSync(plan.launch.childSessionFile);
		const argsOptions = {
			runDir: directory,
			ownExtensionPath,
			trusted: context.trusted(draft.cwd),
			initialPrompt: metadata.initialPrompt,
		};
		const invocation = (context.invocation ?? piInvocation)();
		const rpcArgs = (childSessionFile: string) => [
			...piArgs({ ...draft, childSessionFile }, argsOptions).slice(0, -1),
			"--mode",
			"rpc",
		];
		renderLaunchScript({
			runId,
			name,
			cwd: draft.cwd,
			env: context.env,
			invocation,
			args: rpcArgs(candidateSessionFile),
		});
		if (context.isDisposed())
			throw new Error("Pi replaced the session during widget launch.");
		mkdirSync(directory, { mode: 0o700 });
		runDir = realpathSync(directory);
		writeJsonAtomic(
			join(runDir, "launch-state.json"),
			parseStrict(
				LaunchState,
				{
					v: 1,
					runId,
					ownerKey: context.ownerKey,
					name,
					phase: "preparing",
				},
				"launch state",
			),
		);
		for (const box of ["inbox", "outbox", "questions"])
			mkdirSync(join(runDir, box), { mode: 0o700 });
		if (plan.kind === "spawn")
			newSession = writeChildSession(
				sessionDir,
				draft.cwd,
				parentSession,
				plan.entries ?? [],
			);
		const childSessionFile =
			plan.kind === "spawn" ? newSession : candidateSessionFile;
		const launch = parseStrict(
			Launch,
			{ ...draft, childSessionFile },
			"launch",
		);
		const spec = parseStrict(RunSpec, { ...metadata, launch }, "run spec");
		writeFileSync(
			join(runDir, "system-prompt.md"),
			systemPrompt(spec, "widget"),
			{ flag: "wx", mode: 0o600 },
		);
		writeJsonAtomic(join(runDir, "spec.json"), spec);
		writeJsonAtomic(join(runDir, "launch-state.json"), {
			v: 1,
			runId,
			ownerKey: context.ownerKey,
			name,
			phase: "widget-attempted",
		});
		supervisorAttempted = true;
		backend = await context.startSupervisor(
			spec,
			runDir,
			[...invocation, ...rpcArgs(launch.childSessionFile)],
			Object.fromEntries(
				Object.entries(context.env).filter(
					([key]) => key !== "TMUX" && key !== "TMUX_PANE",
				),
			),
		);
		if (context.isDisposed())
			throw new Error("Pi replaced the session during widget launch.");
		writeRunBackend(runDir, backend);
		const result = { runDir, spec, backend };
		context.commit(result);
		context.appendRegistry(
			parseStrict(
				RegistryRecord,
				plan.kind === "spawn"
					? { v: 1, kind: "spawn", runId, launch }
					: { v: 1, kind: "resume", runId, name },
				"registry record",
			),
		);
		context.startTick();
		return result;
	} catch (error) {
		const errors: unknown[] = [error];
		if (backend !== undefined) {
			try {
				const { connectSupervisor } = await import("./widget-client.ts");
				if (processAlive(backend.child))
					await (
						await connectSupervisor(backend, context.runId, context.ownerKey)
					).stop();
				const deadline = Date.now() + 5000;
				while (processAlive(backend.child) && Date.now() < deadline)
					await new Promise((done) => setTimeout(done, 20));
				if (processAlive(backend.child))
					throw new Error("Widget child did not stop during launch rollback.");
			} catch (stopError) {
				errors.push(stopError);
			}
		}
		if (
			errors.length === 1 &&
			(!supervisorAttempted || backend !== undefined)
		) {
			if (newSession !== undefined) rmSync(newSession, { force: true });
			if (runDir !== undefined)
				rmSync(runDir, { recursive: true, force: true });
			context.release(name);
			throw error;
		}
		throw new AggregateError(
			errors,
			`Widget launch failed and cleanup was not confirmed. Kept recovery files in ${runDir}.`,
		);
	}
}
