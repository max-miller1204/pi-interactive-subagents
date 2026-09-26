import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as queue from "../../src/queue.ts";
import {
	ChildStatus,
	OpenQuestion,
	parseStrict,
	ResultDetails,
	RunSpec,
	readJsonStrict,
	UndeliveredRecord,
} from "../../src/schema.ts";
import {
	customMessage,
	readBranch,
	type Scenario,
	scenario,
	waitFor,
} from "./harness.ts";

const agent = (autoExit = true) =>
	`---\ndescription: E2E worker.\ntools: []\nauto-exit: ${autoExit}\n---\nAnswer the task.\n`;
const script = (steps: unknown[]) => `#script ${JSON.stringify(steps)}`;
const spawn = (task: string, name = "worker") => ({
	call: "subagent",
	args: { agent: "worker", profile: "test", task, name },
});
const steer = (message: string, name = "worker", question_id?: string) => ({
	call: "subagent_message",
	args: { name, message, ...(question_id ? { question_id } : {}) },
});
function messages(entries: SessionEntry[], kind: string) {
	return entries
		.filter(
			(entry) => entry.type === "custom_message" && entry.customType === kind,
		)
		.map(customMessage);
}
function results(run: Scenario, name = "worker") {
	return messages(
		existsSync(run.parentFile) ? run.readParent() : [],
		"subagent_result",
	).filter((entry) => entry.details.name === name);
}
async function result(run: Scenario, name = "worker") {
	const found = await run.waitFor(
		() => results(run, name)[0],
		`result for ${name}`,
		30000,
	);
	const details = parseStrict(ResultDetails, found.details, "E2E result");
	assert.equal(details.deliveryId, `${details.runId}:result`);
	assert.equal(
		results(run, name).filter(
			(entry) => entry.details.deliveryId === details.deliveryId,
		).length,
		1,
	);
	assert.equal(existsSync(details.childSessionFile), true);
	return details;
}
async function spawned(run: Scenario) {
	return run.waitFor(
		() =>
			!existsSync(run.parentFile)
				? undefined
				: run
						.readParent()
						.find(
							(entry) =>
								entry.type === "custom" &&
								entry.customType === "subagent" &&
								(entry.data as { kind?: string }).kind === "spawn",
						),
		"spawn record",
	);
}
async function childFile(run: Scenario) {
	const entry = await spawned(run);
	assert.equal(entry.type, "custom");
	return (entry.data as { launch: { childSessionFile: string } }).launch
		.childSessionFile;
}
async function liveRun(run: Scenario) {
	return run.waitFor(() => {
		const paths = run.childRuns();
		const path = paths.length === 1 ? paths[0] : undefined;
		return path !== undefined && existsSync(join(path, "spec.json"))
			? { path, spec: readJsonStrict(RunSpec, join(path, "spec.json")) }
			: undefined;
	}, "run spec on disk");
}
function checkedResult(entries: SessionEntry[], runId: string, child: string) {
	const deliveryId = `${runId}:result`;
	const matching = messages(entries, "subagent_result").filter(
		(entry) => entry.details.deliveryId === deliveryId,
	);
	assert.equal(matching.length, 1);
	const details = parseStrict(
		ResultDetails,
		matching[0]?.details,
		"E2E result",
	);
	assert.equal(details.runId, runId);
	assert.equal(details.childSessionFile, child);
	return details;
}
function checkedNotice(entries: SessionEntry[], runIds: string[]) {
	const deliveryId = `notice:${[...runIds].sort().join(",")}`;
	const matching = messages(entries, "subagent_notice").filter(
		(entry) => entry.details.deliveryId === deliveryId,
	);
	assert.equal(matching.length, 1);
	assert.equal(messages(entries, "subagent_notice").length, 1);
	assert.ok(matching[0]);
	return matching[0];
}
async function rendered(
	run: Pick<Scenario, "capture" | "tmux" | "waitFor">,
	pane: string,
	expected: string,
) {
	const screen = await run.waitFor(async () => {
		const text = await run.capture(pane);
		return text
			.split("\n")
			.some((row) => row.includes(expected) && row.indexOf(expected) <= 4)
			? text
			: undefined;
	}, `visible ${expected}`);
	const width = Number(
		await run.tmux(["display-message", "-p", "-t", pane, "#{pane_width}"]),
	);
	assert.ok(Number.isSafeInteger(width) && width >= 40);
	assert.ok(
		screen.split("\n").every((line) => visibleWidth(line) <= width),
		`pane text exceeds ${width} columns`,
	);
	const line = screen
		.split("\n")
		.find((row) => row.includes(expected) && row.indexOf(expected) <= 4);
	assert.ok(line, `renderer cut or misaligned ${expected}`);
	return screen;
}
test("UI readiness ignores quoted script text until the aligned response appears", async () => {
	const expected = "Immediate result received.";
	const frames = [` #script [{"say":"${expected}"}]`, ` ${expected}`];
	let captures = 0;
	const run = {
		waitFor,
		capture: async () => {
			const frame = frames[captures++];
			assert.ok(
				frame !== undefined,
				"UI readiness read past the expected response",
			);
			return frame;
		},
		tmux: async (args: string[]) => {
			assert.deepEqual(args, [
				"display-message",
				"-p",
				"-t",
				"%1",
				"#{pane_width}",
			]);
			return "240";
		},
	};
	assert.equal(await rendered(run, "%1", expected), ` ${expected}`);
	assert.equal(captures, 2);
});

async function newSessionReady(
	run: Pick<Scenario, "capture" | "tmux" | "waitFor" | "parentPane">,
) {
	return rendered(run, run.parentPane, "✓ New session started");
}

