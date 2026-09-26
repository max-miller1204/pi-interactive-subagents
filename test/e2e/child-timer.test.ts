import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { processAlive } from "../../src/process.ts";
import {
	ChildStatus,
	PaneFile,
	parseStrict,
	ResultDetails,
	RunSpec,
	readJsonStrict,
	UndeliveredRecord,
} from "../../src/schema.ts";
import { createTmux } from "../../src/tmux.ts";
import { customMessage, type Scenario, scenario } from "./harness.ts";

const script = (steps: unknown[]) => `#script ${JSON.stringify(steps)}`;
const spawn = (task: string, name: string, agent: string) => ({
	call: "subagent",
	args: { agent, profile: "test", task, name },
});
async function active(run: Scenario, name: string) {
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
	}, `live ${name}`);
}

test("child inbox timer failure stops its grandchild and delivers the exact fatal to its parent", async (t) => {
	const run = await scenario(t, {
		agents: {
			worker:
				"---\ndescription: Timer failure worker.\ntools: []\nspawns: [scout]\nauto-exit: false\n---\nComplete the task.\n",
			scout:
				"---\ndescription: Timer failure scout.\ntools: []\n---\nComplete the task.\n",
		},
		prompt: script([
			spawn(
				script([
					spawn(script([{ hang: true }]), "grandchild", "scout"),
					{ say: "Grandchild started." },
				]),
				"worker",
				"worker",
			),
			{ say: "Worker started." },
			{ say: "Worker failure received." },
		]),
	});
	const child = await active(run, "worker");
	const grandchild = await active(run, "grandchild");
	await run.waitFor(() => {
		const file = join(grandchild.path, "status.json");
		return (
			existsSync(file) && readJsonStrict(ChildStatus, file).state === "working"
		);
	}, "grandchild working");
	await run.waitFor(
		async () =>
			(await run.capture(child.pane.paneId)).includes("Grandchild started."),
		"child settled with a live grandchild",
	);
	assert.equal(processAlive(grandchild.pane.process), true);
	const corrupt = join(child.path, "inbox", "unexpected.json");
	const message = `Unexpected file ${corrupt} in a subagent directory.`;
	writeFileSync(corrupt, "{}");
	const saved = await run.waitFor(
		() =>
			run
				.readParent()
				.filter(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === "subagent_result",
				)
				.map(customMessage)
				.find((entry) => entry.details.runId === child.spec.runId),
		"fatal child result",
	);
	const result = parseStrict(
		ResultDetails,
		saved.details,
		"timer failure result",
	);
	assert.equal(result.status, "failed");
	assert.equal(result.errorMessage, message);
	assert.ok(saved.content.includes(message));
	for (const stopped of [child, grandchild]) {
		await run.waitFor(
			() => !processAlive(stopped.pane.process),
			`${stopped.spec.launch.name} process exit`,
		);
		await run.waitFor(
			async () =>
				!(await createTmux(run.socket).listPanes()).has(stopped.pane.paneId),
			`${stopped.spec.launch.name} pane cleanup`,
		);
	}
	const recordFile = join(
		run.agentDir,
		"subagent-runs",
		"undelivered",
		grandchild.spec.spawnerSessionId,
		`${grandchild.spec.runId}.json`,
	);
	const record = readJsonStrict(UndeliveredRecord, recordFile);
	assert.equal(record.kind, "stopped");
	assert.equal(
		record.launch.childSessionFile,
		grandchild.spec.launch.childSessionFile,
	);
	assert.equal(existsSync(record.launch.childSessionFile), true);
	assert.equal(
		run
			.readParent()
			.filter(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === "subagent_result",
			)
			.map(customMessage)
			.filter((entry) => entry.details.runId === child.spec.runId).length,
		1,
	);
});
