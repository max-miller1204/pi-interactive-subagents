import assert from "node:assert/strict";
import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { type TestContext, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents } from "../../src/config.ts";
import { processAlive, processIdentity } from "../../src/process.ts";
import * as queue from "../../src/queue.ts";
import {
	ChildStatus,
	PaneFile,
	ParentMessageDetails,
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
	trackedResource,
} from "./harness.ts";

const script = (steps: unknown[]) => `#script ${JSON.stringify(steps)}`;
const agent = (extra = "", tools: string[] = []) =>
	`---\ndescription: Layout test worker.\ntools: ${JSON.stringify(tools)}\n${extra}---\nComplete the task.\n`;
const spawn = (task: string, name = "worker") => ({
	call: "subagent",
	args: { agent: "worker", profile: "test", task, name },
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
async function active(run: Scenario, name = "worker") {
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
	}, `active ${name}`);
}
async function visible(
	t: TestContext,
	run: Scenario,
	expected: string,
	pane = run.parentPane,
) {
	const first = expected.split("\n")[0];
	assert.ok(first);
	const prefix = first.slice(0, Math.min(30, first.length));
	const screen = await run.waitFor(async () => {
		const text = await run.capture(pane);
		return text.replace(/\s/g, "").includes(expected.replace(/\s/g, "")) &&
			text
				.split("\n")
				.some((line) => line.includes(prefix) && line.indexOf(prefix) <= 4)
			? text
			: undefined;
	}, `complete UI text ${expected}`);
	t.diagnostic(`UI ${pane}:\n${screen}`);
	const raw = await run.tmux(["capture-pane", "-p", "-S", "-80", "-t", pane]);
	const width = integer(
		await run.tmux(["display-message", "-p", "-t", pane, "#{pane_width}"]),
	);
	assert.ok(
		raw.split("\n").every((line) => visibleWidth(line) <= width),
		"UI must fit the pane",
	);
	assert.ok(
		screen
			.split("\n")
			.some((line) => line.includes(prefix) && line.indexOf(prefix) <= 4),
		`UI is cut or misaligned: ${prefix}`,
	);
	return screen;
}
function integer(text: string) {
	assert.match(text, /^[1-9][0-9]*$/);
	const value = Number(text);
	assert.ok(Number.isSafeInteger(value));
	return value;
}
async function verified(
	run: Scenario,
	child: Awaited<ReturnType<typeof active>>,
) {
	const pane = await verifiedPane(
		createTmux(run.socket),
		child.pane,
		child.spec.launch.childSessionFile,
	);
	assert.ok(pane);
	return pane;
}
async function result(
	t: TestContext,
	run: Scenario,
	child: Awaited<ReturnType<typeof active>>,
) {
	const message = await run.waitFor(
		() =>
			messages(run.parentFile, "subagent_result").find(
				(item) => item.details.runId === child.spec.runId,
			),
		"result delivery",
	);
	const details = parseStrict(ResultDetails, message.details, "layout result");
	assert.equal(details.deliveryId, `${child.spec.runId}:result`);
	assert.equal(details.childSessionFile, child.spec.launch.childSessionFile);
	assert.equal(
		messages(run.parentFile, "subagent_result").filter(
			(item) => item.details.deliveryId === details.deliveryId,
		).length,
		1,
	);
	await visible(t, run, `${details.name}  worker  ${details.status}`);
	await run.tmux(["send-keys", "-t", run.parentPane, "C-o"]);
	await visible(t, run, message.content);
	t.diagnostic(`Result: ${JSON.stringify(details)}`);
	return details;
}
async function quitParent(run: Scenario) {
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
		"parent exit",
	);
}

