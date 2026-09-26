import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import {
	readBranch,
	scenario,
	terminateWindow,
	trackedResource,
	waitFor,
} from "./harness.ts";

for (const failure of [
	"acquisition",
	"identity",
	"setup",
	"verification",
	"kill",
] as const)
	test(`tracked cleanup handles ${failure} failure without an unproved kill`, async () => {
		const hooks: (() => Promise<void>)[] = [];
		const diagnostics: string[] = [];
		const retained: string[] = [];
		const calls: string[] = [];
		const resource = trackedResource(
			{
				after: (hook) => {
					hooks.push(hook);
				},
				diagnostic: (text) => {
					diagnostics.push(text);
				},
			},
			"private test resource",
			async (identity: string) => {
				calls.push(`verify:${identity}`);
				if (failure === "verification") throw new Error("identity mismatch");
				calls.push(`kill:${identity}`);
				if (failure === "kill") throw new Error("kill failed");
			},
			(reason) => {
				retained.push(reason);
			},
		);
		assert.equal(hooks.length, 1, "cleanup must register before acquisition");
		assert.ok(hooks[0]);
		resource.acquiring();
		if (failure !== "acquisition" && failure !== "identity")
			resource.identified("saved identity");
		if (failure === "setup") {
			await hooks[0]();
			assert.deepEqual(calls, ["verify:saved identity", "kill:saved identity"]);
			assert.deepEqual(retained, []);
		} else {
			await assert.rejects(hooks[0](), /Retain private test resource/);
			assert.equal(retained.length, 1);
			assert.deepEqual(diagnostics, retained);
			if (failure === "acquisition" || failure === "identity")
				assert.deepEqual(calls, []);
			if (failure === "verification")
				assert.deepEqual(calls, ["verify:saved identity"]);
			if (failure === "kill")
				assert.deepEqual(calls, [
					"verify:saved identity",
					"kill:saved identity",
				]);
		}
		const attempts = calls.length;
		await hooks[0]();
		assert.equal(
			calls.length,
			attempts,
			"cleanup must not retry a retained resource",
		);
	});

test("tracked cleanup does not reuse a released server identity after failed restart", async () => {
	const hooks: (() => Promise<void>)[] = [];
	const disposed: string[] = [];
	const retained: string[] = [];
	const resource = trackedResource(
		{
			after: (hook) => {
				hooks.push(hook);
			},
			diagnostic: () => {},
		},
		"private server",
		async (identity: string) => {
			disposed.push(identity);
		},
		(reason) => {
			retained.push(reason);
		},
	);
	resource.acquiring();
	resource.identified("first server");
	await resource.release();
	resource.acquiring();
	assert.ok(hooks[0]);
	await assert.rejects(hooks[0](), /identity is not proved/);
	assert.deepEqual(disposed, ["first server"]);
	assert.equal(retained.length, 1);
});

for (const failure of ["diagnostic", "retention"] as const)
	test(`tracked cleanup preserves errors when ${failure} reporting fails`, async () => {
		const hooks: (() => Promise<void>)[] = [];
		const reports: string[] = [];
		const resource = trackedResource(
			{
				after: (hook) => {
					hooks.push(hook);
				},
				diagnostic: () => {
					reports.push("diagnostic");
					if (failure === "diagnostic") throw new Error("diagnostic failed");
				},
			},
			"private resource",
			async () => {
				throw new Error("must not dispose without identity");
			},
			() => {
				reports.push("retention");
				if (failure === "retention") throw new Error("retention failed");
			},
		);
		resource.acquiring();
		assert.ok(hooks[0]);
		await assert.rejects(hooks[0](), (error) => {
			assert.ok(error instanceof AggregateError);
			assert.equal(error.errors.length, 2);
			assert.match(String(error.errors[0]), /identity is not proved/);
			assert.match(String(error.errors[1]), new RegExp(`${failure} failed`));
			return true;
		});
		assert.deepEqual(reports.sort(), ["diagnostic", "retention"]);
	});

test("scenario retains files when external pane identity cannot be proved", async (t) => {
	let root: string | undefined;
	t.after(() => {
		if (root === undefined || !existsSync(root)) return;
		// macOS can report ENOTEMPTY while the killed pane's last files settle.
		// Retry the removal. A directory that remains is still an error.
		rmSync(root, { recursive: true, maxRetries: 5, retryDelay: 100 });
	});
	await t.test("retained scenario", async (t) => {
		const run = await scenario(t, { prompt: "Retained session." });
		root = run.root;
		run.retainFiles("External pane identity is not proved.");
		await run.waitFor(
			() => existsSync(run.parentFile),
			"saved retained session",
		);
	});
	assert.ok(root !== undefined && existsSync(root));
	assert.ok(existsSync(`${root}/parent.jsonl`));
});

