import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	parseStrict,
	ResultDetails,
	readJsonStrict,
	UndeliveredRecord,
} from "../../src/schema.ts";
import {
	customMessage,
	readBranch,
	type Scenario,
	scenario,
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
	assert.equal(run.childRuns().length, 0);
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
		]),
	});
	const file = await childFile(run);
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
	assert.equal(parentMessage.details.kind, "message");
	assert.match(
		await run.waitFor(async () => {
			const text = await run.capture(await childPane(run));
			return text.includes("Parent message:") ? text : undefined;
		}, "parent message renderer"),
		/Parent message: message/,
	);
	await run.sendKeys(await childPane(run), "/quit");
	const details = await result(run);
	assert.equal(details.deliveryId, `${details.runId}:result`);
});

test("three steers persist in sequence in an interactive child", async (t) => {
	const run = await scenario(t, {
		agents: { worker: agent(false) },
		prompt: script([spawn("Open session."), { say: "Spawned." }]),
	});
	const file = await childFile(run);
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
		await prompt(run, [
			steer(text),
			{ say: `Sent ${index}.` },
			{ say: "Result received." },
		]);
		await run.waitFor(
			async () => (await parentMessages(file)).length === index + 1,
			`steer ${index + 1}`,
		);
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
		prompt: script([
			spawn(task),
			{ say: "Questions pending." },
			{ say: "Questions received." },
			{ say: "Child finished." },
		]),
	});
	const file = await childFile(run);
	const questions = await run.waitFor(() => {
		const found = existsSync(run.parentFile)
			? messages(run.readParent(), "subagent_question")
			: [];
		return found.length === 2 ? found : undefined;
	}, "two question deliveries");
	const qids = questions.map((question) => question.details.qid);
	assert.equal(new Set(qids).size, 2);
	for (const question of questions) {
		assert.equal(typeof question.details.deliveryId, "string");
		assert.equal(
			messages(run.readParent(), "subagent_question").filter(
				(item) => item.details.deliveryId === question.details.deliveryId,
			).length,
			1,
		);
	}
	const screen = await run.capture();
	assert.match(screen, /First question\?/);
	assert.match(screen, /Second question\?/);
	await prompt(run, [
		steer("Answer second", "worker", String(qids[1])),
		{ say: "Second sent." },
		{ say: "Result noted." },
	]);
	await prompt(run, [
		steer("Answer first", "worker", String(qids[0])),
		{ say: "First sent." },
		{ say: "Result noted." },
	]);
	const details = await result(run);
	assert.equal(details.status, "completed");
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
	assert.ok(answered.every((item) => item.deliveryId.includes(":inbox:")));
	const firstAnswer = answered.find((item) => item.qid === qids[0]);
	const secondAnswer = answered.find((item) => item.qid === qids[1]);
	assert.ok(firstAnswer && secondAnswer);
	assert.match(firstAnswer.content, /Answer first/);
	assert.match(secondAnswer.content, /Answer second/);
	assert.equal(run.childRuns().length, 0);
});

