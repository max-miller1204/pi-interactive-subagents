import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LaunchDraft, parseStrict, type RunSpec } from "../../src/schema.ts";
import {
	launchWidgetRun,
	type WidgetLaunchContext,
} from "../../src/widget-launch.ts";

function setup(t: { after(fn: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "widget-launch-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const ownerDir = join(root, "runs");
	const sessionDir = join(root, "sessions");
	mkdirSync(ownerDir);
	mkdirSync(sessionDir);
	const parent = join(sessionDir, "parent.jsonl");
	const extension = join(root, "extension.ts");
	const cli = join(root, "cli.js");
	writeFileSync(parent, "");
	writeFileSync(extension, "");
	writeFileSync(cli, "");
	const runId = "fd3e64ef-2fe9-4a84-9e8f-83b03cf50102";
	const launch = parseStrict(
		LaunchDraft,
		{
			name: "scout-1",
			agent: "scout",
			profile: "quick",
			cwd: root,
			session: "standalone",
			autoExit: true,
			model: { provider: "provider", id: "model" },
			thinking: "low",
			systemPrompt: { mode: "append", text: "Read files." },
			tools: ["read"],
			extensions: [],
			skills: [],
			depth: 1,
			nested: null,
		},
		"test launch",
	);
	const calls: { argv: string[]; env: NodeJS.ProcessEnv; spec: RunSpec }[] = [];
	const committed: unknown[] = [];
	const context: WidgetLaunchContext = {
		runId,
		ownerDir,
		ownerKey: "owner",
		owner: { pid: 1, start: "owner" },
		spawnerSessionId: "parent",
		spawnerSessionFile: parent,
		sessionDir,
		mode: "tui",
		rpcChild: false,
		ownExtensionPath: extension,
		env: { TMUX: "old", TMUX_PANE: "%1", VALUE: "one" },
		invocation: () => [process.execPath, cli],
		trusted: () => true,
		isDisposed: () => false,
		reserve: () => {},
		release: () => {},
		commit: (run) => {
			committed.push(run);
		},
		appendRegistry: () => {},
		startTick: () => {},
		startSupervisor: async (spec, _runDir, argv, env) => {
			calls.push({ spec, argv, env });
			return {
				kind: "widget",
				supervisor: { pid: 1, start: "supervisor" },
				child: { pid: 2, start: "child" },
				socket: join(root, "w.sock"),
			};
		},
	};
	return {
		root,
		ownerDir,
		runId,
		context,
		plan: { kind: "spawn" as const, launch, initialPrompt: "Do work" },
		calls,
		committed,
	};
}

test("widget launch writes the same run files and uses Pi RPC without tmux", async (t) => {
	const f = setup(t);
	const result = await launchWidgetRun(f.plan, f.context);
	assert.equal(result.backend.kind, "widget");
	assert.equal(f.committed.length, 1);
	assert.equal(f.calls.length, 1);
	assert.equal(f.calls[0]?.argv.slice(-2).join(" "), "--mode rpc");
	assert.equal(f.calls[0]?.argv.includes("Do work"), false);
	assert.equal(f.calls[0]?.env.TMUX, undefined);
	assert.equal(f.calls[0]?.env.TMUX_PANE, undefined);
	assert.equal(f.calls[0]?.env.VALUE, "one");
	assert.equal(f.calls[0]?.spec.initialPrompt, "Do work");
	assert.equal(existsSync(join(result.runDir, "backend.json")), true);
	assert.equal(existsSync(result.spec.launch.childSessionFile), true);
	assert.match(
		readFileSync(join(result.runDir, "system-prompt.md"), "utf8"),
		/subagent/,
	);
});

test("widget RPC child may launch a nested widget", async (t) => {
	const f = setup(t);
	Object.assign(f.context, { mode: "rpc", rpcChild: true });
	const result = await launchWidgetRun(f.plan, f.context);
	assert.equal(result.backend.kind, "widget");
});

test("widget launch keeps recovery files if supervisor startup is uncertain", async (t) => {
	const f = setup(t);
	let released = false;
	f.context.startSupervisor = async () => {
		throw new Error("start failed");
	};
	f.context.release = () => {
		released = true;
	};
	await assert.rejects(
		launchWidgetRun(f.plan, f.context),
		/cleanup was not confirmed/,
	);
	assert.equal(released, false);
	assert.equal(existsSync(join(f.ownerDir, f.runId)), true);
});
