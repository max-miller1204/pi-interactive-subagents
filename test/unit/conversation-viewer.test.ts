import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import {
	createConversationViewer,
	projectLiveRecords,
	viewerWindow,
} from "../../src/conversation-viewer.ts";
import type { Runtime } from "../../src/parent.ts";

const runId = "6065540b-32ac-4cdd-b9d4-8610ef0a7919";

test("live projection replaces message snapshots and keeps tool activity", () => {
	const records = [
		{
			v: 1,
			runId,
			seq: 1,
			messageOrdinal: 2,
			kind: "message_start",
			role: "assistant",
			text: "",
		},
		{
			v: 1,
			runId,
			seq: 2,
			messageOrdinal: 2,
			kind: "message_update",
			role: "assistant",
			text: "Hello",
		},
		{
			v: 1,
			runId,
			seq: 3,
			messageOrdinal: 2,
			kind: "tool_start",
			toolCallId: "one",
			toolName: "read",
			text: "a",
		},
		{
			v: 1,
			runId,
			seq: 4,
			messageOrdinal: 2,
			kind: "tool_end",
			toolCallId: "one",
			toolName: "read",
			text: "done",
			isError: false,
		},
	] as const;
	assert.deepEqual(projectLiveRecords(records), [
		"assistant: Hello",
		"read: a",
		"read ✓: done",
	]);
});

test("viewer follows the end until a user scrolls up", () => {
	const lines = ["a", "b", "c", "d", "e"];
	assert.deepEqual(viewerWindow(lines, 3, null), {
		lines: ["c", "d", "e"],
		top: 2,
	});
	assert.deepEqual(viewerWindow([...lines, "f"], 3, 1), {
		lines: ["b", "c", "d"],
		top: 1,
	});
});

test("viewer sends a human answer, confirms stop, and closes on Escape", async () => {
	const calls: unknown[][] = [];
	let stops = 0;
	let closed = 0;
	const runtime = {
		list: () => ({
			live: [{ name: "worker-1", openQuestions: ["q-12345678"] }],
			branch: new Map(),
		}),
		runs: new Map(),
		message: async (...args: unknown[]) => {
			calls.push(args);
			return "Sent";
		},
		stop: async () => {
			stops++;
		},
	} as unknown as Runtime;
	const tui = {
		terminal: { rows: 15 },
		requestRender: () => {},
	} as unknown as TUI;
	const theme = {
		fg: (_color: string, text: string) => text,
	} as unknown as Theme;
	const viewer = createConversationViewer(
		runtime,
		"worker-1",
		tui,
		theme,
		() => {
			closed++;
		},
	);
	viewer.render(16);
	viewer.handleInput?.("\t");
	viewer.handleInput?.("H");
	viewer.handleInput?.("i");
	viewer.handleInput?.("\r");
	await new Promise((done) => setImmediate(done));
	assert.deepEqual(calls, [["worker-1", "Hi", "q-12345678", "human"]]);
	viewer.handleInput?.("\x18");
	viewer.handleInput?.("y");
	await new Promise((done) => setImmediate(done));
	assert.equal(stops, 1);
	assert.ok(viewer.render(16).every((line) => visibleWidth(line) <= 16));
	viewer.handleInput?.("\x1b");
	assert.equal(closed, 1);
	viewer.dispose();
});
