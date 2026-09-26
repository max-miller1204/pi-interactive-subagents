import {
	existsSync,
	mkdirSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { processIdentity } from "./process.ts";
import { type RunBackend, writeRunBackend } from "./run-backend.ts";
import {
	Launch,
	LaunchDraft,
	LaunchState,
	Name,
	PaneFile,
	type ProcessIdentity,
	parseStrict,
	RegistryRecord,
	RunSpec,
	readJsonStrict,
	writeJsonAtomic,
} from "./schema.ts";
import { parentSessionPath, writeChildSession } from "./session-file.ts";
import {
	balancePaneColumn,
	type ColumnPane,
	childSplitTarget,
	type Tmux,
	verifiedPane,
} from "./tmux.ts";

export function piInvocation(
	parent: Pick<NodeJS.Process, "argv" | "execPath" | "execArgv"> = process,
): string[] {
	const script = parent.argv[1];
	if (
		!script ||
		!isAbsolute(script) ||
		!existsSync(script) ||
		!/\.(c|m)?js$/.test(script)
	) {
		throw new Error(
			"Cannot start a subagent: this Pi build has no CLI script in process.argv[1].",
		);
	}
	return [parent.execPath, ...parent.execArgv, realpathSync(script)];
}

export interface PiArgsOptions {
	runDir: string;
	ownExtensionPath: string;
	trusted: boolean;
	initialPrompt: string;
}

export function piArgs(launch: Launch, options: PiArgsOptions): string[] {
	return [
		"--session",
		launch.childSessionFile,
		"--model",
		`${launch.model.provider}/${launch.model.id}`,
		"--thinking",
		launch.thinking,
		"--no-extensions",
		"-e",
		options.ownExtensionPath,
		...launch.extensions.flatMap((path) => ["-e", path]),
		"--tools",
		launch.tools.join(","),
		"--no-skills",
		...launch.skills.flatMap((path) => ["--skill", path]),
		launch.systemPrompt.mode === "append"
			? "--append-system-prompt"
			: "--system-prompt",
		join(options.runDir, "system-prompt.md"),
		options.trusted ? "--approve" : "--no-approve",
		`--subagent-run=${options.runDir}`,
		options.initialPrompt,
	];
}

export interface LaunchScriptOptions {
	runId: string;
	name: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	invocation: string[];
	args: string[];
}

function wordBytes(word: string): number {
	if (word.includes("\0"))
		throw new Error("A launch word contains a NUL byte.");
	const bytes = Buffer.byteLength(word);
	if (bytes > 131071) tooLong();
	return bytes;
}

function tooLong(): never {
	throw new Error(
		"The task is too long for a command line. Put the details in a file and name the file in the task.",
	);
}

function quote(word: string): string {
	return `'${word.replaceAll("'", "'\\''")}'`;
}

export function renderLaunchScript(options: LaunchScriptOptions): string {
	parseStrict(Name, options.name, "launch name");
	parseStrict(RunSpec.properties.runId, options.runId, "launch run id");
	wordBytes(options.cwd);
	if (options.invocation.length === 0)
		throw new Error("A Pi invocation is required.");
	const environment: string[] = [];
	let environmentBytes = 0;
	for (const name of Object.keys(options.env)) {
		if (name === "" || name.includes("="))
			throw new Error(`Invalid environment name: ${JSON.stringify(name)}.`);
		const value = options.env[name];
		if (value === undefined)
			throw new Error(`Environment variable ${name} has no value.`);
		const word = `${name}=${value}`;
		environmentBytes += wordBytes(word);
		if (name !== "TMUX" && name !== "TMUX_PANE") environment.push(word);
	}
	const argv = [...options.invocation, ...options.args];
	if (
		argv.reduce((total, word) => total + wordBytes(word), environmentBytes) >
		786432
	)
		tooLong();
	const words = [...environment, ...argv];
	return [
		"#!/bin/sh",
		`# pi-interactive-subagents: run ${options.runId}, subagent ${options.name}. This file deletes itself.`,
		'/bin/rm -f -- "$0"',
		`cd -- ${quote(options.cwd)} || exit 97`,
		`exec /usr/bin/env -i "TMUX=$TMUX" "TMUX_PANE=$TMUX_PANE" ${words.map(quote).join(" ")}`,
		"",
	].join("\n");
}

export type LaunchPlan =
	| {
			kind: "spawn";
			launch: LaunchDraft;
			initialPrompt: string;
			entries?: SessionEntry[];
	  }
	| { kind: "resume"; launch: Launch; initialPrompt: string; entries?: never };

export interface StartedRun {
	runDir: string;
	spec: RunSpec;
	pane: PaneFile;
	backend: RunBackend;
}

// The runtime checks the tmux version once before it supplies this context.
// Callbacks are synchronous. reserve must reject a name that is already in use.
export interface LaunchContext {
	runId: string;
	ownerDir: string;
	ownerKey: string;
	owner: ProcessIdentity;
	spawnerSessionId: string;
	spawnerSessionFile: string | undefined;
	sessionDir: string;
	mode: string;
	ownExtensionPath: string;
	env: NodeJS.ProcessEnv;
	tmux: Tmux;
	invocation?: () => string[];
	identity?: (pid: number) => ProcessIdentity | null;
	trusted(cwd: string): boolean;
	isDisposed(): boolean;
	reserve(name: string): void;
	// Remove the reserved run, including a run whose commit callback succeeded.
	release(name: string): void;
	liveColumnPanes(excludePaneId?: string): ColumnPane[];
	// Store the run with phase live. Commit must be synchronous.
	commit(run: StartedRun): void;
	appendRegistry(record: RegistryRecord): void;
	startTick(): void;
}

function checkDisposed(context: LaunchContext, name: string): void {
	if (context.isDisposed()) {
		throw new Error(
			`Pi replaced the session while subagent "${name}" was starting. It was not started.`,
		);
	}
}

function canonicalLaunch(
	plan: LaunchPlan,
	ownExtensionPath: string,
): LaunchDraft {
	const value = structuredClone(
		parseStrict(
			plan.kind === "spawn" ? LaunchDraft : Launch,
			plan.launch,
			"launch",
		),
	);
	value.cwd = realpathSync(value.cwd);
	if (!statSync(value.cwd).isDirectory())
		throw new Error(`Launch cwd is not a directory: ${value.cwd}.`);
	const extensions = new Map<string, string>([
		[ownExtensionPath, ownExtensionPath],
	]);
	value.extensions = value.extensions.map((path) => {
		const real = realpathSync(path);
		const prior = extensions.get(real);
		if (prior !== undefined)
			throw new Error(
				`Two extension paths point to one file: ${prior} and ${path}.`,
			);
		extensions.set(real, path);
		return real;
	});
	value.skills = value.skills.map((path) => realpathSync(path));
	return value;
}

function systemPrompt(spec: RunSpec): string {
	const launch = spec.launch;
	return [
		launch.systemPrompt.text,
		"",
		`Subagent run ${spec.runId}.`,
		`You are the subagent "${launch.name}" (agent ${launch.agent}). A parent Pi agent started you.`,
		"Your last reply is your result. The parent receives it when you finish.",
		'Messages from the parent start with "Message from the parent agent".',
		"Use ask_question only when you cannot continue without a decision from the parent.",
		...(launch.autoExit
			? []
			: [
					"A human works with you in this pane. The parent receives your result when the human closes the pane.",
				]),
		"",
	].join("\n");
}

export async function launchRun(
	plan: LaunchPlan,
	context: LaunchContext,
): Promise<StartedRun> {
	if (context.mode !== "tui")
		throw new Error("Subagents need the interactive Pi TUI.");
	if (!context.env.TMUX || !context.env.TMUX_PANE)
		throw new Error("Subagents need Pi to run inside tmux.");
	if (context.spawnerSessionFile === undefined)
		throw new Error(
			"Subagents need a saved Pi session. Do not use --no-session.",
		);
	const name = plan.launch.name;
	context.reserve(name);
	let runDir: string | undefined;
	let newSession: string | undefined;
	let paneId: string | undefined;
	let paneCreated = false;
	let savedPane: PaneFile | undefined;
	let launchState: LaunchState | undefined;
	const identify = context.identity ?? processIdentity;
	try {
		checkDisposed(context, name);
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
		// The writer uses an ISO timestamp and a UUID. This path has the same byte size.
		const candidateSessionFile =
			plan.kind === "spawn"
				? join(
						sessionDir,
						`${new Date().toISOString().replace(/[:.]/g, "-")}_00000000-0000-0000-0000-000000000000.jsonl`,
					)
				: realpathSync(plan.launch.childSessionFile);
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
		const argsOptions = {
			runDir: directory,
			ownExtensionPath,
			trusted: context.trusted(draft.cwd),
			initialPrompt: metadata.initialPrompt,
		};
		const scriptOptions = {
			runId,
			name,
			cwd: draft.cwd,
			env: { ...context.env },
			invocation: (context.invocation ?? piInvocation)(),
			args: piArgs(
				{ ...draft, childSessionFile: candidateSessionFile },
				argsOptions,
			),
		};
		// Validate the full command before mkdir or the session writer can write a file.
		renderLaunchScript(scriptOptions);
		const target = await childSplitTarget(
			context.tmux,
			context.liveColumnPanes(),
		);
		checkDisposed(context, name);
		if (target !== undefined && !/^%[0-9]+$/.test(target))
			throw new Error(`Invalid live pane id: ${target}.`);
		const parentPane = context.env.TMUX_PANE;
		if (!/^%[0-9]+$/.test(parentPane))
			throw new Error(`Invalid parent pane id: ${parentPane}.`);
		mkdirSync(directory, { mode: 0o700 });
		runDir = directory;
		runDir = realpathSync(runDir);
		launchState = parseStrict(
			LaunchState,
			{ v: 1, runId, ownerKey: context.ownerKey, name, phase: "preparing" },
			"launch state",
		);
		writeJsonAtomic(join(runDir, "launch-state.json"), launchState);
		for (const box of ["inbox", "outbox", "questions"])
			mkdirSync(join(runDir, box), { mode: 0o700 });
		if (plan.kind === "spawn") {
			newSession = writeChildSession(
				sessionDir,
				draft.cwd,
				parentSession,
				plan.entries ?? [],
			);
		}
		// Only an existing session path can complete the stored launch.
		const childSessionFile =
			plan.kind === "spawn" ? newSession : candidateSessionFile;
		const launch = parseStrict(
			Launch,
			{ ...draft, childSessionFile },
			"launch",
		);
		const spec = parseStrict(RunSpec, { ...metadata, launch }, "run spec");
		writeFileSync(join(runDir, "system-prompt.md"), systemPrompt(spec), {
			flag: "wx",
			mode: 0o600,
		});
		writeJsonAtomic(join(runDir, "spec.json"), spec);
		const launchScript = join(runDir, "launch.sh");
		writeFileSync(
			launchScript,
			renderLaunchScript({
				...scriptOptions,
				args: piArgs(launch, argsOptions),
			}),
			{ flag: "wx", mode: 0o700 },
		);
		const server = await context.tmux.serverIdentity();
		checkDisposed(context, name);
		const attemptedState: LaunchState = {
			...launchState,
			phase: "pane-attempted",
		};
		writeJsonAtomic(join(runDir, "launch-state.json"), attemptedState);
		launchState = attemptedState;
		// Start a real process so every server client can read strict snapshots.
		// An empty command leaves pane_pid at zero until respawn, even on failure.
		const paneOutput = (
			await context.tmux.run([
				"split-window",
				"-d",
				...(target === undefined
					? ["-h", "-l", "50%", "-t", parentPane]
					: ["-v", "-t", target]),
				"-P",
				"-F",
				"#{pane_id}",
				"--",
				"/bin/cat",
				"-",
			])
		).trim();
		paneCreated = true;
		if (/^%[0-9]+$/.test(paneOutput)) paneId = paneOutput;
		checkDisposed(context, name);
		if (paneId === undefined)
			throw new Error(`Invalid tmux pane id: ${JSON.stringify(paneOutput)}.`);
		await context.tmux.run([
			"set-option",
			"-p",
			"-t",
			paneId,
			"remain-on-exit",
			"on",
			";",
			"set-option",
			"-p",
			"-t",
			paneId,
			"@pi_subagent_run",
			runId,
			";",
			"set-option",
			"-p",
			"-t",
			paneId,
			"@pi_subagent_name",
			name,
			";",
			"set-option",
			"-p",
			"-t",
			paneId,
			"@pi_subagent_session",
			launch.childSessionFile,
			";",
			"respawn-pane",
			"-k",
			"-t",
			paneId,
			"--",
			"/bin/sh",
			launchScript,
		]);
		checkDisposed(context, name);
		const pidText = (
			await context.tmux.run([
				"display-message",
				"-p",
				"-t",
				paneId,
				"#{pane_pid}",
			])
		).trim();
		const pid = Number(pidText);
		if (!/^[1-9][0-9]*$/.test(pidText) || !Number.isSafeInteger(pid))
			throw new Error(`Invalid tmux pane pid: ${JSON.stringify(pidText)}.`);
		const identity = identify(pid);
		if (identity === null)
			throw new Error(`Subagent "${name}" exited before it could start.`);
		const pane = parseStrict(
			PaneFile,
			{ v: 1, paneId, process: identity, server },
			"pane file",
		);
		if (identity.pid !== pid)
			throw new Error(`Process identity does not match pane pid ${pid}.`);
		savedPane = pane;
		checkDisposed(context, name);
		if (
			(await verifiedPane(context.tmux, pane, launch.childSessionFile)) ===
			undefined
		)
			throw new Error(
				`Subagent pane ${paneId} disappeared before launch completed.`,
			);
		checkDisposed(context, name);
		if (target !== undefined) {
			await balancePaneColumn(context.tmux, [
				...context.liveColumnPanes(),
				{ pane, session: launch.childSessionFile },
			]);
			checkDisposed(context, name);
		}
		writeJsonAtomic(join(runDir, "pane.json"), pane);
		const backend: RunBackend = { kind: "pane", pane };
		writeRunBackend(runDir, backend);
		const result = { runDir, spec, pane, backend };
		context.commit(result);
		context.appendRegistry(
			parseStrict(
				RegistryRecord,
				metadata.kind === "spawn"
					? { v: 1, kind: "spawn", runId, launch }
					: { v: 1, kind: "resume", runId, name },
				"registry record",
			),
		);
		context.startTick();
		return result;
	} catch (error) {
		const errors: unknown[] = [error];
		let safeToRemove = !paneCreated && launchState?.phase !== "pane-attempted";
		if (!safeToRemove && paneId === undefined)
			errors.push(
				new Error(
					`The new pane identity is unknown. Kept its name and recovery files in ${runDir}. Inspect the tmux server before manual cleanup.`,
				),
			);
		if (paneId !== undefined) {
			try {
				if (savedPane === undefined || runDir === undefined)
					throw new Error(
						`Pane ${paneId} ownership is unknown because its child process identity was not recorded. Inspect recovery files in ${runDir}.`,
					);
				const spec = readJsonStrict(RunSpec, join(runDir, "spec.json"));
				const state = await verifiedPane(
					context.tmux,
					savedPane,
					spec.launch.childSessionFile,
				);
				if (state !== undefined)
					await context.tmux.run(["kill-pane", "-t", paneId]);
				const current = identify(savedPane.process.pid);
				safeToRemove =
					current === null || current.start !== savedPane.process.start;
				// Rollback continues even when the runtime has been disposed.
				await balancePaneColumn(context.tmux, context.liveColumnPanes(paneId));
			} catch (cleanupError) {
				errors.push(cleanupError);
			}
			if (!safeToRemove) {
				if (runDir !== undefined && savedPane !== undefined) {
					try {
						writeJsonAtomic(join(runDir, "pane.json"), savedPane);
					} catch (cleanupError) {
						errors.push(cleanupError);
					}
				}
				errors.push(
					new Error(
						`Cannot confirm child exit and pane cleanup for subagent "${name}". Kept its name and recovery files in ${runDir}.`,
					),
				);
			}
		}
		if (safeToRemove && runDir !== undefined && launchState !== undefined) {
			try {
				writeJsonAtomic(join(runDir, "launch-state.json"), {
					...launchState,
					phase: "cleanup-confirmed",
				});
			} catch (cleanupError) {
				errors.push(cleanupError);
			}
		}
		if (safeToRemove) {
			try {
				if (newSession !== undefined) rmSync(newSession, { force: true });
				if (runDir !== undefined)
					rmSync(runDir, { recursive: true, force: true });
				context.release(name);
			} catch (cleanupError) {
				errors.push(cleanupError);
			}
		}
		if (errors.length > 1)
			throw new AggregateError(
				errors,
				errors
					.map((item) => (item instanceof Error ? item.message : String(item)))
					.join("; "),
				{ cause: error },
			);
		throw error;
	}
}
