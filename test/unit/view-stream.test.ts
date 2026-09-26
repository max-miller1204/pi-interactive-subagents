import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendViewRecord, readViewRecords } from "../../src/view-stream.ts";

const runId = "6065540b-32ac-4cdd-b9d4-8610ef0a7919";
function dir(t: { after(fn: () => void): void }) {
	const path = mkdtempSync(join(tmpdir(), "view-stream-"));
	t.after(() => rmSync(path, { recursive: true, force: true }));
	return path;
}

test("view stream preserves ordered message and tool updates", (t) => {
	const path = dir(t);
	for (const record of [
		{
			v: 1,
			runId,
			seq: 1,
			messageOrdinal: 1,
			kind: "message_start",
			role: "assistant",
			text: "",
		},
		{
			v: 1,
			runId,
			seq: 2,
			messageOrdinal: 1,
			kind: "message_update",
			role: "assistant",
			text: "Hello",
		},
		{
			v: 1,
			runId,
			seq: 3,
			messageOrdinal: 1,
			kind: "tool_start",
			toolCallId: "tool-1",
			toolName: "read",
			text: "file",
		},
		{
			v: 1,
			runId,
			seq: 4,
			messageOrdinal: 1,
			kind: "tool_end",
			toolCallId: "tool-1",
			toolName: "read",
			text: "done",
			isError: false,
		},
		{
			v: 1,
			runId,
			seq: 5,
			messageOrdinal: 1,
			kind: "message_end",
			role: "assistant",
			text: "Hello",
		},
	] as const)
		appendViewRecord(path, record);
	assert.deepEqual(
		readViewRecords(path, 3).map((row) => row.seq),
		[4, 5],
	);
});

test("incomplete trailing record waits while live and fails after exit", (t) => {
	const path = dir(t);
	appendViewRecord(path, {
		v: 1,
		runId,
		seq: 1,
		messageOrdinal: 1,
		kind: "message_start",
		role: "assistant",
		text: "",
	});
	appendFileSync(join(path, "view.jsonl"), '{"v":1');
	assert.equal(readViewRecords(path, 0, true).length, 1);
	assert.throws(() => readViewRecords(path, 0, false), /incomplete/);
});

test("malformed complete line and wrong sequence or run fail loudly", (t) => {
	const path = dir(t);
	writeFileSync(join(path, "view.jsonl"), "not-json\n");
	assert.throws(() => readViewRecords(path, 0), /invalid JSON/);
	writeFileSync(join(path, "view.jsonl"), "");
	appendViewRecord(path, {
		v: 1,
		runId,
		seq: 1,
		messageOrdinal: 1,
		kind: "message_start",
		role: "assistant",
		text: "",
	});
	assert.throws(
		() =>
			appendViewRecord(path, {
				v: 1,
				runId,
				seq: 3,
				messageOrdinal: 1,
				kind: "message_end",
				role: "assistant",
				text: "",
			}),
		/sequence/,
	);
	assert.throws(
		() =>
			appendViewRecord(path, {
				v: 1,
				runId: "different",
				seq: 2,
				messageOrdinal: 1,
				kind: "message_end",
				role: "assistant",
				text: "",
			}),
		/run ID|runId/,
	);
});
