import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	CURRENT_SESSION_VERSION,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	classifyResult,
	defaultName,
	Runtime,
	routableQuestions,
} from "../../src/parent.ts";
import * as queue from "../../src/queue.ts";
import {
	type Launch,
	type ProcessIdentity,
	ResultDetails,
	type RunSpec,
	readJsonStrict,
	UndeliveredRecord,
	writeJsonAtomic,
} from "../../src/schema.ts";
import { readBranch } from "../../src/session-file.ts";
import { createTmux, type PaneState } from "../../src/tmux.ts";
import { tmuxLayout } from "../fixtures/tmux-layout.ts";

function present<T>(value: T | undefined): T {
	assert.ok(value !== undefined);
	return value;
}

function root(t: TestContext): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "parent-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
function transcript(
	file: string,
	runId: string,
	stopReason: AssistantMessage["stopReason"] = "stop",
	text = "Result text",
	marker = true,
): SessionEntry[] {
	const timestamp = "2026-09-25T00:00:00.000Z";
	const rows: unknown[] = [
		{
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "child",
			timestamp,
			cwd: "/tmp",
		},
	];
	if (marker)
		rows.push({
			type: "custom",
			id: "marker",
			parentId: null,
			timestamp,
			customType: "subagent_child",
			data: { v: 1, kind: "run", runId, name: "worker-1", sessionId: "child" },
		});
	if (text !== "NO_ASSISTANT")
		rows.push({
			type: "message",
			id: "assistant",
			parentId: marker ? "marker" : null,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				api: "openai-completions",
				provider: "test",
				model: "test",
				usage: {
					input: 1,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 3,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason,
				errorMessage: "provider error",
				timestamp: 1,
			},
		});
	writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
	return readBranch(file);
}
function dead(overrides: Partial<PaneState> = {}): PaneState {
	return {
		paneId: "%2",
		pid: 222,
		dead: true,
		status: 0,
		signal: null,
		session: "",
		...overrides,
	};
}
for (const row of [
	{
		label: "fatal precedes missing pane",
		fatal: "bad config",
		missing: true,
		status: "failed",
	},
	{ label: "missing pane", missing: true, status: "closed" },
	{
		label: "signal precedes exit code",
		pane: { signal: "TERM", status: 2 },
		status: "crashed",
	},
	{ label: "nonzero exit", pane: { status: 2 }, status: "crashed" },
	{ label: "no marker", marker: false, status: "no_output" },
	{ label: "no assistant", text: "NO_ASSISTANT", status: "no_output" },
	{ label: "error", stop: "error", status: "error" },
	{ label: "aborted", stop: "aborted", status: "aborted" },
	{ label: "toolUse", stop: "toolUse", status: "aborted" },
	{ label: "stop", stop: "stop", status: "completed" },
	{ label: "length", stop: "length", status: "completed" },
] as const) {
	test(`classifies ${row.label}`, (t) => {
		const runId = randomUUID();
		const r = row as {
			fatal?: string;
			missing?: boolean;
			pane?: Partial<PaneState>;
			marker?: boolean;
			text?: string;
			stop?: AssistantMessage["stopReason"];
			status: string;
		};
		const branch = transcript(
			join(root(t), "child.jsonl"),
			runId,
			r.stop,
			r.text,
			r.marker,
		);
		assert.equal(
			classifyResult({
				branch,
				runId,
				pane: r.missing ? undefined : dead(r.pane),
				fatal: r.fatal,
			}).status,
			r.status,
		);
	});
}
test("rejects dead panes with no exit evidence and unfinished assistant states", (t) => {
	const runId = randomUUID();
	const branch = transcript(join(root(t), "child.jsonl"), runId, "pending");
	assert.throws(
		() => classifyResult({ branch, runId, pane: dead({ status: null }) }),
		/no exit status and no signal/,
	);
	assert.throws(
		() => classifyResult({ branch, runId, pane: dead() }),
		/pending/,
	);
});
test("routable excludes unshown questions and queued answers, not withdrawn items", (t) => {
	const dir = root(t);
	for (const box of ["inbox", "outbox", "questions"]) mkdirSync(join(dir, box));
	for (const qid of ["q-11111111", "q-22222222", "q-33333333"])
		writeJsonAtomic(join(dir, "questions", `${qid}.json`), {
			v: 1,
			qid,
			text: "Question?",
			toolCallId: qid,
			askedAt: 1,
		});
	queue.put(join(dir, "outbox"), "outbox", {
		v: 1,
		kind: "question",
		qid: "q-11111111",
		text: "Question?",
	});
	queue.put(join(dir, "outbox"), "outbox", {
		v: 1,
		kind: "withdrawn",
		qid: "q-33333333",
	});
	queue.put(join(dir, "inbox"), "inbox", {
		v: 1,
		kind: "answer",
		qid: "q-22222222",
		text: "Answer",
	});
	assert.deepEqual(routableQuestions(dir), ["q-33333333"]);
});
test("result status remains a literal union", () => {
	const statuses: ResultDetails["status"][] = [
		"completed",
		"error",
		"aborted",
		"crashed",
		"closed",
		"no_output",
		"failed",
	];
	type Equal<A, B> =
		(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
			? true
			: false;
	const exact: Equal<
		ResultDetails["status"],
		| "completed"
		| "error"
		| "aborted"
		| "crashed"
		| "closed"
		| "no_output"
		| "failed"
	> = true;
	assert.equal(exact, true);
	assert.equal(statuses.length, 7);
});
test("default name fills the smallest free number", () => {
	assert.equal(
		defaultName("worker", new Set(["worker-1", "worker-3"])),
		"worker-2",
	);
});

function fixture(
	t: TestContext,
	options: { disk?: boolean; sessionId?: string } = {},
) {
	const dir = root(t);
	const parentFile = join(dir, "parent.jsonl");
	if (options.disk) writeFileSync(parentFile, "header\n");
	const entries: SessionEntry[] = [];
	const sent: {
		customType: string;
		content: string;
		details: { deliveryId: string };
		trigger: boolean;
	}[] = [];
	const notifications: string[] = [];
	const commands: string[][] = [];
	const stderr: string[] = [];
	const panes = new Map<string, PaneState>();
	const living = new Set<number>();
	const owner: ProcessIdentity = { pid: process.pid, start: "owner start" };
	let now = 1000;
	let lists = 0;
	let idle = true;
	const pi = {
		getActiveTools: () => [
			"read",
			"subagent",
			"subagent_message",
			"subagents_list",
		],
		setActiveTools: (tools: string[]) => {
			activeTools = tools;
		},
		appendEntry: (customType: string, data: unknown) =>
			entries.push({
				type: "custom",
				id: randomUUID(),
				parentId: null,
				timestamp: "now",
				customType,
				data,
			}),
		sendMessage: (
			message: {
				customType: string;
				content: string;
				details: { deliveryId: string };
			},
			send: { triggerTurn: boolean },
		) => {
			sent.push({ ...message, trigger: send.triggerTurn });
			entries.push({
				type: "custom_message",
				id: randomUUID(),
				parentId: null,
				timestamp: "now",
				display: true,
				...message,
			});
		},
	} as unknown as ExtensionAPI;
	let activeTools = pi.getActiveTools();
	const ctx = {
		mode: "tui",
		isIdle: () => idle,
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
			getSessionFile: () => parentFile,
			getSessionId: () => options.sessionId ?? "parent",
			getSessionDir: () => dir,
		},
		ui: { notify: (message: string) => notifications.push(message) },
	} as unknown as ExtensionContext;
	const server = {
		socket: "/socket",
		process: { pid: 99, start: "server start" },
	};
	const tmux = {
		serverIdentity: async () => structuredClone(server),
		run: async (args: string[]) => {
			commands.push(args);
			return args[0] === "-V" ? "tmux 3.4" : "";
		},
		listPanes: async () => {
			lists++;
			return panes;
		},
		capture: async () => "crash tail",
	};
	const deps = {
		tmux,
		runsRoot: join(dir, "subagent-runs"),
		env: { TMUX: "/socket,1,0", TMUX_PANE: "%1" },
		identity: (pid: number) => (pid === owner.pid ? owner : null),
		alive: (identity: ProcessIdentity) => living.has(identity.pid),
		now: () => now,
		delay: async (ms: number) => {
			now += ms;
		},
		stderr: (text: string) => {
			stderr.push(text);
		},
		stopProcess: (_identity: ProcessIdentity) => {},
		ownExtensionPath: import.meta.filename,
		trusted: () => false,
	};
	const runtime = new Runtime(pi, ctx, deps);
	t.after(() => runtime.onShutdown("new"));
	function prepare(name: string, corrupt = false, ownerDir = runtime.ownerDir) {
		const runId = randomUUID();
		const runDir = join(ownerDir, runId);
		mkdirSync(runDir, { recursive: true });
		for (const box of ["inbox", "outbox", "questions"])
			mkdirSync(join(runDir, box));
		const childSessionFile = join(dir, `${name}.jsonl`);
		transcript(childSessionFile, runId);
		if (corrupt) writeFileSync(childSessionFile, "{bad json\n");
		const launch: Launch = {
			name,
			agent: "worker",
			profile: "quick",
			cwd: dir,
			session: "standalone",
			autoExit: true,
			model: { provider: "test", id: "test" },
			thinking: "off",
			systemPrompt: { mode: "append", text: "Task" },
			tools: [],
			extensions: [],
			skills: [],
			depth: 1,
			nested: null,
			childSessionFile,
		};
		const spec: RunSpec = {
			v: 1,
			runId,
			ownerKey: runtime.ownerKey,
			owner,
			startedAt: now,
			kind: "spawn",
			spawnerSessionId: "parent",
			spawnerSessionFile: parentFile,
			initialPrompt: "Task",
			launch,
		};
		const pane = {
			v: 1 as const,
			paneId: `%${panes.size + 2}`,
			server: structuredClone(server),
			process: { pid: 222 + panes.size, start: "child start" },
		};
		writeJsonAtomic(join(runDir, "spec.json"), spec);
		writeJsonAtomic(join(runDir, "pane.json"), pane);
		panes.set(
			pane.paneId,
			dead({
				paneId: pane.paneId,
				pid: pane.process.pid,
				session: childSessionFile,
			}),
		);
		return {
			runId,
			runDir,
			spec,
			pane,
			result: () => readJsonStrict(ResultDetails, join(runDir, "result.json")),
		};
	}
	return {
		runtime,
		prepare,
		deps,
		ctx,
		pi,
		dir,
		entries,
		parentFile,
		sent,
		notifications,
		commands,
		stderr,
		panes,
		living,
		lists: () => lists,
		advance: (ms: number) => {
			now += ms;
		},
		idle: (value: boolean) => {
			idle = value;
		},
		activeTools: () => activeTools,
	};
}
test("result stores auto-exit provenance and done rows retain agent, duration and tokens for 10 seconds", async (t) => {
	const f = fixture(t, { disk: true });
	const run = f.prepare("worker-1");
	run.spec.launch.autoExit = false;
	writeJsonAtomic(join(run.runDir, "spec.json"), run.spec);
	await f.runtime.start({ reason: "new" });
	f.advance(62000);
	await f.runtime.tick();
	assert.equal(run.result().autoExit, false);
	await f.runtime.tick();
	assert.deepEqual(f.runtime.done, [
		{
			name: "worker-1",
			agent: "worker",
			startedAt: run.spec.startedAt,
			contextTokens: 3,
			until: 73000,
		},
	]);
	f.advance(9999);
	await f.runtime.tick();
	assert.equal(f.runtime.done.length, 1);
	f.advance(1);
	await f.runtime.tick();
	assert.equal(f.runtime.done.length, 0);
});
test("a corrupt run fails while a healthy run still finishes with verified cleanup", async (t) => {
	const f = fixture(t);
	const bad = f.prepare("bad", true);
	const good = f.prepare("good");
	await f.runtime.start({ reason: "new" });
	await f.runtime.tick();
	assert.equal(bad.result().status, "failed");
	assert.match(present(bad.result().errorMessage), /valid JSON/);
	assert.equal(good.result().status, "completed");
	assert.equal(good.result().text, "Result text");
	assert.equal(f.lists(), 2);
});
test("missing pane waits 30 seconds and never reads a still-live transcript", async (t) => {
	const f = fixture(t);
	const run = f.prepare("worker-1", true);
	f.panes.clear();
	f.living.add(run.pane.process.pid);
	await f.runtime.start({ reason: "new" });
	await f.runtime.tick();
	f.advance(29_999);
	await f.runtime.tick();
	assert.equal(existsSync(join(run.runDir, "result.json")), false);
	f.advance(1);
	await f.runtime.tick();
	assert.equal(run.result().status, "closed");
	assert.equal(
		run.result().note,
		"The pane closed, but the process 222 did not end within 30 s.",
	);
	assert.equal(run.result().text, "");
});
test("result contains unread inbox, open questions, transcript and truncation", async (t) => {
	const f = fixture(t);
	const run = f.prepare("worker-1");
	transcript(
		run.spec.launch.childSessionFile,
		run.runId,
		"stop",
		"x".repeat(60_000),
	);
	queue.put(join(run.runDir, "inbox"), "inbox", {
		v: 1,
		kind: "message",
		text: "Unread",
	});
	queue.put(join(run.runDir, "inbox"), "inbox", {
		v: 1,
		kind: "answer",
		qid: "q-11111111",
		text: "Yes",
	});
	writeJsonAtomic(join(run.runDir, "questions", "q-11111111.json"), {
		v: 1,
		qid: "q-11111111",
		text: "Proceed?",
		toolCallId: "call",
		askedAt: 1,
	});
	await f.runtime.start({ reason: "new" });
	await f.runtime.tick();
	const details = run.result();
	assert.deepEqual(details.undelivered, [
		"Unread",
		"Answer to q-11111111: Yes",
	]);
	assert.deepEqual(details.openQuestions, [
		{ qid: "q-11111111", text: "Proceed?" },
	]);
	assert.equal(details.truncated, true);
	assert.equal(details.childSessionFile, run.spec.launch.childSessionFile);
	assert.match(
		present(f.sent[0]).content,
		/The output is cut. Full transcript:/,
	);
});
test("session replacement reattaches and adopts without a turn or killing live children", async (t) => {
	const f = fixture(t);
	const run = f.prepare("worker-1");
	f.panes.set(
		run.pane.paneId,
		dead({ dead: false, session: run.spec.launch.childSessionFile }),
	);
	await f.runtime.start({ reason: "new" });
	await f.runtime.onShutdown("new");
	assert.equal(
		f.commands.some((args) => args[0] === "kill-pane"),
		false,
	);
	const next = new Runtime(f.pi, f.ctx, f.deps);
	t.after(() => next.onShutdown("new"));
	f.panes.set(
		run.pane.paneId,
		dead({ session: run.spec.launch.childSessionFile }),
	);
	await next.start({ reason: "new" });
	await next.tick();
	assert.equal(present(f.sent[0]).trigger, false);
	assert.ok(
		f.entries.some(
			(entry) =>
				entry.type === "custom" &&
				(entry.data as { kind: string }).kind === "adopt",
		),
	);
	assert.equal(
		f.notifications[0],
		"Subagent worker-1 was started in another session. Its result is shown here without a new turn.",
	);
	assert.equal(existsSync(run.runDir), true);
	writeFileSync(f.parentFile, "durable\n");
	await next.tick();
	assert.equal(existsSync(run.runDir), false);
});
test("own runs trigger and unknown live questions adopt before withdrawal", async (t) => {
	const f = fixture(t);
	const run = f.prepare("worker-1");
	f.panes.set(
		run.pane.paneId,
		dead({ dead: false, session: run.spec.launch.childSessionFile }),
	);
	queue.put(join(run.runDir, "outbox"), "outbox", {
		v: 1,
		kind: "question",
		qid: "q-11111111",
		text: "Proceed?",
	});
	queue.put(join(run.runDir, "outbox"), "outbox", {
		v: 1,
		kind: "withdrawn",
		qid: "q-11111111",
	});
	await f.runtime.start({ reason: "new" });
	await f.runtime.tick();
	assert.deepEqual(
		f.sent.map((item) => [item.customType, item.trigger]),
		[
			["subagent_question", false],
			["subagent_withdrawn", false],
		],
	);
	assert.match(present(f.sent[0]).content, /It waits for your answer/);
	const own = fixture(t);
	const ownRun = own.prepare("own");
	own.pi.appendEntry("subagent", {
		v: 1,
		kind: "spawn",
		runId: ownRun.runId,
		launch: ownRun.spec.launch,
	});
	await own.runtime.start({ reason: "new" });
	await own.runtime.tick();
	assert.equal(present(own.sent[0]).trigger, true);
});
test("tick calls never overlap", async (t) => {
	const f = fixture(t);
	f.prepare("worker-1");
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let calls = 0;
	const entered = Promise.withResolvers<void>();
	f.deps.tmux.listPanes = async () => {
		calls++;
		entered.resolve();
		await gate;
		return f.panes;
	};
	await f.runtime.start({ reason: "new" });
	const a = f.runtime.tick();
	const b = f.runtime.tick();
	await entered.promise;
	try {
		assert.equal(a, b);
		assert.equal(calls, 1);
	} finally {
		release();
	}
	await Promise.all([a, b]);
	assert.equal(calls, 2);
});

