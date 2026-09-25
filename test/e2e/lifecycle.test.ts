import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { processIdentity } from "../../src/process.ts";
import {
	ChildStatus,
	PaneFile,
	parseStrict,
	RegistryRecord,
	ResultDetails,
	RunSpec,
	readJsonStrict,
	UndeliveredRecord,
} from "../../src/schema.ts";
import { createTmux, verifiedPane } from "../../src/tmux.ts";
import {
	customMessage,
	readBranch,
	type Scenario,
	scenario,
} from "./harness.ts";

const script = (steps: unknown[]) => `#script ${JSON.stringify(steps)}`;
const agent = (extra = "", tools: string[] = []) =>
	`---\ndescription: Lifecycle test agent.\ntools: ${JSON.stringify(tools)}\n${extra}---\nComplete the task.\n`;
const spawn = (task: string, name = "worker", role = "worker") => ({
	call: "subagent",
	args: { agent: role, profile: "test", task, name },
});
const steer = (message: string, name = "worker") => ({
	call: "subagent_message",
	args: { name, message },
});
function messages(file: string, kind: string) {
	return existsSync(file)
		? readBranch(file)
				.filter(
					(entry) =>
						entry.type === "custom_message" && entry.customType === kind,
				)
				.map(customMessage)
		: [];
}
function records(file: string) {
	return existsSync(file)
		? readBranch(file)
				.filter(
					(entry) => entry.type === "custom" && entry.customType === "subagent",
				)
				.map((entry) => {
					assert.equal(entry.type, "custom");
					return parseStrict(RegistryRecord, entry.data, "lifecycle registry");
				})
		: [];
}
function toolResults(file: string, name: string) {
	return existsSync(file)
		? readBranch(file).flatMap((entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolName === name
					? [entry.message]
					: [],
			)
		: [];
}
async function visible(run: Scenario, text: string, pane = run.parentPane) {
	return run.waitFor(async () => {
		const screen = await run.capture(pane);
		return screen.includes(text) ? screen : undefined;
	}, `visible ${text}`);
}
async function prompt(run: Scenario, steps: unknown[], pane = run.parentPane) {
	await run.sendKeys(pane, script(steps));
}
async function active(run: Scenario, name = "worker") {
	return run.waitFor(() => {
		for (const path of run.childRuns()) {
			if (
				!existsSync(join(path, "spec.json")) ||
				!existsSync(join(path, "pane.json"))
			)
				continue;
			const spec = readJsonStrict(RunSpec, join(path, "spec.json"));
			if (spec.launch.name === name)
				return {
					path,
					spec,
					pane: readJsonStrict(PaneFile, join(path, "pane.json")),
				};
		}
		return undefined;
	}, `live run ${name}`);
}
async function result(run: Scenario, name = "worker", count = 1) {
	const saved = await run.waitFor(
		() =>
			messages(run.parentFile, "subagent_result").filter(
				(entry) => entry.details.name === name,
			)[count - 1],
		`result ${name} ${count}`,
		30000,
	);
	const details = parseStrict(ResultDetails, saved.details, "lifecycle result");
	assert.equal(details.deliveryId, `${details.runId}:result`);
	assert.equal(
		messages(run.parentFile, "subagent_result").filter(
			(entry) => entry.details.deliveryId === details.deliveryId,
		).length,
		1,
	);
	await visible(run, `${name}  ${details.agent}  ${details.status}`);
	return details;
}
async function verify(
	run: Scenario,
	child: Awaited<ReturnType<typeof active>>,
) {
	const pane = await verifiedPane(
		createTmux(run.socket),
		child.pane,
		child.spec.launch.childSessionFile,
	);
	assert.ok(pane, "saved pane must still exist");
	assert.equal(pane.pid, child.pane.process.pid);
	assert.equal(pane.session, child.spec.launch.childSessionFile);
	return pane;
}
async function expanded(run: Scenario, details: ResultDetails) {
	await run.tmux(["send-keys", "-t", run.parentPane, "C-o"]);
	await visible(run, `Full transcript: ${details.childSessionFile}`);
	const colored = await run.tmux([
		"capture-pane",
		"-e",
		"-p",
		"-J",
		"-S",
		"-100",
		"-t",
		run.parentPane,
	]);
	const header = colored
		.split("\n")
		.find((line) =>
			line.includes(`${details.name}  ${details.agent}  ${details.status}`),
		);
	assert.ok(header);
	assert.ok(
		header.includes(
			details.status === "completed" ? "\x1b[38;5;143m" : "\x1b[38;5;226m",
		),
		JSON.stringify(header),
	);
	const screen = await run.capture();
	const saved = messages(run.parentFile, "subagent_result").find(
		(entry) => entry.details.deliveryId === details.deliveryId,
	);
	assert.ok(saved);
	assert.ok(
		screen.replace(/\s+/g, " ").includes(saved.content.replace(/\s+/g, " ")),
		"expanded UI must include the complete saved result",
	);
	return screen;
}
async function ready(run: Scenario) {
	await visible(run, "Lifecycle ready.");
}
const toolExtension = resolve("test/fixtures/lifecycle-tools.ts");
const Probe = Type.Object(
	{
		active: Type.Array(Type.String()),
		argv: Type.Array(Type.String()),
		loaded: Type.Literal(true),
	},
	{ additionalProperties: false },
);
async function probe(run: Scenario, file: string) {
	const response = await run.waitFor(
		() => toolResults(file, "lifecycle_probe")[0],
		"child probe result",
	);
	assert.equal(response.isError, false);
	return parseStrict(Probe, response.details, "probe result");
}
async function reload(run: Scenario) {
	await run.sendKeys(run.parentPane, "/reload");
	await visible(run, "Reloaded");
}
async function restart(run: Scenario) {
	const loads = run
		.readParent()
		.filter(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === "lifecycle_extension_loaded",
		).length;
	await run.sendKeys(run.parentPane, "/quit");
	await run.waitFor(
		async () =>
			(await run.tmux([
				"display-message",
				"-p",
				"-t",
				run.parentPane,
				"#{pane_dead}",
			])) === "1",
		"parent process exit",
	);
	await run.reopen(run.parentFile);
	await run.waitFor(
		() =>
			run
				.readParent()
				.filter(
					(entry) =>
						entry.type === "custom" &&
						entry.customType === "lifecycle_extension_loaded",
				).length > loads,
		"new parent runtime",
	);
}

test("19.3.12: a child-only load failure reports crash, code and pane error", async (t) => {
	const run = await scenario(t, {
		agents: { worker: agent() },
		prompt: script([{ say: "Lifecycle ready." }]),
	});
	await ready(run);
	writeFileSync(
		join(run.agentDir, "subagent-profiles.json"),
		JSON.stringify({
			profiles: {
				test: {
					model: "faux/brain",
					thinking: "off",
					guidance: "Test profile.",
					extensions: [
						realpathSync(resolve("test/fixtures/faux-brain.ts")),
						realpathSync(resolve("test/fixtures/throws-at-load.ts")),
					],
				},
			},
		}),
	);
	await reload(run);
	await prompt(run, [
		spawn("Fail at load."),
		{ say: "Waiting for crash." },
		{ say: "Crash received." },
	]);
	const details = await result(run);
	assert.equal(details.status, "crashed");
	assert.equal(details.exitCode, 1);
	assert.match(details.paneTail ?? "", /Test extension failed at load/);
	assert.match(await expanded(run, details), /Test extension failed at load/);
	assert.doesNotMatch(
		readFileSync(run.stderrFile, "utf8"),
		/Test extension failed at load/,
	);
});

test("19.3.13: explicit process exit reports crashed and exit code 3", async (t) => {
	const run = await scenario(t, {
		agents: { worker: agent() },
		prompt: script([
			spawn(script([{ exit: 3 }])),
			{ say: "Waiting for exit." },
			{ say: "Exit received." },
		]),
	});
	const details = await result(run);
	assert.equal(details.status, "crashed");
	assert.equal(details.exitCode, 3);
	assert.match(await expanded(run, details), /crashed \(exit code 3\)/);
});

test("19.3.14: provider error persists and renders its full message", async (t) => {
	const error = "Lifecycle provider failure: full diagnostic text.";
	const run = await scenario(t, {
		agents: { worker: agent() },
		prompt: script([
			spawn(script([{ error }])),
			{ say: "Waiting for provider." },
			{ say: "Error received." },
		]),
	});
	const details = await result(run);
	assert.equal(details.status, "error");
	assert.equal(details.errorMessage, error);
	assert.match(
		await expanded(run, details),
		/Lifecycle provider failure: full diagnostic text\./,
	);
});

test("19.3.15: a verified manual pane kill reports closed", async (t) => {
	const run = await scenario(t, {
		agents: { worker: agent() },
		prompt: script([
			spawn(script([{ hang: true }])),
			{ say: "Waiting for manual close." },
			{ say: "Close received." },
		]),
	});
	const child = await active(run);
	await visible(run, "Working", child.pane.paneId);
	await verify(run, child);
	await run.tmux(["kill-pane", "-t", child.pane.paneId]);
	const details = await result(run);
	assert.equal(details.status, "closed");
	assert.match(await expanded(run, details), /was closed in its pane/);
});

test("19.3.16: human takeover retains output until pane quit", async (t) => {
	const run = await scenario(t, {
		agents: { worker: agent() },
		prompt: script([
			spawn(script([{ hang: true }])),
			{ say: "Waiting for human." },
			{ say: "Human result received." },
		]),
	});
	const child = await active(run);
	await visible(run, "Working", child.pane.paneId);
	await run.tmux(["send-keys", "-t", child.pane.paneId, "Escape"]);
	await visible(run, "Operation aborted", child.pane.paneId);
	await prompt(
		run,
		[{ say: "Human takeover retained output." }],
		child.pane.paneId,
	);
	await visible(run, "Human takeover retained output.", child.pane.paneId);
	await run.waitFor(() => {
		const status = readJsonStrict(ChildStatus, join(child.path, "status.json"));
		return status.human && status.state === "waiting";
	}, "idle human child");
	assert.equal((await verify(run, child)).dead, false);
	assert.equal(messages(run.parentFile, "subagent_result").length, 0);
	await run.sendKeys(child.pane.paneId, "/quit");
	const details = await result(run);
	assert.match(details.text, /Human takeover retained output\./);
	assert.match(
		await expanded(run, details),
		/Human takeover retained output\./,
	);
});

test("19.3.23: child tools and extension effects enforce the sandbox", async (t) => {
	const run = await scenario(t, {
		extensionPaths: [toolExtension],
		agents: { worker: agent("auto-exit: false\n", ["lifecycle_probe"]) },
		prompt: script([
			spawn(
				script([
					{ call: "lifecycle_probe", args: {} },
					{ say: "Sandbox complete." },
				]),
			),
			{ say: "Waiting for sandbox." },
			{ say: "Sandbox result received." },
		]),
	});
	const child = await active(run);
	const observed = await probe(run, child.spec.launch.childSessionFile);
	assert.ok(observed.active.includes("lifecycle_probe"));
	assert.ok(!observed.active.includes("lifecycle_omitted"));
	assert.deepEqual(new Set(observed.active), new Set(child.spec.launch.tools));
	assert.ok(
		observed.argv.some(
			(word, index) =>
				word === "-e" &&
				observed.argv[index + 1] === realpathSync(toolExtension),
		),
	);
	assert.ok(
		readBranch(child.spec.launch.childSessionFile).some(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === "lifecycle_extension_loaded" &&
				parseStrict(
					Type.Object(
						{ loaded: Type.Literal(true) },
						{ additionalProperties: false },
					),
					entry.data,
					"extension effect",
				).loaded,
		),
	);
	await visible(run, "Sandbox complete.", child.pane.paneId);
	await run.sendKeys(child.pane.paneId, "/quit");
	assert.equal((await result(run)).status, "completed");
});

test("19.3.18: resume uses stored launch arguments and only new output", async (t) => {
	const run = await scenario(t, {
		extensionPaths: [toolExtension],
		agents: {
			worker: agent("skills: [lifecycle-skill]\n", ["read", "lifecycle_probe"]),
		},
		prompt: script([{ say: "Lifecycle ready." }]),
	});
	await ready(run);
	const skill = join(run.agentDir, "skills", "lifecycle-skill", "SKILL.md");
	mkdirSync(join(run.agentDir, "skills", "lifecycle-skill"), {
		recursive: true,
	});
	writeFileSync(
		skill,
		"---\nname: lifecycle-skill\ndescription: Test the stored skill path.\n---\nUse the test skill.\n",
	);
	await reload(run);
	await prompt(run, [
		spawn(script([{ say: "Original segment only." }])),
		{ say: "First run started." },
		{ say: "First result received." },
	]);
	const first = await result(run);
	assert.equal(first.text, "Original segment only.");
	const saved = records(run.parentFile).find((entry) => entry.kind === "spawn");
	assert.ok(saved?.kind === "spawn");
	assert.deepEqual(saved.launch.skills, [skill]);
	await prompt(run, [
		steer(script([{ hang: true }])),
		{ say: "Resume started." },
		{ say: "Resume result received." },
	]);
	const child = await active(run);
	assert.equal(child.spec.kind, "resume");
	assert.deepEqual(child.spec.launch, saved.launch);
	await visible(run, "Working", child.pane.paneId);
	await verify(run, child);
	const argv = execFileSync(
		"ps",
		["-o", "args=", "-p", String(child.pane.process.pid)],
		{ encoding: "utf8" },
	);
	await run.tmux(["send-keys", "-t", child.pane.paneId, "Escape"]);
	await visible(run, "Operation aborted", child.pane.paneId);
	await prompt(run, [{ say: "Resumed segment only." }], child.pane.paneId);
	await visible(run, "Resumed segment only.", child.pane.paneId);
	await run.sendKeys(child.pane.paneId, "/quit");
	const second = await result(run, "worker", 2);
	assert.equal(second.text, "Resumed segment only.");
	assert.equal(second.childSessionFile, first.childSessionFile);
	assert.match(await expanded(run, second), /Resumed segment only\./);
	assert.ok(
		argv.includes(`--tools ${saved.launch.tools.join(",")}`),
		`Pinned Pi replaces OS arguments with its process title: ${JSON.stringify(argv)}`,
	);
	for (const extension of saved.launch.extensions)
		assert.ok(argv.includes(`-e ${extension}`));
	for (const path of saved.launch.skills)
		assert.ok(argv.includes(`--skill ${path}`));
	assert.ok(
		argv.includes(
			`--model ${saved.launch.model.provider}/${saved.launch.model.id}`,
		),
	);
	assert.ok(argv.includes(`--thinking ${saved.launch.thinking}`));
	assert.ok(argv.includes(`--session ${first.childSessionFile}`));
});

test("19.3.20: nested allowlists and depth three constrain actual tools", async (t) => {
	const leafTask = script([
		{ call: "lifecycle_probe", args: {} },
		{ say: "Depth three reached." },
	]);
	const scoutTask = script([
		spawn(leafTask, "leaf", "leaf"),
		{ say: "Leaf started." },
		{ say: "Leaf result received." },
	]);
	const workerTask = script([
		spawn("Denied task.", "denied", "outsider"),
		{ say: "Denied attempt complete." },
	]);
	const run = await scenario(t, {
		extensionPaths: [toolExtension],
		agents: {
			worker: agent("spawns: [scout, leaf, helper]\nauto-exit: false\n"),
			scout: agent("spawns: [leaf, helper]\nauto-exit: false\n", [
				"lifecycle_probe",
			]),
			leaf: agent("spawns: [helper]\nauto-exit: false\n", ["lifecycle_probe"]),
			helper: agent(),
			outsider: agent(),
		},
		prompt: script([
			spawn(workerTask),
			{ say: "Worker started." },
			{ say: "Worker result received." },
		]),
	});
	const worker = await active(run);
	await run.waitFor(
		() => toolResults(worker.spec.launch.childSessionFile, "subagent")[0],
		"denied nested spawn",
	);
	await prompt(
		run,
		[
			spawn(scoutTask, "scout", "scout"),
			{ say: "Scout started." },
			{ say: "Scout result received." },
		],
		worker.pane.paneId,
	);
	const scout = await active(run, "scout");
	const leaf = await active(run, "leaf");
	assert.equal(worker.spec.launch.depth, 1);
	assert.equal(scout.spec.launch.depth, 2);
	assert.equal(leaf.spec.launch.depth, 3);
	const denied = toolResults(
		worker.spec.launch.childSessionFile,
		"subagent",
	)[0];
	assert.ok(denied?.isError);
	assert.match(JSON.stringify(denied.content), /Unknown agent/);
	await visible(run, 'Unknown agent "outsider"', worker.pane.paneId);
	const observation = await probe(run, leaf.spec.launch.childSessionFile);
	for (const name of ["subagent", "subagent_message", "subagents_list"])
		assert.ok(!observation.active.includes(name));
	assert.deepEqual(
		new Set(observation.active),
		new Set(leaf.spec.launch.tools),
	);
	assert.equal(leaf.spec.launch.nested, null);
	await visible(run, "Depth three reached.", leaf.pane.paneId);
	for (const child of [leaf, scout, worker]) {
		await verify(run, child);
		await run.sendKeys(child.pane.paneId, "/quit");
		await run.waitFor(
			async () =>
				!(await createTmux(run.socket).listPanes()).has(child.pane.paneId),
			`nested cleanup ${child.spec.launch.name}`,
		);
	}
	assert.equal((await result(run)).status, "completed");
});

test("19.3.11: parent quit stops child and grandchild with durable records", async (t) => {
	const workerTask = script([
		spawn(script([{ hang: true }]), "grandchild", "scout"),
		{ say: "Grandchild started." },
	]);
	const run = await scenario(t, {
		agents: {
			worker: agent("spawns: [scout]\nauto-exit: false\n"),
			scout: agent(),
		},
		prompt: script([spawn(workerTask), { say: "Worker started." }]),
	});
	const child = await active(run);
	const grandchild = await active(run, "grandchild");
	await visible(run, "Working", grandchild.pane.paneId);
	await verify(run, child);
	await verify(run, grandchild);
	await run.sendKeys(run.parentPane, "/quit");
	for (const stopped of [child, grandchild]) {
		const file = join(
			run.agentDir,
			"subagent-runs",
			"undelivered",
			stopped.spec.spawnerSessionId,
			`${stopped.spec.runId}.json`,
		);
		await run.waitFor(
			() => existsSync(file),
			`stopped record ${stopped.spec.launch.name}`,
		);
		const saved = readJsonStrict(UndeliveredRecord, file);
		assert.equal(saved.kind, "stopped");
		assert.deepEqual(saved.launch, stopped.spec.launch);
		assert.equal(existsSync(saved.launch.childSessionFile), true);
		assert.equal(
			(await createTmux(run.socket).listPanes()).has(stopped.pane.paneId),
			false,
		);
	}
	assert.equal(
		grandchild.spec.spawnerSessionFile,
		child.spec.launch.childSessionFile,
	);
	await run.waitFor(
		() =>
			readFileSync(run.stderrFile, "utf8").includes(
				"Their sessions are saved.",
			),
		"quit report",
	);
	assert.match(
		readFileSync(run.stderrFile, "utf8"),
		/stopped 1 running subagents: worker/,
	);
});

test("19.3.21 and 22: fork copies the active branch without delegation or ancestor ownership", async (t) => {
	const run = await scenario(t, {
		agents: {
			sibling: agent(),
			worker: agent(
				"session: fork\nspawns: [scout, helper]\nauto-exit: false\n",
			),
			scout: agent("session: fork\nspawns: [helper]\nauto-exit: false\n"),
			helper: agent(),
		},
		prompt: script([
			spawn("Ancestor sibling output.", "sibling", "sibling"),
			{ say: "Sibling started." },
			{ say: "Sibling result received." },
		]),
	});
	await result(run, "sibling");
	await prompt(run, [{ say: "Active parent branch marker." }]);
	await visible(run, "Active parent branch marker.");
	const before = run.readParent();
	const nestedTask = script([
		steer("Do not resume ancestor sibling.", "sibling"),
		{ say: "Ancestor lookup checked." },
	]);
	const task = script([
		spawn(nestedTask, "grandchild", "scout"),
		{ say: "Fork grandchild started." },
		{ say: "Fork grandchild result received." },
	]);
	await prompt(run, [
		spawn(task),
		{ say: "Fork worker started." },
		{ say: "Fork worker result received." },
	]);
	const child = await active(run);
	await run.waitFor(
		() =>
			toolResults(child.spec.launch.childSessionFile, "subagent").length > 0,
		"fork delegation attempt",
	);
	const grandchild = await active(run, "grandchild");
	await visible(run, "Ancestor lookup checked.", grandchild.pane.paneId);
	const copied = readBranch(child.spec.launch.childSessionFile);
	assert.deepEqual(copied.slice(0, before.length), before);
	const delegation = run
		.readParent()
		.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some(
					(block) =>
						block.type === "toolCall" &&
						block.name === "subagent" &&
						block.arguments.name === "worker",
				),
		);
	assert.ok(delegation);
	assert.ok(!copied.some((entry) => entry.id === delegation.id));
	const parentBranch = run.readParent();
	const delegationIndex = parentBranch.findIndex(
		(entry) => entry.id === delegation.id,
	);
	assert.deepEqual(
		copied.slice(0, delegationIndex),
		parentBranch.slice(0, delegationIndex),
	);
	assert.ok(
		records(grandchild.spec.launch.childSessionFile).some(
			(entry) => entry.kind === "spawn" && entry.launch.name === "sibling",
		),
	);
	const denied = toolResults(
		grandchild.spec.launch.childSessionFile,
		"subagent_message",
	).at(-1);
	assert.ok(denied?.isError);
	assert.match(JSON.stringify(denied.content), /Unknown subagent/);
	await visible(run, 'Unknown subagent "sibling"', grandchild.pane.paneId);
	assert.equal(
		records(grandchild.spec.launch.childSessionFile).filter(
			(entry) => entry.kind === "resume",
		).length,
		0,
	);
	for (const nested of [grandchild, child]) {
		await verify(run, nested);
		await run.sendKeys(nested.pane.paneId, "/quit");
		await run.waitFor(
			async () =>
				!(await createTmux(run.socket).listPanes()).has(nested.pane.paneId),
			"fork child pane cleanup",
		);
	}
	await result(run);
});

