import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	canExit,
	type ExitState,
	installChildRole,
	preflightChild,
} from "../../src/child.ts";
import { Deliverer, type Source } from "../../src/delivery.ts";
import { processIdentity } from "../../src/process.ts";
import * as queue from "../../src/queue.ts";
import {
	type ChildEntry,
	ChildStatus,
	Fatal,
	OpenQuestion,
	type RunSpec,
	readJsonStrict,
	writeJsonAtomic,
} from "../../src/schema.ts";
import { readViewRecords } from "../../src/view-stream.ts";

function present<T>(value: T | undefined | null): T {
	assert.ok(value !== undefined && value !== null);
	return value;
}
type FixtureEntry = {
	type: string;
	customType?: string;
	data?: ChildEntry;
	details?: unknown;
	message?: {
		role: string;
		stopReason?: ExitState["stopReason"];
		content?: string;
		details?: unknown;
	};
};
type SentMessage = {
	content: string;
	details: { deliveryId: string; kind: string; qid?: string };
};

function fixture(t: TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "child-")));
	const runId = randomUUID();
	const runDir = join(root, runId);
	for (const dir of [
		runDir,
		...["inbox", "outbox", "questions"].map((name) => join(runDir, name)),
	])
		mkdirSync(dir);
	const file = join(root, "session.jsonl");
	writeFileSync(file, "header\n");
	const spec: RunSpec = {
		v: 1,
		runId,
		ownerKey: "owner",
		owner: present(processIdentity(process.pid)),
		startedAt: 1,
		kind: "spawn",
		spawnerSessionId: "parent",
		spawnerSessionFile: file,
		initialPrompt: "Do the task",
		launch: {
			name: "worker-1",
			agent: "worker",
			profile: "quick",
			cwd: root,
			session: "standalone",
			autoExit: true,
			model: { provider: "test", id: "test" },
			thinking: "off",
			systemPrompt: { mode: "append", text: "Task guidance" },
			tools: ["read", "ask_question"],
			extensions: [],
			skills: [],
			depth: 1,
			nested: null,
			childSessionFile: file,
		},
	};
	writeJsonAtomic(join(runDir, "spec.json"), spec);
	const entries: FixtureEntry[] = [];
	const sent: SentMessage[] = [];
	const notices: string[] = [];
	const statuses: string[] = [];
	let tool: ToolDefinition | undefined;
	let shutdowns = 0;
	const pi = {
		registerTool: (value: ToolDefinition) => {
			tool = value;
		},
		getActiveTools: () => spec.launch.tools,
		getThinkingLevel: () => "off",
		appendEntry: (customType: string, data: ChildEntry) =>
			entries.push({ type: "custom", customType, data }),
		sendMessage: (message: SentMessage) => sent.push(message),
	} as unknown as ExtensionAPI;
	const ctx = {
		model: { provider: "test", id: "test" },
		getSystemPrompt: () => `Subagent run ${runId}.`,
		isIdle: () => true,
		hasPendingMessages: () => false,
		getContextUsage: () => ({ tokens: 123 }),
		shutdown: () => {
			shutdowns++;
		},
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus: (_key: string, text: string) => statuses.push(text),
		},
		sessionManager: {
			getSessionFile: () => file,
			getSessionId: () => "child",
			getEntries: () => entries,
			getBranch: () => entries,
		},
	} as unknown as ExtensionContext;
	const sources: Source[] = [];
	const runtime = {
		sources,
		runs: new Map<string, unknown>(),
		deliverer: new Deliverer(
			pi,
			ctx,
			sources,
			() => false,
			true,
			() => true,
		),
	};
	let child: ReturnType<typeof installChildRole> | undefined;
	t.after(() => {
		runtime.deliverer?.shutdown();
		child?.dispose();
		rmSync(root, { recursive: true, force: true });
	});
	return {
		root,
		runId,
		runDir,
		file,
		spec,
		entries,
		sent,
		notices,
		statuses,
		pi,
		ctx,
		runtime,
		start: () => {
			child = installChildRole(pi, ctx, runtime, preflightChild(ctx, runDir));
			return child;
		},
		ask: (question: string, signal?: AbortSignal) => {
			assert.ok(tool);
			return tool.execute("call", { question }, signal, undefined, ctx);
		},
		questions: () =>
			readdirSync(join(runDir, "questions")).map((name) =>
				readJsonStrict(OpenQuestion, join(runDir, "questions", name)),
			),
		answer: (qid: string, text: string) =>
			queue.put(join(runDir, "inbox"), "inbox", {
				v: 1,
				kind: "answer",
				qid,
				text,
			}),
		outbox: () => queue.list(join(runDir, "outbox"), "outbox"),
		shutdowns: () => shutdowns,
	};
}

