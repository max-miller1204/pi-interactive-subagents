import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { scenario, terminateWindow } from "./harness.ts";

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
