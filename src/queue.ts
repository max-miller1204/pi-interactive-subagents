import { randomBytes } from "node:crypto";
import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
	InboxItem,
	OutboxItem,
	parseStrict,
	readJsonStrict,
	writeJsonAtomic,
} from "./schema.ts";

export type Box = "inbox" | "outbox";
export type Item<B extends Box> = B extends "inbox" ? InboxItem : OutboxItem;
export type QueueEntry<B extends Box> = { seq: string; item: Item<B> };

const itemName = /^(\d{20}-[0-9a-f]{8})\.json$/;
const sequence = /^\d{20}-[0-9a-f]{8}$/;

function validSequence(seq: string): void {
	if (!sequence.test(seq)) throw new Error(`Invalid queue sequence: ${seq}`);
}

function names(dir: string): string[] {
	return readdirSync(dir)
		.filter((name) => !name.startsWith("."))
		.map((name) => {
			if (!itemName.test(name)) {
				throw new Error(
					`Unexpected file ${join(dir, name)} in a subagent directory.`,
				);
			}
			return name;
		})
		.sort();
}

export function put<B extends Box>(dir: string, box: B, item: Item<B>): string {
	const schema = box === "inbox" ? InboxItem : OutboxItem;
	parseStrict(schema, item, `${box} item`);
	const seq = `${String(process.hrtime.bigint()).padStart(20, "0")}-${randomBytes(4).toString("hex")}`;
	validSequence(seq);
	writeJsonAtomic(join(dir, `${seq}.json`), item);
	return seq;
}

export function list<B extends Box>(dir: string, box: B): QueueEntry<B>[] {
	const schema = box === "inbox" ? InboxItem : OutboxItem;
	return names(dir).map((name) => ({
		seq: name.slice(0, -5),
		item: readJsonStrict(schema, join(dir, name)) as Item<B>,
	}));
}

export function count(dir: string): number {
	return names(dir).length;
}

export function itemId(runId: string, box: Box, seq: string): string {
	validSequence(seq);
	return `${runId}:${box}:${seq}`;
}

// Call this only after the consumer confirms delivery or drops the item.
export function deleteConsumed(dir: string, seq: string): void {
	validSequence(seq);
	unlinkSync(join(dir, `${seq}.json`));
}
