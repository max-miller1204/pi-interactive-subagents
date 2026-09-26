import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	PaneFile,
	parseStrict,
	RunBackendRecord,
	readJsonStrict,
	writeJsonAtomic,
} from "./schema.ts";

export type RunBackend =
	| { kind: "pane"; pane: PaneFile }
	| {
			kind: "widget";
			supervisor: { pid: number; start: string };
			child: { pid: number; start: string };
			socket: string;
	  };

export function readRunBackend(runDir: string): RunBackend {
	const file = join(runDir, "backend.json");
	if (existsSync(file)) {
		const record = readJsonStrict(RunBackendRecord, file);
		if (record.kind === "pane") return { kind: "pane", pane: record.pane };
		return {
			kind: "widget",
			supervisor: record.supervisor,
			child: record.child,
			socket: record.socket,
		};
	}
	const pane = readJsonStrict(PaneFile, join(runDir, "pane.json"));
	return { kind: "pane", pane };
}

export function writeRunBackend(runDir: string, backend: RunBackend): void {
	writeJsonAtomic(
		join(runDir, "backend.json"),
		parseStrict(RunBackendRecord, { v: 1, ...backend }, "backend identity"),
	);
}
