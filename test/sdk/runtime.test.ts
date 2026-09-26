import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as nextImmediate } from "node:timers/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { checkPiVersion, createSubagentsExtension } from "../../src/index.ts";
import { processIdentity } from "../../src/process.ts";
import * as queue from "../../src/queue.ts";
import {
	Fatal,
	OpenQuestion,
	readJsonStrict,
	writeJsonAtomic,
} from "../../src/schema.ts";
import { createRuntimeHarness, until } from "./harness.ts";

type Harness = Awaited<ReturnType<typeof createRuntimeHarness>>;
function inbox(h: Harness, text: string) {
	return queue.put(join(h.runDir, "inbox"), "inbox", {
		v: 1,
		kind: "message",
		text,
	});
}
function questions(h: Harness) {
	return readdirSync(join(h.runDir, "questions")).map((name) =>
		readJsonStrict(OpenQuestion, join(h.runDir, "questions", name)),
	);
}
function answer(h: Harness, qid: string, text: string) {
	return queue.put(join(h.runDir, "inbox"), "inbox", {
		v: 1,
		kind: "answer",
		qid,
		text,
	});
}
async function idle(h: Harness, count: number) {
	await until(
		() =>
			h.events.filter((event) => event === "agent_settled").length >= count &&
			h.ctx.isIdle(),
		"The child did not settle.",
	);
	h.assertNoErrors();
}
const prepareRun: NonNullable<
	Parameters<typeof createRuntimeHarness>[1]
>["prepare"] = ({ spec, runDir, manager, tmux }) => {
	for (const dir of ["inbox", "outbox", "questions"])
		mkdirSync(join(runDir, dir), { recursive: true });
	writeJsonAtomic(join(runDir, "spec.json"), spec);
	writeJsonAtomic(join(runDir, "pane.json"), {
		v: 1,
		paneId: "%2",
		process: { pid: 999999, start: "fixture" },
		server: structuredClone(tmux.server),
	});
	const child = SessionManager.open(spec.launch.childSessionFile);
	child.appendCustomEntry("subagent_child", {
		v: 1,
		kind: "run",
		runId: spec.runId,
		name: spec.launch.name,
		sessionId: child.getSessionId(),
	});
	child.appendMessage(fauxAssistantMessage("The child result."));
	manager.appendCustomEntry("subagent", {
		v: 1,
		kind: "spawn",
		runId: spec.runId,
		launch: spec.launch,
	});
	tmux.panes.set("%2", {
		paneId: "%2",
		pid: 999999,
		dead: false,
		status: null,
		signal: null,
		session: spec.launch.childSessionFile,
	});
};

for (const identity of [
	"matching",
	"pid",
	"session",
	"server",
	"unknown",
] as const)
	test(`SDK dead-owner recovery checks ${identity} identity before cleanup`, async (t) => {
		let retained = "";
		const h = await createRuntimeHarness(t, {
			identity: (pid) => (pid === 999998 ? null : processIdentity(pid)),
			prepare: (context) => {
				prepareRun(context);
				const ownerDir = join(
					context.runDir,
					"..",
					"..",
					`999998-${"a".repeat(64)}`,
				);
				mkdirSync(ownerDir, { recursive: true });
				retained = join(ownerDir, context.spec.runId);
				renameSync(context.runDir, retained);
				const pane = context.tmux.panes.get("%2");
				assert.ok(pane);
				if (identity === "pid") pane.pid = 123456;
				if (identity === "session") pane.session = "/unrelated-session";
				if (identity === "server")
					context.tmux.server.process.start = "restarted server";
				if (identity === "unknown")
					context.tmux.serverIdentity = async () => {
						throw new Error("server identity unavailable");
					};
			},
		});
		const matching = identity === "matching";
		assert.equal(
			h.tmux.commands.some((args) => args[0] === "kill-pane"),
			matching,
		);
		assert.equal(existsSync(join(retained, "pane.json")), !matching);
		assert.equal(existsSync(join(retained, "spec.json")), !matching);
		assert.equal(existsSync(h.spec.launch.childSessionFile), true);
		if (!matching)
			assert.ok(
				h.notices.some((notice) => notice.message.includes("identity")),
			);
	});

test("factory rejects unsupported Pi versions", () => {
	for (const version of ["1.87.1", "0.86.9", "0.88.0"])
		assert.throws(() => checkPiVersion(version), {
			message: `pi-interactive-subagents 4 needs Pi 0.87. This Pi is ${version}. Install Pi 0.87, or update pi-interactive-subagents.`,
		});
	checkPiVersion("0.87.1");
	assert.equal(typeof createSubagentsExtension, "function");
});
for (const mode of ["print", "json", "rpc"] as const)
	test(`${mode} parent disables spawn tools with one info notice`, async (t) => {
		const h = await createRuntimeHarness(t, { mode });
		assert.deepEqual(h.session.getActiveToolNames(), []);
		assert.deepEqual(h.notices, [
			{
				message: "Subagents are off: this mode is not the interactive Pi TUI.",
				type: "info",
			},
		]);
	});
test("RPC child with a valid run spec enables its subagent role", async (t) => {
	const h = await createRuntimeHarness(t, {
		child: true,
		mode: "rpc",
		disabled: "tmux",
	});
	assert.equal(
		h.notices.some((notice) => notice.message.startsWith("Subagents are off")),
		false,
	);
	assert.ok(h.session.getActiveToolNames().includes("ask_question"));
});
for (const disabled of ["tmux", "session"] as const)
	test(`TUI parent without ${disabled} disables spawn tools`, async (t) => {
		const h = await createRuntimeHarness(t, { disabled });
		assert.deepEqual(h.session.getActiveToolNames(), []);
		assert.equal(h.notices.length, 1);
		assert.equal(h.notices[0]?.type, "info");
	});
test("valid TUI parent registers tools, command, renderers and one widget before its file exists", async (t) => {
	const h = await createRuntimeHarness(t);
	assert.deepEqual(h.session.getActiveToolNames().toSorted(), [
		"subagent",
		"subagent_message",
		"subagents_list",
	]);
	assert.ok(h.pi.getCommands().some((command) => command.name === "subagent"));
	assert.equal(h.renderers.size, 6);
	assert.equal(h.widgets.length, 1);
	assert.match(h.session.systemPrompt, /Pick a profile for every subagent/);
	assert.equal(h.notices.length, 0);
});

