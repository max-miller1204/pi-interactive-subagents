import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { processAlive, processIdentity } from "../../src/process.ts";
import {
	PaneFile,
	type ProcessIdentity,
	RunSpec,
	readJsonStrict,
} from "../../src/schema.ts";
import { createTmux } from "../../src/tmux.ts";
import {
	customMessage,
	readBranch,
	type Scenario,
	scenario,
} from "./harness.ts";

const script = (steps: unknown[]) => `#script ${JSON.stringify(steps)}`;
const spawn = (name: string, agent = "worker") => ({
	call: "subagent",
	args: {
		agent,
		profile: "test",
		name,
		task: script([{ say: `${name} ready.` }]),
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
	}, `${name} launch`);
}

test("ancestor polling and sibling cleanup continue during a descendant split before respawn", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-split-barrier-"));
	const bin = join(root, "bin");
	mkdirSync(bin);
	const target = join(root, "target");
	const entered = join(root, "entered");
	const release = join(root, "release");
	const realTmux = execFileSync("/bin/sh", ["-c", "command -v tmux"], {
		encoding: "utf8",
	}).trim();
	assert.ok(realTmux.startsWith("/"));
	assert.ok(process.env.PATH);
	// Only the descendant's split pauses. Other clients use the same private server.
	writeFileSync(
		join(bin, "tmux"),
		`#!${process.execPath}
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
(async () => {
 const args = process.argv.slice(2);
 const result = spawnSync(${JSON.stringify(realTmux)}, args, { encoding: 'utf8' });
 if (result.error) throw result.error;
 process.stderr.write(result.stderr);
 if (result.status === null) throw new Error('tmux exited on signal ' + result.signal);
 if (result.status !== 0) { process.stdout.write(result.stdout); process.exit(result.status); }
 if (args[2] === 'split-window' && existsSync(${JSON.stringify(target)}) && process.env.TMUX_PANE === readFileSync(${JSON.stringify(target)}, 'utf8')) {
  writeFileSync(${JSON.stringify(entered)}, JSON.stringify({ pane: result.stdout.trim(), caller: process.env.TMUX_PANE, pid: process.ppid }), { flag: 'wx' });
  const deadline = Date.now() + 30000;
  while (!existsSync(${JSON.stringify(release)})) {
   if (Date.now() > deadline) throw new Error('Descendant split barrier timed out');
   await new Promise(resolve => setTimeout(resolve, 20));
  }
 }
 process.stdout.write(result.stdout);
})().catch(error => { console.error(error); process.exitCode = 1; });
`,
		{ mode: 0o700 },
	);
	const run = await scenario(t, {
		commandPath: `${bin}:${process.env.PATH}`,
		agents: {
			worker:
				"---\ndescription: Split race worker.\ntools: []\nspawns: [scout]\nauto-exit: false\n---\nComplete the task.\n",
			scout:
				"---\ndescription: Split race grandchild.\ntools: []\nauto-exit: false\n---\nComplete the task.\n",
		},
		prompt: script([
			spawn("descendant"),
			spawn("sibling"),
			{ say: "Ancestor ready." },
			{ say: "Sibling completed." },
		]),
	}).finally(() =>
		t.after(() => rmSync(root, { recursive: true, force: true })),
	);
	const descendant = await child(run, "descendant");
	const sibling = await child(run, "sibling");
	for (const entry of [sibling, descendant])
		await run.waitFor(
			() =>
				readBranch(entry.spec.launch.childSessionFile).some(
					(item) =>
						item.type === "message" &&
						item.message.role === "assistant" &&
						item.message.content.some(
							(block) =>
								block.type === "text" &&
								block.text === `${entry.spec.launch.name} ready.`,
						),
				),
			`${entry.spec.launch.name} assistant ready`,
		);
	writeFileSync(target, descendant.pane.paneId);
	await run.sendKeys(
		descendant.pane.paneId,
		script([
			spawn("grandchild", "scout"),
			{ say: "Descendant launch completed." },
		]),
	);
	let bootstrap: { paneId: string; process: ProcessIdentity } | undefined;
	try {
		await run.waitFor(
			() => existsSync(entered),
			"descendant inside split-to-respawn interval",
		);
		const barrier = JSON.parse(readFileSync(entered, "utf8"));
		assert.equal(barrier.caller, descendant.pane.paneId);
		assert.equal(
			barrier.pid,
			descendant.pane.process.pid,
			"split executes in the descendant Pi process",
		);
		const ancestorPid = Number(
			await run.tmux([
				"display-message",
				"-p",
				"-t",
				run.parentPane,
				"#{pane_pid}",
			]),
		);
		assert.notEqual(barrier.pid, ancestorPid);
		t.diagnostic(
			`Split barrier: ${JSON.stringify(barrier)}; ancestor PID: ${ancestorPid}`,
		);
		// A completed sibling proves the ancestor actually polled, not only that a direct snapshot works.
		await run.sendKeys(sibling.pane.paneId, "/quit");
		await run.waitFor(
			() =>
				run
					.readParent()
					.filter(
						(entry) =>
							entry.type === "custom_message" &&
							entry.customType === "subagent_result",
					)
					.map(customMessage)
					.find((entry) => entry.details.runId === sibling.spec.runId),
			"ancestor sibling result while descendant split is paused",
		);
		await run.waitFor(
			() => !existsSync(sibling.path),
			"ancestor sibling cleanup while descendant split is paused",
		);
		const panes = await createTmux(run.socket).listPanes();
		const state = panes.get(barrier.pane);
		assert.ok(state);
		assert.equal(state.session, "");
		const identity = processIdentity(state.pid);
		assert.ok(identity);
		bootstrap = { paneId: state.paneId, process: identity };
		assert.equal(panes.has(sibling.pane.paneId), false);
		const ui = await run.capture();
		t.diagnostic(`Ancestor UI during descendant split:\n${ui}`);
		assert.doesNotMatch(ui, /Malformed tmux (pane line|geometry)/);
	} finally {
		writeFileSync(release, "release");
		t.diagnostic(`Ancestor UI at barrier release:\n${await run.capture()}`);
		t.diagnostic(
			`Descendant UI at barrier release:\n${await run.capture(descendant.pane.paneId)}`,
		);
	}
	const grandchild = await child(run, "grandchild");
	assert.ok(bootstrap);
	const savedBootstrap = bootstrap;
	assert.equal(grandchild.pane.paneId, savedBootstrap.paneId);
	assert.notEqual(grandchild.pane.process.pid, savedBootstrap.process.pid);
	await run.waitFor(
		() => !processAlive(savedBootstrap.process),
		"bootstrap exits after respawn",
	);
	await run.waitFor(
		() =>
			readBranch(grandchild.spec.launch.childSessionFile).some(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.content.some(
						(block) =>
							block.type === "text" && block.text === "grandchild ready.",
					),
			),
		"grandchild assistant ready",
	);
	for (const pane of [
		run.parentPane,
		descendant.pane.paneId,
		grandchild.pane.paneId,
	]) {
		const ui = await run.capture(pane);
		t.diagnostic(`Final UI ${pane}:\n${ui}`);
		assert.doesNotMatch(
			ui,
			/Malformed tmux (pane line|geometry)|missing step|split barrier timed out/,
		);
	}
});