test("new-session readiness does not match the previous question", async () => {
	const frames = ["New session question?", " ✓ New session started"];
	let captures = 0;
	const run = {
		parentPane: "%1",
		waitFor,
		capture: async () => {
			const frame = frames[captures++];
			assert.ok(frame !== undefined);
			return frame;
		},
		tmux: async (args: string[]) => {
			assert.deepEqual(args, [
				"display-message",
				"-p",
				"-t",
				"%1",
				"#{pane_width}",
			]);
			return "240";
		},
	};
	assert.equal(await newSessionReady(run), " ✓ New session started");
	assert.equal(captures, 2);
});

async function childPane(run: Scenario) {
	return run.waitFor(() => {
		const paths = run.childRuns();
		const path = paths.length === 1 ? paths[0] : undefined;
		if (path === undefined || !existsSync(join(path, "pane.json"))) return;
		return (
			JSON.parse(readFileSync(join(path, "pane.json"), "utf8")) as {
				paneId: string;
			}
		).paneId;
	}, "child pane");
}

test("autonomous result is durable once and done row expires", async (t) => {
	const run = await scenario(t, {
		agents: { worker: agent() },
		prompt: script([
			spawn("Finish task."),
			{ say: "Parent done." },
			{ say: "Result received." },
		]),
	});
	const entry = await spawned(run);
	const active = await liveRun(run);
	assert.equal(entry.type, "custom");
	assert.equal(
		run
			.readParent()
			.filter(
				(item) =>
					item.type === "custom" &&
					item.customType === "subagent" &&
					(item.data as { kind?: string }).kind === "spawn",
			).length,
		1,
	);
	const details = await result(run);
	assert.equal(details.status, "completed");
	checkedResult(
		run.readParent(),
		active.spec.runId,
		active.spec.launch.childSessionFile,
	);
	await run.waitFor(() => !existsSync(active.path), "autonomous run cleanup");
	assert.equal(
		details.childSessionFile,
		(entry.data as { launch: { childSessionFile: string } }).launch
			.childSessionFile,
	);
	const started = run
		.readParent()
		.find(
			(item) =>
				item.type === "message" &&
				item.message.role === "toolResult" &&
				item.message.toolName === "subagent",
		);
	assert.ok(
		started?.type === "message" && started.message.role === "toolResult",
	);
	const pane = JSON.stringify(started.message.content).match(
		/pane (%[0-9]+)/,
	)?.[1];
	assert.ok(pane);
	assert.ok(
		!(await run.tmux(["list-panes", "-a", "-F", "#{pane_id}"]))
			.split("\n")
			.includes(pane),
	);
	assert.match(await run.capture(), /worker.*done/);
	await run.waitFor(
		async () =>
			!(
				await run.tmux(["capture-pane", "-p", "-J", "-t", run.parentPane])
			).includes("worker  worker  done"),
		"expired done row",
		15000,
	);
});

async function prompt(run: Scenario, steps: unknown[]) {
	await run.sendKeys(run.parentPane, script(steps));
}
// The child deletes an answer file after it reads it.
// The parent then deletes the run directory.
// Sample the inbox on every event-loop turn.
// Observe the file before deletion.
async function inboxAnswer(dir: string, qid: string) {
	const inbox = join(dir, "inbox");
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		const found = queue
			.list(inbox, "inbox")
			.find((item) => item.item.kind === "answer" && item.item.qid === qid);
		if (found) return found;
		await new Promise((resolve) => setImmediate(resolve));
	}
	throw new Error(`Timed out waiting for answer file ${qid} after 20000 ms.`);
}
async function parentMessages(file: string) {
	return existsSync(file)
		? messages(readBranch(file), "subagent_parent_message")
		: [];
}

test("task precedes an immediate steer in the child branch", async (t) => {
	const task = script([{ say: "Task complete." }, { say: "Steer complete." }]);
	const run = await scenario(t, {
		agents: { worker: agent(false) },
		prompt: script([
			spawn(task),
			steer("Immediate steer."),
			{ say: "Parent ready." },
			{ say: "Immediate result received." },
		]),
	});
	const file = await childFile(run);
	const active = await liveRun(run);
	const queued = await run.waitFor(
		() =>
			queue
				.list(join(active.path, "inbox"), "inbox")
				.find(
					(item) =>
						item.item.kind === "message" &&
						item.item.text === "Immediate steer.",
				),
		"immediate steer file",
	);
	const deliveryId = queue.itemId(active.spec.runId, "inbox", queued.seq);
	await run.waitFor(
		async () => (await parentMessages(file)).length === 1,
		"child steer",
	);
	const entries = readBranch(file);
	const taskIndex = entries.findIndex(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "user" &&
			JSON.stringify(entry.message.content).includes("Task complete."),
	);
	const steerIndex = entries.findIndex(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "subagent_parent_message",
	);
	assert.ok(
		taskIndex >= 0 && steerIndex > taskIndex,
		"child task must precede steer",
	);
	const parentMessage = (await parentMessages(file))[0];
	assert.ok(parentMessage);
	assert.deepEqual(parentMessage.details, {
		deliveryId,
		kind: "message",
		text: "Immediate steer.",
	});
	assert.equal(
		(await parentMessages(file)).filter(
			(item) => item.details.deliveryId === deliveryId,
		).length,
		1,
	);
	const pane = await childPane(run);
	assert.match(
		await rendered(run, pane, "Parent message: message"),
		/Parent message: message/,
	);
	await run.tmux(["send-keys", "-t", pane, "C-o"]);
	assert.match(
		await rendered(run, pane, "Immediate steer."),
		/Parent message: message/,
	);
	await run.sendKeys(pane, "/quit");
	await result(run);
	assert.equal(
		checkedResult(run.readParent(), active.spec.runId, file).status,
		"completed",
	);
	const response = await run.waitFor(() => {
		const branch = run.readParent();
		const index = branch.findIndex(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "subagent_result",
		);
		return branch
			.slice(index + 1)
			.find(
				(entry) =>
					entry.type === "message" && entry.message.role === "assistant",
			);
	}, "parent response to immediate-steer result");
	assert.ok(
		response.type === "message" && response.message.role === "assistant",
	);
	assert.equal(
		response.message.stopReason,
		"stop",
		JSON.stringify(response.message),
	);
	assert.equal(
		run
			.readParent()
			.filter(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.stopReason === "error",
			).length,
		0,
	);
	await rendered(run, run.parentPane, "Immediate result received.");
});