test("child installation rejects a raw path without preflight", (t) => {
	const f = fixture(t);
	assert.throws(() => {
		// @ts-expect-error Installation requires a child-owned preflight object.
		const child = installChildRole(f.pi, f.ctx, f.runtime, f.runDir);
		child.dispose();
	}, /Child startup must pass preflight/);
});

test("child preflight validates the spec and session before runtime startup", (t) => {
	const f = fixture(t);
	const startup = preflightChild(f.ctx, f.runDir);
	assert.deepEqual(startup.spec, f.spec);
	assert.equal(startup.onInput(), undefined);
	assert.equal(startup.onToolCall(), undefined);
	assert.equal(f.runtime.sources.length, 0);
	assert.equal(f.shutdowns(), 0);
});
for (const fault of ["spec", "session", "directory"] as const)
	test(`child preflight handles invalid ${fault} once`, (t) => {
		const f = fixture(t);
		if (fault === "spec") writeFileSync(join(f.runDir, "spec.json"), "{}");
		if (fault === "session")
			f.ctx.sessionManager.getSessionFile = () => join(f.root, "missing");
		const startup = preflightChild(
			f.ctx,
			fault === "directory" ? join(f.root, "missing") : f.runDir,
		);
		assert.equal(startup.spec, undefined);
		assert.deepEqual(startup.onInput(), { action: "handled" });
		assert.equal(startup.onToolCall()?.block, true);
		assert.equal(f.shutdowns(), 1);
		assert.equal(f.notices.length, 1);
		if (fault !== "directory") {
			const fatal = readJsonStrict(Fatal, join(f.runDir, "fatal.json"));
			startup.fail(new Error("second failure"));
			assert.deepEqual(
				readJsonStrict(Fatal, join(f.runDir, "fatal.json")),
				fatal,
			);
			assert.equal(f.shutdowns(), 1);
		}
	});

test("answers simultaneous questions by id and keeps delivery files until durable", async (t) => {
	const f = fixture(t);
	f.start();
	const first = f.ask("Which file?");
	const second = f.ask("Which model?");
	const questions = f.questions();
	assert.equal(questions.length, 2);
	assert.equal(f.outbox().length, 2);
	const a = present(questions.find((q) => q.text === "Which file?"));
	const b = present(questions.find((q) => q.text === "Which model?"));
	const seq = f.answer(b.qid, "deep");
	f.runtime.deliverer.pump();
	assert.equal(f.questions().length, 1);
	f.answer(a.qid, "README.md");
	f.runtime.deliverer.pump();
	assert.deepEqual((await first).content, [
		{ type: "text", text: "README.md" },
	]);
	const result = await second;
	assert.deepEqual(result.content, [{ type: "text", text: "deep" }]);
	assert.deepEqual(result.details, {
		deliveryId: queue.itemId(f.runId, "inbox", seq),
		qid: b.qid,
	});
	assert.equal(queue.count(join(f.runDir, "inbox")), 2);
	f.entries.push({
		type: "message",
		message: { role: "toolResult", details: result.details },
	});
	f.runtime.deliverer.reconcile();
	assert.equal(queue.count(join(f.runDir, "inbox")), 1);
});
test("answer then abort does not withdraw", async (t) => {
	const f = fixture(t);
	f.start();
	const controller = new AbortController();
	const pending = f.ask("Which file?", controller.signal);
	f.answer(present(f.questions()[0]).qid, "README.md");
	f.runtime.deliverer.pump();
	await pending;
	controller.abort();
	assert.equal(f.questions().length, 0);
	assert.equal(f.outbox().filter((q) => q.item.kind === "withdrawn").length, 0);
});
test("abort then answer withdraws once and sends a normal message", async (t) => {
	const f = fixture(t);
	f.start();
	const controller = new AbortController();
	const pending = f.ask("Which file?", controller.signal);
	const qid = present(f.questions()[0]).qid;
	const rejection = assert.rejects(
		pending,
		new RegExp(`Question ${qid} was withdrawn`),
	);
	controller.abort();
	controller.abort();
	await rejection;
	f.answer(qid, "README.md");
	f.runtime.deliverer.onAgentStart();
	f.runtime.deliverer.onAgentSettled();
	f.runtime.deliverer.pump();
	assert.equal(f.outbox().filter((q) => q.item.kind === "withdrawn").length, 1);
	assert.equal(
		present(f.sent[0]).content,
		`Answer from the parent agent to question ${qid}, which you withdrew:\n\nREADME.md`,
	);
	assert.deepEqual(present(f.sent[0]).details.kind, "answer");
});
test("dispose rejects all waiters and removes their files", async (t) => {
	const f = fixture(t);
	const child = f.start();
	const one = f.ask("First?");
	const two = f.ask("Second?");
	const rejected = [
		assert.rejects(one, /runtime stopped/),
		assert.rejects(two, /runtime stopped/),
	];
	child.dispose();
	await Promise.all(rejected);
	assert.equal(f.questions().length, 0);
	assert.equal(f.outbox().length, 2);
});
test("already aborted questions have no file or outbox effects", async (t) => {
	const f = fixture(t);
	f.start();
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		f.ask("Question?", controller.signal),
		/cancelled before it was sent/,
	);
	assert.equal(f.questions().length, 0);
	assert.equal(f.outbox().length, 0);
});