test("quit stops children and stores notices until durable confirmation", async (t) => {
	const f = fixture(t, { disk: true });
	const run = f.prepare("worker-1");
	f.panes.set(
		run.pane.paneId,
		dead({ dead: false, session: run.spec.launch.childSessionFile }),
	);
	f.living.add(run.pane.process.pid);
	const original = f.deps.tmux.run;
	f.deps.tmux.run = async (args) => {
		const output = await original(args);
		if (args[0] === "kill-pane") f.living.delete(run.pane.process.pid);
		return output;
	};
	await f.runtime.start({ reason: "new" });
	await f.runtime.onShutdown("quit");
	const file = join(
		f.deps.runsRoot,
		"undelivered",
		"parent",
		`${run.runId}.json`,
	);
	assert.equal(readJsonStrict(UndeliveredRecord, file).kind, "stopped");
	assert.equal(existsSync(run.runDir), false);
	assert.equal(existsSync(f.runtime.ownerDir), false);
	assert.equal(f.stderr.length, 1);
	assert.match(
		present(f.stderr[0]),
		/Pi quit, so it stopped 1 running subagents: worker-1/,
	);
	assert.match(
		present(f.stderr[0]),
		/Open this session again and use subagent_message/,
	);
	rmSync(f.parentFile);
	const next = new Runtime(f.pi, f.ctx, f.deps);
	t.after(() => next.onShutdown("new"));
	await next.start({ reason: "startup" });
	await next.tick();
	assert.equal(f.sent.length, 1);
	assert.equal(present(f.sent[0]).customType, "subagent_notice");
	assert.equal(present(f.sent[0]).trigger, false);
	await next.tick();
	assert.equal(existsSync(file), true);
	writeFileSync(f.parentFile, "durable\n");
	await next.tick();
	assert.equal(existsSync(file), false);
	assert.equal(f.sent.length, 1);
});
test("quit preserves undelivered results and gives truthful advice for an unsaved session", async (t) => {
	const f = fixture(t);
	const run = f.prepare("worker-1");
	await f.runtime.start({ reason: "new" });
	await f.runtime.tick();
	await f.runtime.onShutdown("quit");
	const file = join(
		f.deps.runsRoot,
		"undelivered",
		"parent",
		`${run.runId}.json`,
	);
	const record = readJsonStrict(UndeliveredRecord, file);
	assert.equal(record.kind, "result");
	if (record.kind === "result") assert.match(record.content, /Result text/);
	assert.match(
		present(f.stderr[0]),
		/This session was not saved, because it has no reply yet/,
	);
	assert.ok(present(f.stderr[0]).includes(run.spec.launch.childSessionFile));
	assert.doesNotMatch(
		present(f.stderr[0]),
		/Open this session again|You see it when you open this session again/,
	);
});
test("quit waits no more than five seconds and keeps files for live children", async (t) => {
	const f = fixture(t);
	const run = f.prepare("worker-1");
	f.living.add(run.pane.process.pid);
	f.panes.set(
		run.pane.paneId,
		dead({ dead: false, session: run.spec.launch.childSessionFile }),
	);
	let waited = 0;
	f.deps.delay = async (ms) => {
		waited += ms;
		f.advance(ms);
	};
	await f.runtime.start({ reason: "new" });
	await f.runtime.onShutdown("quit");
	assert.equal(waited, 5000);
	assert.equal(existsSync(run.runDir), true);
	assert.match(
		present(f.stderr[0]),
		/Subagent worker-1 \(pid 222\) did not stop within 5 s/,
	);
	assert.equal(
		existsSync(
			join(f.deps.runsRoot, "undelivered", "parent", `${run.runId}.json`),
		),
		false,
	);
});
test("a failed pane kill is reported and its run files stay", async (t) => {
	const f = fixture(t);
	const run = f.prepare("worker-1");
	f.panes.set(
		run.pane.paneId,
		dead({ dead: false, session: run.spec.launch.childSessionFile }),
	);
	f.deps.tmux.run = async () => {
		throw new Error("permission denied");
	};
	await f.runtime.start({ reason: "new" });
	await f.runtime.onShutdown("quit");
	assert.equal(existsSync(run.runDir), true);
	assert.match(
		present(f.stderr[0]),
		/Could not close pane %2: permission denied/,
	);
});
test("startup recovers dead-owner records in one sorted notice and keeps live orphans", async (t) => {
	const f = fixture(t);
	const oldOwner = join(f.deps.runsRoot, "owners", `999999-${"a".repeat(64)}`);
	const stopped = f.prepare("stopped", false, oldOwner);
	const orphan = f.prepare("orphan", false, oldOwner);
	f.living.add(orphan.pane.process.pid);
	const finished = f.prepare("finished");
	await f.runtime.start({ reason: "new" });
	await f.runtime.tick();
	const details = finished.result();
	const oldFinished = f.prepare("old-finished", false, oldOwner);
	writeJsonAtomic(join(oldFinished.runDir, "result.json"), {
		...details,
		deliveryId: `${oldFinished.runId}:result`,
		runId: oldFinished.runId,
		name: "old-finished",
		childSessionFile: oldFinished.spec.launch.childSessionFile,
	});
	await f.runtime.onShutdown("new");
	const next = new Runtime(f.pi, f.ctx, f.deps);
	t.after(() => next.onShutdown("new"));
	await next.start({ reason: "startup" });
	await next.tick();
	const notices = f.sent.filter(
		(message) => message.customType === "subagent_notice",
	);
	assert.equal(notices.length, 1);
	assert.equal(
		present(notices[0]).details.deliveryId,
		`notice:${[stopped.runId, oldFinished.runId].sort().join(",")}`,
	);
	assert.match(present(notices[0]).content, /Stopped: stopped/);
	assert.match(present(notices[0]).content, /Results that were not delivered:/);
	assert.equal(existsSync(orphan.runDir), true);
	assert.equal(existsSync(stopped.runDir), false);
	assert.equal(existsSync(oldFinished.runDir), false);
	assert.equal(readdirSync(oldOwner).length, 1);
});
for (const mismatch of ["pid", "session", "server", "unknown"] as const)
	for (const path of ["recovery", "tick", "quit"] as const)
		test(`${path} retains recovery files and does not kill a pane with ${mismatch} identity`, async (t) => {
			const f = fixture(t, { disk: true });
			const oldOwner = join(
				f.deps.runsRoot,
				"owners",
				`999999-${"a".repeat(64)}`,
			);
			const run = f.prepare(
				"protected",
				false,
				path === "recovery" ? oldOwner : undefined,
			);
			const state = present(f.panes.get(run.pane.paneId));
			if (mismatch === "pid") state.pid++;
			if (mismatch === "session") state.session = "/unrelated-session";
			if (mismatch === "server")
				f.deps.tmux.serverIdentity = async () => ({
					socket: "/socket",
					process: { pid: 99, start: "restarted server" },
				});
			if (mismatch === "unknown")
				f.deps.tmux.serverIdentity = async () => {
					throw new Error("server identity unavailable");
				};
			await f.runtime.start({
				reason: path === "recovery" ? "startup" : "new",
			});
			if (path === "tick") {
				await f.runtime.tick();
				await f.runtime.tick();
			}
			if (path === "quit") await f.runtime.onShutdown("quit");
			assert.equal(
				f.commands.some((args) => args[0] === "kill-pane"),
				false,
			);
			assert.equal(existsSync(join(run.runDir, "spec.json")), true);
			assert.equal(existsSync(join(run.runDir, "pane.json")), true);
			assert.equal(existsSync(run.spec.launch.childSessionFile), true);
			assert.match(
				[
					...f.notifications,
					...f.stderr,
					...f.sent.map((message) => message.content),
				].join("\n"),
				/identity/,
			);
		});