test("three steers persist in sequence in an interactive child", async (t) => {
	const run = await scenario(t, {
		agents: { worker: agent(false) },
		prompt: script([spawn("Open session."), { say: "Spawned." }]),
	});
	const file = await childFile(run);
	const active = await liveRun(run);
	assert.equal(active.spec.launch.childSessionFile, file);
	await run.waitFor(
		() =>
			existsSync(file) &&
			readBranch(file).some(
				(entry) =>
					entry.type === "message" && entry.message.role === "assistant",
			),
		"child first response",
	);
	for (const [index, text] of [
		"First steer",
		"Second steer",
		"Third steer",
	].entries()) {
		await run.waitFor(
			() => {
				const statusFile = join(active.path, "status.json");
				if (!existsSync(statusFile)) return false;
				const status = readJsonStrict(ChildStatus, statusFile);
				return (
					status.state === "waiting" &&
					!status.question &&
					queue.list(join(active.path, "inbox"), "inbox").length === 0
				);
			},
			`child idle before steer ${index + 1}`,
		);
		const before = readBranch(file).length;
		const queued = run.waitFor(
			() =>
				queue
					.list(join(active.path, "inbox"), "inbox")
					.find(
						(item) => item.item.kind === "message" && item.item.text === text,
					),
			`steer file ${index + 1}`,
		);
		await prompt(run, [
			steer(text),
			{ say: `Sent ${index}.` },
			{ say: "Result received." },
		]);
		const item = await queued;
		assert.deepEqual(item.item, { v: 1, kind: "message", text });
		const deliveryId = queue.itemId(active.spec.runId, "inbox", item.seq);
		await run.waitFor(
			() => {
				const branch = readBranch(file);
				const item = messages(branch, "subagent_parent_message")[index];
				return (
					item?.details.text === text &&
					branch
						.slice(before)
						.some(
							(entry) =>
								entry.type === "message" && entry.message.role === "assistant",
						) &&
					readJsonStrict(ChildStatus, join(active.path, "status.json"))
						.state === "waiting"
				);
			},
			`child settles after steer ${index + 1}`,
		);
		const matching = (await parentMessages(file)).filter(
			(entry) => entry.details.deliveryId === deliveryId,
		);
		assert.equal(matching.length, 1);
		assert.deepEqual(matching[0]?.details, {
			deliveryId,
			kind: "message",
			text,
		});
	}
	const steers = await parentMessages(file);
	assert.deepEqual(
		steers.map((entry) => entry.details.text),
		["First steer", "Second steer", "Third steer"],
	);
	assert.equal(
		new Set(steers.map((entry) => entry.details.deliveryId)).size,
		3,
	);
	await run.sendKeys(await childPane(run), "/quit");
	await result(run);
	checkedResult(run.readParent(), active.spec.runId, file);
});

test("parallel questions pair reverse-order answers by qid", async (t) => {
	const task = script([
		{
			calls: [
				{ call: "ask_question", args: { question: "First question?" } },
				{ call: "ask_question", args: { question: "Second question?" } },
			],
		},
		{ say: "Both answered." },
	]);
	const run = await scenario(t, {
		agents: { worker: agent() },
		prompt: script([spawn(task), { hang: true }, { say: "Unexpected turn." }]),
	});
	const file = await childFile(run);
	const active = await liveRun(run);
	const queued = await run.waitFor(() => {
		const found = queue.list(join(active.path, "outbox"), "outbox");
		return found.length === 2 ? found : undefined;
	}, "two outbox question files");
	assert.ok(queued.every((item) => item.item.kind === "question"));
	const qids = queued.map((item) => item.item.qid);
	assert.equal(new Set(qids).size, 2);
	for (const item of queued) {
		assert.equal(item.item.kind, "question");
		const questionFile = join(
			active.path,
			"questions",
			`${item.item.qid}.json`,
		);
		assert.equal(
			readJsonStrict(OpenQuestion, questionFile).text,
			item.item.text,
		);
	}
	await run.tmux(["send-keys", "-t", run.parentPane, "Escape"]);
	const questions = await run.waitFor(() => {
		const found = messages(run.readParent(), "subagent_question");
		return found.length === 2 ? found : undefined;
	}, "two question deliveries");
	await run.waitFor(
		() => queue.list(join(active.path, "outbox"), "outbox").length === 0,
		"questions confirmed on disk",
	);
	for (const [index, item] of queued.entries()) {
		assert.equal(item.item.kind, "question");
		const expectedId = queue.itemId(active.spec.runId, "outbox", item.seq);
		assert.equal(questions[index]?.details.deliveryId, expectedId);
		assert.equal(questions[index]?.details.qid, item.item.qid);
		assert.equal(questions[index]?.details.question, item.item.text);
		assert.equal(
			questions.filter((question) => question.details.deliveryId === expectedId)
				.length,
			1,
		);
	}
	const screen = await rendered(run, run.parentPane, "First question?");
	assert.match(screen, /Second question\?/);
	const expectedAnswers = new Map<string, string>();
	for (const [qid, answer] of [
		[qids[1], "Answer second"],
		[qids[0], "Answer first"],
	] as const) {
		assert.ok(qid);
		const inboxFile = inboxAnswer(active.path, qid);
		await prompt(run, [
			steer(answer, "worker", qid),
			{ say: "Answer sent." },
			{ say: "Result noted." },
		]);
		const item = await inboxFile;
		assert.deepEqual(item.item, { v: 1, kind: "answer", qid, text: answer });
		expectedAnswers.set(
			qid,
			queue.itemId(active.spec.runId, "inbox", item.seq),
		);
	}
	const details = await result(run);
	assert.equal(details.status, "completed");
	assert.equal(details.runId, active.spec.runId);
	const child = readBranch(file).filter(
		(entry) => entry.type === "message" && entry.message.role === "toolResult",
	);
	assert.equal(child.length, 2);
	const answered = child.map((entry) => {
		assert.equal(entry.type, "message");
		assert.equal(entry.message.role, "toolResult");
		const pair = entry.message.details as { deliveryId: string; qid: string };
		return { ...pair, content: JSON.stringify(entry.message.content) };
	});
	assert.equal(new Set(answered.map((item) => item.deliveryId)).size, 2);
	assert.deepEqual(new Set(answered.map((item) => item.qid)), new Set(qids));
	for (const item of answered)
		assert.equal(item.deliveryId, expectedAnswers.get(item.qid));
	const firstAnswer = answered.find((item) => item.qid === qids[0]);
	const secondAnswer = answered.find((item) => item.qid === qids[1]);
	assert.ok(firstAnswer && secondAnswer);
	assert.match(firstAnswer.content, /Answer first/);
	assert.match(secondAnswer.content, /Answer second/);
	await run.waitFor(() => !existsSync(active.path), "question run cleanup");
});