for (const failure of ["tool", "model", "thinking", "prompt"] as const)
	test(`self-check blocks input and tools on wrong ${failure}`, async (t) => {
		const f = fixture(t);
		const messages = {
			tool: 'Tool "read" is not active in this subagent.',
			model:
				"This subagent runs model test/wrong, but its profile chose test/test.",
			thinking:
				"This subagent runs thinking level high, but its profile chose off.",
			prompt: "The system prompt file of this subagent was not read.",
		};
		if (failure === "tool") f.pi.getActiveTools = () => ["ask_question"];
		if (failure === "model")
			Object.assign(present(f.ctx.model), { id: "wrong" });
		if (failure === "thinking") f.pi.getThinkingLevel = () => "high";
		if (failure === "prompt")
			f.ctx.getSystemPrompt = () => "/missing/prompt.md";
		const child = f.start();
		assert.deepEqual(readJsonStrict(Fatal, join(f.runDir, "fatal.json")), {
			v: 1,
			message: messages[failure],
		});
		assert.deepEqual(
			child.onInput({ source: "interactive", text: f.spec.initialPrompt }),
			{ action: "handled" },
		);
		assert.deepEqual(child.onToolCall(), {
			block: true,
			reason: messages[failure],
		});
		assert.deepEqual(f.notices, [messages[failure]]);
		assert.equal(f.shutdowns(), 1);
		await assert.rejects(f.ask("Can I run?"), { message: messages[failure] });
	});
for (const failure of ["runId", "session", "schema"] as const)
	test(`startup records fatal ${failure} mismatch`, (t) => {
		const f = fixture(t);
		if (failure === "runId") f.spec.runId = randomUUID();
		if (failure === "session")
			f.spec.launch.childSessionFile = join(f.root, "other.jsonl");
		writeJsonAtomic(
			join(f.runDir, "spec.json"),
			failure === "schema" ? { ...f.spec, extra: true } : f.spec,
		);
		const child = f.start();
		assert.ok(existsSync(join(f.runDir, "fatal.json")));
		assert.equal(f.shutdowns(), 1);
		assert.equal(child.onToolCall()?.block, true);
	});