test("three idle inbox items start one run and use its boundary in order", {
	timeout: 20_000,
}, async (t) => {
	const h = await createRuntimeHarness(t, { child: true });
	h.faux.setResponses([fauxAssistantMessage("Task complete.")]);
	await h.session.prompt(h.spec.initialPrompt);
	const requests: string[] = [];
	h.faux.setResponses([
		(context) => {
			requests.push(JSON.stringify(context));
			return fauxAssistantMessage("First item.");
		},
		(context) => {
			requests.push(JSON.stringify(context));
			return fauxAssistantMessage("Other items.");
		},
	]);
	for (const text of ["Inbox alpha", "Inbox beta", "Inbox gamma"])
		inbox(h, text);
	await idle(h, 2);
	assert.equal(h.events.filter((event) => event === "agent_start").length, 2);
	assert.equal(h.messages("subagent_parent_message").length, 3);
	assert.equal(queue.count(join(h.runDir, "inbox")), 0);
	assert.equal(requests.length, 2);
	assert.ok(requests[0]?.includes("Inbox alpha"));
	assert.ok(!requests[0]?.includes("Inbox beta"));
	assert.ok(
		requests[1] &&
			requests[1].indexOf("Inbox beta") < requests[1].indexOf("Inbox gamma"),
	);
	assert.deepEqual(h.session.getSteeringMessages(), []);
	assert.deepEqual(h.session.getFollowUpMessages(), []);
});

for (const action of ["stream", "clearQueue", "abort", "compact"] as const)
	test(`${action} keeps ready items exactly once`, {
		timeout: 20_000,
	}, async (t) => {
		const h = await createRuntimeHarness(t, { child: true, autoExit: true });
		if (action === "compact") {
			h.runtime.services.settingsManager.applyOverrides({
				compaction: { keepRecentTokens: 1, reserveTokens: 128 },
			});
			h.faux.setResponses([
				fauxAssistantMessage("History. ".repeat(100)),
				fauxAssistantMessage("History two. ".repeat(100)),
			]);
			await h.session.prompt(h.spec.initialPrompt.repeat(100));
			await h.session.prompt("More history. ".repeat(100));
		}
		const before = h.events.filter((event) => event === "agent_settled").length;
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		h.faux.setResponses([
			async (_context, options) => {
				options?.signal?.addEventListener("abort", () => release.resolve(), {
					once: true,
				});
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("Streaming response.");
			},
			fauxAssistantMessage(
				action === "compact" ? "Summary." : "Read messages.",
			),
			fauxAssistantMessage("Later item."),
		]);
		const prompt = h.session.prompt(
			action === "compact" ? "Another request" : h.spec.initialPrompt,
		);
		await started.promise;
		inbox(h, "While streaming alpha");
		inbox(h, "While streaming beta");
		if (action === "clearQueue") h.session.clearQueue();
		assert.equal(h.messages("subagent_parent_message").length, 0);
		if (action === "abort") await h.session.abort();
		else if (action === "compact") await h.session.compact();
		else release.resolve();
		await prompt;
		await until(
			() => h.messages("subagent_parent_message").length === 2,
			"Ready items were not delivered.",
		);
		await idle(h, before + 1);
		await until(
			() => queue.count(join(h.runDir, "inbox")) === 0,
			"The delivered files were not confirmed.",
		);
		assert.deepEqual(h.session.getSteeringMessages(), []);
		assert.deepEqual(h.session.getFollowUpMessages(), []);
		if (action === "abort") {
			assert.equal(h.shutdowns, 0);
			assert.equal(
				h.events.filter((event) => event === "agent_start").length,
				1,
			);
			inbox(h, "Later wake");
			await idle(h, 2);
			assert.equal(
				h.events.filter((event) => event === "agent_start").length,
				2,
			);
			assert.equal(h.messages("subagent_parent_message").length, 3);
		}
		if (action === "stream" || action === "clearQueue")
			assert.equal(h.shutdowns, 1);
	});

for (const initial of [true, false])
	test(`${initial ? "argv task gate" : "prompt preflight"} blocks the inbox until agent_start`, {
		timeout: 20_000,
	}, async (t) => {
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let hold = initial;
		const h = await createRuntimeHarness(t, {
			child: true,
			extension: (pi) => {
				pi.on("before_agent_start", async () => {
					if (hold) {
						reached.resolve();
						await release.promise;
					}
				});
			},
		});
		if (!initial) {
			h.faux.setResponses([fauxAssistantMessage("Initial task.")]);
			await h.session.prompt(h.spec.initialPrompt);
			hold = true;
		}
		inbox(h, "Waiting inbox message");
		const requests: string[] = [];
		h.faux.setResponses([
			(context) => {
				requests.push(JSON.stringify(context));
				return fauxAssistantMessage("Task first.");
			},
			(context) => {
				requests.push(JSON.stringify(context));
				return fauxAssistantMessage("Inbox second.");
			},
		]);
		const prompt = h.session.prompt(
			initial ? h.spec.initialPrompt : "A human prompt",
		);
		await reached.promise;
		// The child pump runs every 250 ms. Its status exposes the guard after 2 s.
		await until(
			() =>
				h.widgets.some(
					(widget) =>
						typeof widget === "function" &&
						widget(
							{ requestRender() {} },
							{ fg: (_color: string, text: string) => text },
						)
							.render(100)
							.includes("waiting for your prompt to start"),
				),
			"The prompt guard was not rendered.",
		);
		assert.equal(requests.length, 0);
		assert.equal(h.messages("subagent_parent_message").length, 0);
		release.resolve();
		await prompt;
		assert.ok(!requests[0]?.includes("Waiting inbox message"));
		assert.ok(requests[1]?.includes("Waiting inbox message"));
		assert.equal(h.messages("subagent_parent_message").length, 1);
	});

for (const fault of [
	"spec",
	"session",
	"tool",
	"model",
	"thinking",
	"prompt",
] as const)
	test(`child ${fault} failure writes fatal once and blocks input and tools`, async (t) => {
		const h = await createRuntimeHarness(t, { child: true, fault });
		const fatalFile = join(h.runDir, "fatal.json");
		assert.ok(readJsonStrict(Fatal, fatalFile).message);
		const fatal = readFileSync(fatalFile, "utf8");
		assert.equal(h.shutdowns, 1);
		assert.equal(
			h.notices.filter((notice) => notice.type === "error").length,
			1,
		);
		await h.session.prompt(h.spec.initialPrompt);
		assert.equal(h.faux.state.callCount, 0);
		const result = await h.session.extensionRunner.emitToolCall({
			type: "tool_call",
			toolCallId: "test",
			toolName: "ask_question",
			input: { question: "Blocked?" },
		});
		assert.equal(result?.block, true);
		assert.equal(readFileSync(fatalFile, "utf8"), fatal);
		assert.equal(h.shutdowns, 1);
		if (fault === "spec" || fault === "session")
			assert.equal(h.widgets.length, 0);
	});

