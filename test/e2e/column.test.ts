import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { processAlive, processIdentity } from "../../src/process.ts";
import {
	PaneFile,
	parseStrict,
	ResultDetails,
	RunSpec,
	readJsonStrict,
} from "../../src/schema.ts";
import { createTmux, verifiedPane } from "../../src/tmux.ts";
import { tmuxLayout } from "../fixtures/tmux-layout.ts";
import {
	customMessage,
	type Scenario,
	scenario,
	trackedResource,
} from "./harness.ts";

const script = (steps: unknown[]) => `#script ${JSON.stringify(steps)}`;
const spawn = (name: string) => ({
	call: "subagent",
	args: {
		agent: "worker",
		profile: "test",
		name,
		task: script([{ say: `Column child ${name} ready.` }]),
	},
});
async function child(run: Scenario, name: string) {
	return run.waitFor(() => {
		for (const path of run.childRuns()) {
			if (!existsSync(join(path, "pane.json"))) continue;
			const spec = readJsonStrict(RunSpec, join(path, "spec.json"));
			if (spec.launch.name === name)
				return {
					path,
					spec,
					pane: readJsonStrict(PaneFile, join(path, "pane.json")),
				};
		}
		return undefined;
	}, `column child ${name}`);
}
async function geometry(run: Scenario) {
	const text = await run.tmux([
		"list-panes",
		"-t",
		run.parentPane,
		"-F",
		"#{pane_id}\t#{pane_width}\t#{pane_height}\t#{pane_left}\t#{pane_top}",
	]);
	return text.split("\n").map((line) => {
		const fields = line.split("\t");
		assert.equal(fields.length, 5);
		const id = fields[0];
		assert.ok(id);
		assert.match(id, /^%[0-9]+$/);
		const values = fields.slice(1).map((value) => {
			assert.match(value, /^(0|[1-9][0-9]*)$/);
			const number = Number(value);
			assert.ok(Number.isSafeInteger(number));
			return number;
		});
		return { id, values };
	});
}