test("startup appends a run marker once and withdraws stale questions", (t) => {
	const f = fixture(t);
	const qid = "q-12345678";
	writeJsonAtomic(join(f.runDir, "questions", `${qid}.json`), {
		v: 1,
		qid,
		text: "Old?",
		toolCallId: "old",
		askedAt: 1,
	});
	f.start().dispose();
	f.start();
	assert.equal(f.entries.filter((e) => e.data?.kind === "run").length, 1);
	assert.equal(f.questions().length, 0);
	assert.deepEqual(
		f.outbox().map((q) => q.item),
		[{ v: 1, kind: "withdrawn", qid }],
	);
});
test("argv input leaves auto-exit on, later human input persists takeover once", (t) => {
	const f = fixture(t);
	const child = f.start();
	assert.equal(
		readJsonStrict(ChildStatus, join(f.runDir, "status.json")).state,
		"starting",
	);
	child.onInput({ source: "interactive", text: f.spec.initialPrompt });
	assert.equal(f.statuses.at(-1), "subagent worker-1 · auto-exit on");
	child.onInput({ source: "extension", text: "parent" });
	child.onInput({ source: "interactive", text: "I take over" });
	child.onInput({ source: "interactive", text: "Again" });
	assert.equal(f.entries.filter((e) => e.data?.kind === "human").length, 1);
	assert.equal(f.statuses.at(-1), "subagent worker-1 · auto-exit off");
	assert.equal(
		readJsonStrict(ChildStatus, join(f.runDir, "status.json")).human,
		true,
	);
	child.dispose();
	f.start();
	assert.equal(f.statuses.at(-1), "subagent worker-1 · auto-exit off");
});
test("wrong first input reports takeover and restored user messages count as initial input", (t) => {
	const f = fixture(t);
	let child = f.start();
	child.onInput({ source: "interactive", text: "Wrong" });
	assert.deepEqual(f.notices, [
		"The first input of this subagent was not its task. Auto-exit is off.",
	]);
	child.dispose();
	f.entries.splice(1);
	f.entries.push({
		type: "message",
		message: { role: "user", content: "task" },
	});
	child = f.start();
	child.onInput({ source: "interactive", text: f.spec.initialPrompt });
	assert.equal(f.entries.filter((e) => e.data?.kind === "human").length, 1);
});
test("guards cancel switch and fork, and tree adds a leaf marker", (t) => {
	const f = fixture(t);
	const child = f.start();
	assert.deepEqual(child.onBeforeSwitch(), { cancel: true });
	assert.deepEqual(child.onBeforeFork(), { cancel: true });
	child.onTree();
	assert.deepEqual(present(f.entries.at(-1)).data, {
		v: 1,
		kind: "leaf",
		runId: f.runId,
	});
	assert.deepEqual(
		f.notices,
		Array(2).fill(
			"This pane is a subagent. Pi cannot switch or fork its session.",
		),
	);
});
test("status tracks working, question wait, settled and context usage", async (t) => {
	const f = fixture(t);
	const child = f.start();
	const status = () =>
		readJsonStrict(ChildStatus, join(f.runDir, "status.json"));
	child.onAgentStart();
	assert.equal(status().state, "working");
	const pending = f.ask("Question?");
	assert.equal(status().state, "waiting");
	assert.equal(status().question, true);
	f.answer(present(f.questions()[0]).qid, "Yes");
	f.runtime.deliverer.pump();
	await pending;
	assert.equal(status().state, "working");
	child.onMessageEnd({ message: { role: "assistant" } });
	assert.equal(status().contextTokens, 123);
	f.ctx.getContextUsage = () => undefined;
	child.onMessageEnd({ message: { role: "assistant" } });
	assert.equal(status().contextTokens, null);
	child.onAgentSettled();
	assert.equal(status().state, "waiting");
});
test("child writes ordered live messages and resumes view sequence after reload", (t) => {
	const f = fixture(t);
	let child = f.start();
	child.onMessageStart({
		message: { role: "assistant", content: [{ type: "text", text: "" }] },
	});
	child.onMessageUpdate({
		message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
	});
	child.onToolStart({
		toolCallId: "call-1",
		toolName: "read",
		args: { path: "a" },
	});
	child.onToolEnd({
		toolCallId: "call-1",
		toolName: "read",
		result: { content: "done" },
		isError: false,
	});
	child.onMessageEnd({
		message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
	});
	assert.deepEqual(
		readViewRecords(f.runDir, 0, true, f.runId).map((row) => row.seq),
		[1, 2, 3, 4, 5],
	);
	child.dispose();
	child = f.start();
	child.onMessageStart({ message: { role: "user", content: "More" } });
	assert.equal(
		readViewRecords(f.runDir, 5, true, f.runId)[0]?.messageOrdinal,
		2,
	);
});
test("inbox timer uses the task gate and starts at 250 ms", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const f = fixture(t);
	f.start();
	queue.put(join(f.runDir, "inbox"), "inbox", {
		v: 1,
		kind: "message",
		text: "Parent",
	});
	t.mock.timers.tick(250);
	assert.equal(f.sent.length, 0);
	f.runtime.deliverer.onAgentStart();
	f.runtime.deliverer.onAgentSettled();
	t.mock.timers.tick(249);
	assert.equal(f.sent.length, 0);
	t.mock.timers.tick(1);
	assert.equal(
		present(f.sent[0]).content,
		"Message from the parent agent:\n\nParent",
	);
});
test("owner death at 2000 ms stops timers without shutdown or inbox delivery", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const f = fixture(t);
	f.spec.owner = { pid: process.pid, start: "not-the-owner-start" };
	writeJsonAtomic(join(f.runDir, "spec.json"), f.spec);
	f.start();
	t.mock.timers.tick(1999);
	assert.equal(f.notices.length, 0);
	t.mock.timers.tick(1);
	assert.deepEqual(f.notices, [
		`The parent Pi process ended without a quit. Continue work in this pane. Parent messaging and auto-exit are off. Session switching and forking remain blocked. Session: ${f.file}`,
	]);
	assert.equal(f.shutdowns(), 0);
	assert.equal(f.statuses.at(-1), "subagent worker-1 · auto-exit off");
	queue.put(join(f.runDir, "inbox"), "inbox", {
		v: 1,
		kind: "message",
		text: "Late",
	});
	f.runtime.deliverer.onAgentStart();
	f.runtime.deliverer.onAgentSettled();
	t.mock.timers.tick(5000);
	assert.equal(f.sent.length, 0);
	assert.equal(f.notices.length, 1);
});
for (const timer of ["pump", "owner"] as const)
	test(`${timer} timer failure writes the exact fatal and stops both timers`, (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const f = fixture(t);
		const child = f.start();
		const notify = t.mock.method(f.ctx.ui, "notify");
		const pump = t.mock.method(f.runtime.deliverer, "pump");
		let message: string;
		if (timer === "pump") {
			const corrupt = join(f.runDir, "inbox", "unexpected.json");
			writeFileSync(corrupt, "{}");
			message = `Unexpected file ${corrupt} in a subagent directory.`;
			f.runtime.deliverer.onAgentStart();
		} else {
			const moved = join(f.root, "moved");
			renameSync(f.runDir, moved);
			symlinkSync(moved, f.runDir);
			message = `The subagent run directory changed: ${f.runDir}.`;
		}
		assert.doesNotThrow(() =>
			t.mock.timers.tick(timer === "pump" ? 250 : 2000),
		);
		assert.deepEqual(readJsonStrict(Fatal, join(f.runDir, "fatal.json")), {
			v: 1,
			message,
		});
		assert.deepEqual(
			notify.mock.calls.map((call) => call.arguments),
			[[message, "error"]],
		);
		assert.equal(f.shutdowns(), 1);
		assert.deepEqual(
			child.onInput({ source: "interactive", text: "Continue" }),
			{
				action: "handled",
			},
		);
		assert.deepEqual(child.onToolCall(), { block: true, reason: message });
		assert.deepEqual(present(f.runtime.sources[0]).items(), []);
		const pumps = pump.mock.callCount();
		t.mock.timers.tick(6000);
		assert.equal(pump.mock.callCount(), pumps);
		assert.equal(f.shutdowns(), 1);
		assert.deepEqual(f.notices, [message]);
	});

