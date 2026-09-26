import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readRunBackend, writeRunBackend } from "../../src/run-backend.ts";
import { writeJsonAtomic } from "../../src/schema.ts";

const pane = {
	v: 1 as const,
	paneId: "%7",
	process: { pid: 123, start: "child start" },
	server: {
		socket: "/tmp/tmux.sock",
		process: { pid: 90, start: "server start" },
	},
};

test("new pane identity reads from backend.json", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "run-backend-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeRunBackend(dir, { kind: "pane", pane });
	assert.deepEqual(readRunBackend(dir), { kind: "pane", pane });
});

test("a valid legacy pane identity reads without backend.json", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "run-backend-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeJsonAtomic(join(dir, "pane.json"), pane);
	assert.deepEqual(readRunBackend(dir), { kind: "pane", pane });
});

test("a corrupt backend record does not use legacy pane identity", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "run-backend-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeJsonAtomic(join(dir, "pane.json"), pane);
	writeJsonAtomic(join(dir, "backend.json"), {
		v: 1,
		kind: "widget",
		child: pane.process,
	});
	assert.throws(() => readRunBackend(dir), /backend\.json/);
});