test("child inbox timer failure blocks SDK input and tools with the original error", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const h = await createRuntimeHarness(t, { child: true });
	const corrupt = join(h.runDir, "inbox", "unexpected.json");
	writeFileSync(corrupt, "{}");
	const message = `Unexpected file ${corrupt} in a subagent directory.`;
	assert.doesNotThrow(() => t.mock.timers.tick(250));
	assert.deepEqual(readJsonStrict(Fatal, join(h.runDir, "fatal.json")), {
		v: 1,
		message,
	});
	assert.deepEqual(h.notices, [{ message, type: "error" }]);
	assert.equal(h.shutdowns, 1);
	await h.session.prompt("Continue after failure");
	assert.equal(h.faux.state.callCount, 0);
	assert.deepEqual(
		await h.session.extensionRunner.emitToolCall({
			type: "tool_call",
			toolCallId: "blocked",
			toolName: "ask_question",
			input: { question: "Continue?" },
		}),
		{ block: true, reason: message },
	);
	t.mock.timers.tick(6000);
	assert.equal(h.shutdowns, 1);
	assert.deepEqual(h.notices, [{ message, type: "error" }]);
	h.assertNoErrors();
});

for (const fault of ["directory", "spec", "session"] as const)
	test(`invalid child ${fault} cannot construct or start the parent role`, async (t) => {
		let parentIdentityCalls = 0;
		const h = await createRuntimeHarness(t, {
			child: true,
			fault,
			identity: () => {
				parentIdentityCalls++;
				throw new Error("Parent startup must not run.");
			},
		});
		assert.equal(parentIdentityCalls, 0);
		assert.equal(h.widgets.length, 0);
		assert.equal(h.shutdowns, 1);
		assert.equal(h.notices.length, 1);
		assert.deepEqual(h.tmux.commands, []);
		await h.session.prompt(h.spec.initialPrompt);
		assert.equal(h.faux.state.callCount, 0);
		const result = await h.session.extensionRunner.emitToolCall({
			type: "tool_call",
			toolCallId: "test",
			toolName: "ask_question",
			input: { question: "Blocked?" },
		});
		assert.equal(result?.block, true);
	});

test("child session guards cancel newSession and fork", async (t) => {
	const h = await createRuntimeHarness(t, { child: true });
	h.faux.setResponses([fauxAssistantMessage("Task complete.")]);
	await h.session.prompt(h.spec.initialPrompt);
	const user = h.session.sessionManager
		.getEntries()
		.find((entry) => entry.type === "message" && entry.message.role === "user");
	assert.ok(user);
	assert.deepEqual(await h.runtime.newSession(), { cancelled: true });
	assert.deepEqual(await h.runtime.fork(user.id), { cancelled: true });
	assert.equal(
		h.notices.filter((notice) =>
			notice.message.includes("cannot switch or fork"),
		).length,
		2,
	);
});