test("an answer passes an earlier queued instruction without losing it", async (t) => {
	const task = script([
		{ call: "ask_question", args: { question: "Need the answer?" } },
		{ say: "Answer accepted." },
		{ say: "Instruction accepted." },
	]);
	const run = await scenario(t, {
		agents: { worker: agent(false) },
		prompt: script([
			spawn(task),
			steer("Queued instruction"),
			{ say: "Question pending." },
			{ say: "Question seen." },
		]),
	});
	const file = await childFile(run);
	const question = await run.waitFor(
		() =>
			existsSync(run.parentFile)
				? messages(run.readParent(), "subagent_question")[0]
				: undefined,
		"question",
	);
	const qid = String(question.details.qid);
	await prompt(run, [
		steer("Answer now", "worker", qid),
		{ say: "Answer queued." },
		{ say: "Result seen." },
	]);
	await run.waitFor(
		() =>
			readBranch(file).some(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					typeof entry.message.details === "object" &&
					entry.message.details !== null &&
					"deliveryId" in entry.message.details,
			),
		"question answer tool result",
	);
	const delivered = await run.waitFor(async () => {
		const found = await parentMessages(file);
		return found.length === 1 ? found : undefined;
	}, "queued instruction delivery");
	assert.ok(delivered[0]);
	assert.equal(delivered[0].details.text, "Queued instruction");
	assert.equal(messages(readBranch(file), "subagent_parent_message").length, 1);
	assert.match(
		await run.waitFor(async () => {
			const text = await run.capture(await childPane(run));
			return text.includes("Parent message:") ? text : undefined;
		}, "visible parent message"),
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
function readyResult(run: Scenario): boolean {
	const paths = run.childRuns();
	return (
		paths.length === 1 &&
		paths[0] !== undefined &&
		existsSync(join(paths[0], "result.json"))
	);
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
	const oldId = sessionId(run.parentFile);
	const question = await run.waitFor(
		() => messages(run.readParent(), "subagent_question")[0],
		"new session question",
	);
	await run.sendKeys(run.parentPane, "/new");
	await run.waitFor(
		async () => (await run.capture()).includes("New session"),
		"new session UI",
	);
	await prompt(run, [
		steer("New session answer", "worker", String(question.details.qid)),
		{ say: "Answer sent." },
	]);
	const file = await run.waitFor(
		() =>
			otherSessions(run, child).find(
				(path) => existsSync(path) && sessionId(path) !== oldId,
			),
		"new parent session",
	);
	assert.notEqual(sessionId(file), oldId);
	const found = await run.waitFor(
		() => messages(readBranch(file), "subagent_result")[0],
		"new session child result",
	);
	const details = parseStrict(
		ResultDetails,
		found.details,
		"new session result",
	);
	assert.equal(details.deliveryId, `${details.runId}:result`);
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
	await run.waitFor(
		() => run.childRuns().length === 0,
		"cleaned new session run",
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
	assert.ok(resumed);
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
	assert.ok(resumedResults[1]);
	assert.equal(
		parseStrict(ResultDetails, resumedResults[1].details, "resumed result")
			.status,
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
	const found = await run.waitFor(
		() => messages(readBranch(file), "subagent_result")[0],
		"fork result",
	);
	const details = parseStrict(ResultDetails, found.details, "fork result");
	assert.equal(details.status, "completed");
	assert.equal(details.deliveryId, `${details.runId}:result`);
	assert.equal(messages(readBranch(file), "subagent_result").length, 1);
	assert.equal(messages(run.readParent(), "subagent_result").length, 0);
	const branch = readBranch(file);
	const index = branch.findIndex(
		(entry) =>
			entry.type === "custom_message" && entry.customType === "subagent_result",
	);
	assert.ok(
		branch
			.slice(index + 1)
			.some(
				(entry) =>
					entry.type === "message" && entry.message.role === "assistant",
			),
	);
});

test("Esc appends a ready result without another model run", async (t) => {
	const run = await scenario(t, {
		agents: { worker: agent() },
		prompt: script([
			spawn("Esc child result."),
			{ hang: true },
			{ say: "Unexpected new run." },
		]),
	});
	await childFile(run);
	await run.waitFor(() => readyResult(run), "ready result behind parent hang");
	const before = run
		.readParent()
		.filter(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		).length;
	await run.tmux(["send-keys", "-t", run.parentPane, "Escape"]);
	const details = await result(run);
	assert.equal(details.status, "completed");
	await run.waitFor(() => run.childRuns().length === 0, "Esc run cleanup");
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
	assert.match(
		readFileSync(run.stderrFile, "utf8"),
		/Pi quit, so it stopped 1 running subagents: worker/,
	);
	assert.ok(
		!(await run.tmux(["list-panes", "-a", "-F", "#{pane_id}"]))
			.split("\n")
			.includes(pane),
	);
	await run.reopen(run.parentFile);
	await run.waitFor(
		() => messages(run.readParent(), "subagent_notice")[0],
		"reopened notice",
	);
	assert.equal(messages(run.readParent(), "subagent_notice").length, 1);
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
	await run.waitFor(
		async () => (await run.capture()).includes("New session"),
		"new session before quit",
	);
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
	assert.equal(
		readJsonStrict(UndeliveredRecord, join(dir, record)).kind,
		"stopped",
	);
	assert.equal(
		existsSync(join(run.agentDir, "subagent-runs", "undelivered", oldId)),
		false,
	);
	assert.match(
		readFileSync(run.stderrFile, "utf8"),
		/Pi quit, so it stopped 1 running subagents: worker/,
	);
	await run.reopen(file);
	await run.waitFor(
		() => messages(readBranch(file), "subagent_notice")[0],
		"notice in new session",
	);
	assert.equal(messages(readBranch(file), "subagent_notice").length, 1);
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
	await run.waitFor(
		() => messages(readBranch(file), "subagent_result")[0],
		"resumed result in new session",
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
	await run.waitFor(
		async () => (await run.capture()).includes("New session"),
		"unsaved new session",
	);
	assert.deepEqual(otherSessions(run, child), []);
	await run.sendKeys(run.parentPane, "/quit");
	const dir = join(run.agentDir, "subagent-runs", "undelivered", oldId);
	const record = await run.waitFor(
		() => findRecord(dir),
		"old session recovery record",
	);
	assert.equal(
		readJsonStrict(UndeliveredRecord, join(dir, record)).kind,
		"stopped",
	);
	assert.equal(
		readdirSync(join(run.agentDir, "subagent-runs", "undelivered")).length,
		1,
	);
	await run.reopen(run.parentFile);
	await run.waitFor(
		() => messages(run.readParent(), "subagent_notice")[0],
		"old session notice",
	);
	assert.equal(messages(run.readParent(), "subagent_notice").length, 1);
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
		agents: { worker: agent() },
		prompt: script([
			spawn("Finished behind hang."),
			{ hang: true },
			{ say: "Unexpected turn." },
		]),
	});
	const child = await childFile(run);
	const id = sessionId(run.parentFile);
	await run.waitFor(() => readyResult(run), "finished result held behind hang");
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
	assert.match(saved.content, /Finished behind hang/);
	assert.match(
		readFileSync(run.stderrFile, "utf8"),
		/It kept 1 result that was not delivered: worker/,
	);
	assert.equal(run.childRuns().length, 0);
	await run.reopen(run.parentFile);
	const notice = await run.waitFor(
		() => messages(run.readParent(), "subagent_notice")[0],
		"finished result notice",
	);
	assert.match(notice.content, /Finished behind hang/);
	assert.equal(messages(run.readParent(), "subagent_notice").length, 1);
	assert.equal(messages(run.readParent(), "subagent_result").length, 0);
});
