import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");

test("rejects a mismatched Pi executable", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-version-test-"));
	try {
		const pi = join(dir, "pi");
		writeFileSync(pi, "#!/bin/sh\necho 0.0.0\n");
		chmodSync(pi, 0o755);
		const result = spawnSync(
			process.execPath,
			[join(root, "scripts/check-pi-version.mjs")],
			{
				cwd: root,
				encoding: "utf8",
				env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
			},
		);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /0\.0\.0/);
		assert.match(result.stderr, /0\.87\.1/);
		assert.match(result.stderr, /update|install/i);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cleans the private tmux server after a failing test", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-tmux-test-"));
	try {
		const fixture = join(dir, "fail.test.mjs");
		writeFileSync(
			fixture,
			'import test from "node:test";\ntest("fails", () => { throw new Error("fixture failure"); });\n',
		);
		const environment = { ...process.env };
		delete environment.NODE_TEST_CONTEXT;
		const result = spawnSync(
			process.execPath,
			[
				join(root, "scripts/run-tests.mjs"),
				"--isolated-tmux",
				"--test",
				fixture,
			],
			{
				cwd: root,
				encoding: "utf8",
				env: environment,
			},
		);
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stdout + result.stderr, /fixture failure/);
		const server = spawnSync(
			"tmux",
			[
				"-L",
				`pi-subagents-test-${result.pid}`,
				"-f",
				"/dev/null",
				"has-session",
			],
			{
				encoding: "utf8",
			},
		);
		assert.equal(server.status, 1, "the private tmux server still runs");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
