import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { processAlive } from "../../src/process.ts";
import {
	ChildStatus,
	parseStrict,
	ResultDetails,
	RunBackendRecord,
	RunSpec,
	readJsonStrict,
} from "../../src/schema.ts";
import { readBranch } from "./harness.ts";
import { type WidgetScenario, widgetScenario } from "./widget-harness.ts";

const script = (steps: unknown[]) => `#script ${JSON.stringify(steps)}`;
const agent = `---\ndescription: Widget E2E worker.\ntools: []\n---\nComplete the task.\n`;
const waitingAgent = `---\ndescription: Widget E2E worker.\ntools: []\nauto-exit: false\n---\nWait for more work.\n`;

async function openViewer(run: WidgetScenario, name: string): Promise<void> {
	run.send("/subagents");
	await run.waitFor(
		() => run.screen().includes(`Run: ${name}`),
		"subagents menu",
	);
	run.write("\x1b[B\r");
	await run.waitFor(
		() => run.screen().includes(`Subagent ${name}`),
		"conversation viewer",
	);
}

test("outside tmux auto starts an interactive widget and delivers one result", {
	timeout: 60_000,
}, async (t) => {
	const run = await widgetScenario(t, {
		agents: { worker: agent },
		prompt: script([
			{
				call: "subagent",
				args: {
					agent: "worker",
					profile: "test",
					task: script([{ say: "Widget done." }]),
					name: "worker-1",
				},
			},
		]),
	});
	const active = await run.waitFor(
		() =>
			run.childRuns().find((path) => existsSync(join(path, "backend.json"))),
		"widget backend",
	);
	const backend = readJsonStrict(
		RunBackendRecord,
		join(active, "backend.json"),
	);
	assert.equal(backend.kind, "widget");
	assert.equal(existsSync(join(active, "pane.json")), false);
	const result = await run.waitFor(
		() => run.results()[0],
		"widget result",
		45_000,
	);
	const details = parseStrict(ResultDetails, result.details, "widget result");
	assert.equal(result.details.deliveryId, `${details.runId}:result`);
	assert.equal(details.status, "completed");
	assert.equal(
		run.results().filter((row) => row.details.deliveryId === details.deliveryId)
			.length,
		1,
	);
});

test("widget viewer sends a human message to an interactive child", {
	timeout: 60_000,
}, async (t) => {
	const run = await widgetScenario(t, {
		agents: { worker: waitingAgent },
		prompt: script([
			{
				call: "subagent",
				args: {
					agent: "worker",
					profile: "test",
					name: "worker-1",
					task: script([{ say: "Ready for a message." }]),
				},
			},
		]),
	});
	const active = await run.waitFor(
		() =>
			run.childRuns().find((path) => existsSync(join(path, "backend.json"))),
		"interactive widget backend",
	);
	await run.waitFor(
		() => run.screen().includes("Started worker-1"),
		"parent idle",
	);
	await openViewer(run, "worker-1");
	run.send('#script [{"say":"Human reply received."}]');
	const spec = readJsonStrict(RunSpec, join(active, "spec.json"));
	await run.waitFor(
		() => {
			const branch = readBranch(spec.launch.childSessionFile);
			return (
				branch.some(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === "subagent_parent_message" &&
						(entry.details as { source?: string }).source === "human",
				) &&
				branch.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						JSON.stringify(entry.message.content).includes(
							"Human reply received.",
						),
				)
			);
		},
		"human message and child reply",
		30_000,
	);
	assert.equal(
		readJsonStrict(RunBackendRecord, join(active, "backend.json")).kind,
		"widget",
	);
	run.write("\x18y");
	const result = await run.waitFor(
		() => run.results()[0],
		"stopped widget result",
		30_000,
	);
	assert.equal(
		parseStrict(ResultDetails, result.details, "stopped result").status,
		"closed",
	);
});