test("an answer passes two earlier queued instructions without reordering them", async (t) => {
	const task = script([
		{ call: "ask_question", args: { question: "Need the answer?" } },
		{ say: "Answer accepted." },
		{ say: "First instruction accepted." },
		{ say: "Second instruction accepted." },
	]);
	const run = await scenario(t, {
		agents: { worker: agent(false) },
		prompt: script([
			spawn(task),
			steer("Queued instruction one"),
			steer("Queued instruction two"),
			{ say: "Question pending." },
			{ say: "Question seen." },
		]),
	});
	const file = await childFile(run);
	const active = await liveRun(run);
	const question = await run.waitFor(
		() =>
			existsSync(run.parentFile)
				? messages(run.readParent(), "subagent_question")[0]
				: undefined,
		"question",
	);
	const qid = String(question.details.qid);
	await run.waitFor(
		() => queue.list(join(active.path, "outbox"), "outbox").length === 0,
		"question confirmed before answer",
	);
	assert.equal(
		readJsonStrict(OpenQuestion, join(active.path, "questions", `${qid}.json`))
			.qid,
		qid,
	);
	const blocked = await run.waitFor(() => {
		const items = queue.list(join(active.path, "inbox"), "inbox");
		return items.length === 2 ? items : undefined;
	}, "two blocked instructions");
	assert.deepEqual(
		blocked.map((item) => item.item),
		[
			{ v: 1, kind: "message", text: "Queued instruction one" },
			{ v: 1, kind: "message", text: "Queued instruction two" },
		],
	);
	assert.equal(messages(readBranch(file), "subagent_parent_message").length, 0);
	const instructionIds = blocked.map((item) =>
		queue.itemId(active.spec.runId, "inbox", item.seq),
	);
	const pendingAnswer = inboxAnswer(active.path, qid);
	await prompt(run, [
		steer("Answer now", "worker", qid),
		{ say: "Answer queued." },
		{ say: "Result seen." },
	]);
	const answerFile = await pendingAnswer;
	assert.deepEqual(answerFile.item, {
		v: 1,
		kind: "answer",
		qid,
		text: "Answer now",
	});
	assert.ok(blocked.every((item) => item.seq < answerFile.seq));
	const answerId = queue.itemId(active.spec.runId, "inbox", answerFile.seq);
	const toolResult = await run.waitFor(
		() =>
			readBranch(file).find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					(entry.message.details as { deliveryId?: string } | undefined)
						?.deliveryId === answerId,
			),
		"exact answer tool result",
	);
	assert.equal(toolResult.type, "message");
	assert.equal(toolResult.message.role, "toolResult");
	assert.deepEqual(toolResult.message.details, { deliveryId: answerId, qid });
	assert.deepEqual(toolResult.message.content, [
		{ type: "text", text: "Answer now" },
	]);
	assert.equal(
		readBranch(file).filter(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				(entry.message.details as { deliveryId?: string } | undefined)
					?.deliveryId === answerId,
		).length,
		1,
	);
	const delivered = await run.waitFor(async () => {
		const found = await parentMessages(file);
		return found.length === 2 ? found : undefined;
	}, "both queued instructions delivered in order");
	assert.deepEqual(
		delivered.map((item) => item.details),
		[
			{
				deliveryId: instructionIds[0],
				kind: "message",
				text: "Queued instruction one",
			},
			{
				deliveryId: instructionIds[1],
				kind: "message",
				text: "Queued instruction two",
			},
		],
	);
	const branch = readBranch(file);
	const answerIndex = branch.findIndex((entry) => entry.id === toolResult.id);
	for (const id of instructionIds) {
		const index = branch.findIndex(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "subagent_parent_message" &&
				(entry.details as { deliveryId?: string }).deliveryId === id,
		);
		assert.ok(
			index > answerIndex,
			"answer must bypass both earlier instructions",
		);
		assert.equal(
			messages(branch, "subagent_parent_message").filter(
				(item) => item.details.deliveryId === id,
			).length,
			1,
		);
	}
	const pane = await childPane(run);
	assert.match(
		await rendered(run, pane, "Parent message: message"),
		/Parent message: message/,
	);
	await run.tmux(["send-keys", "-t", pane, "C-o"]);
	assert.match(
		await rendered(run, pane, "Queued instruction"),
		/Parent message: message/,
	);
	await run.sendKeys(await childPane(run), "/quit");
	await result(run);
});