test("owner directory is private and fresh parent paths are enabled", async (t) => {
	const f = fixture(t);
	await f.runtime.start({ reason: "new" });
	assert.equal(statSync(f.runtime.ownerDir).mode & 0o777, 0o700);
	assert.ok(f.activeTools().includes("subagent"));
	assert.equal(f.notifications.length, 0);
});

test("confirmed timeout results stay quiet while the child is still alive", async (t) => {
	const f = fixture(t, { disk: true });
	const run = f.prepare("worker-1", true);
	f.panes.clear();
	f.living.add(run.pane.process.pid);
	await f.runtime.start({ reason: "new" });
	await f.runtime.tick();
	f.advance(30_000);
	await f.runtime.tick();
	await f.runtime.tick();
	await f.runtime.tick();
	assert.equal(f.sent.length, 1);
	assert.equal(existsSync(run.runDir), true);
	f.living.clear();
	await f.runtime.tick();
	assert.equal(existsSync(run.runDir), false);
	assert.equal(f.sent.length, 1);
});
test("a confirmed live-process result stays suppressed on reattach and dead-owner cleanup", async (t) => {
	const f = fixture(t, { disk: true });
	const run = f.prepare("worker-1", true);
	f.panes.clear();
	f.living.add(run.pane.process.pid);
	await f.runtime.start({ reason: "new" });
	await f.runtime.tick();
	f.advance(30_000);
	await f.runtime.tick();
	await f.runtime.tick();
	assert.equal(existsSync(join(run.runDir, "delivery-ack.json")), true);
	await f.runtime.onShutdown("new");
	const next = new Runtime(f.pi, f.ctx, f.deps);
	t.after(() => next.onShutdown("new"));
	await next.start({ reason: "new" });
	await next.tick();
	assert.equal(f.sent.length, 1);
	assert.equal(existsSync(run.runDir), true);
	await next.onShutdown("new");
	const foreignDeps = {
		...f.deps,
		identity: (pid: number) =>
			pid === process.pid
				? { pid, start: "replacement process identity" }
				: null,
	};
	f.living.clear();
	const recovery = new Runtime(f.pi, f.ctx, foreignDeps);
	t.after(() => recovery.onShutdown("new"));
	await recovery.start({ reason: "startup" });
	await recovery.tick();
	assert.equal(existsSync(run.runDir), false);
	assert.equal(f.sent.length, 1);
	assert.equal(
		existsSync(join(f.deps.runsRoot, "undelivered", "parent")),
		false,
	);
});
test("quit stops an acknowledged timeout process without creating another notice", async (t) => {
	const f = fixture(t, { disk: true });
	const run = f.prepare("worker-1", true);
	f.panes.clear();
	f.living.add(run.pane.process.pid);
	await f.runtime.start({ reason: "new" });
	await f.runtime.tick();
	f.advance(30_000);
	await f.runtime.tick();
	await f.runtime.tick();
	const signals: number[] = [];
	f.deps.stopProcess = (identity) => {
		signals.push(identity.pid);
		f.living.clear();
	};
	await f.runtime.onShutdown("quit");
	assert.deepEqual(signals, [run.pane.process.pid]);
	assert.equal(existsSync(run.runDir), false);
	assert.equal(
		existsSync(join(f.deps.runsRoot, "undelivered", "parent")),
		false,
	);
});
test("a failed result write cannot hold another run and notifies once", async (t) => {
	const f = fixture(t);
	const bad = f.prepare("bad", true);
	const good = f.prepare("good");
	mkdirSync(join(bad.runDir, "result.json"));
	await f.runtime.start({ reason: "new" });
	await f.runtime.tick();
	await f.runtime.tick();
	assert.ok(f.runtime.runs.get("bad")?.broken);
	assert.equal(good.result().status, "completed");
	assert.equal(
		f.notifications.filter((message) =>
			message.includes("Could not write result"),
		).length,
		1,
	);
});
test("listPanes errors notify once and the next tick retries", async (t) => {
	const f = fixture(t);
	const run = f.prepare("worker-1");
	const list = f.deps.tmux.listPanes;
	f.deps.tmux.listPanes = async () => {
		throw new Error("server unavailable");
	};
	await f.runtime.start({ reason: "new" });
	await f.runtime.tick();
	await f.runtime.tick();
	assert.deepEqual(f.notifications, ["server unavailable"]);
	f.deps.tmux.listPanes = list;
	await f.runtime.tick();
	assert.equal(run.result().status, "completed");
});
test("corrupt fatal, question and inbox files produce isolated failed results", async (t) => {
	for (const target of [
		"fatal.json",
		"questions/q-11111111.json",
		"inbox/00000000000000000001-11111111.json",
		"outbox/00000000000000000001-11111111.json",
	]) {
		const f = fixture(t);
		const bad = f.prepare("bad");
		const good = f.prepare("good");
		writeFileSync(join(bad.runDir, target), "{bad json\n");
		await f.runtime.start({ reason: "new" });
		await f.runtime.tick();
		assert.equal(bad.result().status, "failed", target);
		assert.match(present(bad.result().errorMessage), /invalid JSON/);
		assert.equal(good.result().status, "completed");
	}
});
test("messages select one open question and reject stale or ambiguous answers", async (t) => {
	const f = fixture(t);
	const run = f.prepare("worker-1");
	f.panes.set(run.pane.paneId, dead({ dead: false }));
	await f.runtime.start({ reason: "new" });
	assert.equal(
		await f.runtime.message("worker-1", "Steer"),
		'Queued for "worker-1". It reads the message at its next step.',
	);
	const putQuestion = (qid: string) =>
		writeJsonAtomic(join(run.runDir, "questions", `${qid}.json`), {
			v: 1,
			qid,
			text: "Question?",
			toolCallId: qid,
			askedAt: 1,
		});
	putQuestion("q-11111111");
	assert.equal(
		await f.runtime.message("worker-1", "Yes"),
		'Sent as the answer to question q-11111111 of "worker-1".',
	);
	await assert.rejects(
		f.runtime.message("worker-1", "Again", "q-11111111"),
		/is not open/,
	);
	putQuestion("q-22222222");
	putQuestion("q-33333333");
	await assert.rejects(
		f.runtime.message("worker-1", "Which?"),
		/2 open questions/,
	);
	assert.match(
		await f.runtime.message("worker-1", "This", "q-33333333"),
		/Sent as the answer/,
	);
	await assert.rejects(f.runtime.message("unknown", "Hi"), /Unknown subagent/);
});
test("a reconciliation error does not prevent quit from stopping children", async (t) => {
	const f = fixture(t);
	const run = f.prepare("worker-1");
	f.panes.set(
		run.pane.paneId,
		dead({ dead: false, session: run.spec.launch.childSessionFile }),
	);
	await f.runtime.start({ reason: "new" });
	assert.ok(f.runtime.deliverer);
	f.runtime.deliverer.reconcile = () => {
		throw new Error("receiving session is corrupt");
	};
	await f.runtime.onShutdown("quit");
	assert.ok(f.commands.some((args) => args[0] === "kill-pane"));
	assert.ok(f.notifications.includes("receiving session is corrupt"));
	assert.equal(
		readJsonStrict(
			UndeliveredRecord,
			join(f.deps.runsRoot, "undelivered", "parent", `${run.runId}.json`),
		).kind,
		"stopped",
	);
});
test("quit owns an in-flight finalization and keeps its crashed result", async (t) => {
	const f = fixture(t);
	const run = f.prepare("worker-1");
	f.panes.set(
		run.pane.paneId,
		dead({ status: 2, session: run.spec.launch.childSessionFile }),
	);
	let release!: () => void;
	let captured!: () => void;
	const atCapture = new Promise<void>((resolve) => {
		captured = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.deps.tmux.capture = async () => {
		captured();
		await gate;
		return "tail";
	};
	await f.runtime.start({ reason: "new" });
	const ticking = f.runtime.tick();
	await atCapture;
	const shutting = f.runtime.onShutdown("quit");
	release();
	await Promise.all([ticking, shutting]);
	const record = readJsonStrict(
		UndeliveredRecord,
		join(f.deps.runsRoot, "undelivered", "parent", `${run.runId}.json`),
	);
	assert.equal(record.kind, "result");
	if (record.kind === "result") {
		assert.equal(record.details.status, "crashed");
		assert.equal(record.details.paneTail, undefined);
	}
	assert.equal(f.sent.length, 0);
});
test("durable result confirmation retains failed pane cleanup across reattach", async (t) => {
	const f = fixture(t, { disk: true });
	const run = f.prepare("worker-1");
	let attempts = 0;
	f.deps.tmux.run = async (args) => {
		if (args[0] === "kill-pane") {
			attempts++;
			throw new Error("pane cleanup denied");
		}
		return "";
	};
	await f.runtime.start({ reason: "new" });
	await f.runtime.tick();
	await f.runtime.tick();
	assert.equal(existsSync(run.runDir), true);
	assert.equal(f.sent.length, 1);
	assert.ok(attempts >= 2);
	assert.equal(existsSync(join(run.runDir, "delivery-ack.json")), true);
	await f.runtime.onShutdown("new");
	const next = new Runtime(f.pi, f.ctx, f.deps);
	t.after(() => next.onShutdown("new"));
	await next.start({ reason: "new" });
	await next.tick();
	assert.equal(existsSync(run.runDir), true);
	assert.equal(f.sent.length, 1);
	f.deps.tmux.run = async (args) => {
		if (args[0] === "kill-pane") {
			attempts++;
			f.panes.delete(run.pane.paneId);
		}
		return "";
	};
	await next.tick();
	assert.equal(existsSync(run.runDir), false);
	assert.equal(next.runs.size, 0);
	assert.equal(f.sent.length, 1);
});
test("dead-owner recovery retains acknowledged runs until pane cleanup succeeds", async (t) => {
	const f = fixture(t, { disk: true });
	const run = f.prepare("worker-1");
	f.deps.tmux.run = async () => {
		throw new Error("pane cleanup denied");
	};
	await f.runtime.start({ reason: "new" });
	await f.runtime.tick();
	await f.runtime.tick();
	await f.runtime.onShutdown("new");
	const deps = {
		...f.deps,
		identity: (pid: number) =>
			pid === process.pid ? { pid, start: "new owner" } : null,
	};
	const recovery = new Runtime(f.pi, f.ctx, deps);
	t.after(() => recovery.onShutdown("new"));
	await recovery.start({ reason: "startup" });
	assert.equal(existsSync(run.runDir), true);
	assert.equal(f.sent.length, 1);
	await recovery.onShutdown("new");
	deps.tmux.run = async (args) => {
		if (args[0] === "kill-pane") f.panes.delete(run.pane.paneId);
		return "";
	};
	const retry = new Runtime(f.pi, f.ctx, deps);
	t.after(() => retry.onShutdown("new"));
	await retry.start({ reason: "startup" });
	await retry.tick();
	assert.equal(existsSync(run.runDir), false);
	assert.equal(f.sent.length, 1);
	assert.equal(
		existsSync(join(f.deps.runsRoot, "undelivered", "parent")),
		false,
	);
});
test("an acknowledged result still reports a later pane identity mismatch", async (t) => {
	const f = fixture(t, { disk: true });
	const run = f.prepare("worker-1");
	const execute = f.deps.tmux.run;
	f.deps.tmux.run = async () => {
		throw new Error("cleanup denied");
	};
	await f.runtime.start({ reason: "new" });
	await f.runtime.tick();
	await f.runtime.tick();
	assert.equal(existsSync(join(run.runDir, "delivery-ack.json")), true);
	f.deps.tmux.run = execute;
	present(f.panes.get(run.pane.paneId)).pid++;
	await f.runtime.tick();
	assert.equal(
		f.commands.some((args) => args[0] === "kill-pane"),
		false,
	);
	assert.equal(existsSync(run.runDir), true);
	assert.equal(f.sent.length, 1);
	assert.ok(
		f.notifications.some((message) => message.includes("identity mismatch")),
	);
});

test("quit completes retained pane cleanup without another result or notice", async (t) => {
	const f = fixture(t, { disk: true });
	const run = f.prepare("worker-1");
	f.deps.tmux.run = async () => {
		throw new Error("pane cleanup denied");
	};
	await f.runtime.start({ reason: "new" });
	await f.runtime.tick();
	await f.runtime.tick();
	f.deps.tmux.run = async (args) => {
		if (args[0] === "kill-pane") f.panes.delete(run.pane.paneId);
		return "";
	};
	await f.runtime.onShutdown("quit");
	assert.equal(f.panes.size, 0);
	assert.equal(existsSync(run.runDir), false);
	assert.equal(f.sent.length, 1);
	assert.equal(
		existsSync(join(f.deps.runsRoot, "undelivered", "parent")),
		false,
	);
});
test("quit retries cleanup of a confirmed finished dead pane and preserves failure", async (t) => {
	const f = fixture(t, { disk: true });
	const run = f.prepare("worker-1");
	let attempts = 0;
	f.deps.tmux.run = async (args) => {
		if (args[0] === "kill-pane") {
			attempts++;
			throw new Error("pane cleanup denied");
		}
		return "";
	};
	await f.runtime.start({ reason: "new" });
	await f.runtime.tick();
	const before = attempts;
	await f.runtime.onShutdown("quit");
	assert.equal(attempts, before + 1);
	assert.equal(existsSync(run.runDir), true);
	assert.match(
		present(f.stderr[0]),
		/Could not close pane %2: pane cleanup denied/,
	);
	assert.equal(
		existsSync(
			join(f.deps.runsRoot, "undelivered", "parent", `${run.runId}.json`),
		),
		false,
	);
});
test("quit closes an interrupted capture pane or retains its finalized result on failure", async (t) => {
	for (const fail of [false, true]) {
		const f = fixture(t);
		const run = f.prepare("worker-1");
		f.panes.set(
			run.pane.paneId,
			dead({ status: 2, session: run.spec.launch.childSessionFile }),
		);
		const gate = Promise.withResolvers<void>();
		const capture = Promise.withResolvers<void>();
		f.deps.tmux.capture = async () => {
			capture.resolve();
			await gate.promise;
			return "tail";
		};
		let attempts = 0;
		f.deps.tmux.run = async (args) => {
			if (args[0] === "kill-pane") {
				attempts++;
				if (fail) throw new Error("pane cleanup denied");
				f.panes.delete(run.pane.paneId);
			}
			return "";
		};
		await f.runtime.start({ reason: "new" });
		const tick = f.runtime.tick();
		await capture.promise;
		const quit = f.runtime.onShutdown("quit");
		gate.resolve();
		await Promise.all([tick, quit]);
		assert.equal(attempts, 1);
		if (fail) {
			assert.equal(existsSync(run.runDir), true);
			assert.equal(run.result().status, "crashed");
			assert.match(present(f.stderr[0]), /Could not close pane/);
		} else {
			assert.equal(existsSync(run.runDir), false);
			assert.equal(f.panes.size, 0);
		}
	}
});
test("quit retains every run when its pane snapshot fails", async (t) => {
	const f = fixture(t);
	const stopped = f.prepare("stopped");
	const retained = f.prepare("retained");
	const finished = f.prepare("finished");
	for (const run of [stopped, retained]) {
		f.living.add(run.pane.process.pid);
		f.panes.set(
			run.pane.paneId,
			dead({
				paneId: run.pane.paneId,
				pid: run.pane.process.pid,
				dead: false,
				session: run.spec.launch.childSessionFile,
			}),
		);
	}
	await f.runtime.start({ reason: "new" });
	await f.runtime.tick();
	assert.equal(finished.result().status, "completed");
	f.deps.tmux.listPanes = async () => {
		throw new Error("snapshot unavailable");
	};
	const attempted: string[] = [];
	const signals: ProcessIdentity[] = [];
	f.deps.stopProcess = (identity) => {
		signals.push(identity);
	};
	f.deps.tmux.run = async (args) => {
		if (args[0] === "kill-pane") {
			attempted.push(present(args[2]));
			if (args[2] === retained.pane.paneId) throw new Error("cleanup denied");
			if (args[2] === stopped.pane.paneId)
				f.living.delete(stopped.pane.process.pid);
		}
		return "";
	};
	await f.runtime.onShutdown("quit");
	assert.deepEqual(attempted, []);
	assert.deepEqual(signals, []);
	const records = join(f.deps.runsRoot, "undelivered", "parent");
	for (const run of [stopped, retained, finished]) {
		assert.equal(existsSync(run.runDir), true);
		assert.equal(existsSync(join(records, `${run.runId}.json`)), false);
	}
	assert.ok(
		f.notifications.some((message) => message.includes("snapshot unavailable")),
	);
	const advice = present(f.stderr[0]);
	assert.match(
		advice,
		/Could not list panes during quit: snapshot unavailable/,
	);
	assert.match(advice, /Could not close pane %3: Pane identity is unknown/);
	assert.doesNotMatch(advice, /stopped 1 running subagents|It kept 1 result/);
	assert.match(advice, /Subagent retained \(pid 223\) is still running/);
	assert.match(advice, /This session was not saved/);
	assert.doesNotMatch(advice, /did not stop within 5 s/);
});
test("an unavailable quit snapshot never becomes missing-pane evidence for signaling", async (t) => {
	const f = fixture(t);
	const run = f.prepare("worker-1", true);
	f.panes.clear();
	f.living.add(run.pane.process.pid);
	await f.runtime.start({ reason: "new" });
	await f.runtime.tick();
	f.advance(30_000);
	await f.runtime.tick();
	const signals: ProcessIdentity[] = [];
	const attempts: string[][] = [];
	f.deps.stopProcess = (identity) => {
		signals.push(identity);
	};
	f.deps.tmux.listPanes = async () => {
		throw new Error("snapshot unavailable");
	};
	f.deps.tmux.run = async (args) => {
		attempts.push(args);
		throw new Error("pane not found");
	};
	await f.runtime.onShutdown("quit");
	assert.deepEqual(signals, []);
	assert.deepEqual(attempts, []);
	assert.equal(existsSync(run.runDir), true);
	assert.equal(
		existsSync(
			join(f.deps.runsRoot, "undelivered", "parent", `${run.runId}.json`),
		),
		false,
	);
	const advice = present(f.stderr[0]);
	assert.match(
		advice,
		/Could not list panes during quit: snapshot unavailable/,
	);
	assert.match(advice, /Could not close pane %2: Pane identity is unknown/);
	assert.match(advice, /is still running/);
	assert.doesNotMatch(advice, /stopped 1|did not stop within 5 s/);
});

test("quit after reattach stops an unacknowledged timeout process and retains an unconfirmed exit", async (t) => {
	const f = fixture(t);
	const run = f.prepare("worker-1", true);
	f.panes.clear();
	f.living.add(run.pane.process.pid);
	await f.runtime.start({ reason: "new" });
	await f.runtime.tick();
	f.advance(30_000);
	await f.runtime.tick();
	await f.runtime.onShutdown("new");
	assert.equal(existsSync(join(run.runDir, "delivery-ack.json")), false);
	const signals: ProcessIdentity[] = [];
	let livenessChecks = 0;
	const next = new Runtime(f.pi, f.ctx, {
		...f.deps,
		alive: (identity) => {
			livenessChecks++;
			return f.living.has(identity.pid);
		},
		stopProcess: (identity) => {
			assert.ok(livenessChecks >= 2);
			signals.push(identity);
		},
	});
	t.after(() => next.onShutdown("new"));
	await next.start({ reason: "new" });
	await next.onShutdown("quit");
	assert.deepEqual(signals, [run.pane.process]);
	assert.equal(existsSync(run.runDir), true);
	assert.match(present(f.stderr[0]), /did not stop within 5 s/);
	assert.equal(
		existsSync(
			join(f.deps.runsRoot, "undelivered", "parent", `${run.runId}.json`),
		),
		false,
	);
});
test("the result contains an open question before its stale outbox question is dropped", async (t) => {
	const f = fixture(t);
	const run = f.prepare("worker-1");
	const qid = "q-11111111";
	writeJsonAtomic(join(run.runDir, "questions", `${qid}.json`), {
		v: 1,
		qid,
		text: "Proceed?",
		toolCallId: "call",
		askedAt: 1,
	});
	const seq = queue.put(join(run.runDir, "outbox"), "outbox", {
		v: 1,
		kind: "question",
		qid,
		text: "Proceed?",
	});
	await f.runtime.start({ reason: "new" });
	const source = present(
		f.runtime.sources.find((source) => source.key === run.runId),
	);
	const confirm = source.confirm;
	let dropped = false;
	source.confirm = (item) => {
		if (item.id === queue.itemId(run.runId, "outbox", seq)) {
			assert.deepEqual(run.result().openQuestions, [{ qid, text: "Proceed?" }]);
			dropped = true;
		}
		confirm(item);
	};
	await f.runtime.tick();
	assert.equal(dropped, true);
	assert.equal(queue.count(join(run.runDir, "outbox")), 0);
	assert.equal(existsSync(f.parentFile), false);
	assert.equal(
		f.entries.some(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "subagent_question",
		),
		false,
	);
});

test("dead pane capture and a human-closed child keep final text", async (t) => {
	const f = fixture(t);
	const run = f.prepare("worker-1");
	f.panes.set(
		run.pane.paneId,
		dead({ status: 7, session: run.spec.launch.childSessionFile }),
	);
	await f.runtime.start({ reason: "new" });
	await f.runtime.tick();
	assert.equal(run.result().paneTail, "crash tail");
	assert.equal(run.result().text, "Result text");
	assert.match(present(f.sent[0]).content, /crashed \(exit code 7\)/);
	const human = fixture(t);
	const closed = human.prepare("worker-1");
	closed.spec.launch.autoExit = false;
	writeJsonAtomic(join(closed.runDir, "spec.json"), closed.spec);
	human.panes.clear();
	await human.runtime.start({ reason: "new" });
	await human.runtime.tick();
	assert.equal(closed.result().status, "closed");
	assert.match(
		present(human.sent[0]).content,
		/was closed in its pane by a human/,
	);
});
for (const failure of ["none", "before-respawn", "registry"] as const)
	test(`pane startup preserves strict snapshots and sibling progress: ${failure}`, async (t) => {
		const failRegistry = failure === "registry";
		const f = fixture(t);
		const survivor = f.prepare("survivor");
		f.pi.appendEntry("subagent", {
			v: 1,
			kind: "spawn",
			runId: survivor.runId,
			launch: survivor.spec.launch,
		});
		const { childSessionFile: _child, ...draft } = survivor.spec.launch;
		f.panes.set(
			survivor.pane.paneId,
			dead({
				paneId: survivor.pane.paneId,
				pid: survivor.pane.process.pid,
				session: survivor.spec.launch.childSessionFile,
				dead: false,
			}),
		);
		f.living.add(survivor.pane.process.pid);
		const empty = Promise.withResolvers<void>();
		const respawn = Promise.withResolvers<void>();
		let emptyReads = 0;
		let snapshots = 0;
		const strict = createTmux("/socket", async (_file, args) => {
			assert.equal(args[2], "list-panes");
			snapshots++;
			if (f.panes.get("%99")?.pid === 0) emptyReads++;
			return {
				stdout: [...f.panes.values()]
					.map(
						(pane) =>
							`${pane.paneId}\t${pane.pid}\t${Number(pane.dead)}\t${pane.status === null ? "" : pane.status}\t${pane.signal === null ? "" : pane.signal}\t${pane.session}`,
					)
					.join("\n"),
				stderr: "",
			};
		});
		const append = f.pi.appendEntry.bind(f.pi);
		f.pi.appendEntry = (type, data) => {
			if (
				failRegistry &&
				type === "subagent" &&
				data !== null &&
				typeof data === "object" &&
				"kind" in data &&
				data.kind === "spawn"
			)
				throw new Error("Injected registry failure");
			append(type, data);
		};
		const runtime = new Runtime(f.pi, f.ctx, {
			...f.deps,
			identity: (pid) =>
				pid === process.pid
					? { pid, start: "owner start" }
					: f.living.has(pid)
						? { pid, start: "child start" }
						: null,
			stopProcess: (identity) => {
				f.living.delete(identity.pid);
			},
			invocation: () => [process.execPath, "/fake/cli.js"],
			tmux: {
				...f.deps.tmux,
				listPanes: () => strict.listPanes(),
				run: async (args) => {
					f.commands.push(args);
					if (args[0] === "-V") return "tmux 3.7c";
					if (args[0] === "split-window") {
						f.panes.set(
							"%99",
							dead({
								paneId: "%99",
								pid: args.at(-1) === "" ? 0 : 899,
								dead: false,
								status: null,
								session: "",
							}),
						);
						empty.resolve();
						await respawn.promise;
						return "%99";
					}
					if (args[0] === "set-option") {
						if (failure === "before-respawn")
							throw new Error("Injected failure before respawn");
						f.panes.set(
							"%99",
							dead({
								paneId: "%99",
								pid: 900,
								dead: false,
								status: null,
								session: present(
									args[args.indexOf("@pi_subagent_session") + 1],
								),
							}),
						);
						f.living.add(900);
					}
					if (args[0] === "kill-pane") {
						const id = present(args[2]);
						const pane = f.panes.get(id);
						assert.ok(pane);
						f.living.delete(pane.pid);
						f.panes.delete(id);
					}
					if (args[0] === "show-options") return "off";
					if (args[0] === "list-panes")
						return `${survivor.pane.paneId}\t${survivor.pane.process.pid}\t0\t0\t80\t12\t${survivor.spec.launch.childSessionFile}\n%99\t900\t0\t13\t80\t11\t${present(f.panes.get("%99")).session}`;
					if (args.at(-1) === "#{window_layout}")
						return tmuxLayout(
							`80x24,0,0[80x12,0,0,${survivor.pane.paneId.slice(1)},80x11,0,13,99]`,
						);
					return args.at(-1) === "#{pane_pid}" ? "900" : "";
				},
			},
		});
		t.after(() => runtime.onShutdown("new"));
		await runtime.start({ reason: "new" });
		const launched = runtime.spawn({ ...draft, name: "new" }, "New task").then(
			(value) => ({ value, error: undefined }),
			(error) => ({ value: undefined, error }),
		);
		let poll: Promise<void> | undefined;
		try {
			await empty.promise;
			// A failed start must not poison snapshots or block sibling progress.
			if (failure !== "before-respawn") await strict.listPanes();
			emptyReads = 0;
			poll = runtime.tick();
			assert.match(
				await runtime.message("survivor", "Steer during another pane start."),
				/Queued for "survivor"/,
			);
			assert.equal(
				queue.list(join(survivor.runDir, "inbox"), "inbox").length,
				1,
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(
				emptyReads,
				0,
				`Unexpected parent errors: ${JSON.stringify(f.notifications)}`,
			);
			assert.deepEqual(f.notifications, []);
			respawn.resolve();
			const outcome = await launched;
			if (failure === "before-respawn") {
				assert.match(String(outcome.error), /Injected failure before respawn/);
				assert.match(String(outcome.error), /ownership is unknown/);
				assert.match(String(outcome.error), /Kept its name and recovery files/);
				assert.equal(outcome.value, undefined);
				assert.equal(f.panes.has("%99"), true);
				assert.equal(
					f.commands.some((args) => args[0] === "kill-pane"),
					false,
				);
				const retained = readdirSync(runtime.ownerDir).filter(
					(id) => id !== survivor.runId,
				);
				assert.equal(retained.length, 1);
				assert.ok(
					existsSync(join(runtime.ownerDir, present(retained[0]), "spec.json")),
				);
				await assert.rejects(
					runtime.spawn({ ...draft, name: "new" }, "Retry"),
					/already/,
				);
			} else if (failRegistry) {
				assert.match(String(outcome.error), /Injected registry failure/);
				assert.equal(outcome.value, undefined);
				assert.equal(f.panes.has("%99"), false);
				assert.ok(
					f.commands.some(
						(args) => args[0] === "kill-pane" && args[2] === "%99",
					),
				);
			} else {
				assert.equal(outcome.error, undefined);
				assert.equal(outcome.value?.pane.paneId, "%99");
			}
			await poll;
			assert.deepEqual(f.notifications, []);
			const count = snapshots;
			f.living.delete(survivor.pane.process.pid);
			f.panes.set(
				survivor.pane.paneId,
				dead({
					paneId: survivor.pane.paneId,
					pid: survivor.pane.process.pid,
					session: survivor.spec.launch.childSessionFile,
				}),
			);
			await runtime.tick();
			assert.ok(
				snapshots > count,
				"polling resumes after pane creation or failed launch cleanup",
			);
			assert.equal(
				f.sent.filter((message) => message.customType === "subagent_result")
					.length,
				1,
			);
			assert.match(present(f.sent[0]).content, /survivor/);
			assert.deepEqual(f.notifications, []);
		} finally {
			respawn.resolve();
			await launched;
			await poll;
			await runtime.onShutdown("new");
		}
	});

test("concurrent spawn checks tmux once and commits fresh-parent launches", async (t) => {
	const f = fixture(t);
	const prepared = f.prepare("template");
	const { childSessionFile: _child, ...draft } = prepared.spec.launch;
	rmSync(prepared.runDir, { recursive: true });
	f.panes.clear();
	const calls: string[][] = [];
	let pane = 89;
	const runtime = new Runtime(f.pi, f.ctx, {
		...f.deps,
		identity: (pid) => ({
			pid,
			start: pid === process.pid ? "owner start" : "child start",
		}),
		invocation: () => [process.execPath, "/fake/cli.js"],
		tmux: {
			...f.deps.tmux,
			run: async (args) => {
				calls.push(args);
				if (args[0] === "-V") {
					await Promise.resolve();
					return "tmux 3.4";
				}
				if (args[0] === "split-window") return `%${++pane}`;
				if (args[0] === "set-option") {
					const id = present(args[3]);
					const session = present(
						args[args.indexOf("@pi_subagent_session") + 1],
					);
					f.panes.set(id, dead({ paneId: id, pid: 900, session, dead: false }));
				}
				if (args[0] === "display-message") return "900";
				return "";
			},
		},
	});
	t.after(() => runtime.onShutdown("new"));
	await runtime.start({ reason: "new" });
	const [one, two] = await Promise.all([
		runtime.spawn({ ...draft, name: "one" }, "Task one"),
		runtime.spawn({ ...draft, name: "two" }, "Task two"),
	]);
	assert.equal(calls.filter((args) => args[0] === "-V").length, 1);
	assert.equal(one.spec.spawnerSessionFile, f.parentFile);
	assert.equal(two.spec.spawnerSessionFile, f.parentFile);
	assert.equal(existsSync(f.parentFile), false);
	assert.equal(runtime.runs.size, 2);
	assert.equal(
		f.entries.filter(
			(entry) => entry.type === "custom" && entry.customType === "subagent",
		).length,
		2,
	);
});
test("resume uses the saved launch and appends a resume record", async (t) => {
	const f = fixture(t);
	const run = f.prepare("worker-1");
	f.pi.appendEntry("subagent", {
		v: 1,
		kind: "spawn",
		runId: run.runId,
		launch: run.spec.launch,
	});
	rmSync(run.runDir, { recursive: true });
	f.panes.clear();
	const runtime = new Runtime(f.pi, f.ctx, {
		...f.deps,
		identity: (pid) => ({
			pid,
			start: pid === process.pid ? "owner start" : "child start",
		}),
		invocation: () => [process.execPath, "/fake/cli.js"],
		tmux: {
			...f.deps.tmux,
			run: async (args) => {
				if (args[0] === "-V") return "tmux 3.4";
				if (args[0] === "split-window") return "%99";
				if (args[0] === "set-option")
					f.panes.set(
						"%99",
						dead({
							paneId: "%99",
							pid: 333,
							session: run.spec.launch.childSessionFile,
							dead: false,
						}),
					);
				return args[0] === "display-message" ? "333" : "";
			},
		},
	});
	t.after(() => runtime.onShutdown("new"));
	await runtime.start({ reason: "new" });
	assert.equal(
		await runtime.message("worker-1", "Continue"),
		'Resumed subagent "worker-1" in pane %99. Its result arrives as a message.',
	);
	const resumed = runtime.runs.get("worker-1");
	assert.ok(resumed);
	assert.deepEqual(resumed.spec.launch, run.spec.launch);
	assert.equal(resumed.spec.kind, "resume");
	assert.equal(
		resumed.spec.initialPrompt,
		"Message from the parent agent:\n\nContinue",
	);
	assert.ok(
		f.entries.some(
			(entry) =>
				entry.type === "custom" &&
				(entry.data as { kind: string }).kind === "resume",
		),
	);
});
test("child resume enforces its allowlist", async (t) => {
	const f = fixture(t);
	const run = f.prepare("worker-1");
	f.pi.appendEntry("subagent", {
		v: 1,
		kind: "spawn",
		runId: run.runId,
		launch: run.spec.launch,
	});
	rmSync(run.runDir, { recursive: true });
	f.panes.clear();
	const runtime = new Runtime(f.pi, f.ctx, { ...f.deps, childSpec: run.spec });
	t.after(() => runtime.onShutdown("new"));
	await runtime.start({ reason: "new" });
	await assert.rejects(
		runtime.message("worker-1", "Continue"),
		/not in the spawn allowlist/,
	);
});
test("resume rejects missing sessions, live panes, stale qids and missing extension paths", async (t) => {
	const f = fixture(t);
	const run = f.prepare("worker-1");
	f.pi.appendEntry("subagent", {
		v: 1,
		kind: "spawn",
		runId: run.runId,
		launch: run.spec.launch,
	});
	rmSync(run.runDir, { recursive: true });
	await f.runtime.start({ reason: "new" });
	await assert.rejects(
		f.runtime.message("worker-1", "Continue", "q-11111111"),
		/has finished, so question/,
	);
	f.panes.set(
		run.pane.paneId,
		dead({ dead: false, session: run.spec.launch.childSessionFile }),
	);
	await assert.rejects(
		f.runtime.message("worker-1", "Continue"),
		/still open in pane/,
	);
	f.panes.clear();
	run.spec.launch.extensions.push(join(f.dir, "missing.ts"));
	await assert.rejects(
		f.runtime.message("worker-1", "Continue"),
		/path.*missing/,
	);
	rmSync(run.spec.launch.childSessionFile);
	await assert.rejects(
		f.runtime.message("worker-1", "Continue"),
		/session file.*missing/,
	);
});
test("uncommitted launches are skipped and disabled modes remove only subagent tools", async (t) => {
	const f = fixture(t);
	const run = f.prepare("worker-1");
	rmSync(join(run.runDir, "pane.json"));
	await f.runtime.start({ reason: "new" });
	assert.equal(f.runtime.runs.size, 0);
	const disabled = fixture(t);
	Object.assign(disabled.ctx, { mode: "rpc" });
	await disabled.runtime.start({ reason: "new" });
	assert.deepEqual(disabled.activeTools(), ["read"]);
	assert.match(present(disabled.notifications[0]), /^Subagents are off:/);
	await assert.rejects(
		disabled.runtime.message("worker-1", "Hi"),
		/Subagents are off/,
	);
});