test("widget viewer answers a child question", {
	timeout: 60_000,
}, async (t) => {
	const run = await widgetScenario(t, {
		agents: { worker: agent },
		prompt: script([
			{
				call: "subagent",
				args: {
					agent: "worker",
					profile: "test",
					name: "worker-1",
					task: script([
						{ call: "ask_question", args: { question: "Choose a direction?" } },
						{ say: "Answer received." },
						{ say: "Finished after answer." },
					]),
				},
			},
		]),
	});
	const active = await run.waitFor(
		() =>
			run.childRuns().find((path) => existsSync(join(path, "backend.json"))),
		"question widget backend",
	);
	await run.waitFor(
		() =>
			existsSync(join(active, "status.json")) &&
			readJsonStrict(ChildStatus, join(active, "status.json")).question,
		"open child question",
	);
	await run.waitFor(
		() => run.screen().includes("Started worker-1"),
		"parent idle",
	);
	await openViewer(run, "worker-1");
	await run.waitFor(
		() => run.screen().includes("Questions: q-"),
		"question in viewer",
	);
	run.write("\t");
	run.send("Go left.");
	const spec = readJsonStrict(RunSpec, join(active, "spec.json"));
	await run.waitFor(
		() => {
			const branch = readBranch(spec.launch.childSessionFile);
			return (
				branch.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						JSON.stringify(entry.message.content).includes("Go left."),
				) &&
				branch.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						JSON.stringify(entry.message.content).includes("Answer received."),
				)
			);
		},
		"answer and child reply",
		30_000,
	);
	assert.equal(
		readJsonStrict(ChildStatus, join(active, "status.json")).human,
		true,
	);
	run.write("\x18y");
	const result = await run.waitFor(
		() => run.results()[0],
		"answered widget stopped",
		30_000,
	);
	assert.equal(
		parseStrict(ResultDetails, result.details, "answered result").status,
		"closed",
	);
});

test("widget child crash reports one crashed result", {
	timeout: 60_000,
}, async (t) => {
	const run = await widgetScenario(t, {
		agents: { worker: agent },
		prompt: script([
			{
				call: "subagent",
				args: {
					agent: "worker",
					profile: "test",
					name: "worker-1",
					task: script([{ exit: 17 }]),
				},
			},
		]),
	});
	const result = await run.waitFor(
		() => run.results()[0],
		"crashed widget result",
		30_000,
	);
	const details = parseStrict(ResultDetails, result.details, "crashed result");
	assert.equal(details.status, "crashed");
	assert.equal(
		run.results().filter((row) => row.details.deliveryId === details.deliveryId)
			.length,
		1,
	);
});

test("reload reconnects the viewer to the same widget child", {
	timeout: 60_000,
}, async (t) => {
	const run = await widgetScenario(t, {
		agents: { worker: waitingAgent },
		prompt: script([
			{
				call: "subagent",
				args: {
					agent: "worker",
					profile: "test",
					name: "worker-1",
					task: script([{ say: "Ready across reload." }]),
				},
			},
		]),
	});
	const active = await run.waitFor(
		() =>
			run.childRuns().find((path) => existsSync(join(path, "backend.json"))),
		"reload widget backend",
	);
	const before = readJsonStrict(RunBackendRecord, join(active, "backend.json"));
	assert.equal(before.kind, "widget");
	await run.waitFor(
		() => run.screen().includes("Started worker-1"),
		"parent idle",
	);
	run.send("/reload");
	await run.waitFor(
		() => run.screen().includes("Reloaded"),
		"parent reload",
		30_000,
	);
	const after = readJsonStrict(RunBackendRecord, join(active, "backend.json"));
	assert.deepEqual(after, before);
	assert.equal(processAlive(before.child), true);
	await openViewer(run, "worker-1");
	run.send(script([{ say: "Reply after reload." }]));
	const spec = readJsonStrict(RunSpec, join(active, "spec.json"));
	await run.waitFor(
		() =>
			readBranch(spec.launch.childSessionFile).some(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					JSON.stringify(entry.message.content).includes("Reply after reload."),
			),
		"reply after reload",
		30_000,
	);
	run.write("\x18y");
	const result = await run.waitFor(
		() => run.results()[0],
		"reloaded widget result",
		30_000,
	);
	const details = parseStrict(ResultDetails, result.details, "reloaded result");
	assert.equal(details.status, "closed");
	assert.equal(
		run.results().filter((row) => row.details.deliveryId === details.deliveryId)
			.length,
		1,
	);
});