test("reload reattaches a waiting child and delivers its result once", async (t) => {
	const task = script([
		{ call: "ask_question", args: { question: "Reload question?" } },
		{ say: "Reload answer complete." },
	]);
	const run = await scenario(t, {
		agents: { worker: agent() },
		prompt: script([
			spawn(task),
			{ say: "Waiting." },
			{ say: "Question noted." },
		]),
	});
	const file = await childFile(run);
	const question = await run.waitFor(
		() =>
			existsSync(run.parentFile)
				? messages(run.readParent(), "subagent_question")[0]
				: undefined,
		"reload question",
	);
	const id = sessionId(run.parentFile);
	await run.sendKeys(run.parentPane, "/reload");
	await run.waitFor(
		async () => (await run.capture()).includes("Reloaded"),
		"parent reload",
		20000,
	);
	await prompt(run, [
		steer("Reload answer", "worker", String(question.details.qid)),
		{ say: "Answer submitted." },
		{ say: "Result received." },
	]);
	const details = await result(run);
	assert.equal(details.status, "completed");
	assert.equal(details.childSessionFile, file);
	assert.equal(sessionId(run.parentFile), id);
	assert.equal(results(run).length, 1);
});

function otherSessions(run: Scenario, child: string): string[] {
	return readdirSync(run.root, { recursive: true, encoding: "utf8" })
		.filter((name) => typeof name === "string" && name.endsWith(".jsonl"))
		.map((name) => join(run.root, name))
		.filter((file) => file !== run.parentFile && file !== child);
}
function findRecord(dir: string): string | undefined {
	return existsSync(dir)
		? readdirSync(dir).find((name) => name.endsWith(".json"))
		: undefined;
}
function sessionId(file: string): string {
	const line = readFileSync(file, "utf8").split("\n")[0];
	assert.ok(line);
	const header = JSON.parse(line) as {
		type: string;
		id: string;
	};
	assert.equal(header.type, "session");
	return header.id;
}

test("new session adopts a child result without starting a turn", async (t) => {
	const task = script([
		{ call: "ask_question", args: { question: "New session question?" } },
		{ say: "New session child finished." },
		{ say: "Resumed child finished." },
	]);
	const run = await scenario(t, {
		agents: { worker: agent() },
		prompt: script([
			spawn(task),
			{ say: "Wait." },
			{ say: "Question received." },
		]),
	});
	const child = await childFile(run);
	const active = await liveRun(run);
	const oldId = sessionId(run.parentFile);
	const question = await run.waitFor(
		() => messages(run.readParent(), "subagent_question")[0],
		"new session question",
	);
	await run.sendKeys(run.parentPane, "/new");
	await newSessionReady(run);
	await prompt(run, [
		steer("New session answer", "worker", String(question.details.qid)),
		{ say: "Answer sent." },
		{ say: "INVALID RESULT TURN" },
	]);
	const file = await run.waitFor(
		() =>
			otherSessions(run, child).find(
				(path) => existsSync(path) && sessionId(path) !== oldId,
			),
		"new parent session",
	);
	assert.notEqual(sessionId(file), oldId);
	await run.waitFor(
		() =>
			readBranch(file).some(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					JSON.stringify(entry.message.content).includes("Answer sent."),
			),
		"parent reply before new result",
	);
	await run.waitFor(
		() => messages(readBranch(file), "subagent_result")[0],
		"new session child result",
	);
	const details = checkedResult(readBranch(file), active.spec.runId, child);
	assert.equal(details.status, "completed");
	assert.equal(messages(readBranch(file), "subagent_result").length, 1);
	assert.equal(messages(run.readParent(), "subagent_result").length, 0);
	assert.ok(
		readBranch(file).some(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === "subagent" &&
				(entry.data as { kind?: string }).kind === "adopt",
		),
	);
	const branch = readBranch(file);
	const resultIndex = branch.findIndex(
		(entry) =>
			entry.type === "custom_message" && entry.customType === "subagent_result",
	);
	assert.ok(resultIndex >= 0);
	assert.equal(
		branch
			.slice(resultIndex + 1)
			.filter(
				(entry) =>
					entry.type === "message" && entry.message.role === "assistant",
			).length,
		0,
	);
	await run.waitFor(() => !existsSync(active.path), "cleaned new session run");
	await rendered(run, run.parentPane, "worker  worker  done");
	await run.waitFor(
		async () =>
			!(
				await run.tmux(["capture-pane", "-p", "-J", "-t", run.parentPane])
			).includes("worker  worker  done"),
		"new result done row expires",
		15000,
	);
	assert.equal(
		readBranch(file).filter(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				JSON.stringify(entry.message.content).includes("INVALID RESULT TURN"),
		).length,
		0,
	);
	assert.equal(
		readBranch(file)
			.slice(resultIndex + 1)
			.filter(
				(entry) =>
					entry.type === "message" && entry.message.role === "assistant",
			).length,
		0,
	);
	await prompt(run, [
		steer("Resume by name"),
		{ say: "Resumed." },
		{ say: "Result seen." },
	]);
	const resumed = await run.waitFor(
		() =>
			readBranch(file).filter(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "subagent" &&
					(entry.data as { kind?: string }).kind === "resume",
			)[0],
		"name reuse after adopt",
	);
	assert.ok(resumed?.type === "custom");
	const resumedResults = await run.waitFor(
		() => {
			const found = messages(readBranch(file), "subagent_result");
			return found.length === 2 ? found : undefined;
		},
		"resumed result",
		30000,
	);
	assert.equal(
		new Set(resumedResults.map((item) => item.details.deliveryId)).size,
		2,
	);
	assert.equal(
		checkedResult(
			readBranch(file),
			(resumed.data as { runId: string }).runId,
			child,
		).status,
		"completed",
	);
});

