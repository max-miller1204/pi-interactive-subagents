import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type TestContext, test } from "node:test";
import { processAlive } from "../../src/process.ts";
import type { RunSpec } from "../../src/schema.ts";
import { connectSupervisor } from "../../src/widget-client.ts";
import { startSupervisor } from "../../src/widget-supervisor.ts";

const fixture = resolve("test/fixtures/widget-rpc-child.mjs");

function setup(t: TestContext) {
	const runDir = mkdtempSync(join(tmpdir(), "widget-supervisor-"));
	const log = join(runDir, "rpc.log");
	t.after(() => rmSync(runDir, { recursive: true, force: true }));
	return { runDir, log };
}

function spec(runDir: string): RunSpec {
	return {
		runId: "24def062-85d2-4079-ac90-85d70c41103e",
		ownerKey: "owner-key",
		initialPrompt: "Do the task",
		launch: { cwd: runDir },
	} as RunSpec;
}

async function until(predicate: () => boolean, timeoutMs = 3000) {
	const end = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > end)
			throw new Error("Timed out waiting for widget process");
		await new Promise((done) => setTimeout(done, 20));
	}
}

test("supervisor prompts once and accepts a fresh connection", async (t) => {
	const { runDir, log } = setup(t);
	const backend = await startSupervisor(
		spec(runDir),
		runDir,
		[process.execPath, fixture],
		{ ...process.env, WIDGET_TEST_LOG: log },
	);
	t.after(() => {
		if (processAlive(backend.supervisor)) process.kill(backend.supervisor.pid);
	});
	await until(() => existsSync(log));
	const commands = readFileSync(log, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.equal(commands.length, 1);
	assert.equal(commands[0].type, "prompt");
	assert.equal(commands[0].message, "Do the task");
	assert.equal(statSync(backend.socket).mode & 0o777, 0o600);
	const first = await connectSupervisor(
		backend,
		spec(runDir).runId,
		"owner-key",
	);
	assert.equal((await first.status()).childAlive, true);
	const second = await connectSupervisor(
		backend,
		spec(runDir).runId,
		"owner-key",
	);
	assert.equal((await second.status()).childAlive, true);
	await second.stop();
	await until(() => !processAlive(backend.child));
});

test("rejects wrong run and owner before process control", async (t) => {
	const { runDir, log } = setup(t);
	const backend = await startSupervisor(
		spec(runDir),
		runDir,
		[process.execPath, fixture],
		{ ...process.env, WIDGET_TEST_LOG: log },
	);
	t.after(() => {
		if (processAlive(backend.supervisor)) process.kill(backend.supervisor.pid);
	});
	await assert.rejects(connectSupervisor(backend, "wrong-run", "owner-key"));
	await assert.rejects(
		connectSupervisor(backend, spec(runDir).runId, "wrong-owner"),
	);
	assert.equal(processAlive(backend.child), true);
	await (
		await connectSupervisor(backend, spec(runDir).runId, "owner-key")
	).stop();
});

test("stale process identity leaves the socket and child untouched", async (t) => {
	const { runDir, log } = setup(t);
	const backend = await startSupervisor(
		spec(runDir),
		runDir,
		[process.execPath, fixture],
		{ ...process.env, WIDGET_TEST_LOG: log },
	);
	t.after(() => {
		if (processAlive(backend.supervisor)) process.kill(backend.supervisor.pid);
	});
	const stale = {
		...backend,
		supervisor: { ...backend.supervisor, start: "Mon Jan  1 00:00:00 1900" },
	};
	await assert.rejects(
		connectSupervisor(stale, spec(runDir).runId, "owner-key"),
		/identity/,
	);
	assert.equal(existsSync(backend.socket), true);
	assert.equal(processAlive(backend.child), true);
	await (
		await connectSupervisor(backend, spec(runDir).runId, "owner-key")
	).stop();
});

test("child crash writes an exit record", async (t) => {
	const { runDir, log } = setup(t);
	const backend = await startSupervisor(
		spec(runDir),
		runDir,
		[process.execPath, fixture],
		{ ...process.env, WIDGET_TEST_LOG: log, WIDGET_TEST_CRASH: "1" },
	);
	await until(() => existsSync(join(runDir, "widget-exit.json")));
	const record = JSON.parse(
		readFileSync(join(runDir, "widget-exit.json"), "utf8"),
	);
	assert.equal(record.exitCode, 42);
	assert.equal(record.runId, spec(runDir).runId);
	assert.equal(processAlive(backend.child), false);
});

test("malformed Pi RPC output writes a failure record", async (t) => {
	const { runDir, log } = setup(t);
	const backend = await startSupervisor(
		spec(runDir),
		runDir,
		[process.execPath, fixture],
		{ ...process.env, WIDGET_TEST_LOG: log, WIDGET_TEST_MALFORMED: "1" },
	);
	await until(() => existsSync(join(runDir, "widget-exit.json")));
	const record = JSON.parse(
		readFileSync(join(runDir, "widget-exit.json"), "utf8"),
	);
	assert.match(record.error, /RPC output was malformed/);
	assert.equal(processAlive(backend.child), false);
});
