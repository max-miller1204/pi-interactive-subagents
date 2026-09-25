import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { count, deleteConsumed, itemId, list, put } from "../../src/queue.ts";

function withQueue(run: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "queue-test-"));
	try {
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("1,000 writes preserve production order and strict inbox types", () =>
	withQueue((dir) => {
		const sequences: string[] = [];
		for (let i = 0; i < 1_000; i++) {
			sequences.push(
				put(dir, "inbox", { v: 1, kind: "message", text: String(i) }),
			);
		}
		assert.deepEqual(sequences, [...sequences].sort());
		assert.ok(sequences.every((seq) => /^\d{20}-[0-9a-f]{8}$/.test(seq)));
		assert.equal(count(dir), 1_000);
		assert.deepEqual(
			list(dir, "inbox"),
			sequences.map((seq, i) => ({
				seq,
				item: { v: 1, kind: "message", text: String(i) },
			})),
		);
		assert.equal(readdirSync(dir).length, 1_000);
		const first = sequences[0];
		assert.ok(first);
		assert.equal(itemId("run-1", "inbox", first), `run-1:inbox:${first}`);
	}));

test("outbox items have their own schema", () =>
	withQueue((dir) => {
		const seq = put(dir, "outbox", {
			v: 1,
			kind: "question",
			qid: "q-1234abcd",
			text: "Why?",
		});
		assert.deepEqual(list(dir, "outbox"), [
			{
				seq,
				item: { v: 1, kind: "question", qid: "q-1234abcd", text: "Why?" },
			},
		]);
		assert.equal(itemId("run-1", "outbox", seq), `run-1:outbox:${seq}`);
	}));

test("invalid JSON and invalid item schemas fail without deletion", () =>
	withQueue((dir) => {
		const file = join(dir, `${"1".padStart(20, "0")}-1234abcd.json`);
		writeFileSync(file, "{");
		assert.throws(() => list(dir, "inbox"), /json|JSON|Unexpected/i);
		assert.ok(existsSync(file));
		writeFileSync(
			file,
			JSON.stringify({ v: 1, kind: "message", text: "ok", extra: true }),
		);
		assert.throws(() => list(dir, "inbox"), /extra|additional|property/i);
		assert.ok(existsSync(file));
	}));

test("hidden temporary files are ignored, but visible unexpected names fail", () =>
	withQueue((dir) => {
		writeFileSync(join(dir, ".tmp-incomplete"), "{");
		assert.deepEqual(list(dir, "inbox"), []);
		assert.equal(count(dir), 0);
		const bad = join(dir, "unexpected.txt");
		writeFileSync(bad, "{}");
		assert.throws(
			() => list(dir, "inbox"),
			new RegExp(
				`Unexpected file ${bad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} in a subagent directory\\.`,
			),
		);
		assert.throws(() => count(dir), /Unexpected file/);
	}));

test("bad sequence is rejected, including by deletion and delivery id", () =>
	withQueue((dir) => {
		writeFileSync(join(dir, "123.json"), "{}");
		assert.throws(() => list(dir, "outbox"), /Unexpected file/);
		assert.throws(() => deleteConsumed(dir, "123"), /sequence/);
		assert.throws(() => itemId("run-1", "inbox", "123"), /sequence/);
	}));

test("only confirmed consumption deletes an item", () =>
	withQueue((dir) => {
		const seq = put(dir, "inbox", {
			v: 1,
			kind: "answer",
			qid: "q-1234abcd",
			text: "Yes",
		});
		assert.equal(list(dir, "inbox").length, 1);
		assert.equal(count(dir), 1);
		assert.ok(existsSync(join(dir, `${seq}.json`)));
		deleteConsumed(dir, seq);
		assert.equal(count(dir), 0);
		assert.deepEqual(list(dir, "inbox"), []);
		assert.throws(() => deleteConsumed(dir, seq), /ENOENT/);
	}));