test("fork delivers one result to the fork branch with a turn", async (t) => {
	const task = script([
		{ call: "ask_question", args: { question: "Fork question?" } },
		{ say: "Fork child done." },
	]);
	const run = await scenario(t, {
		agents: { worker: agent() },
		prompt: script([
			spawn(task),
			{ say: "Wait." },
			{ say: "Question received." },
		]),
	});
	const child = await childFile(run);
	const active = await liveRun(run);
	const oldId = sessionId(run.parentFile);
	const question = await run.waitFor(
		() => messages(run.readParent(), "subagent_question")[0],
		"fork question",
	);
	await prompt(run, [{ say: "Fork anchor." }]);
	await run.waitFor(
		() =>
			run
				.readParent()
				.filter(
					(entry) => entry.type === "message" && entry.message.role === "user",
				).length === 2,
		"fork anchor prompt",
	);
	await run.sendKeys(run.parentPane, "/fork");
	const picker = await run.waitFor(async () => {
		const text = await run.capture();
		return text.includes("Fork") ? text : undefined;
	}, "fork picker");
	assert.match(picker, /Fork/);
	await run.tmux(["send-keys", "-t", run.parentPane, "Enter"]);
	await run.waitFor(
		async () => (await run.capture()).includes("Forked to new session"),
		"fork choice",
	);
	await run.tmux(["send-keys", "-t", run.parentPane, "C-c"]);
	await prompt(run, [
		steer("Fork answer", "worker", String(question.details.qid)),
		{ say: "Fork answer sent." },
		{ say: "Result processed." },
	]);
	const file = await run.waitFor(
		() =>
			otherSessions(run, child).find(
				(path) => existsSync(path) && sessionId(path) !== oldId,
			),
		"fork parent session",
	);
	assert.notEqual(sessionId(file), oldId);
	await run.waitFor(
		() =>
			readBranch(file).some(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					JSON.stringify(entry.message.content).includes("Fork answer sent."),
			),
		"parent reply before fork result",
	);
	await run.waitFor(
		() => messages(readBranch(file), "subagent_result")[0],
		"fork result",
	);
	const details = checkedResult(readBranch(file), active.spec.runId, child);
	assert.equal(details.status, "completed");
	assert.equal(messages(readBranch(file), "subagent_result").length, 1);
	assert.equal(messages(run.readParent(), "subagent_result").length, 0);
	const branch = readBranch(file);
	const index = branch.findIndex(
		(entry) =>
			entry.type === "custom_message" && entry.customType === "subagent_result",
	);
	await run.waitFor(
		() =>
			readBranch(file)
				.slice(index + 1)
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						JSON.stringify(entry.message.content).includes("Result processed."),
				),
		"result-triggered fork model reply",
	);
	const after = readBranch(file)
		.slice(index + 1)
		.filter(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
	assert.equal(after.length, 1);
	assert.match(JSON.stringify(after[0]), /Result processed\./);
});

test("Esc appends a ready result without another model run", async (t) => {
	const run = await scenario(t, {
		agents: { worker: agent(false) },
		prompt: script([
			spawn("Esc child result."),
			{ hang: true },
			{ say: "Unexpected new run." },
		]),
	});
	const child = await childFile(run);
	const active = await liveRun(run);
	const pane = await childPane(run);
	await run.waitFor(
		() =>
			readBranch(child).some(
				(entry) =>
					entry.type === "message" && entry.message.role === "assistant",
			),
		"Esc child first reply",
	);
	await run.waitFor(
		async () => (await run.capture()).includes("Working"),
		"parent hangs before Esc",
	);
	await run.sendKeys(pane, "/quit");
	await run.waitFor(
		() => existsSync(join(active.path, "result.json")),
		"ready result behind parent hang",
	);
	const before = run
		.readParent()
		.filter(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		).length;
	await run.tmux(["send-keys", "-t", run.parentPane, "Escape"]);
	await rendered(run, run.parentPane, "Operation aborted");
	await result(run);
	assert.equal(
		checkedResult(run.readParent(), active.spec.runId, child).status,
		"completed",
	);
	await run.waitFor(() => !existsSync(active.path), "Esc run cleanup");
	await rendered(run, run.parentPane, "worker  worker  done");
	await run.waitFor(
		async () =>
			!(
				await run.tmux(["capture-pane", "-p", "-J", "-t", run.parentPane])
			).includes("worker  worker  done"),
		"Esc result done row expires",
		15000,
	);
	const after = run
		.readParent()
		.filter(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
	assert.equal(after.length, before + 1);
	assert.ok(
		!after.some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				JSON.stringify(entry.message.content).includes("Unexpected new run."),
		),
	);
});

