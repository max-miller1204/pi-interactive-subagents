import {
	appendFileSync,
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { parseStrict, ViewRecord } from "./schema.ts";

const MAX_RECORD_BYTES = 1024 * 1024;

function file(runDir: string): string {
	return join(runDir, "view.jsonl");
}

export function readViewRecords(
	runDir: string,
	afterSeq: number,
	childAlive = true,
	expectedRunId?: string,
): ViewRecord[] {
	if (!Number.isSafeInteger(afterSeq) || afterSeq < 0)
		throw new Error("Invalid view sequence cursor.");
	const content = readFileSync(file(runDir), "utf8");
	const complete = content.length === 0 || content.endsWith("\n");
	if (!complete && !childAlive)
		throw new Error(
			`The view stream has an incomplete final record: ${file(runDir)}.`,
		);
	const lines = content.split("\n");
	if (!complete) lines.pop();
	let seq = 0;
	let ordinal = 0;
	let runId = expectedRunId;
	const records: ViewRecord[] = [];
	for (const line of lines) {
		if (line === "") continue;
		if (Buffer.byteLength(line) > MAX_RECORD_BYTES)
			throw new Error("View record exceeds the size limit.");
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch (error) {
			throw new Error(
				`The view stream has invalid JSON at sequence ${seq + 1}.`,
				{ cause: error },
			);
		}
		const record = parseStrict(ViewRecord, value, "view record");
		if (record.seq !== seq + 1)
			throw new Error(
				`View sequence mismatch at ${record.seq}; expected ${seq + 1}.`,
			);
		if (runId !== undefined && record.runId !== runId)
			throw new Error("View run ID does not match.");
		if (record.messageOrdinal < ordinal)
			throw new Error("View message ordinal moved backward.");
		seq = record.seq;
		ordinal = record.messageOrdinal;
		runId = record.runId;
		if (record.seq > afterSeq) records.push(record);
	}
	return records;
}

export function appendViewRecord(runDir: string, record: ViewRecord): void {
	const value = parseStrict(ViewRecord, record, "view record");
	const path = file(runDir);
	let last: ViewRecord | undefined;
	if (existsSync(path)) {
		const size = statSync(path).size;
		if (size > 0) {
			const length = Math.min(size, MAX_RECORD_BYTES + 2);
			const buffer = Buffer.alloc(length);
			const descriptor = openSync(path, "r");
			try {
				if (readSync(descriptor, buffer, 0, length, size - length) !== length)
					throw new Error("Could not read the end of the view stream.");
			} finally {
				closeSync(descriptor);
			}
			if (buffer.at(-1) !== 10)
				throw new Error("The view stream has an incomplete final record.");
			const priorNewline = buffer.lastIndexOf(10, length - 2);
			if (priorNewline < 0 && size > length)
				throw new Error("View record exceeds the size limit.");
			const line = buffer
				.subarray(priorNewline + 1, length - 1)
				.toString("utf8");
			last = parseStrict(ViewRecord, JSON.parse(line), "last view record");
		}
	}
	if (value.seq !== (last?.seq ?? 0) + 1)
		throw new Error(
			`View sequence mismatch: expected ${(last?.seq ?? 0) + 1}.`,
		);
	if (last !== undefined && value.runId !== last.runId)
		throw new Error("View run ID does not match.");
	if (last !== undefined && value.messageOrdinal < last.messageOrdinal)
		throw new Error("View message ordinal moved backward.");
	const line = `${JSON.stringify(value)}\n`;
	if (Buffer.byteLength(line) > MAX_RECORD_BYTES)
		throw new Error("View record exceeds the size limit.");
	appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
}
