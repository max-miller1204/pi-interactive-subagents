import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { scenario } from "./harness.ts";

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
	await run.tmux(["kill-window", "-t", run.parentPane]);
	await run.waitFor(
		async () =>
			!(await run.tmux(["list-panes", "-a", "-F", "#{pane_id}"]))
				.split("\n")
				.includes(run.parentPane),
		"parent window exit",
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