test("quit saves a stopped child, reports stderr, and reopens one notice", async (t) => {
	const task = script([
		{ call: "ask_question", args: { question: "Still working?" } },
		{ say: "Resumed work." },
	]);
	const run = await scenario(t, {
		agents: { worker: agent() },
		prompt: script([
			spawn(task),
			{ say: "Waiting." },
			{ say: "Question received." },
		]),
	});
	const child = await childFile(run);
	const pane = await childPane(run);
	await run.waitFor(
		() => messages(run.readParent(), "subagent_question")[0],
		"running child question",
	);
	const id = sessionId(run.parentFile);
	const assistantCount = run
		.readParent()
		.filter(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		).length;
	await run.sendKeys(run.parentPane, "/quit");
	const dir = join(run.agentDir, "subagent-runs", "undelivered", id);
	const record = await run.waitFor(() => findRecord(dir), "stopped record");
	const saved = readJsonStrict(UndeliveredRecord, join(dir, record));
	assert.equal(saved.kind, "stopped");
	assert.equal(saved.launch.childSessionFile, child);
	assert.ok(
		!(await run.tmux(["list-panes", "-a", "-F", "#{pane_id}"]))
			.split("\n")
			.includes(pane),
	);
	await run.waitFor(
		async () =>
			(await run.tmux([
				"display-message",
				"-p",
				"-t",
				run.parentPane,
				"#{pane_dead}",
			])) === "1" &&
			readFileSync(run.stderrFile, "utf8").includes(
				"Their sessions are saved.",
			),
		"final quit report and dead pane",
	);
	assert.match(
		readFileSync(run.stderrFile, "utf8"),
		/Pi quit, so it stopped 1 running subagents: worker/,
	);
	await run.reopen(run.parentFile);
	await run.waitFor(
		() => messages(run.readParent(), "subagent_notice")[0],
		"reopened notice",
	);
	const notice = checkedNotice(run.readParent(), [saved.runId]);
	const stoppedLine =
		"Stopped: worker. Their sessions are saved. Resume one with subagent_message({ name, message }).";
	assert.equal(
		notice.content,
		`Pi stopped while subagents were running.\n\n${stoppedLine}`,
	);
	await rendered(run, run.parentPane, "Subagent delivery notice: worker");
	await run.tmux(["send-keys", "-t", run.parentPane, "C-o"]);
	await rendered(
		run,
		run.parentPane,
		"Pi stopped while subagents were running.",
	);
	const expanded = await rendered(run, run.parentPane, stoppedLine);
	assert.ok(
		expanded
			.split("\n")
			.map((line) => line.trim())
			.join("\n")
			.includes(`Pi stopped while subagents were running.\n\n${stoppedLine}`),
	);
	assert.equal(
		run
			.readParent()
			.filter(
				(entry) =>
					entry.type === "message" && entry.message.role === "assistant",
			).length,
		assistantCount,
	);
	assert.equal(
		run
			.readParent()
			.filter(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "subagent" &&
					(entry.data as { kind?: string }).kind === "spawn",
			).length,
		1,
	);
	await prompt(run, [
		steer("Resume after quit"),
		{ say: "Resumed." },
		{ say: "Result noted." },
	]);
	await run.waitFor(
		() =>
			run
				.readParent()
				.some(
					(entry) =>
						entry.type === "custom" &&
						entry.customType === "subagent" &&
						(entry.data as { kind?: string }).kind === "resume",
				),
		"resumed name",
	);
	await result(run);
});

test("quit after new stores the notice for the new session", async (t) => {
	const task = script([
		{ call: "ask_question", args: { question: "New quit question?" } },
		{ say: "Resumed after new." },
	]);
	const run = await scenario(t, {
		agents: { worker: agent() },
		prompt: script([
			spawn(task),
			{ say: "Waiting." },
			{ say: "Question seen." },
		]),
	});
	const child = await childFile(run);
	const oldId = sessionId(run.parentFile);
	await run.waitFor(
		() => messages(run.readParent(), "subagent_question")[0],
		"question before new quit",
	);
	await run.sendKeys(run.parentPane, "/new");
	await newSessionReady(run);
	await prompt(run, [{ say: "New session saved." }]);
	const file = await run.waitFor(
		() =>
			otherSessions(run, child).find(
				(path) => existsSync(path) && sessionId(path) !== oldId,
			),
		"saved new session",
	);
	const id = sessionId(file);
	await run.sendKeys(run.parentPane, "/quit");
	const dir = join(run.agentDir, "subagent-runs", "undelivered", id);
	await run.waitFor(
		() => readFileSync(run.stderrFile, "utf8").includes("Pi quit"),
		"new session quit report",
	);
	const record = await run.waitFor(
		() => findRecord(dir),
		"new session stopped record",
	);
	const saved = readJsonStrict(UndeliveredRecord, join(dir, record));
	assert.equal(saved.kind, "stopped");
	assert.equal(saved.launch.childSessionFile, child);
	assert.equal(
		existsSync(join(run.agentDir, "subagent-runs", "undelivered", oldId)),
		false,
	);
	assert.match(
		readFileSync(run.stderrFile, "utf8"),
		/Pi quit, so it stopped 1 running subagents: worker/,
	);
	await run.waitFor(
		async () =>
			(await run.tmux([
				"display-message",
				"-p",
				"-t",
				run.parentPane,
				"#{pane_dead}",
			])) === "1" &&
			readFileSync(run.stderrFile, "utf8").includes(
				"Their sessions are saved.",
			),
		"new session quit complete",
	);
	await run.reopen(file);
	await run.waitFor(
		() => messages(readBranch(file), "subagent_notice")[0],
		"notice in new session",
	);
	const notice = checkedNotice(readBranch(file), [saved.runId]);
	const stoppedLine =
		"Stopped: worker. Their sessions are saved. Resume one with subagent_message({ name, message }).";
	assert.equal(
		notice.content,
		`Pi stopped while subagents were running.\n\n${stoppedLine}`,
	);
	await rendered(run, run.parentPane, "Subagent delivery notice: worker");
	await run.tmux(["send-keys", "-t", run.parentPane, "C-o"]);
	await rendered(
		run,
		run.parentPane,
		"Pi stopped while subagents were running.",
	);
	const expanded = await rendered(run, run.parentPane, stoppedLine);
	assert.ok(
		expanded
			.split("\n")
			.map((line) => line.trim())
			.join("\n")
			.includes(`Pi stopped while subagents were running.\n\n${stoppedLine}`),
	);
	await prompt(run, [
		steer("Resume after new quit"),
		{ say: "Resume sent." },
		{ say: "Result seen." },
	]);
	await run.waitFor(
		() =>
			readBranch(file).some(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "subagent" &&
					(entry.data as { kind?: string }).kind === "resume",
			),
		"resume by name in new session",
	);
	const resumedResult = await run.waitFor(
		() => messages(readBranch(file), "subagent_result")[0],
		"resumed result in new session",
	);
	const resume = readBranch(file).find(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === "subagent" &&
			(entry.data as { kind?: string }).kind === "resume",
	);
	assert.ok(resume?.type === "custom");
	assert.equal(
		checkedResult(
			readBranch(file),
			(resume.data as { runId: string }).runId,
			child,
		).deliveryId,
		resumedResult.details.deliveryId,
	);
});