test("19.3.24: project agents stay unavailable until private project trust", async (t) => {
	const run = await scenario(t, {
		approval: "ask",
		extensionPaths: [toolExtension],
		prompt: script([{ say: "Lifecycle ready." }]),
	});
	await ready(run);
	mkdirSync(join(run.cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(join(run.cwd, ".pi", "agents", "project-worker.md"), agent());
	await reload(run);
	await visible(run, "Project subagent files are ignored.");
	await prompt(run, [
		spawn("Untrusted task.", "untrusted", "project-worker"),
		{ say: "Untrusted attempt complete." },
	]);
	await visible(run, "Untrusted attempt complete.");
	assert.ok(toolResults(run.parentFile, "subagent")[0]?.isError);
	assert.equal(records(run.parentFile).length, 0);
	assert.equal(new ProjectTrustStore(run.agentDir).get(run.cwd), null);
	await run.sendKeys(run.parentPane, "/trust");
	await visible(run, "Trust");
	await run.tmux(["send-keys", "-t", run.parentPane, "Enter"]);
	await run.waitFor(
		() => new ProjectTrustStore(run.agentDir).get(run.cwd) === true,
		"private trust decision",
	);
	await visible(run, "Restart pi for this to take effect.");
	const loads = run
		.readParent()
		.filter(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === "lifecycle_extension_loaded",
		).length;
	await run.sendKeys(run.parentPane, "/quit");
	await run.waitFor(
		async () =>
			(await run.tmux([
				"display-message",
				"-p",
				"-t",
				run.parentPane,
				"#{pane_dead}",
			])) === "1",
		"parent quit before trust restart",
	);
	await run.reopen(run.parentFile);
	await run.waitFor(
		() =>
			run
				.readParent()
				.filter(
					(entry) =>
						entry.type === "custom" &&
						entry.customType === "lifecycle_extension_loaded",
				).length > loads,
		"trusted startup",
	);
	await prompt(run, [
		spawn("Trusted project output.", "trusted", "project-worker"),
		{ say: "Trusted worker started." },
		{ say: "Trusted result received." },
	]);
	const details = await result(run, "trusted");
	assert.equal(details.status, "completed");
	assert.match(details.text, /Trusted project output/);
	assert.equal(
		records(run.parentFile).filter((entry) => entry.kind === "spawn").length,
		1,
	);
});

test("19.3.19: an open child session rejects resume without a second pane", async (t) => {
	const run = await scenario(t, {
		agents: { worker: agent() },
		prompt: script([
			spawn("Original output."),
			{ say: "First run started." },
			{ say: "First result received." },
		]),
	});
	const finished = await result(run);
	const tmux = createTmux(run.socket);
	const server = await tmux.serverIdentity();
	const paneId = (
		await run.tmux([
			"new-window",
			"-d",
			"-P",
			"-F",
			"#{pane_id}",
			"--",
			"/bin/sh",
			join(run.root, "reopen.sh"),
			finished.childSessionFile,
		])
	).trim();
	await run.tmux([
		"set-option",
		"-p",
		"-t",
		paneId,
		"@pi_subagent_session",
		finished.childSessionFile,
	]);
	const state = (await tmux.listPanes()).get(paneId);
	assert.ok(state);
	const identity = processIdentity(state.pid);
	assert.ok(identity);
	const saved = parseStrict(
		PaneFile,
		{ v: 1, paneId, process: identity, server },
		"human reopened pane",
	);
	t.after(async () => {
		const current = await verifiedPane(tmux, saved, finished.childSessionFile);
		if (current) await tmux.run(["kill-pane", "-t", paneId]);
	});
	await visible(run, "Original output.", paneId);
	const panes = [...(await tmux.listPanes()).keys()];
	assert.equal(
		(await verifiedPane(tmux, saved, finished.childSessionFile))?.dead,
		false,
	);
	await prompt(run, [steer("Resume must fail."), { say: "Guard checked." }]);
	await visible(run, "Guard checked.");
	const denied = toolResults(run.parentFile, "subagent_message")[0];
	assert.ok(denied?.isError);
	assert.match(JSON.stringify(denied.content), /still open in pane/);
	await visible(run, `still open in pane ${paneId}`);
	assert.deepEqual([...(await tmux.listPanes()).keys()], panes);
	assert.equal(
		records(run.parentFile).filter((entry) => entry.kind === "resume").length,
		0,
	);
});

test("pane recovery proves server and pane identity before cleanup", async (t) => {
	const runnerSocket = process.env.TMUX?.split(",")[0];
	assert.ok(runnerSocket?.includes("pi-subagents-test-"));
	const runner = createTmux(runnerSocket);
	const runnerIdentity = await runner.serverIdentity();
	const socket = `/tmp/pi-subagents-test-lifecycle-${randomUUID()}.sock`;
	const second = createTmux(socket);
	const start = () =>
		execFileSync(
			"tmux",
			[
				"-S",
				socket,
				"-f",
				"/dev/null",
				"new-session",
				"-d",
				"-s",
				"identity",
				"-x",
				"240",
				"-y",
				"80",
				"sleep 300",
			],
			{ encoding: "utf8" },
		);
	start();
	let cleanupServer = await second.serverIdentity();
	let serverRunning = true;
	t.after(async () => {
		if (serverRunning) {
			assert.deepEqual(await second.serverIdentity(), cleanupServer);
			await second.run(["kill-server"]);
		}
		assert.deepEqual(await runner.serverIdentity(), runnerIdentity);
	});
	const oldServer = cleanupServer;
	const oldState = (await second.listPanes()).get("%0");
	assert.ok(oldState);
	const oldProcess = processIdentity(oldState.pid);
	assert.ok(oldProcess);
	const oldPane = parseStrict(
		PaneFile,
		{ v: 1, paneId: oldState.paneId, process: oldProcess, server: oldServer },
		"original private pane",
	);
	assert.ok(await verifiedPane(second, oldPane, oldState.session));
	assert.deepEqual(await second.serverIdentity(), oldServer);
	await second.run(["kill-server"]);
	serverRunning = false;
	start();
	serverRunning = true;
	const currentServer = await second.serverIdentity();
	cleanupServer = currentServer;
	await t.test(
		"reused server and pane IDs preserve unrelated work; matching dead pane is cleaned",
		async (t) => {
			const run = await scenario(t, {
				tmuxEnvironment: `${socket},${currentServer.process.pid},0`,
				extensionPaths: [toolExtension],
				agents: { worker: agent("auto-exit: false\n") },
				prompt: script([
					spawn("Recovery session output."),
					{ say: "Recovery worker started." },
					{ say: "Recovery result received." },
				]),
			});
			assert.equal(run.socket, socket);
			const child = await active(run);
			await visible(run, "ack: Recovery session output.", child.pane.paneId);
			await verify(run, child);
			await run.sendKeys(child.pane.paneId, "/quit");
			await result(run);
			await run.waitFor(
				() => !existsSync(child.path),
				"original recovery run cleanup",
			);
			const owner = oldServer.process;
			const ownerKey = `${owner.pid}-${createHash("sha256").update(owner.start).digest("hex")}`;
			const runId = randomUUID();
			const path = join(
				run.agentDir,
				"subagent-runs",
				"owners",
				ownerKey,
				runId,
			);
			mkdirSync(path, { recursive: true });
			const spec = parseStrict(
				RunSpec,
				{ ...child.spec, runId, owner, ownerKey },
				"recovery run spec",
			);
			writeFileSync(join(path, "spec.json"), JSON.stringify(spec));
			const stale = parseStrict(
				PaneFile,
				{ v: 1, paneId: "%0", process: oldProcess, server: oldServer },
				"old server pane",
			);
			writeFileSync(join(path, "pane.json"), JSON.stringify(stale));
			const unrelated = (await second.listPanes()).get("%0");
			assert.ok(unrelated && !unrelated.dead);
			await restart(run);
			await visible(run, "Tmux server identity mismatch");
			assert.deepEqual((await second.listPanes()).get("%0"), unrelated);
			assert.deepEqual(
				readJsonStrict(PaneFile, join(path, "pane.json")),
				stale,
			);
			assert.equal(existsSync(spec.launch.childSessionFile), true);
			writeFileSync(
				join(path, "pane.json"),
				JSON.stringify({ ...stale, server: currentServer }),
			);
			await restart(run);
			await visible(run, "Tmux pane %0 identity mismatch");
			assert.deepEqual((await second.listPanes()).get("%0"), unrelated);
			assert.equal(existsSync(join(path, "pane.json")), true);
			assert.equal(existsSync(spec.launch.childSessionFile), true);
			const matchingId = (
				await second.run([
					"new-window",
					"-d",
					"-P",
					"-F",
					"#{pane_id}",
					"sleep 300",
				])
			).trim();
			await second.run([
				"set-option",
				"-p",
				"-t",
				matchingId,
				"remain-on-exit",
				"on",
			]);
			await second.run([
				"set-option",
				"-p",
				"-t",
				matchingId,
				"@pi_subagent_session",
				spec.launch.childSessionFile,
			]);
			const initialState = (await second.listPanes()).get(matchingId);
			assert.ok(initialState);
			const initialProcess = processIdentity(initialState.pid);
			assert.ok(initialProcess);
			const initialPane = parseStrict(
				PaneFile,
				{
					v: 1,
					paneId: matchingId,
					process: initialProcess,
					server: currentServer,
				},
				"initial matching pane",
			);
			assert.ok(
				await verifiedPane(second, initialPane, spec.launch.childSessionFile),
			);
			await second.run(["respawn-pane", "-k", "-t", matchingId, "sleep 1"]);
			const matchingState = (await second.listPanes()).get(matchingId);
			assert.ok(matchingState);
			const matchingProcess = processIdentity(matchingState.pid);
			assert.ok(matchingProcess);
			const matching = parseStrict(
				PaneFile,
				{
					v: 1,
					paneId: matchingId,
					process: matchingProcess,
					server: currentServer,
				},
				"matching pane",
			);
			await run.waitFor(
				async () =>
					(await verifiedPane(second, matching, spec.launch.childSessionFile))
						?.dead,
				"matching pane exits",
			);
			writeFileSync(join(path, "pane.json"), JSON.stringify(matching));
			await restart(run);
			await run.waitFor(() => !existsSync(path), "verified recovery cleanup");
			assert.equal((await second.listPanes()).has(matchingId), false);
			assert.deepEqual((await second.listPanes()).get("%0"), unrelated);
			assert.equal(existsSync(spec.launch.childSessionFile), true);
			await run.waitFor(
				() =>
					messages(run.parentFile, "subagent_notice").some((message) =>
						message.content.includes("Stopped: worker"),
					),
				"recovery notice",
			);
			await visible(run, "Subagent delivery notice: worker");
		},
	);
});
