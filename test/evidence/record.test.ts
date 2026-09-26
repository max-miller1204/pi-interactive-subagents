import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as hold } from "node:timers/promises";
import { promisify } from "node:util";
import {
	PaneFile,
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
} from "../e2e/harness.ts";

const exec = promisify(execFile);
const script = (steps: unknown[]) => `#script ${JSON.stringify(steps)}`;
const spawn = (name: string, agent: string, steps: unknown[]) => ({
	call: "subagent",
	args: { name, agent, profile: "test", task: script(steps) },
});
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function rendered(run: Scenario, pane: string, text: string) {
	await run.waitFor(
		async () =>
			(await run.capture(pane))
				.split("\n")
				.some((line) => line.trimStart().startsWith(text)),
		`rendered response: ${text}`,
	);
}
function messages(run: Scenario, kind: string) {
	return run
		.readParent()
		.filter(
			(entry) => entry.type === "custom_message" && entry.customType === kind,
		)
		.map(customMessage);
}
async function child(run: Scenario, name: string) {
	return run.waitFor(() => {
		for (const path of run.childRuns()) {
			if (!existsSync(join(path, "pane.json"))) continue;
			const spec = readJsonStrict(RunSpec, join(path, "spec.json"));
			if (spec.launch.name === name)
				return readJsonStrict(PaneFile, join(path, "pane.json")).paneId;
		}
		return undefined;
	}, `child pane: ${name}`);
}
async function result(run: Scenario, name: string, status: string) {
	const found = await run.waitFor(
		() =>
			messages(run, "subagent_result").find(
				(entry) => entry.details.name === name,
			),
		`result: ${name}`,
	);
	const details = parseStrict(ResultDetails, found.details, "recorded result");
	assert.equal(details.status, status);
	assert.equal(
		messages(run, "subagent_result").filter(
			(entry) => entry.details.deliveryId === details.deliveryId,
		).length,
		1,
	);
	return details;
}