for (const failure of ["missing run directory", "blocked fatal file"] as const)
	test(`${failure} reports both errors and shuts down without escaping the timer`, (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const f = fixture(t);
		const child = f.start();
		const notify = t.mock.method(f.ctx.ui, "notify");
		const pump =
			failure === "missing run directory"
				? t.mock.method(f.runtime.deliverer, "pump", () => {})
				: t.mock.method(f.runtime.deliverer, "pump");
		if (failure === "missing run directory")
			rmSync(f.runDir, { recursive: true });
		else {
			mkdirSync(join(f.runDir, "fatal.json"));
			writeFileSync(join(f.runDir, "inbox", "unexpected.json"), "{}");
		}
		assert.doesNotThrow(() => t.mock.timers.tick(2000));
		assert.equal(f.shutdowns(), 1);
		assert.equal(f.notices.length, 2);
		assert.match(
			present(f.notices[0]),
			failure === "missing run directory"
				? /ENOENT/
				: /Unexpected file .*unexpected.json/,
		);
		assert.match(
			present(f.notices[1]),
			/Could not write the subagent fatal record: /,
		);
		assert.match(
			present(f.notices[1]),
			failure === "missing run directory" ? /ENOENT/ : /EISDIR/,
		);
		assert.deepEqual(
			notify.mock.calls.map((call) => call.arguments[1]),
			["error", "error"],
		);
		assert.equal(child.onToolCall()?.reason, f.notices[0]);
		const pumps = pump.mock.callCount();
		assert.doesNotThrow(() => t.mock.timers.tick(6000));
		assert.equal(pump.mock.callCount(), pumps);
		assert.equal(f.shutdowns(), 1);
		assert.equal(f.notices.length, 2);
	});

