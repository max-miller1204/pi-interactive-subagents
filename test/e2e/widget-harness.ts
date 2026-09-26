import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import * as pty from "node-pty";
import { processAlive } from "../../src/process.ts";
import { readRunBackend } from "../../src/run-backend.ts";
import { RunBackendRecord, readJsonStrict } from "../../src/schema.ts";
import { connectSupervisor } from "../../src/widget-client.ts";
import { customMessage, readBranch, waitFor } from "./harness.ts";

const repo = resolve(import.meta.dirname, "../..");
const cli = realpathSync(
	join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
);
const extension = realpathSync(join(repo, "src/index.ts"));
const provider = realpathSync(join(repo, "test/fixtures/faux-brain.ts"));

export interface WidgetScenario {
	root: string;
	parentFile: string;
	screen(): string;
	send(text: string): void;
	write(text: string): void;
	waitFor: typeof waitFor;
	childRuns(): string[];
	results(): ReturnType<typeof customMessage>[];
}

export async function widgetScenario(
	t: TestContext,
	options: { prompt: string; agents: Record<string, string> },
): Promise<WidgetScenario> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-widget-e2e-")));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const parentFile = join(root, "parent.jsonl");
	mkdirSync(cwd);
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	writeFileSync(
		join(agentDir, "subagent-profiles.json"),
		JSON.stringify({
			profiles: {
				test: {
					model: "faux/brain",
					thinking: "off",
					guidance: "Test profile.",
					extensions: [provider],
				},
			},
		}),
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			quietStartup: true,
			compaction: { enabled: false },
			retry: { enabled: false },
		}),
	);
	for (const [name, markdown] of Object.entries(options.agents)) {
		assert.match(name, /^[a-z0-9][a-z0-9-]{0,31}$/);
		writeFileSync(join(agentDir, "agents", `${name}.md`), markdown);
	}
	const env: Record<string, string> = {
		HOME: process.env.HOME ?? "",
		PATH: process.env.PATH ?? "",
		TERM: "xterm-256color",
		PI_CODING_AGENT_DIR: agentDir,
		PI_SUBAGENT_TEST_ROOT: root,
	};
	if (!env.HOME || !env.PATH)
		throw new Error("HOME and PATH are required for widget E2E tests.");
	const terminal = pty.spawn(
		process.execPath,
		[
			cli,
			"--no-extensions",
			"-e",
			extension,
			"-e",
			provider,
			"--model",
			"faux/brain",
			"--thinking",
			"off",
			"--session",
			parentFile,
			"--approve",
			options.prompt,
		],
		{ cwd, env, cols: 120, rows: 40, name: "xterm-256color" },
	);
	let output = "";
	terminal.onData((chunk) => {
		output = (output + chunk).slice(-500_000);
	});
	let exited = false;
	const exit = new Promise<void>((resolve) =>
		terminal.onExit(() => {
			exited = true;
			resolve();
		}),
	);
	const childRuns = () => {
		const owners = join(agentDir, "subagent-runs", "owners");
		return existsSync(owners)
			? readdirSync(owners).flatMap((owner) =>
					readdirSync(join(owners, owner)).map((id) => join(owners, owner, id)),
				)
			: [];
	};
	t.after(async () => {
		const errors: Error[] = [];
		if (!exited) terminal.kill("SIGTERM");
		await Promise.race([
			exit,
			new Promise<void>((resolve) => setTimeout(resolve, 3000)),
		]);
		for (const runDir of childRuns()) {
			try {
				const backend =
					existsSync(join(runDir, "backend.json")) ||
					existsSync(join(runDir, "pane.json"))
						? readRunBackend(runDir)
						: readJsonStrict(
								RunBackendRecord,
								join(runDir, "widget-ready.json"),
							);
				if (backend.kind !== "widget")
					throw new Error(`Unexpected pane backend in ${runDir}.`);
				if (processAlive(backend.child)) {
					if (processAlive(backend.supervisor))
						await (
							await connectSupervisor(
								backend,
								readRunId(runDir),
								readOwnerKey(runDir),
							)
						).stop();
					else if (processAlive(backend.child))
						process.kill(backend.child.pid, "SIGTERM");
					const deadline = Date.now() + 3000;
					while (processAlive(backend.child) && Date.now() < deadline)
						await new Promise((done) => setTimeout(done, 20));
					if (processAlive(backend.child))
						throw new Error(`Widget child ${backend.child.pid} did not stop.`);
				}
			} catch (error) {
				errors.push(error instanceof Error ? error : new Error(String(error)));
			}
		}
		if (errors.length) {
			t.diagnostic(
				`Kept ${root} for recovery. ${errors.map((error) => error.message).join("; ")}`,
			);
			t.diagnostic(
				`Terminal tail: ${stripTerminalSequences(output).slice(-2500)}`,
			);
			throw new AggregateError(errors, "Widget E2E cleanup failed.");
		}
		rmSync(root, { recursive: true, force: true });
	});
	return {
		root,
		parentFile,
		screen: () => stripTerminalSequences(output),
		send: (text) => terminal.write(`${text}\r`),
		write: (text) => terminal.write(text),
		waitFor,
		childRuns,
		results: () =>
			existsSync(parentFile)
				? readBranch(parentFile)
						.filter(
							(entry) =>
								entry.type === "custom_message" &&
								entry.customType === "subagent_result",
						)
						.map(customMessage)
				: [],
	};
}

function readRunId(runDir: string): string {
	const name = runDir.split("/").at(-1);
	if (!name) throw new Error(`Invalid widget run directory ${runDir}.`);
	return name;
}
function readOwnerKey(runDir: string): string {
	const name = runDir.split("/").at(-2);
	if (!name) throw new Error(`Invalid widget owner directory ${runDir}.`);
	return name;
}