test("19.3.25: a steer after the exit decision remains unread in the result", async (t) => {
	const run = await scenario(t, {
		agents: { worker: agent() },
		prompt: script([{ say: "Late test ready." }]),
	});
	await visible(t, run, "Late test ready.");
	const marker = join(run.root, "exit-decision.json");
	const release = join(run.root, "release-exit");
	const fixture = join(run.root, "exit-gate.ts");
	writeFileSync(
		fixture,
		`import { existsSync, writeFileSync } from 'node:fs';\nexport default function(pi) {\n pi.on('session_shutdown', async (event, ctx) => {\n  const run = process.argv.find(word => word.startsWith('--subagent-run='));\n  if (!run) return;\n  if (event.reason !== 'quit') throw new Error('Expected child auto-exit quit.');\n  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid, runDir:run.slice(15), session:ctx.sessionManager.getSessionFile()}));\n  const deadline = Date.now() + 20000;\n  while (!existsSync(${JSON.stringify(release)})) {\n   if (Date.now() > deadline) throw new Error('Exit gate was not released.');\n   await new Promise(resolve => setTimeout(resolve, 20));\n  }\n });\n}\n`,
	);
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
						fixture,
					],
				},
			},
		}),
	);
	await run.sendKeys(run.parentPane, "/reload");
	await visible(t, run, "Reloaded");
	await run.sendKeys(
		run.parentPane,
		script([
			spawn(script([{ say: "Exit decision reached." }])),
			{ say: "Child started." },
			{ say: "Late result received." },
		]),
	);
	const child = await active(run);
	await run.waitFor(
		() => existsSync(marker),
		"shutdown hook after autonomous exit decision",
	);
	assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), {
		pid: child.pane.process.pid,
		runDir: child.path,
		session: child.spec.launch.childSessionFile,
	});
	assert.equal((await verified(run, child)).dead, false);
	assert.equal(
		readJsonStrict(ChildStatus, join(child.path, "status.json")).human,
		false,
	);
	const text = "Late steer must be reported, not lost.";
	await run.sendKeys(
		run.parentPane,
		script([
			{ call: "subagent_message", args: { name: "worker", message: text } },
			{ say: "Late steer queued." },
			{ say: "Late result received." },
		]),
	);
	const inbox = join(child.path, "inbox");
	const queued = await run.waitFor(() => {
		const entries = queue.list(inbox, "inbox");
		return entries.length === 1 ? entries[0] : undefined;
	}, "late steer in inbox");
	assert.deepEqual(queued.item, { v: 1, kind: "message", text });
	assert.equal(
		messages(child.spec.launch.childSessionFile, "parent_message").length,
		0,
	);
	t.diagnostic(
		`Exit boundary: ${readFileSync(marker, "utf8")}; queue: ${JSON.stringify(queued)}`,
	);
	writeFileSync(release, "release");
	const details = await result(t, run, child);
	assert.equal(details.status, "completed");
	assert.deepEqual(details.undelivered, [text]);
	assert.equal(details.text, "Exit decision reached.");
	assert.equal(
		messages(child.spec.launch.childSessionFile, "parent_message").map((item) =>
			parseStrict(ParentMessageDetails, item.details, "late child message"),
		).length,
		0,
	);
	await run.waitFor(() => !existsSync(child.path), "late run cleanup");
});

test("19.3.26: stale server environment is excluded from the real child", async (t) => {
	const run = await scenario(t, {
		extensionPaths: [resolve("test/fixtures/lifecycle-tools.ts")],
		agents: { worker: agent("auto-exit: false\n", ["lifecycle_probe"]) },
		prompt: script([{ say: "Environment ready." }]),
	});
	await visible(t, run, "Environment ready.");
	const tmux = createTmux(run.socket);
	const server = await tmux.serverIdentity();
	t.after(async () => {
		assert.deepEqual(await tmux.serverIdentity(), server);
		await run.tmux(["set-environment", "-gu", "STALE"]);
	});
	await run.tmux(["set-environment", "-g", "STALE", "x"]);
	assert.equal(await run.tmux(["show-environment", "-g", "STALE"]), "STALE=x");
	await run.sendKeys(
		run.parentPane,
		script([
			spawn(
				script([
					{ call: "lifecycle_probe", args: { environment: true } },
					{ say: "Environment isolated." },
				]),
			),
			{ say: "Environment child started." },
			{ say: "Environment result received." },
		]),
	);
	const child = await active(run);
	await visible(t, run, "Environment isolated.", child.pane.paneId);
	assert.equal((await verified(run, child)).dead, false);
	assert.equal(processAlive(child.pane.process), true);
	const probes = readBranch(child.spec.launch.childSessionFile).filter(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolName === "lifecycle_probe",
	);
	assert.equal(probes.length, 1);
	const probe = probes[0];
	assert.ok(probe?.type === "message" && probe.message.role === "toolResult");
	assert.equal(probe.message.isError, false);
	const environment = parseStrict(
		Type.Object(
			{
				pid: Type.Integer({ minimum: 1 }),
				sessionFile: Type.String(),
				runDir: Type.String(),
				tmux: Type.String(),
				tmuxPane: Type.String(),
				stalePresent: Type.Boolean(),
			},
			{ additionalProperties: false },
		),
		probe.message.details,
		"live child environment probe",
	);
	const sessionId = await run.tmux([
		"display-message",
		"-p",
		"-t",
		child.pane.paneId,
		"#{session_id}",
	]);
	assert.match(sessionId, /^\$[0-9]+$/);
	assert.deepEqual(environment, {
		pid: child.pane.process.pid,
		sessionFile: child.spec.launch.childSessionFile,
		runDir: child.path,
		tmux: `${run.socket},${server.process.pid},${sessionId.slice(1)}`,
		tmuxPane: child.pane.paneId,
		stalePresent: false,
	});
	assert.deepEqual(processIdentity(child.pane.process.pid), child.pane.process);
	assert.equal((await verified(run, child)).dead, false);
	t.diagnostic(`Live child environment probe: ${JSON.stringify(environment)}`);
	await run.sendKeys(child.pane.paneId, "/quit");
	assert.equal((await result(t, run, child)).status, "completed");
});

