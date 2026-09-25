import assert from "node:assert/strict";
import childProcess, {
	type ExecFileSyncOptionsWithStringEncoding,
	spawnSync,
} from "node:child_process";
import { test } from "node:test";
import { processAlive, processIdentity } from "../../src/process.ts";

test("own process identity is stable and alive", () => {
	const identity = processIdentity(process.pid);
	assert.ok(identity);
	assert.equal(identity.pid, process.pid);
	assert.match(
		identity.start,
		/^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/,
	);
	assert.deepEqual(processIdentity(process.pid), identity);
	assert.equal(processAlive(identity), true);
});

test("an exited process has no identity and is not alive", () => {
	const child = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
	assert.equal(child.status, 0);
	assert.ok(child.pid > 0);
	assert.equal(processIdentity(child.pid), null);
	assert.equal(
		processAlive({ pid: child.pid, start: "Fri Sep 25 01:02:03 2026" }),
		false,
	);
});

test("a reused pid with a different start time is not alive", () => {
	const identity = processIdentity(process.pid);
	assert.ok(identity);
	assert.equal(
		processAlive({ ...identity, start: "Fri Sep 25 01:02:03 1900" }),
		false,
	);
});

test("ps uses the requested pid and the C locale", (t) => {
	const start = "Fri Sep 25 01:02:03 2026";
	t.mock.method(
		childProcess,
		"execFileSync",
		(
			file: string,
			args: string[],
			options: ExecFileSyncOptionsWithStringEncoding,
		) => {
			assert.equal(file, "ps");
			assert.deepEqual(args, ["-o", "lstart=", "-p", "123"]);
			assert.equal(options.env?.LC_ALL, "C");
			assert.equal(options.encoding, "utf8");
			assert.equal(options.env?.PATH, process.env.PATH);
			return `  ${start}\n`;
		},
	);
	assert.deepEqual(processIdentity(123), { pid: 123, start });
});

test("only status 1 with empty stdout and stderr means no process", (t) => {
	t.mock.method(childProcess, "execFileSync", () => {
		throw Object.assign(new Error("no process"), {
			status: 1,
			stdout: "",
			stderr: "",
		});
	});
	assert.equal(processIdentity(123), null);
});

test("ps failures, including non-ENOENT launch failures, throw", (t) => {
	for (const failure of [
		{ status: 2, stdout: "", stderr: "permission denied" },
		{ status: 1, stdout: "", stderr: "permission denied" },
		{ status: 1, stdout: "unexpected output", stderr: "" },
		{ code: "EACCES", stdout: "", stderr: "permission denied" },
		{ code: "ENOENT" },
	]) {
		const mock = t.mock.method(childProcess, "execFileSync", () => {
			throw Object.assign(new Error("cannot run ps"), failure);
		});
		assert.throws(() => processIdentity(123), /ps failed for pid 123:/);
		mock.mock.restore();
	}
});

test("empty and malformed successful ps output throw", (t) => {
	for (const output of [
		"",
		"\n",
		"not a date\n",
		"Fri Sep 25 25:02:03 2026\n",
		"Fri Sep 25 01:02:03 2026\nFri Sep 25 01:02:03 2026\n",
	]) {
		const mock = t.mock.method(childProcess, "execFileSync", () => output);
		assert.throws(() => processIdentity(123), /ps.*pid 123/);
		mock.mock.restore();
	}
});

test("invalid pids throw before calling ps", (t) => {
	const mock = t.mock.method(childProcess, "execFileSync", () =>
		assert.fail("ps must not run"),
	);
	for (const pid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.throws(() => processIdentity(pid), /pid/);
	}
	assert.equal(mock.mock.callCount(), 0);
});