test("quit after an unsaved new session preserves recovery under the saved spawner", async (t) => {
	const task = script([
		{ call: "ask_question", args: { question: "Unsaved quit question?" } },
		{ say: "Resumed from spawner." },
	]);
	const run = await scenario(t, {
		agents: { worker: agent() },
		prompt: script([
			spawn(task),
			{ say: "Waiting." },
			{ say: "Question seen." },
		]),
	});
	const child = await childFile(run);
	const oldId = sessionId(run.parentFile);
	await run.waitFor(
		() => messages(run.readParent(), "subagent_question")[0],
		"question before unsaved new",
	);
	await run.sendKeys(run.parentPane, "/new");
	await newSessionReady(run);
	assert.deepEqual(otherSessions(run, child), []);
	await run.sendKeys(run.parentPane, "/quit");
	const dir = join(run.agentDir, "subagent-runs", "undelivered", oldId);
	const record = await run.waitFor(
		() => findRecord(dir),
		"old session recovery record",
	);
	const saved = readJsonStrict(UndeliveredRecord, join(dir, record));
	assert.equal(saved.kind, "stopped");
	assert.equal(saved.launch.childSessionFile, child);
	assert.equal(
		readdirSync(join(run.agentDir, "subagent-runs", "undelivered")).length,
		1,
	);
	await run.waitFor(
		async () =>
			(await run.tmux([
				"display-message",
				"-p",
				"-t",
				run.parentPane,
				"#{pane_dead}",
			])) === "1" &&
			readFileSync(run.stderrFile, "utf8").includes(
				"This session was not saved",
			),
		"unsaved quit complete",
	);
	await run.reopen(run.parentFile);
	await run.waitFor(
		() => messages(run.readParent(), "subagent_notice")[0],
		"old session notice",
	);
	checkedNotice(run.readParent(), [saved.runId]);
	await rendered(run, run.parentPane, "Subagent delivery notice: worker");
	await prompt(run, [
		steer("Resume from saved spawner"),
		{ say: "Resume sent." },
		{ say: "Result noted." },
	]);
	await run.waitFor(
		() =>
			run
				.readParent()
				.some(
					(entry) =>
						entry.type === "custom" &&
						entry.customType === "subagent" &&
						(entry.data as { kind?: string }).kind === "resume",
				),
		"resumable name from spawner",
	);
	await result(run);
});

test("quit behind a hanging parent saves one finished result notice", async (t) => {
	const run = await scenario(t, {
		agents: { worker: agent(false) },
		prompt: script([
			spawn("Finished behind hang."),
			{ hang: true },
			{ say: "Unexpected turn." },
		]),
	});
	const child = await childFile(run);
	const active = await liveRun(run);
	const pane = await childPane(run);
	const id = sessionId(run.parentFile);
	await run.waitFor(
		() =>
			readBranch(child).some(
				(entry) =>
					entry.type === "message" && entry.message.role === "assistant",
			),
		"interactive child first reply",
	);
	await run.waitFor(
		async () => (await run.capture()).includes("Working"),
		"parent hangs after spawn",
	);
	await run.sendKeys(pane, "/quit");
	await run.waitFor(
		() => existsSync(join(active.path, "result.json")),
		"finished result held behind hang",
	);
	assert.equal(messages(run.readParent(), "subagent_result").length, 0);
	await run.sendKeys(run.parentPane, "/quit");
	const dir = join(run.agentDir, "subagent-runs", "undelivered", id);
	const file = await run.waitFor(
		() => findRecord(dir),
		"undelivered finished result",
	);
	const saved = readJsonStrict(UndeliveredRecord, join(dir, file));
	assert.equal(saved.kind, "result");
	assert.equal(saved.launch.childSessionFile, child);
	assert.equal(
		parseStrict(ResultDetails, saved.details, "undelivered result").deliveryId,
		`${saved.runId}:result`,
	);
	assert.match(saved.content, /Finished behind hang/);
	await run.waitFor(() => !existsSync(active.path), "quit result run cleanup");
	await run.waitFor(
		async () =>
			(await run.tmux([
				"display-message",
				"-p",
				"-t",
				run.parentPane,
				"#{pane_dead}",
			])) === "1" &&
			readFileSync(run.stderrFile, "utf8").includes("It kept 1 result"),
		"finished result quit complete",
	);
	assert.match(
		readFileSync(run.stderrFile, "utf8"),
		/It kept 1 result that was not delivered: worker/,
	);
	await run.reopen(run.parentFile);
	const notice = await run.waitFor(
		() => messages(run.readParent(), "subagent_notice")[0],
		"finished result notice",
	);
	assert.match(notice.content, /Finished behind hang/);
	const confirmed = checkedNotice(run.readParent(), [saved.runId]);
	assert.equal(confirmed.details.deliveryId, notice.details.deliveryId);
	assert.equal(messages(run.readParent(), "subagent_result").length, 0);
	await rendered(run, run.parentPane, "Subagent delivery notice:");
	await run.tmux(["send-keys", "-t", run.parentPane, "C-o"]);
	await rendered(run, run.parentPane, "ack: Finished behind hang.");
});