test("19.3.27: killed test parent leaves an open orphan and one stopped recovery record", async (t) => {
	const run = await scenario(t, {
		agents: { worker: agent() },
		prompt: script([
			spawn(script([{ hang: true }])),
			{ say: "Orphan child started." },
		]),
	});
	const child = await active(run);
	await run.waitFor(
		() =>
			existsSync(join(child.path, "status.json")) &&
			readJsonStrict(ChildStatus, join(child.path, "status.json")).state ===
				"working",
		"orphan child working",
	);
	const tmux = createTmux(run.socket);
	const server = await tmux.serverIdentity();
	const parent = (await tmux.listPanes()).get(run.parentPane);
	assert.ok(parent && !parent.dead);
	assert.equal(parent.pid, child.spec.owner.pid);
	assert.notEqual(parent.pid, process.pid);
	assert.notEqual(parent.pid, process.ppid);
	assert.notEqual(parent.pid, server.process.pid);
	assert.notEqual(run.parentPane, process.env.TMUX_PANE);
	const saved = parseStrict(
		PaneFile,
		{ v: 1, paneId: run.parentPane, process: child.spec.owner, server },
		"test parent identity",
	);
	assert.ok(await verifiedPane(tmux, saved, parent.session));
	assert.deepEqual(processIdentity(parent.pid), child.spec.owner);
	assert.equal(child.spec.spawnerSessionFile, realpathSync(run.parentFile));
	const runnerIdentity = processIdentity(process.pid);
	assert.ok(runnerIdentity);
	process.kill(parent.pid, "SIGKILL");
	await run.waitFor(
		() => !processAlive(child.spec.owner),
		"only test parent exits",
	);
	assert.deepEqual(processIdentity(process.pid), runnerIdentity);
	const notice = `The parent Pi process ended without a quit. This pane is now a normal Pi session. Its result is not delivered. Session: ${child.spec.launch.childSessionFile}`;
	await visible(t, run, `Error: ${notice}`, child.pane.paneId);
	assert.equal((await verified(run, child)).dead, false);
	assert.equal(processAlive(child.pane.process), true);
	assert.equal(existsSync(join(child.path, "result.json")), false);
	await run.sendKeys(child.pane.paneId, "/quit");
	await run.waitFor(() => !processAlive(child.pane.process), "orphan exit");
	assert.equal((await verified(run, child)).dead, true);
	// A different session keeps the stopped record available for a strict disk check.
	const recoverySession = join(run.root, "recovery.jsonl");
	writeFileSync(
		recoverySession,
		`${JSON.stringify({ id: "layout-recovery", type: "session", version: 3, timestamp: new Date().toISOString(), cwd: run.cwd })}\n`,
	);
	await run.reopen(recoverySession);
	const folder = join(
		run.agentDir,
		"subagent-runs",
		"undelivered",
		child.spec.spawnerSessionId,
	);
	await run.waitFor(
		() => existsSync(folder) && readdirSync(folder).length === 1,
		"one stopped recovery record",
	);
	const files = readdirSync(folder);
	assert.deepEqual(files, [`${child.spec.runId}.json`]);
	const record = readJsonStrict(
		UndeliveredRecord,
		join(folder, files[0] as string),
	);
	assert.equal(record.kind, "stopped");
	assert.deepEqual(record.launch, child.spec.launch);
	assert.equal(record.runId, child.spec.runId);
	await run.waitFor(
		() => !existsSync(child.path),
		"recovered orphan directory cleanup",
	);
	assert.equal((await tmux.listPanes()).has(child.pane.paneId), false);
	assert.deepEqual(await tmux.serverIdentity(), server);
	t.diagnostic(
		`Killed test parent: ${JSON.stringify(saved)}; orphan: ${JSON.stringify(child.pane)}; recovery: ${JSON.stringify(record)}`,
	);
	await quitParent(run);
	await run.reopen(run.parentFile);
	const delivered = await run.waitFor(
		() => messages(run.parentFile, "subagent_notice")[0],
		"orphan recovery notice",
	);
	assert.equal(delivered.details.deliveryId, `notice:${child.spec.runId}`);
	assert.equal(messages(run.parentFile, "subagent_notice").length, 1);
	await visible(t, run, "Subagent delivery notice: worker");
	await run.tmux(["send-keys", "-t", run.parentPane, "C-o"]);
	await visible(t, run, delivered.content);
});