test("private parent acknowledges a prompt and exits when its window closes", async (t) => {
	const run = await scenario(t, { prompt: "probe" });
	await run.waitFor(
		() =>
			existsSync(run.parentFile) &&
			run
				.readParent()
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.content.some(
							(block) => block.type === "text" && block.text === "ack: probe",
						),
				),
		"parent acknowledgement",
	);
	assert.match(
		await run.waitFor(async () => {
			const text = await run.capture();
			return text.includes("ack: probe") ? text : undefined;
		}, "visible parent acknowledgement"),
		/ack: probe/,
	);
	const pidText = await run.tmux([
		"display-message",
		"-p",
		"-t",
		run.parentPane,
		"#{pane_pid}",
	]);
	assert.match(pidText, /^[1-9][0-9]*$/);
	const pid = Number(pidText);
	await run.tmux(["kill-window", "-t", run.parentPane]);
	await run.waitFor(
		async () =>
			!(await run.tmux(["list-panes", "-a", "-F", "#{pane_id}"]))
				.split("\n")
				.includes(run.parentPane),
		"parent window exit",
	);
	await run.waitFor(() => {
		try {
			process.kill(pid, 0);
			return false;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
			throw error;
		}
	}, `parent process ${pid} exit`);
});

test("cleanup kills the window even when pane diagnostics fail", async () => {
	const calls: string[] = [];
	await assert.rejects(
		terminateWindow(
			async (args) => {
				calls.push(args[0] ?? "");
				if (args[0] === "capture-pane") throw new Error("capture failed");
				return "";
			},
			"%99",
			() => {},
		),
		/capture failed/,
	);
	assert.deepEqual(calls, ["capture-pane", "kill-window"]);
	await assert.rejects(
		terminateWindow(
			async (args) => {
				throw new Error(`${args[0]} failed`);
			},
			"%99",
			() => {},
		),
		(error: unknown) => {
			assert.ok(error instanceof AggregateError);
			assert.equal(error.errors.length, 2);
			assert.match(error.message, /Cannot kill parent window/);
			return true;
		},
	);
});

test("failed parent reports extension load error and cleanup removes its window", async (t) => {
	const run = await scenario(t, {
		prompt: "probe",
		extensionPaths: [
			resolve(import.meta.dirname, "../fixtures/throws-at-load.ts"),
		],
	});
	await run.waitFor(
		async () =>
			(await run.tmux(["list-panes", "-a", "-F", "#{pane_id} #{pane_dead}"]))
				.split("\n")
				.some((line) => line === `${run.parentPane} 1`),
		"failed parent process exit",
	);
	assert.match(
		readFileSync(run.stderrFile, "utf8") + (await run.capture()),
		/Test extension failed at load/,
	);
});

test("session polling waits for a record newline without accepting partial JSON", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "session-poll-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "session.jsonl");
	const header = JSON.stringify({
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: "test",
		timestamp: new Date().toISOString(),
		cwd: dir,
	});
	writeFileSync(file, header.slice(0, 8));
	let reads = 0;
	const branch = await waitFor(
		() => {
			if (++reads === 2) writeFileSync(file, `${header}\n`);
			return readBranch(file);
		},
		"committed session record",
		1000,
	);
	assert.deepEqual(branch, []);
	assert.equal(reads, 2);
});

test("session polling rejects complete invalid JSON immediately", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "session-poll-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "session.jsonl");
	writeFileSync(file, "{invalid}\n");
	let reads = 0;
	await assert.rejects(
		waitFor(
			() => {
				reads++;
				return readBranch(file);
			},
			"invalid session",
			1000,
		),
		/not valid JSON/,
	);
	assert.equal(reads, 1);
});

test("session polling reports an unfinished write at its deadline", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "session-poll-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "session.jsonl");
	writeFileSync(file, "{");
	await assert.rejects(
		waitFor(() => readBranch(file), "unfinished session", 60),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /Timed out waiting for unfinished session/);
			assert.ok(error.cause instanceof Error);
			assert.match(error.cause.message, /missing final newline/);
			return true;
		},
	);
});