test("separate row subtrees reject column resizing during launch, rollback, and cleanup", async (t) => {
	const run = await scenario(t, {
		agents: {
			worker:
				"---\ndescription: Column ownership test.\ntools: []\nauto-exit: false\n---\nComplete the task.\n",
		},
		prompt: script([
			spawn("one"),
			spawn("two"),
			spawn("three"),
			{ say: "Column ready." },
		]),
	});
	const children = await Promise.all(
		["one", "two", "three"].map((name) => child(run, name)),
	);
	for (const entry of children) {
		await run.waitFor(
			async () =>
				(await run.capture(entry.pane.paneId)).includes(
					`Column child ${entry.spec.launch.name} ready.`,
				),
			"child output before rearrangement",
		);
	}
	const tmux = createTmux(run.socket);
	const server = await tmux.serverIdentity();
	const resource = trackedResource(
		t,
		"row subtree user pane",
		async (saved: { pane: PaneFile; session: string }) => {
			if (await verifiedPane(tmux, saved.pane, saved.session))
				await tmux.run(["kill-pane", "-t", saved.pane.paneId]);
		},
		(reason) => run.retainFiles(reason),
	);
	resource.acquiring();
	const user = (
		await run.tmux([
			"split-window",
			"-d",
			"-v",
			"-t",
			run.parentPane,
			"-P",
			"-F",
			"#{pane_id}",
			"printf 'Protected lower user row.\\n'; exec sleep 300",
		])
	).trim();
	const state = (await tmux.listPanes()).get(user);
	assert.ok(state);
	const identity = processIdentity(state.pid);
	assert.ok(identity);
	resource.identified({
		pane: parseStrict(
			PaneFile,
			{ v: 1, paneId: user, process: identity, server },
			"row user pane",
		),
		session: state.session,
	});
	assert.equal(
		await run.tmux([
			"display-message",
			"-p",
			"-t",
			run.parentPane,
			"#{window_width}x#{window_height}",
		]),
		"240x60",
	);
	const audit = join(run.root, "resize-audit");
	assert.match(audit, /^[A-Za-z0-9_./-]+$/);
	writeFileSync(audit, "", { flag: "wx" });
	await run.tmux([
		"set-hook",
		"-w",
		"-t",
		run.parentPane,
		"after-resize-pane",
		`run-shell 'echo resize >> ${audit}'`,
	]);
	const first = children[0];
	const middle = children[1];
	const last = children[2];
	assert.ok(first && middle && last);
	assert.ok(
		await verifiedPane(tmux, first.pane, first.spec.launch.childSessionFile),
	);
	await run.tmux(["resize-pane", "-t", first.pane.paneId, "-y", "20"]);
	await run.waitFor(
		() => readFileSync(audit, "utf8") === "resize\n",
		"resize audit hook control",
	);
	writeFileSync(audit, "");
	const id = (pane: string) => pane.slice(1);
	const layout = tmuxLayout(
		`240x60,0,0[240x30,0,0{120x30,0,0,${id(run.parentPane)},119x30,121,0,${id(first.pane.paneId)}},240x29,0,31{120x29,0,31,${id(user)},119x29,121,31[119x14,121,31,${id(middle.pane.paneId)},119x14,121,46,${id(last.pane.paneId)}]}]`,
	);
	assert.deepEqual(await tmux.serverIdentity(), server);
	for (const entry of children)
		assert.ok(
			await verifiedPane(tmux, entry.pane, entry.spec.launch.childSessionFile),
		);
	await run.tmux(["select-layout", "-t", run.parentPane, layout]);
	assert.ok(
		await verifiedPane(tmux, first.pane, first.spec.launch.childSessionFile),
	);
	assert.ok(
		await verifiedPane(
			tmux,
			{ v: 1, paneId: user, process: identity, server },
			state.session,
		),
	);
	await run.tmux(["swap-pane", "-d", "-s", user, "-t", first.pane.paneId]);
	const before = await geometry(run);
	const users = before.filter(
		(pane) => pane.id === run.parentPane || pane.id === user,
	);
	t.diagnostic(
		`Separate-row layout: ${layout}\nBefore launch: ${JSON.stringify(before)}`,
	);
	await run.sendKeys(
		run.parentPane,
		script([
			spawn("four"),
			{ say: "Unsafe column launch rejected." },
			{ say: "Cleanup result received." },
		]),
	);
	const denied = await run.waitFor(
		() =>
			run
				.readParent()
				.flatMap((entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolName === "subagent"
						? [entry.message]
						: [],
				)[3],
		"unsafe launch and rollback complete",
	);
	const afterLaunch = await geometry(run);
	t.diagnostic(
		`After launch and rollback: ${JSON.stringify(afterLaunch)}\nResize audit: ${JSON.stringify(readFileSync(audit, "utf8"))}\nLaunch result: ${JSON.stringify(denied)}\nParent UI:\n${await run.capture()}\nUser UI:\n${await run.capture(user)}`,
	);
	assert.deepEqual(
		afterLaunch.filter((pane) => users.some((saved) => saved.id === pane.id)),
		users,
	);
	assert.equal(
		readFileSync(audit, "utf8"),
		"",
		"launch and rollback must not resize a row subtree",
	);
	assert.equal(denied.isError, true);
	assert.match(JSON.stringify(denied.content), /isolated column subtree/);
	assert.deepEqual(
		afterLaunch,
		before,
		"rollback must remove only the new child split",
	);
	for (const path of run
		.childRuns()
		.filter((path) => !children.some((entry) => entry.path === path))) {
		const retained = readJsonStrict(PaneFile, join(path, "pane.json"));
		const spec = readJsonStrict(RunSpec, join(path, "spec.json"));
		assert.equal(spec.launch.name, "four");
		assert.equal(
			await verifiedPane(tmux, retained, spec.launch.childSessionFile),
			undefined,
		);
		await run.waitFor(
			() => !processAlive(retained.process),
			"retained rollback child process exits",
		);
		t.diagnostic(
			`Rollback retained its recovery record because exit was not immediate: ${JSON.stringify(retained)}`,
		);
	}
	assert.ok(
		await verifiedPane(tmux, middle.pane, middle.spec.launch.childSessionFile),
	);
	await run.sendKeys(middle.pane.paneId, "/quit");
	const message = await run.waitFor(
		() =>
			run
				.readParent()
				.filter(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === "subagent_result",
				)
				.map(customMessage)
				.find((entry) => entry.details.runId === middle.spec.runId),
		"middle child result after unsafe cleanup balance",
	);
	assert.equal(
		parseStrict(ResultDetails, message.details, "row cleanup result").status,
		"completed",
	);
	await run.waitFor(
		() => !existsSync(middle.path),
		"middle child cleanup acknowledged",
	);
	assert.equal((await tmux.listPanes()).has(middle.pane.paneId), false);
	const afterCleanup = await geometry(run);
	t.diagnostic(
		`After cleanup: ${JSON.stringify(afterCleanup)}\nResize audit: ${JSON.stringify(readFileSync(audit, "utf8"))}\nParent UI:\n${await run.capture()}\nUser UI:\n${await run.capture(user)}`,
	);
	assert.deepEqual(
		afterCleanup.filter((pane) => users.some((saved) => saved.id === pane.id)),
		users,
	);
	assert.equal(
		readFileSync(audit, "utf8"),
		"",
		"cleanup must not resize a row subtree",
	);
	assert.deepEqual(await tmux.serverIdentity(), server);
	await resource.release();
});