async function layout(run: Scenario) {
	const output = await run.tmux([
		"list-panes",
		"-t",
		run.parentPane,
		"-F",
		"#{pane_id}\t#{pane_width}\t#{pane_height}\t#{window_width}",
	]);
	return output.split("\n").map((line) => {
		const fields = line.split("\t");
		assert.equal(fields.length, 4);
		const [pane, width, height, windowWidth] = fields;
		assert.ok(pane && width && height && windowWidth);
		assert.match(pane, /^%[0-9]+$/);
		return {
			pane,
			width: integer(width),
			height: integer(height),
			windowWidth: integer(windowWidth),
		};
	});
}

test("19.3.28: three child panes share one even column without resizing the user pane", async (t) => {
	const run = await scenario(t, {
		agents: { worker: agent("auto-exit: false\n") },
		prompt: script([{ say: "Layout parent ready." }]),
	});
	await visible(t, run, "Layout parent ready.");
	const tmux = createTmux(run.socket);
	const resource = trackedResource(
		t,
		"layout user pane",
		async (saved: { pane: PaneFile; session: string }) => {
			const current = await verifiedPane(tmux, saved.pane, saved.session);
			if (current) await tmux.run(["kill-pane", "-t", saved.pane.paneId]);
		},
		(reason) => run.retainFiles(reason),
	);
	const server = await tmux.serverIdentity();
	resource.acquiring();
	const userPane = (
		await run.tmux([
			"split-window",
			"-d",
			"-h",
			"-b",
			"-l",
			"25%",
			"-t",
			run.parentPane,
			"-P",
			"-F",
			"#{pane_id}",
			"printf 'User pane stays intact.\\n'; exec sleep 300",
		])
	).trim();
	const state = (await tmux.listPanes()).get(userPane);
	assert.ok(state);
	const identity = processIdentity(state.pid);
	assert.ok(identity);
	resource.identified({
		pane: parseStrict(
			PaneFile,
			{ v: 1, paneId: userPane, process: identity, server },
			"user pane",
		),
		session: state.session,
	});
	const secondResource = trackedResource(
		t,
		"second layout user pane",
		async (saved: { pane: PaneFile; session: string }) => {
			if (await verifiedPane(tmux, saved.pane, saved.session))
				await tmux.run(["kill-pane", "-t", saved.pane.paneId]);
		},
		(reason) => run.retainFiles(reason),
	);
	secondResource.acquiring();
	const secondUser = (
		await run.tmux([
			"split-window",
			"-d",
			"-v",
			"-t",
			userPane,
			"-P",
			"-F",
			"#{pane_id}",
			"printf 'Second user pane stays intact.\\n'; exec sleep 300",
		])
	).trim();
	const secondState = (await tmux.listPanes()).get(secondUser);
	assert.ok(secondState);
	const secondIdentity = processIdentity(secondState.pid);
	assert.ok(secondIdentity);
	secondResource.identified({
		pane: parseStrict(
			PaneFile,
			{ v: 1, paneId: secondUser, process: secondIdentity, server },
			"second user pane",
		),
		session: secondState.session,
	});
	const before = await layout(run);
	const users = before.filter(
		(row) => row.pane === userPane || row.pane === secondUser,
	);
	assert.equal(users.length, 2);
	await visible(t, run, "User pane stays intact.", userPane);
	await visible(t, run, "Second user pane stays intact.", secondUser);
	t.diagnostic(`Layout before: ${JSON.stringify(before)}`);
	const children: Awaited<ReturnType<typeof active>>[] = [];
	for (const name of ["one", "two", "three"]) {
		await run.sendKeys(
			run.parentPane,
			script([
				spawn(script([{ say: `Child ${name} complete.` }]), name),
				{ say: `Parent started ${name}.` },
				{ say: "First layout result received." },
				{ say: "Second layout result received." },
				{ say: "Third layout result received." },
			]),
		);
		const child = await active(run, name);
		children.push(child);
		await visible(t, run, `Child ${name} complete.`, child.pane.paneId);
		const after = await layout(run);
		assert.deepEqual(
			after.filter((row) => users.some((user) => row.pane === user.pane)),
			users,
		);
		const column = after.filter((row) =>
			children.some((item) => item.pane.paneId === row.pane),
		);
		assert.equal(column.length, children.length);
		assert.equal(new Set(column.map((row) => row.width)).size, 1);
		assert.ok(
			Math.max(...column.map((row) => row.height)) -
				Math.min(...column.map((row) => row.height)) <=
				1,
			"child heights must be even",
		);
		const positions = await Promise.all(
			children.map((item) =>
				run.tmux([
					"display-message",
					"-p",
					"-t",
					item.pane.paneId,
					"#{pane_left}",
				]),
			),
		);
		assert.ok(positions.every((value) => /^[0-9]+$/.test(value)));
		assert.equal(new Set(positions).size, 1, "children must occupy one column");
		t.diagnostic(
			`Layout after ${name}: ${JSON.stringify(after)}; left=${JSON.stringify(positions)}`,
		);
		await visible(t, run, `Parent started ${name}.`);
		await visible(t, run, "User pane stays intact.", userPane);
		await visible(t, run, "Second user pane stays intact.", secondUser);
	}
	for (const child of children) {
		await visible(
			t,
			run,
			`Child ${child.spec.launch.name} complete.`,
			child.pane.paneId,
		);
		assert.equal((await verified(run, child)).dead, false);
	}
	const remaining = [...children];
	for (const index of [1, 0, 2]) {
		const child = children[index];
		assert.ok(child);
		await verified(run, child);
		await run.sendKeys(child.pane.paneId, "/quit");
		const message = await run.waitFor(
			() =>
				messages(run.parentFile, "subagent_result").find(
					(item) => item.details.runId === child.spec.runId,
				),
			"layout cleanup result",
		);
		const details = parseStrict(
			ResultDetails,
			message.details,
			"layout cleanup result",
		);
		assert.equal(details.status, "completed");
		assert.equal(details.childSessionFile, child.spec.launch.childSessionFile);
		await run.waitFor(
			() => !existsSync(child.path),
			"layout cleanup acknowledgement",
		);
		assert.equal((await tmux.listPanes()).has(child.pane.paneId), false);
		remaining.splice(remaining.indexOf(child), 1);
		const after = await layout(run);
		assert.deepEqual(
			after.filter((row) => users.some((user) => user.pane === row.pane)),
			users,
		);
		const column = after.filter((row) =>
			remaining.some((item) => item.pane.paneId === row.pane),
		);
		assert.equal(column.length, remaining.length);
		if (column.length > 0) {
			assert.equal(new Set(column.map((row) => row.width)).size, 1);
			assert.ok(
				Math.max(...column.map((row) => row.height)) -
					Math.min(...column.map((row) => row.height)) <=
					1,
			);
		}
		t.diagnostic(
			`Layout after cleanup ${child.spec.launch.name}: ${JSON.stringify(after)}`,
		);
		await visible(t, run, `${child.spec.launch.name}  worker  completed`);
		await visible(t, run, "User pane stays intact.", userPane);
		await visible(t, run, "Second user pane stays intact.", secondUser);
	}
	await visible(t, run, "Third layout result received.");
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
	await secondResource.release();
	await resource.release();
});