test("finished widget resumes in widget mode with one new result", {
	timeout: 60_000,
}, async (t) => {
	const run = await widgetScenario(t, {
		agents: { worker: agent },
		prompt: script([
			{
				call: "subagent",
				args: {
					agent: "worker",
					profile: "test",
					name: "worker-1",
					task: script([{ say: "First result." }]),
				},
			},
		]),
	});
	const first = parseStrict(
		ResultDetails,
		(await run.waitFor(() => run.results()[0], "first widget result", 30_000))
			.details,
		"first result",
	);
	assert.equal(first.backend, "widget");
	await run.waitFor(
		() => run.screen().includes("First result."),
		"parent idle after first result",
	);
	run.send(
		script([
			{
				call: "subagent_message",
				args: {
					name: "worker-1",
					message: script([{ say: "Second result." }]),
				},
			},
			{ say: "Resume sent." },
			{ say: "Second result received." },
		]),
	);
	const second = parseStrict(
		ResultDetails,
		(await run.waitFor(() => run.results()[1], "second widget result", 30_000))
			.details,
		"second result",
	);
	assert.equal(second.backend, "widget");
	assert.equal(second.status, "completed");
	assert.notEqual(second.runId, first.runId);
	assert.equal(
		new Set(run.results().map((row) => row.details.deliveryId)).size,
		2,
	);
});

test("nested subagent inherits widget mode", { timeout: 60_000 }, async (t) => {
	const worker = `---\ndescription: Parent widget worker.\ntools: []\nspawns: [scout]\nauto-exit: false\n---\nDelegate the task.\n`;
	const run = await widgetScenario(t, {
		agents: { worker, scout: agent },
		prompt: script([
			{
				call: "subagent",
				args: {
					agent: "worker",
					profile: "test",
					name: "worker-1",
					task: script([
						{
							call: "subagent",
							args: {
								agent: "scout",
								profile: "test",
								name: "scout-1",
								task: script([{ say: "Nested widget result." }]),
							},
						},
						{ say: "Scout started." },
						{ say: "Scout finished." },
					]),
				},
			},
		]),
	});
	const workerRun = await run.waitFor(
		() =>
			run
				.childRuns()
				.find(
					(path) =>
						existsSync(join(path, "spec.json")) &&
						readJsonStrict(RunSpec, join(path, "spec.json")).launch.name ===
							"worker-1",
				),
		"parent widget run",
	);
	const workerSpec = readJsonStrict(RunSpec, join(workerRun, "spec.json"));
	const workerBackend = await run.waitFor(
		() =>
			existsSync(join(workerRun, "backend.json"))
				? readJsonStrict(RunBackendRecord, join(workerRun, "backend.json"))
				: undefined,
		"parent widget backend",
	);
	assert.equal(workerBackend.kind, "widget");
	const nestedResult = await run
		.waitFor(
			() =>
				readBranch(workerSpec.launch.childSessionFile).flatMap((entry) =>
					entry.type === "custom_message" &&
					entry.customType === "subagent_result"
						? [parseStrict(ResultDetails, entry.details, "nested result")]
						: [],
				)[0],
			"nested widget result",
			10_000,
		)
		.catch((error) => {
			t.diagnostic(
				`Worker tail: ${JSON.stringify(readBranch(workerSpec.launch.childSessionFile).slice(-8))}`,
			);
			t.diagnostic(`Runs: ${JSON.stringify(run.childRuns())}`);
			throw error;
		});
	assert.equal(nestedResult.backend, "widget");
	assert.equal(nestedResult.status, "completed");
	await run.waitFor(
		() => run.screen().includes("Started worker-1"),
		"parent idle",
	);
	await openViewer(run, "worker-1");
	run.write("\x18y");
	const result = await run.waitFor(
		() => run.results()[0],
		"parent widget closed",
		30_000,
	);
	assert.equal(
		parseStrict(ResultDetails, result.details, "parent result").status,
		"closed",
	);
});