test("two parallel questions receive answers by id with durable delivery ids", {
	timeout: 20_000,
}, async (t) => {
	const h = await createRuntimeHarness(t, { child: true, autoExit: true });
	h.faux.setResponses([
		fauxAssistantMessage(
			[
				{
					type: "toolCall",
					id: "a",
					name: "ask_question",
					arguments: { question: "Which file?" },
				},
				{
					type: "toolCall",
					id: "b",
					name: "ask_question",
					arguments: { question: "Which model?" },
				},
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Questions answered."),
	]);
	const prompt = h.session.prompt(h.spec.initialPrompt);
	await until(
		() => questions(h).length === 2,
		"Parallel questions did not open.",
	);
	assert.equal(queue.count(join(h.runDir, "outbox")), 2);
	assert.equal(h.shutdowns, 0);
	const first = questions(h).find((q) => q.text === "Which file?");
	const second = questions(h).find((q) => q.text === "Which model?");
	assert.ok(first && second);
	const secondSeq = answer(h, second.qid, "quick");
	const firstSeq = answer(h, first.qid, "README.md");
	await prompt;
	const results = h.session.messages.filter(
		(message) => message.role === "toolResult",
	);
	assert.deepEqual(
		results
			.map((result) => ({
				id: result.toolCallId,
				content: result.content,
				details: result.details,
			}))
			.toSorted((a, b) => a.id.localeCompare(b.id)),
		[
			{
				id: "a",
				content: [{ type: "text", text: "README.md" }],
				details: {
					deliveryId: queue.itemId(h.spec.runId, "inbox", firstSeq),
					qid: first.qid,
				},
			},
			{
				id: "b",
				content: [{ type: "text", text: "quick" }],
				details: {
					deliveryId: queue.itemId(h.spec.runId, "inbox", secondSeq),
					qid: second.qid,
				},
			},
		],
	);
	assert.equal(questions(h).length, 0);
	assert.equal(queue.count(join(h.runDir, "inbox")), 0);
	assert.equal(h.shutdowns, 1);
});

test("an inbox instruction queued before a question cannot block its later answer", {
	timeout: 5000,
}, async (t) => {
	const h = await createRuntimeHarness(t, { child: true });
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	h.faux.setResponses([
		async () => {
			entered.resolve();
			await release.promise;
			return fauxAssistantMessage(
				{
					type: "toolCall",
					id: "blocked",
					name: "ask_question",
					arguments: { question: "Which file?" },
				},
				{ stopReason: "toolUse" },
			);
		},
		fauxAssistantMessage("Instruction and answer read."),
	]);
	const prompt = h.session.prompt(h.spec.initialPrompt);
	await entered.promise;
	const instruction = inbox(h, "Keep the earlier instruction");
	release.resolve();
	await until(() => questions(h).length === 1, "Question did not open.");
	const question = questions(h)[0];
	assert.ok(question);
	const seq = answer(h, question.qid, "README.md");
	await prompt;
	h.assertNoErrors();
	const results = h.session.messages.filter(
		(message) => message.role === "toolResult",
	);
	assert.equal(results.length, 1);
	assert.deepEqual(results[0]?.details, {
		deliveryId: queue.itemId(h.spec.runId, "inbox", seq),
		qid: question.qid,
	});
	const messages = h.messages("subagent_parent_message");
	assert.equal(messages.length, 1);
	const instructionMessage = messages[0];
	assert.ok(instructionMessage?.type === "custom_message");
	assert.deepEqual(instructionMessage.details, {
		deliveryId: queue.itemId(h.spec.runId, "inbox", instruction),
		kind: "message",
		text: "Keep the earlier instruction",
	});
	assert.equal(queue.count(join(h.runDir, "inbox")), 0);
	const persisted = SessionManager.open(h.spec.launch.childSessionFile)
		.getEntries()
		.filter(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "subagent_parent_message",
		);
	assert.deepEqual(persisted, messages);
	assert.match(
		readFileSync(h.spec.launch.childSessionFile, "utf8"),
		/README.md/,
	);
	assert.deepEqual(h.session.getSteeringMessages(), []);
	assert.deepEqual(h.session.getFollowUpMessages(), []);
});

for (const answered of [true, false])
	test(`${answered ? "answer then abort" : "abort then answer"} closes a question once`, {
		timeout: 20_000,
	}, async (t) => {
		const continuation = Promise.withResolvers<void>();
		const h = await createRuntimeHarness(t, { child: true, autoExit: true });
		h.faux.setResponses([
			fauxAssistantMessage(
				{
					type: "toolCall",
					id: "a",
					name: "ask_question",
					arguments: { question: "Which file?" },
				},
				{ stopReason: "toolUse" },
			),
			async (_context, options) => {
				const stopped = Promise.withResolvers<void>();
				options?.signal?.addEventListener("abort", () => stopped.resolve(), {
					once: true,
				});
				continuation.resolve();
				await stopped.promise;
				return fauxAssistantMessage("Interrupted.");
			},
		]);
		const prompt = h.session.prompt(h.spec.initialPrompt);
		await until(() => questions(h).length === 1, "Question did not open.");
		const question = questions(h)[0];
		assert.ok(question);
		if (answered) {
			answer(h, question.qid, "README.md");
			await continuation.promise;
		}
		await h.session.abort();
		await prompt;
		assert.equal(h.shutdowns, 0, JSON.stringify(h.session.messages));
		assert.equal(questions(h).length, 0);
		assert.equal(
			queue
				.list(join(h.runDir, "outbox"), "outbox")
				.filter((entry) => entry.item.kind === "withdrawn").length,
			answered ? 0 : 1,
		);
		if (!answered) {
			h.faux.setResponses([fauxAssistantMessage("Late answer read.")]);
			const seq = answer(h, question.qid, "Late README.md");
			await idle(h, 2);
			assert.equal(h.messages("subagent_parent_message").length, 1);
			const lateAnswer = h.messages("subagent_parent_message")[0];
			assert.ok(lateAnswer?.type === "custom_message");
			assert.deepEqual(lateAnswer.details, {
				deliveryId: queue.itemId(h.spec.runId, "inbox", seq),
				kind: "answer",
				qid: question.qid,
				text: "Late README.md",
			});
			assert.deepEqual(
				SessionManager.open(h.spec.launch.childSessionFile)
					.getEntries()
					.filter(
						(entry) =>
							entry.type === "custom_message" &&
							entry.customType === "subagent_parent_message",
					),
				h.messages("subagent_parent_message"),
			);
			assert.match(
				JSON.stringify(h.messages("subagent_parent_message")),
				/which you withdrew/,
			);
		}
	});

test("abort during a question holds an unread inbox item without a new run", {
	timeout: 20_000,
}, async (t) => {
	const h = await createRuntimeHarness(t, { child: true, autoExit: true });
	h.faux.setResponses([
		fauxAssistantMessage(
			{
				type: "toolCall",
				id: "held-question",
				name: "ask_question",
				arguments: { question: "Which file?" },
			},
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("This request must not start."),
	]);
	const prompt = h.session.prompt(h.spec.initialPrompt);
	await until(() => questions(h).length === 1, "The question did not open.");
	inbox(h, "Hold this item after Esc");
	await h.session.abort();
	await prompt;
	await until(
		() => queue.count(join(h.runDir, "inbox")) === 0,
		"The held item was not confirmed.",
	);
	assert.equal(h.messages("subagent_parent_message").length, 1);
	assert.equal(h.events.filter((event) => event === "agent_start").length, 1);
	assert.equal(h.faux.state.callCount, 1);
	assert.equal(h.shutdowns, 0);
});

test("an aborted question holds an item first queued at settlement until a later item wakes it", {
	timeout: 20_000,
}, async (t) => {
	let h: Harness;
	let firstSettlement = true;
	h = await createRuntimeHarness(t, {
		child: true,
		autoExit: true,
		extension: (pi) => {
			pi.on("agent_settled", () => {
				if (!firstSettlement) return;
				firstSettlement = false;
				const assistant = h.session.messages.findLast(
					(message) => message.role === "assistant",
				);
				assert.equal(assistant?.stopReason, "error");
				assert.equal(h.messages("subagent_parent_message").length, 0);
				inbox(h, "Unread at settlement");
			});
		},
	});
	h.faux.setResponses([
		fauxAssistantMessage(
			{
				type: "toolCall",
				id: "question",
				name: "ask_question",
				arguments: { question: "Which file?" },
			},
			{ stopReason: "toolUse" },
		),
		async (_context, options) => {
			options?.signal?.throwIfAborted();
			return fauxAssistantMessage("Unexpected wake.");
		},
	]);
	const prompt = h.session.prompt(h.spec.initialPrompt);
	await until(() => questions(h).length === 1, "The question did not open.");
	await h.session.abort();
	await prompt;
	await until(
		() => queue.count(join(h.runDir, "inbox")) === 0,
		"The quiet delivery was not confirmed.",
	);
	assert.equal(h.messages("subagent_parent_message").length, 1);
	assert.equal(h.events.filter((event) => event === "agent_start").length, 1);
	assert.equal(h.events.filter((event) => event === "agent_settled").length, 1);
	assert.equal(h.faux.state.callCount, 1);
	assert.equal(h.shutdowns, 0);
	h.faux.setResponses([fauxAssistantMessage("Read the new item.")]);
	inbox(h, "Later wake");
	await idle(h, 2);
	assert.equal(h.events.filter((event) => event === "agent_start").length, 2);
	assert.equal(h.faux.state.callCount, 2);
	assert.equal(h.shutdowns, 1);
	assert.equal(h.messages("subagent_parent_message").length, 2);
});

for (const starts of [2, 3])
	test(`same factory replacement with ${starts} starts joins suspended recovery before touching its files`, {
		timeout: 20_000,
	}, async (t) => {
		const h = await createRuntimeHarness(t);
		const ownerKey = `1-${"0".repeat(64)}`;
		const deadDir = join(h.root, "runs", "owners", ownerKey, h.spec.runId);
		mkdirSync(deadDir, { recursive: true });
		writeJsonAtomic(join(deadDir, "spec.json"), {
			...h.spec,
			ownerKey,
			owner: { pid: 1, start: "dead" },
		});
		writeJsonAtomic(join(deadDir, "pane.json"), {
			v: 1,
			paneId: "%2",
			server: structuredClone(h.tmux.server),
			process: { pid: 999999, start: "dead" },
		});
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let snapshots = 0;
		h.tmux.listPanes = async () => {
			snapshots++;
			if (snapshots === 1) {
				entered.resolve();
				await release.promise;
			}
			return new Map();
		};
		const runner = h.session.extensionRunner;
		const oldStart = runner.emit({ type: "session_start", reason: "startup" });
		await Promise.race([entered.promise, oldStart]);
		h.assertNoErrors();
		assert.deepEqual(h.notices, []);
		assert.equal(snapshots, 1);
		let replacementFinished = false;
		const replacing = runner.emit({ type: "session_start", reason: "startup" });
		const latest =
			starts === 3
				? runner.emit({ type: "session_start", reason: "startup" })
				: replacing;
		const replacement = latest.then(() => {
			replacementFinished = true;
		});
		let finishedBeforeRelease: boolean;
		let snapshotsBeforeRelease: number;
		try {
			await nextImmediate();
			finishedBeforeRelease = replacementFinished;
			snapshotsBeforeRelease = snapshots;
		} finally {
			release.resolve();
			await Promise.all([oldStart, replacing, replacement]);
		}
		assert.equal(
			finishedBeforeRelease,
			false,
			"Replacement must join the old startup.",
		);
		assert.equal(
			snapshotsBeforeRelease,
			1,
			"Recovery must not overlap across runtimes.",
		);
		assert.equal(snapshots, 2);
		assert.equal(existsSync(deadDir), false);
		assert.equal(
			h.widgets.length,
			2,
			"Only the replacement installs a new widget.",
		);
		assert.deepEqual(h.notices, []);
		const noticeDir = join(
			h.root,
			"runs",
			"undelivered",
			h.session.sessionManager.getSessionId(),
		);
		assert.equal(readdirSync(noticeDir).length, 1);
		h.assertNoErrors();
	});

test("a prompt settled during suspended recovery does not block ready notices", {
	timeout: 20_000,
}, async (t) => {
	const h = await createRuntimeHarness(t);
	const ownerKey = `1-${"0".repeat(64)}`;
	const deadDir = join(h.root, "runs", "owners", ownerKey, h.spec.runId);
	mkdirSync(deadDir, { recursive: true });
	writeJsonAtomic(join(deadDir, "spec.json"), {
		...h.spec,
		ownerKey,
		owner: { pid: 1, start: "dead" },
	});
	writeJsonAtomic(join(deadDir, "pane.json"), {
		v: 1,
		paneId: "%3",
		server: structuredClone(h.tmux.server),
		process: { pid: 999999, start: "dead" },
	});
	const noticeDir = join(
		h.root,
		"runs",
		"undelivered",
		h.session.sessionManager.getSessionId(),
	);
	mkdirSync(noticeDir, { recursive: true });
	const noticeFile = join(noticeDir, `${h.spec.runId}.json`);
	writeJsonAtomic(noticeFile, {
		v: 1,
		kind: "stopped",
		runId: h.spec.runId,
		launch: h.spec.launch,
		at: Date.now(),
	});
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let snapshots = 0;
	h.tmux.listPanes = async () => {
		if (++snapshots === 1) {
			entered.resolve();
			await release.promise;
		}
		return new Map();
	};
	const startup = h.session.extensionRunner.emit({
		type: "session_start",
		reason: "startup",
	});
	await entered.promise;
	try {
		h.faux.setResponses([
			fauxAssistantMessage("Prompt completed during recovery."),
		]);
		await h.session.prompt("Complete this prompt before recovery resumes.");
		await nextImmediate();
		assert.equal(
			h.messages("subagent_notice").length,
			0,
			"Dormant delivery must not send at boundaries or its scheduled pump.",
		);
		assert.equal(existsSync(noticeFile), true);
		assert.equal(
			h.events.filter((event) => event === "agent_settled").length,
			1,
		);
	} finally {
		release.resolve();
		await startup;
	}
	await until(() => snapshots >= 3, "The enabled parent did not tick twice.");
	assert.equal(
		h.messages("subagent_notice").length,
		1,
		"A settled startup prompt must not block the ready notice.",
	);
	assert.equal(h.faux.state.callCount, 1);
	assert.equal(h.events.filter((event) => event === "agent_start").length, 1);
	assert.equal(h.events.filter((event) => event === "agent_settled").length, 1);
	assert.equal(existsSync(noticeFile), false);
	h.assertNoErrors();
});

test("same factory retries recovery after a rejected suspended startup", {
	timeout: 20_000,
}, async (t) => {
	const h = await createRuntimeHarness(t);
	const ownerKey = `1-${"0".repeat(64)}`;
	const deadDir = join(h.root, "runs", "owners", ownerKey, h.spec.runId);
	mkdirSync(deadDir, { recursive: true });
	writeJsonAtomic(join(deadDir, "spec.json"), {
		...h.spec,
		ownerKey,
		owner: { pid: 1, start: "dead" },
	});
	writeJsonAtomic(join(deadDir, "pane.json"), {
		v: 1,
		paneId: "%3",
		server: structuredClone(h.tmux.server),
		process: { pid: 999999, start: "dead" },
	});
	const entered = Promise.withResolvers<void>();
	const snapshot = Promise.withResolvers<Map<string, never>>();
	let snapshots = 0;
	h.tmux.listPanes = async () => {
		snapshots++;
		if (snapshots === 1) {
			entered.resolve();
			return snapshot.promise;
		}
		return new Map();
	};
	const runner = h.session.extensionRunner;
	const oldStart = runner.emit({ type: "session_start", reason: "startup" });
	await entered.promise;
	const replacement = runner.emit({ type: "session_start", reason: "startup" });
	await nextImmediate();
	assert.equal(snapshots, 1);
	snapshot.reject(new Error("Fixture startup snapshot failed."));
	await Promise.all([oldStart, replacement]);
	const errors = h.takeErrors();
	await runner.emit({ type: "session_start", reason: "startup" });
	const laterErrors = h.takeErrors();
	assert.deepEqual(
		errors.map((event) => event.error),
		["Fixture startup snapshot failed."],
	);
	assert.deepEqual(laterErrors, []);
	assert.equal(snapshots, 2);
	assert.equal(existsSync(deadDir), false);
	assert.equal(h.widgets.length, 3);
});

for (const killFails of [false, true])
	test(`quit after a failed startup performs safe cleanup${killFails ? " and reports cleanup errors" : ""}`, {
		timeout: 20_000,
	}, async (t) => {
		const h = await createRuntimeHarness(t);
		assert.ok(prepareRun);
		prepareRun({
			root: h.root,
			spec: h.spec,
			runDir: h.runDir,
			manager: h.session.sessionManager,
			tmux: h.tmux,
		});
		const ownerKey = `1-${"0".repeat(64)}`;
		const deadDir = join(h.root, "runs", "owners", ownerKey, h.spec.runId);
		mkdirSync(deadDir, { recursive: true });
		writeJsonAtomic(join(deadDir, "spec.json"), {
			...h.spec,
			ownerKey,
			owner: { pid: 1, start: "dead" },
		});
		writeJsonAtomic(join(deadDir, "pane.json"), {
			v: 1,
			paneId: "%3",
			server: structuredClone(h.tmux.server),
			process: { pid: 999999, start: "dead" },
		});
		const entered = Promise.withResolvers<void>();
		const snapshot = Promise.withResolvers<Map<string, never>>();
		const listPanes = h.tmux.listPanes.bind(h.tmux);
		const run = h.tmux.run.bind(h.tmux);
		let snapshots = 0;
		h.tmux.listPanes = async () => {
			if (++snapshots === 1) {
				entered.resolve();
				return snapshot.promise;
			}
			return listPanes();
		};
		if (killFails)
			h.tmux.run = async (args) => {
				h.tmux.commands.push(args);
				throw new Error("Fixture pane cleanup failed.");
			};
		const runner = h.session.extensionRunner;
		const start = runner.emit({ type: "session_start", reason: "startup" });
		await entered.promise;
		const quit = runner.emit({ type: "session_shutdown", reason: "quit" });
		snapshot.reject(new Error("Fixture startup snapshot failed."));
		await Promise.all([start, quit]);
		const errors = h.takeErrors();
		h.tmux.run = run;
		assert.ok(
			h.tmux.commands.some(
				(args) => args[0] === "kill-pane" && args[2] === "%2",
			),
			"Quit must close its attached pane after failed startup.",
		);
		assert.equal(existsSync(h.runDir), killFails);
		assert.equal(
			existsSync(deadDir),
			true,
			"Disposed startup must not recover foreign files.",
		);
		assert.deepEqual(
			errors.map((event) => event.error),
			["Fixture startup snapshot failed."],
		);
		assert.equal(h.stderr.length, 1);
		if (killFails) {
			assert.match(h.stderr[0] ?? "", /Fixture pane cleanup failed/);
			assert.ok(
				h.notices.some(
					(notice) => notice.message === "Fixture pane cleanup failed.",
				),
			);
		} else assert.match(h.stderr[0] ?? "", /stopped 1 running subagents/);
	});

test("failed parent startup reconciles a durable result before quit cleanup", {
	timeout: 20_000,
}, async (t) => {
	const h = await createRuntimeHarness(t);
	h.faux.setResponses([fauxAssistantMessage("Save parent.")]);
	await h.session.prompt("Save parent.");
	assert.ok(prepareRun);
	prepareRun({
		root: h.root,
		spec: h.spec,
		runDir: h.runDir,
		manager: h.session.sessionManager,
		tmux: h.tmux,
	});
	const details = {
		v: 1,
		deliveryId: `${h.spec.runId}:result`,
		runId: h.spec.runId,
		name: h.spec.launch.name,
		agent: h.spec.launch.agent,
		profile: h.spec.launch.profile,
		autoExit: false,
		status: "completed",
		text: "Durable result",
		truncated: false,
		undelivered: [],
		openQuestions: [],
		durationMs: 1,
		contextTokens: null,
		childSessionFile: h.spec.launch.childSessionFile,
		spawnerSessionFile: h.spec.spawnerSessionFile,
	};
	writeJsonAtomic(join(h.runDir, "result.json"), details);
	h.pi.sendMessage(
		{
			customType: "subagent_result",
			content: "Durable result",
			display: true,
			details,
		},
		{ triggerTurn: false },
	);
	const ownerKey = `1-${"0".repeat(64)}`;
	const deadDir = join(h.root, "runs", "owners", ownerKey, h.spec.runId);
	mkdirSync(deadDir, { recursive: true });
	writeJsonAtomic(join(deadDir, "spec.json"), {
		...h.spec,
		ownerKey,
		owner: { pid: 1, start: "dead" },
	});
	writeJsonAtomic(join(deadDir, "pane.json"), {
		v: 1,
		paneId: "%3",
		server: structuredClone(h.tmux.server),
		process: { pid: 999999, start: "dead" },
	});
	const entered = Promise.withResolvers<void>();
	const snapshot = Promise.withResolvers<Map<string, never>>();
	const listPanes = h.tmux.listPanes.bind(h.tmux);
	let snapshots = 0;
	h.tmux.listPanes = async () => {
		if (++snapshots === 1) {
			entered.resolve();
			return snapshot.promise;
		}
		return listPanes();
	};
	const runner = h.session.extensionRunner;
	const start = runner.emit({ type: "session_start", reason: "startup" });
	await entered.promise;
	const quit = runner.emit({ type: "session_shutdown", reason: "quit" });
	snapshot.reject(new Error("Fixture startup snapshot failed."));
	await Promise.all([start, quit]);
	assert.deepEqual(
		h.takeErrors().map((event) => event.error),
		["Fixture startup snapshot failed."],
	);
	assert.equal(existsSync(h.runDir), false);
	assert.equal(h.messages("subagent_result").length, 1);
	assert.equal(
		existsSync(
			join(
				h.root,
				"runs",
				"undelivered",
				h.session.sessionManager.getSessionId(),
			),
		),
		false,
	);
	assert.doesNotMatch(h.stderr.join(""), /kept 1 result/);
});

test("failed factory startup still reconciles and disposes its child", {
	timeout: 20_000,
}, async (t) => {
	const h = await createRuntimeHarness(t, { child: true });
	const runner = h.session.extensionRunner;
	h.failNextWidget(new Error("Fixture widget startup failed."));
	await runner.emit({ type: "session_start", reason: "reload" });
	const startupErrors = h.takeErrors();
	const seq = inbox(h, "Durable before shutdown");
	h.pi.sendMessage(
		{
			customType: "subagent_parent_message",
			content: "Durable before shutdown",
			display: true,
			details: {
				deliveryId: queue.itemId(h.spec.runId, "inbox", seq),
				kind: "message",
			},
		},
		{ triggerTurn: false },
	);
	h.faux.setResponses([
		fauxAssistantMessage(
			{
				type: "toolCall",
				id: "disposed",
				name: "ask_question",
				arguments: { question: "Must be disposed?" },
			},
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Disposed."),
	]);
	const prompt = h.session.prompt(h.spec.initialPrompt);
	try {
		await until(() => questions(h).length === 1, "The question did not open.");
		await runner.emit({ type: "session_shutdown", reason: "reload" });
		const shutdownErrors = h.takeErrors();
		assert.equal(
			questions(h).length,
			0,
			"Failed startup must not skip child disposal.",
		);
		assert.equal(queue.count(join(h.runDir, "inbox")), 0);
		assert.deepEqual(
			startupErrors.map((event) => event.error),
			["Fixture widget startup failed."],
		);
		assert.deepEqual(shutdownErrors, []);
	} finally {
		await h.session.abort();
		await prompt;
	}
	await runner.emit({ type: "session_start", reason: "reload" });
	h.assertNoErrors();
	assert.equal(h.widgets.length, 2);
});

test("dead parent pane result is delivered once and removed", {
	timeout: 20_000,
}, async (t) => {
	const h = await createRuntimeHarness(t, { prepare: prepareRun });
	h.faux.setResponses([fauxAssistantMessage("Result received.")]);
	h.tmux.markChildDead();
	await until(() => !existsSync(h.runDir), "The result was not confirmed.");
	await idle(h, 1);
	assert.equal(h.messages("subagent_result").length, 1);
	assert.ok(h.renderRequests > 0);
	assert.deepEqual(h.tmux.killedLiveChildren, []);
});

test("newSession keeps a live child and adopts its result without a turn until durable", {
	timeout: 20_000,
}, async (t) => {
	const h = await createRuntimeHarness(t, { prepare: prepareRun });
	await h.runtime.newSession();
	h.tmux.markChildDead();
	await until(
		() => h.messages("subagent_result").length === 1,
		"The adopted result did not arrive.",
	);
	assert.equal(h.faux.state.callCount, 0);
	assert.equal(h.tmux.killedLiveChildren.length, 0);
	assert.ok(existsSync(h.runDir));
	assert.equal(
		h.session.sessionManager
			.getEntries()
			.filter(
				(entry) => entry.type === "custom" && entry.customType === "subagent",
			).length,
		1,
	);
	assert.equal(h.widgets.length, 2);
	h.faux.setResponses([fauxAssistantMessage("Save the adopted result.")]);
	await h.session.prompt("Save this session.");
	await until(
		() => !existsSync(h.runDir),
		"The durable adopted result was not confirmed.",
	);
	assert.equal(h.messages("subagent_result").length, 1);
});

for (const operation of ["newSession", "fork"] as const)
	test(`${operation} while a result is ready delivers only in the replacement`, {
		timeout: 20_000,
	}, async (t) => {
		const h = await createRuntimeHarness(t, { prepare: prepareRun });
		h.faux.setResponses([fauxAssistantMessage("Initial answer.")]);
		await h.session.prompt("Initial prompt.");
		const entry = h.session.sessionManager
			.getEntries()
			.findLast(
				(entry) =>
					entry.type === "message" && entry.message.role === "assistant",
			);
		assert.ok(entry);
		const started = Promise.withResolvers<void>();
		h.faux.setResponses([
			async (_context, options) => {
				const aborted = Promise.withResolvers<void>();
				options?.signal?.addEventListener("abort", () => aborted.resolve(), {
					once: true,
				});
				started.resolve();
				await aborted.promise;
				return fauxAssistantMessage("Interrupted.");
			},
			fauxAssistantMessage("Replacement received result."),
		]);
		const old = h.session;
		const prompt = old.prompt("Work while the child finishes.");
		await started.promise;
		h.tmux.markChildDead();
		await until(
			() => existsSync(join(h.runDir, "result.json")),
			"The parent did not finalize the ready result.",
		);
		assert.equal(h.messages("subagent_result").length, 0);
		if (operation === "newSession") await h.runtime.newSession();
		else await h.runtime.fork(entry.id, { position: "at" });
		await prompt;
		await until(
			() => h.messages("subagent_result").length === 1,
			"The replacement did not receive the result.",
		);
		assert.equal(
			old.sessionManager
				.getEntries()
				.filter(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === "subagent_result",
				).length,
			0,
		);
		if (operation === "fork") {
			await idle(h, 3);
			assert.equal(h.faux.state.callCount, 3);
			assert.equal(existsSync(h.runDir), false);
		} else assert.equal(h.faux.state.callCount, 2);
	});

test("quit keeps a ready result and the next start shows one notice", {
	timeout: 20_000,
}, async (t) => {
	const reached = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let hold = false;
	const h = await createRuntimeHarness(t, {
		prepare: prepareRun,
		extension: (pi) => {
			pi.on("before_agent_start", async () => {
				if (hold) {
					reached.resolve();
					await release.promise;
				}
			});
		},
	});
	h.faux.setResponses([
		fauxAssistantMessage("Save parent."),
		fauxAssistantMessage("Prompt after quit."),
		fauxAssistantMessage("Save notice."),
	]);
	await h.session.prompt("Save parent.");
	const file = h.session.sessionManager.getSessionFile();
	assert.ok(file);
	hold = true;
	const prompt = h.session.prompt("Hold before the run.");
	await reached.promise;
	h.tmux.markChildDead();
	await until(
		() => existsSync(join(h.runDir, "result.json")),
		"The result did not become ready.",
	);
	await h.session.extensionRunner.emit({
		type: "session_shutdown",
		reason: "quit",
	});
	assert.equal(h.stderr.length, 1);
	assert.match(h.stderr[0] ?? "", /kept 1 result that was not delivered/);
	hold = false;
	release.resolve();
	await prompt;
	await h.runtime.switchSession(file);
	await until(
		() => h.messages("subagent_notice").length === 1,
		"The quit notice did not arrive.",
	);
	assert.equal(h.messages("subagent_result").length, 0);
	assert.equal(existsSync(h.runDir), false);
	assert.match(
		JSON.stringify(h.messages("subagent_notice")),
		/The child result/,
	);
});

for (const stopReason of ["stop", "error"] as const)
	test(`child exits on ${stopReason} after delivery reconciliation`, async (t) => {
		const h = await createRuntimeHarness(t, { child: true, autoExit: true });
		h.faux.setResponses([
			fauxAssistantMessage("Final response.", {
				stopReason,
				...(stopReason === "error"
					? { errorMessage: "Fixture provider error." }
					: {}),
			}),
		]);
		await h.session.prompt(h.spec.initialPrompt);
		assert.equal(h.shutdowns, 1);
	});

test("interactive human input disables child auto-exit", async (t) => {
	const h = await createRuntimeHarness(t, { child: true, autoExit: true });
	h.faux.setResponses([fauxAssistantMessage("Human response.")]);
	await h.session.prompt("A human changed the task.");
	assert.equal(h.shutdowns, 0);
	assert.match(
		JSON.stringify(h.session.sessionManager.getBranch()),
		/"kind":"human"/,
	);
});

test("slow auth preserves argv task ordering before an existing inbox item", {
	timeout: 20_000,
}, async (t) => {
	const h = await createRuntimeHarness(t, { child: true });
	const reached = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const modelRuntime = h.runtime.services.modelRuntime;
	const checkAuth = modelRuntime.checkAuth.bind(modelRuntime);
	modelRuntime.hasConfiguredAuth = () => false;
	modelRuntime.checkAuth = async (...args) => {
		reached.resolve();
		await release.promise;
		return checkAuth(...args);
	};
	inbox(h, "Inbox before argv");
	const requests: string[] = [];
	h.faux.setResponses([
		(context) => {
			requests.push(JSON.stringify(context));
			return fauxAssistantMessage("Task first.");
		},
		(context) => {
			requests.push(JSON.stringify(context));
			return fauxAssistantMessage("Inbox next.");
		},
	]);
	const prompt = h.session.prompt(h.spec.initialPrompt);
	await reached.promise;
	assert.equal(h.ctx.isIdle(), true);
	await until(
		() =>
			h.widgets.some(
				(widget) =>
					typeof widget === "function" &&
					widget(
						{ requestRender() {} },
						{ fg: (_color: string, text: string) => text },
					)
						.render(100)
						.includes("waiting for your prompt to start"),
			),
		"Auth did not hold the task gate.",
	);
	assert.equal(h.messages("subagent_parent_message").length, 0);
	release.resolve();
	await prompt;
	assert.ok(!requests[0]?.includes("Inbox before argv"));
	assert.ok(requests[1]?.includes("Inbox before argv"));
});

test("session_start refreshes catalog guidelines without duplicating its widget", async (t) => {
	const h = await createRuntimeHarness(t);
	const agents = join(h.root, "agent", "agents");
	mkdirSync(agents);
	writeFileSync(
		join(agents, "fresh.md"),
		"---\ndescription: Fresh catalog description\ntools: []\n---\nDo the task.\n",
	);
	await h.runtime.newSession();
	assert.match(h.session.systemPrompt, /Fresh catalog description/);
	assert.equal(h.widgets.length, 2);
});

test("agent_before_settle injects a late inbox item and continues once", async (t) => {
	let h: Harness;
	let queued = false;
	h = await createRuntimeHarness(t, {
		child: true,
		extension: (pi) => {
			pi.on("agent_before_settle", () => {
				if (queued) return;
				queued = true;
				inbox(h, "At the final boundary");
			});
		},
	});
	h.faux.setResponses([
		fauxAssistantMessage("First answer."),
		fauxAssistantMessage("Boundary answer."),
	]);
	await h.session.prompt(h.spec.initialPrompt);
	assert.equal(h.faux.state.callCount, 2);
	assert.equal(h.messages("subagent_parent_message").length, 1);
	assert.equal(queue.count(join(h.runDir, "inbox")), 0);
});

test("an idle child receives parent messages after reload", {
	timeout: 20_000,
}, async (t) => {
	const h = await createRuntimeHarness(t, { child: true });
	h.faux.setResponses([fauxAssistantMessage("Task complete.")]);
	await h.session.prompt(h.spec.initialPrompt);
	await h.session.extensionRunner.emit({
		type: "session_start",
		reason: "reload",
	});
	h.assertNoErrors();
	h.faux.setResponses([fauxAssistantMessage("Continued after reload.")]);
	inbox(h, "Continue after reload");
	await idle(h, 2);
	assert.equal(h.messages("subagent_parent_message").length, 1);
	assert.equal(queue.count(join(h.runDir, "inbox")), 0);
});

test("shutdown confirms child inbox entries before child disposal hides its source", async (t) => {
	const h = await createRuntimeHarness(t, { child: true });
	const seq = inbox(h, "Already durable before shutdown");
	h.pi.sendMessage(
		{
			customType: "subagent_parent_message",
			content: "Already durable before shutdown",
			display: true,
			details: {
				deliveryId: queue.itemId(h.spec.runId, "inbox", seq),
				kind: "message",
			},
		},
		{ triggerTurn: false },
	);
	assert.equal(queue.count(join(h.runDir, "inbox")), 1);
	await h.session.extensionRunner.emit({
		type: "session_shutdown",
		reason: "reload",
	});
	assert.equal(queue.count(join(h.runDir, "inbox")), 0);
});

test("child session_tree appends a leaf marker", async (t) => {
	const h = await createRuntimeHarness(t, { child: true });
	await h.session.extensionRunner.emit({
		type: "session_tree",
		newLeafId: h.session.sessionManager.getLeafId(),
		oldLeafId: null,
		fromExtension: false,
	});
	const last = h.session.sessionManager.getBranch().at(-1);
	assert.equal(last?.type, "custom");
	if (last?.type === "custom")
		assert.deepEqual(last.data, { v: 1, kind: "leaf", runId: h.spec.runId });
});

test("the factory stops before registration on an unsupported installed Pi", () => {
	const result = spawnSync(
		process.execPath,
		[
			"--experimental-test-module-mocks",
			"--input-type=module",
			"-e",
			`
		import assert from "node:assert/strict";
		import { mock } from "node:test";
		const pi = await import("@earendil-works/pi-coding-agent");
		mock.module("@earendil-works/pi-coding-agent", { namedExports: { ...pi, VERSION: "1.0.0" } });
		const { createSubagentsExtension } = await import("./src/index.ts");
		assert.throws(() => createSubagentsExtension({}, {}), /needs Pi 0.87. This Pi is 1.0.0/);
	`,
		],
		{
			cwd: join(import.meta.dirname, "../.."),
			encoding: "utf8",
			timeout: 20_000,
		},
	);
	assert.equal(result.status, 0, result.stdout + result.stderr);
});