test("19.3.29: explicit symlinks resolve agent, session, extension and run paths", async (t) => {
	const run = await scenario(t, {
		extensionPaths: [resolve("test/fixtures/lifecycle-tools.ts")],
		agents: {
			worker: agent("auto-exit: false\nspawns: [helper]\n", [
				"lifecycle_probe",
			]),
			helper: agent(),
		},
		prompt: script([{ say: "Real paths ready." }]),
	});
	await visible(t, run, "Real paths ready.");
	await quitParent(run);
	const alias = join(run.root, "agent-link");
	const sessionAlias = join(run.root, "parent-link.jsonl");
	const repoAlias = join(run.root, "repo-link");
	const extensionAlias = join(repoAlias, "src/index.ts");
	const fixtureAlias = join(repoAlias, "test/fixtures/faux-brain.ts");
	symlinkSync(run.agentDir, alias, "dir");
	symlinkSync(run.parentFile, sessionAlias);
	symlinkSync(realpathSync(resolve(".")), repoAlias, "dir");
	for (const path of [alias, sessionAlias, repoAlias])
		assert.equal(lstatSync(path).isSymbolicLink(), true);
	if (process.platform === "darwin")
		assert.match(run.root, /^\/private\/var\/folders\//);
	const reopen = join(run.root, "reopen.sh");
	writeFileSync(
		reopen,
		readFileSync(reopen, "utf8")
			.replace(
				`PI_CODING_AGENT_DIR=${run.agentDir}`,
				`PI_CODING_AGENT_DIR=${alias}`,
			)
			.replace(realpathSync(resolve("src/index.ts")), extensionAlias),
	);
	writeFileSync(
		join(alias, "subagent-profiles.json"),
		JSON.stringify({
			profiles: {
				test: {
					model: "faux/brain",
					thinking: "off",
					guidance: "Test profile.",
					extensions: [fixtureAlias],
				},
			},
		}),
	);
	await run.reopen(sessionAlias);
	await visible(t, run, "Real paths ready.");
	await run.sendKeys(
		run.parentPane,
		script([
			spawn(
				script([
					{ call: "lifecycle_probe", args: {} },
					{ say: "Canonical child output." },
				]),
			),
			{ say: "Canonical child started." },
			{ say: "Canonical result received." },
		]),
	);
	const child = await active(run);
	await visible(t, run, "Canonical child output.", child.pane.paneId);
	assert.equal(child.spec.spawnerSessionFile, realpathSync(sessionAlias));
	assert.equal(
		child.spec.launch.childSessionFile,
		realpathSync(child.spec.launch.childSessionFile),
	);
	assert.equal(child.path, realpathSync(child.path));
	assert.ok(
		child.path.startsWith(`${realpathSync(alias)}/subagent-runs/owners/`),
	);
	assert.deepEqual(child.spec.launch.extensions, [
		realpathSync(resolve("test/fixtures/lifecycle-tools.ts")),
		realpathSync(fixtureAlias),
	]);
	assert.ok(child.spec.launch.nested);
	const helper = child.spec.launch.nested.agents.helper;
	assert.ok(helper);
	assert.equal(helper.file, realpathSync(join(alias, "agents", "helper.md")));
	const discovery = discoverAgents(
		{ cwd: run.cwd, isProjectTrusted: () => true },
		extensionAlias,
		alias,
	);
	const worker = discovery.agents.get("worker");
	assert.ok(worker && "file" in worker);
	assert.equal(worker.file, realpathSync(join(alias, "agents", "worker.md")));
	const probe = readBranch(child.spec.launch.childSessionFile).find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolName === "lifecycle_probe",
	);
	assert.ok(probe?.type === "message" && probe.message.role === "toolResult");
	assert.equal(probe.message.isError, false);
	const observed = parseStrict(
		Type.Object(
			{
				active: Type.Array(Type.String()),
				argv: Type.Array(Type.String()),
				loaded: Type.Literal(true),
				pid: Type.Integer({ minimum: 1 }),
				sessionFile: Type.String(),
				runDir: Type.String(),
			},
			{ additionalProperties: false },
		),
		probe.message.details,
		"real-path child probe",
	);
	assert.equal(observed.pid, (await verified(run, child)).pid);
	assert.equal(observed.sessionFile, child.spec.launch.childSessionFile);
	assert.equal(observed.runDir, child.path);
	const argv = observed.argv.join(" ");
	for (const path of [
		realpathSync(extensionAlias),
		realpathSync(fixtureAlias),
		child.spec.launch.childSessionFile,
		child.path,
	])
		assert.ok(argv.includes(path), `missing real argv path ${path}`);
	for (const path of [sessionAlias, extensionAlias, fixtureAlias])
		assert.ok(!argv.includes(path));
	for (const entry of run
		.readParent()
		.filter(
			(entry) => entry.type === "custom" && entry.customType === "subagent",
		)) {
		assert.equal(entry.type, "custom");
		const record = parseStrict(
			RegistryRecord,
			entry.data,
			"real-path registry",
		);
		if (record.kind === "spawn")
			assert.deepEqual(record.launch, child.spec.launch);
	}
	t.diagnostic(
		`Symlinks: ${JSON.stringify({ alias, sessionAlias, extensionAlias, fixtureAlias })}\nSpec: ${JSON.stringify(child.spec)}\nChild argv: ${argv}`,
	);
	await run.sendKeys(child.pane.paneId, "/quit");
	assert.equal((await result(t, run, child)).status, "completed");
});