test("record real Pi and tmux workflows", { timeout: 180_000 }, async (t) => {
	const evidenceDir = process.env.EVIDENCE_DIR;
	assert.ok(evidenceDir, "Set EVIDENCE_DIR to a new output directory.");
	const output = resolve(evidenceDir);
	mkdirSync(output, { recursive: false });
	const checkpoints: { name: string; elapsedMs: number }[] = [];
	const started = Date.now();
	const run = await scenario(t, {
		prompt: script([
			{ say: "Recording ready. Scripted model responses; real Pi and tmux." },
		]),
		agents: {
			worker:
				"---\ndescription: Question worker.\ntools: []\nauto-exit: true\n---\nComplete the task.\n",
			reviewer:
				"---\ndescription: Persistent reviewer.\ntools: []\nauto-exit: false\nspawns: [scout]\n---\nComplete the task.\n",
			scout:
				"---\ndescription: Nested scout.\ntools: []\nauto-exit: false\n---\nComplete the task.\n",
		},
	});
	await rendered(run, run.parentPane, "Recording ready.");
	await run.tmux(["select-window", "-t", run.parentPane]);
	await run.tmux(["set-option", "status-left-length", "100"]);
	await run.tmux([
		"set-option",
		"status-left",
		"EVIDENCE: scripted provider | ",
	]);
	const tape = join(output, "workflow.tape");
	writeFileSync(
		tape,
		[
			`Output ${JSON.stringify(join(output, "workflow.mp4"))}`,
			'Set Shell "bash"',
			"Set Width 2400",
			"Set Height 1350",
			"Set FontSize 16",
			"Set Framerate 15",
			"Set TypingSpeed 0ms",
			"Hide",
			`Type ${JSON.stringify(`env -u TMUX tmux -S ${quote(run.socket)} attach-session -t tests`)}`,
			"Enter",
			"Sleep 500ms",
			"Show",
			"Wait+Screen@150s /EVIDENCE PASSED/",
			"Sleep 2s",
			`Screenshot ${JSON.stringify(join(output, "workflow.png"))}`,
			"Sleep 1s",
			"",
		].join("\n"),
	);
	let stepsDone = false;
	const recording = exec("vhs", [tape], {
		timeout: 170_000,
		maxBuffer: 4_000_000,
	});
	const finished = recording.then(({ stdout, stderr }) => {
		writeFileSync(join(output, "vhs.log"), stdout + stderr);
		assert.ok(stepsDone, "Recorder stopped before all assertions passed.");
	});
	const checkpoint = async (name: string) => {
		checkpoints.push({ name, elapsedMs: Date.now() - started });
		writeFileSync(
			join(output, "checkpoints.json"),
			JSON.stringify(checkpoints, null, 2),
		);
		writeFileSync(
			join(output, `${checkpoints.length}-screen.txt`),
			await run.capture(),
		);
		await run.tmux(["display-message", "-d", "1800", name]);
		await hold(2000);
	};
	const workflow = async () => {
		await run.waitFor(
			async () => (await run.tmux(["list-clients"])).length > 0,
			"VHS terminal attached",
		);
		await checkpoint("1. Real Pi session ready");
		await run.sendKeys(
			run.parentPane,
			script([
				spawn("worker", "worker", [
					{
						call: "ask_question",
						args: { question: "Which validation target should I use?" },
					},
					{ say: "Validated the requested Linux target." },
				]),
				{ say: "Worker started. Waiting for its question." },
				{ say: "Question received from worker." },
			]),
		);
		const question = await run.waitFor(
			() => messages(run, "subagent_question")[0],
			"worker question",
		);
		assert.equal(
			question.details.question,
			"Which validation target should I use?",
		);
		await rendered(run, run.parentPane, "Question received from worker.");
		await checkpoint("2. Child question delivered to parent");
		await run.sendKeys(run.parentPane, "/reload");
		await run.waitFor(
			async () => (await run.capture()).includes("Reloaded"),
			"parent reload",
		);
		await checkpoint("3. Parent reloaded while child waits");
		await run.sendKeys(
			run.parentPane,
			script([
				{
					call: "subagent_message",
					args: {
						name: "worker",
						question_id: question.details.qid,
						message: "Use Linux.",
					},
				},
				{ say: "Answer sent after reload." },
				{ say: "Worker result received after reload." },
			]),
		);
		const completed = await result(run, "worker", "completed");
		assert.match(completed.text, /Validated the requested Linux target/);
		const answers = readBranch(completed.childSessionFile).flatMap((entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolName === "ask_question"
				? [entry.message]
				: [],
		);
		assert.equal(answers.length, 1);
		const answer = answers[0];
		assert.ok(answer);
		assert.equal(answer.isError, false);
		assert.deepEqual(answer.content, [{ type: "text", text: "Use Linux." }]);
		assert.ok(
			typeof answer.details === "object" &&
				answer.details !== null &&
				"qid" in answer.details,
		);
		assert.equal(answer.details.qid, question.details.qid);
		await rendered(run, run.parentPane, "Worker result received after reload.");
		await checkpoint("4. Answer delivered; completed result received once");
		await run.sendKeys(
			run.parentPane,
			script([
				spawn("a", "reviewer", [{ say: "Reviewer A ready." }]),
				spawn("b", "reviewer", [{ say: "Reviewer B ready." }]),
				{ say: "Two reviewers ready." },
			]),
		);
		const a = await child(run, "a");
		const b = await child(run, "b");
		await rendered(run, a, "Reviewer A ready.");
		await rendered(run, b, "Reviewer B ready.");
		await run.sendKeys(
			b,
			script([
				spawn("g", "scout", [{ say: "Nested scout ready." }]),
				{ say: "Nested scout started." },
			]),
		);
		const g = await child(run, "g");
		await rendered(run, g, "Nested scout ready.");
		const geometry = () =>
			run.tmux([
				"list-panes",
				"-t",
				run.parentPane,
				"-F",
				"#{pane_id} #{pane_left} #{pane_top} #{pane_width} #{pane_height}",
			]);
		const fixed = [run.parentPane, b, g];
		const frozen = (text: string) =>
			text
				.split("\n")
				.filter((line) => fixed.includes(line.split(" ")[0] ?? ""));
		const before = frozen(await geometry());
		await checkpoint("5. Nested child runs in its own pane");
		await run.sendKeys(
			run.parentPane,
			script([
				spawn("c", "reviewer", [{ say: "Reviewer C ready." }]),
				{ say: "Root sibling started beside the nested row." },
			]),
		);
		const c = await child(run, "c");
		await rendered(run, c, "Reviewer C ready.");
		assert.deepEqual(frozen(await geometry()), before);
		await checkpoint(
			"6. New sibling preserves parent and nested pane geometry",
		);
		await run.sendKeys(
			run.parentPane,
			script([
				{
					call: "subagent_message",
					args: {
						name: "c",
						message: script([{ say: "Steering instruction received." }]),
					},
				},
				{ say: "Steering message sent." },
				{ say: "Child crash reported to parent." },
			]),
		);
		await rendered(run, c, "Steering instruction received.");
		await checkpoint("7. Parent steering reaches the child");
		await run.sendKeys(c, script([{ exit: 3 }]));
		const crashed = await result(run, "c", "crashed");
		assert.equal(crashed.exitCode, 3);
		await rendered(run, run.parentPane, "Child crash reported to parent.");
		await checkpoint("8. Unexpected exit reported with code 3");
		assert.equal(messages(run, "subagent_result").length, 2);
		const descendants = run
			.childRuns()
			.map((path) => readJsonStrict(RunSpec, join(path, "spec.json")));
		assert.deepEqual(descendants.map((spec) => spec.launch.name).sort(), [
			"a",
			"b",
			"g",
		]);
		const failedChild = run
			.childRuns()
			.find(
				(path) =>
					readJsonStrict(RunSpec, join(path, "spec.json")).launch.name === "b",
			);
		assert.ok(failedChild);
		await run.sendKeys(
			run.parentPane,
			script([
				{ say: "Testing child timer failure." },
				{ say: "Child timer failure reported." },
			]),
		);
		await rendered(run, run.parentPane, "Testing child timer failure.");
		const corrupt = join(failedChild, "inbox", "unexpected.json");
		const fatalText = `Unexpected file ${corrupt} in a subagent directory.`;
		writeFileSync(corrupt, "{}");
		const failed = await result(run, "b", "failed");
		assert.equal(failed.errorMessage, fatalText);
		await run.waitFor(async () => {
			const panes = (
				await run.tmux(["list-panes", "-t", run.parentPane, "-F", "#{pane_id}"])
			).split("\n");
			return !panes.includes(b) && !panes.includes(g);
		}, "timer failure stops child and grandchild panes");
		await rendered(run, run.parentPane, "Child timer failure reported.");
		await checkpoint(
			"9. Timer failure reports the exact error and stops descendants",
		);
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
			"parent quit completes",
		);
		assert.equal(
			await run.tmux(["list-panes", "-t", run.parentPane, "-F", "#{pane_id}"]),
			run.parentPane,
		);
		for (const spec of descendants.filter((spec) => spec.launch.name !== "b")) {
			const saved = readJsonStrict(
				UndeliveredRecord,
				join(
					run.agentDir,
					"subagent-runs",
					"undelivered",
					spec.spawnerSessionId,
					`${spec.runId}.json`,
				),
			);
			assert.equal(saved.kind, "stopped");
			assert.deepEqual(saved.launch, spec.launch);
		}
		await checkpoint(
			"10. Parent quit stops remaining children and saves recovery records",
		);
		stepsDone = true;
		await run.tmux([
			"set-option",
			"status-left",
			"EVIDENCE PASSED | 10 checkpoints | ",
		]);
	};
	const work = workflow();
	try {
		await Promise.race([work, finished]);
		await finished;
		assert.ok(existsSync(join(output, "workflow.mp4")));
		assert.ok(existsSync(join(output, "workflow.png")));
	} finally {
		if (recording.child.exitCode === null) recording.child.kill("SIGTERM");
		await finished.catch((error: unknown) => {
			writeFileSync(join(output, "recorder-error.txt"), String(error));
		});
		await work.catch(() => {});
		cpSync(run.root, join(output, "sessions"), { recursive: true });
	}
});
