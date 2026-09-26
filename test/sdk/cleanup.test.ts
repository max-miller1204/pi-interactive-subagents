import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanupTmuxServer } from "./harness.ts";

const realTmux = spawnSync("which", ["tmux"], {
	encoding: "utf8",
}).stdout.trim();
assert.ok(realTmux, "tmux must be installed.");

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

test("CLI fixture cleanup reports kill-server failure instead of leaking silently", {
	timeout: 20_000,
}, (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-sdk-cleanup-"));
	const socketFile = join(root, "socket");
	t.after(() => {
		if (existsSync(socketFile)) {
			const socket = readFileSync(socketFile, "utf8");
			const killed = spawnSync(realTmux, ["-L", socket, "kill-server"], {
				encoding: "utf8",
			});
			assert.equal(killed.status, 0, killed.stderr);
			assert.equal(
				spawnSync(realTmux, ["-L", socket, "list-sessions"]).status,
				1,
			);
		}
		rmSync(root, { recursive: true, force: true });
	});
	const shim = join(root, "tmux");
	writeFileSync(
		shim,
		`#!/bin/sh
socket="$2"
for arg do
  if [ "$arg" = kill-server ]; then
    echo 'injected kill-server failure' >&2
    exit 64
  fi
  if [ "$arg" = new-session ]; then
    printf '%s' "$socket" > ${quote(socketFile)}
    ${quote(realTmux)} -L "$socket" -f /dev/null new-session -d -s cleanup-keeper ${quote(`${quote(process.execPath)} -e 'setInterval(() => {}, 60000)'`)} || exit "$?"
  fi
done
exec ${quote(realTmux)} "$@"
`,
	);
	chmodSync(shim, 0o755);
	const fixture = join(root, "fixture.test.mjs");
	writeFileSync(
		fixture,
		`import test from "node:test";
import { runCli } from ${JSON.stringify(new URL("./harness.ts", import.meta.url).href)};
test("interactive cleanup", async (t) => { await runCli(t, { interactive: true, prompt: "Check cleanup." }); });
`,
	);
	assert.ok(process.env.PATH);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATH: `${root}:${process.env.PATH}`,
	};
	delete env.NODE_TEST_CONTEXT;
	const result = spawnSync(process.execPath, ["--test", fixture], {
		env,
		encoding: "utf8",
		timeout: 15_000,
	});
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stdout + result.stderr, /injected kill-server failure/);
	assert.ok(
		existsSync(socketFile),
		"The fixture must have started a real private server.",
	);
	assert.equal(
		spawnSync(realTmux, [
			"-L",
			readFileSync(socketFile, "utf8"),
			"list-sessions",
		]).status,
		0,
		"The injected failure must leave a live server for the regression to detect.",
	);
});

test("cleanup verifies a live private server stops and recognizes later cleanup", {
	timeout: 10_000,
}, async (t) => {
	const socket = `pi-cleanup-${randomUUID()}`;
	t.after(() => cleanupTmuxServer(socket, realTmux));
	const started = spawnSync(
		realTmux,
		[
			"-L",
			socket,
			"-f",
			"/dev/null",
			"new-session",
			"-d",
			"-s",
			"keeper",
			`${quote(process.execPath)} -e 'setInterval(() => {}, 60000)'`,
		],
		{ encoding: "utf8" },
	);
	assert.equal(started.status, 0, started.stderr);
	assert.equal(await cleanupTmuxServer(socket, realTmux), "stopped");
	assert.equal(spawnSync(realTmux, ["-L", socket, "list-sessions"]).status, 1);
	assert.equal(await cleanupTmuxServer(socket, realTmux), "already-exited");
});

test("cleanup recognizes a server that never created a socket", async () => {
	assert.equal(
		await cleanupTmuxServer(`pi-cleanup-${randomUUID()}`, realTmux),
		"already-exited",
	);
});

test("cleanup fails when kill-server reports success but leaves a live server", {
	timeout: 10_000,
}, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-cleanup-survivor-"));
	const socket = `pi-cleanup-${randomUUID()}`;
	t.after(async () => {
		await cleanupTmuxServer(socket, realTmux);
		rmSync(root, { recursive: true, force: true });
	});
	const started = spawnSync(
		realTmux,
		[
			"-L",
			socket,
			"-f",
			"/dev/null",
			"new-session",
			"-d",
			"-s",
			"keeper",
			`${quote(process.execPath)} -e 'setInterval(() => {}, 60000)'`,
		],
		{ encoding: "utf8" },
	);
	assert.equal(started.status, 0, started.stderr);
	const shim = join(root, "tmux");
	writeFileSync(
		shim,
		`#!/bin/sh\nfor arg do\n  if [ "$arg" = kill-server ]; then exit 0; fi\ndone\nexec ${quote(realTmux)} "$@"\n`,
	);
	chmodSync(shim, 0o755);
	await assert.rejects(
		cleanupTmuxServer(socket, shim),
		/still runs after kill-server/,
	);
	assert.equal(spawnSync(realTmux, ["-L", socket, "list-sessions"]).status, 0);
});

test("cleanup does not treat an arbitrary probe error as an absent server", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-cleanup-probe-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const shim = join(root, "tmux");
	writeFileSync(shim, "#!/bin/sh\necho 'injected probe failure' >&2\nexit 1\n");
	chmodSync(shim, 0o755);
	await assert.rejects(
		cleanupTmuxServer(`pi-cleanup-${randomUUID()}`, shim),
		/Cannot verify tmux server.*injected probe failure/,
	);
});