test("a failed shutdown request still throws after a timer failure stops both timers", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const f = fixture(t);
	f.start();
	const pump = t.mock.method(f.runtime.deliverer, "pump");
	f.ctx.shutdown = () => {
		throw new Error("Shutdown request failed.");
	};
	writeFileSync(join(f.runDir, "inbox", "unexpected.json"), "{}");
	assert.throws(() => t.mock.timers.tick(250), {
		message: "Shutdown request failed.",
	});
	const pumps = pump.mock.callCount();
	assert.doesNotThrow(() => t.mock.timers.tick(6000));
	assert.equal(pump.mock.callCount(), pumps);
});

function exitState(): ExitState {
	return {
		autoExit: true,
		human: false,
		orphaned: false,
		exiting: false,
		fatal: false,
		stopReason: "stop",
		inboxCount: 0,
		offeredCount: 0,
		nestedRunCount: 0,
		waiterCount: 0,
		pendingMessages: false,
	};
}
for (const stopReason of [
	"stop",
	"length",
	"error",
	"aborted",
	"toolUse",
	"pending",
	undefined,
] as const)
	test(`exit truth table for ${stopReason}`, () => {
		const state = { ...exitState(), stopReason };
		const eligible =
			stopReason === "stop" ||
			stopReason === "length" ||
			stopReason === "error";
		assert.equal(canExit(state), eligible);
		for (const flag of [
			"human",
			"orphaned",
			"exiting",
			"fatal",
			"pendingMessages",
		] as const)
			assert.equal(canExit({ ...state, [flag]: true }), false, flag);
		for (const count of [
			"inboxCount",
			"offeredCount",
			"nestedRunCount",
			"waiterCount",
		] as const)
			assert.equal(canExit({ ...state, [count]: 1 }), false, count);
		assert.equal(canExit({ ...state, autoExit: false }), false);
	});
