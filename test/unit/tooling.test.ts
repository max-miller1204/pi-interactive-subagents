import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const runner = join(root, "scripts/run-tests.mjs");

function serverStatus(pid: number): number | null {
	return spawnSync("tmux", [
		"-L",
		`pi-subagents-test-${pid}`,
		"-f",
		"/dev/null",
		"has-session",
	]).status;
}

function cleanEnvironment(): NodeJS.ProcessEnv {
	const environment = { ...process.env };
	delete environment.NODE_TEST_CONTEXT;
	return environment;
}

async function waitForServer(pid: number, readyFile: string): Promise<void> {
	const deadline = Date.now() + 3000;
	while (serverStatus(pid) !== 0 || !existsSync(readyFile)) {
		assert.ok(Date.now() < deadline, "private tmux server did not start");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

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

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	test(`cleans the private tmux server on ${signal}`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-tmux-signal-"));
		const fixture = join(dir, "wait.mjs");
		const readyFile = join(dir, "ready");
		writeFileSync(
			fixture,
			`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(readyFile)}, "ready");\nsetTimeout(() => {}, 2500);\n`,
		);
		const child = spawn(
			process.execPath,
			[runner, "--isolated-tmux", fixture],
			{
				cwd: root,
				env: cleanEnvironment(),
				stdio: "ignore",
			},
		);
		assert.ok(child.pid);
		try {
			await waitForServer(child.pid, readyFile);
			const exit = new Promise<number | null>((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error("signal cleanup timed out")),
					1000,
				);
				child.once("exit", (code) => {
					clearTimeout(timeout);
					resolve(code);
				});
			});
			child.kill(signal);
			assert.equal(await exit, 1);
			assert.equal(
				serverStatus(child.pid),
				1,
				"private tmux server still runs",
			);
		} finally {
			child.kill("SIGKILL");
			spawnSync("tmux", [
				"-L",
				`pi-subagents-test-${child.pid}`,
				"-f",
				"/dev/null",
				"kill-server",
			]);
			rmSync(dir, { recursive: true, force: true });
		}
	});
}

test("cleans the private tmux server after startup failure", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-tmux-startup-"));
	const realTmux = spawnSync("which", ["tmux"], {
		encoding: "utf8",
	}).stdout.trim();
	const fakeTmux = join(dir, "tmux");
	writeFileSync(
		fakeTmux,
		`#!/bin/sh\nfor arg do\n  if [ "$arg" = display-message ]; then exit 64; fi\ndone\nexec "${realTmux}" "$@"\n`,
	);
	chmodSync(fakeTmux, 0o755);
	let pid: number | undefined;
	try {
		const result = spawnSync(
			process.execPath,
			[runner, "--isolated-tmux", "--version"],
			{
				cwd: root,
				env: { ...cleanEnvironment(), PATH: `${dir}:${process.env.PATH}` },
				encoding: "utf8",
			},
		);
		pid = result.pid;
		assert.ok(pid);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /display-message/);
		assert.equal(serverStatus(pid), 1, "private tmux server still runs");
	} finally {
		if (pid)
			spawnSync("tmux", [
				"-L",
				`pi-subagents-test-${pid}`,
				"-f",
				"/dev/null",
				"kill-server",
			]);
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