test("exit stops timers before shutdown and preserves an item that arrives after the decision", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const f = fixture(t);
	f.spec.owner = { pid: process.pid, start: "not-the-owner-start" };
	writeJsonAtomic(join(f.runDir, "spec.json"), f.spec);
	const child = f.start();
	const pump = t.mock.method(f.runtime.deliverer, "pump");
	f.entries.push({
		type: "message",
		message: { role: "assistant", stopReason: "stop" },
	});
	f.ctx.shutdown = () => {
		queue.put(join(f.runDir, "inbox"), "inbox", {
			v: 1,
			kind: "message",
			text: "Too late",
		});
		t.mock.timers.tick(2000);
		assert.equal(pump.mock.callCount(), 0);
		assert.deepEqual(f.notices, []);
	};
	f.runtime.deliverer.onAgentStart();
	f.runtime.deliverer.onAgentSettled();
	child.onAgentSettled();
	f.runtime.deliverer.pump();
	assert.equal(queue.count(join(f.runDir, "inbox")), 1);
	assert.equal(f.sent.length, 0);
});
test("settled exit waits for nested results and the actual Deliverer offers", (t) => {
	const f = fixture(t);
	const child = f.start();
	f.entries.push({
		type: "message",
		message: { role: "assistant", stopReason: "error" },
	});
	f.runtime.runs.set("nested", {});
	child.onAgentSettled();
	assert.equal(f.shutdowns(), 0);
	f.runtime.runs.clear();
	const items = [{ id: "nested:result" }];
	f.runtime.sources.push({
		key: "nested",
		items: () => items,
		build: (item) => ({
			kind: "message",
			message: {
				customType: "subagent_result",
				display: true,
				content: "Result",
				details: { deliveryId: item.id },
			},
			trigger: true,
		}),
		confirm: () => {
			items.splice(0);
		},
	});
	f.runtime.deliverer.onAgentStart();
	f.runtime.deliverer.onAgentSettled();
	f.runtime.deliverer.pump();
	assert.equal(f.runtime.deliverer.offeredCount, 1);
	child.onAgentSettled();
	assert.equal(f.shutdowns(), 0);
	f.entries.push({
		type: "custom_message",
		details: { deliveryId: "nested:result" },
	});
	f.runtime.deliverer.onAgentSettled();
	child.onAgentSettled();
	assert.equal(f.shutdowns(), 1);
});
test("settled exit cannot pass an open question or pending Pi message", async (t) => {
	const f = fixture(t);
	const child = f.start();
	f.entries.push({
		type: "message",
		message: { role: "assistant", stopReason: "length" },
	});
	const controller = new AbortController();
	const pending = f.ask("Still here?", controller.signal);
	child.onAgentSettled();
	assert.equal(f.shutdowns(), 0);
	const rejected = assert.rejects(pending, /withdrawn/);
	controller.abort();
	await rejected;
	f.ctx.hasPendingMessages = () => true;
	child.onAgentSettled();
	assert.equal(f.shutdowns(), 0);
	f.ctx.hasPendingMessages = () => false;
	child.onAgentSettled();
	assert.equal(f.shutdowns(), 0);
	child.onAgentStart();
	child.onAgentSettled();
	assert.equal(f.shutdowns(), 1);
});
test("exit uses only assistant messages after the current run marker", (t) => {
	const f = fixture(t);
	f.entries.push({
		type: "message",
		message: { role: "assistant", stopReason: "stop" },
	});
	const child = f.start();
	child.onAgentSettled();
	assert.equal(f.shutdowns(), 0);
});
test("startup resolves run and session symlinks before comparing paths", (t) => {
	const f = fixture(t);
	const runLink = join(f.root, "run-link");
	const fileLink = join(f.root, "session-link");
	symlinkSync(f.runDir, runLink);
	symlinkSync(f.file, fileLink);
	f.ctx.sessionManager.getSessionFile = () => fileLink;
	const child = installChildRole(
		f.pi,
		f.ctx,
		f.runtime,
		preflightChild(f.ctx, runLink),
	);
	try {
		assert.equal(f.shutdowns(), 0);
		assert.equal(f.entries.filter((e) => e.data?.kind === "run").length, 1);
	} finally {
		child.dispose();
	}
});
test("a missing run path blocks input and tools and shuts down", (t) => {
	const f = fixture(t);
	const child = installChildRole(
		f.pi,
		f.ctx,
		f.runtime,
		preflightChild(f.ctx, join(f.root, "missing")),
	);
	assert.equal(f.shutdowns(), 1);
	assert.match(present(f.notices[0]), /ENOENT/);
	assert.deepEqual(child.onInput({ source: "interactive", text: "Task" }), {
		action: "handled",
	});
	assert.equal(child.onToolCall()?.block, true);
	child.dispose();
});
test("an offered answer with no durable tool result returns as a normal inbox message", async (t) => {
	const f = fixture(t);
	f.start();
	const pending = f.ask("Question?");
	const qid = present(f.questions()[0]).qid;
	f.answer(qid, "Answer");
	f.runtime.deliverer.onAgentStart();
	f.runtime.deliverer.pump();
	await pending;
	assert.equal(f.runtime.deliverer.offeredCount, 1);
	assert.equal(f.sent.length, 0);
	f.runtime.deliverer.onAgentSettled();
	f.runtime.deliverer.pump();
	assert.equal(
		present(f.sent[0]).content,
		`Answer from the parent agent to question ${qid}, which you withdrew:\n\nAnswer`,
	);
	assert.equal(queue.count(join(f.runDir, "inbox")), 1);
});
test("question state reaches disk before a failed outbox write", async (t) => {
	const f = fixture(t);
	f.start();
	rmSync(join(f.runDir, "outbox"), { recursive: true });
	await assert.rejects(f.ask("Question?"), /ENOENT/);
	assert.equal(f.questions().length, 1);
});
test("a captured answer rejects a second close and removes its abort listener", async (t) => {
	const f = fixture(t);
	f.start();
	const controller = new AbortController();
	const remove = t.mock.method(controller.signal, "removeEventListener");
	const pending = f.ask("Question?", controller.signal);
	f.answer(present(f.questions()[0]).qid, "Answer");
	const source = present(f.runtime.sources[0]);
	const item = present(source.items()[0]);
	const outgoing = source.build(item);
	assert.ok(outgoing !== "drop" && outgoing.kind === "answer");
	outgoing.resolve(item.id, outgoing.text);
	await pending;
	assert.equal(remove.mock.callCount(), 1);
	assert.throws(
		() => outgoing.resolve(item.id, outgoing.text),
		/already answered/,
	);
});
