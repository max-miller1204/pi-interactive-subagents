import {
	closeSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { type AssistantMessage, uuidv7 } from "@earendil-works/pi-ai";
import {
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	type SessionHeader,
	type SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	ChildEntry,
	DisplayModeEntry,
	type Launch,
	parseStrict,
	RegistryRecord,
} from "./schema.ts";

// Pi assigns the parent path before it writes the first assistant response.
export function parentSessionPath(path: string): string {
	if (lstatSync(path, { throwIfNoEntry: false }) === undefined)
		return join(realpathSync(dirname(path)), basename(path));
	return realpathSync(path);
}

export function writeChildSession(
	dir: string,
	cwd: string,
	parentSession: string,
	entries: SessionEntry[],
): string {
	const id = uuidv7();
	const timestamp = new Date().toISOString();
	const file = join(
		realpathSync(dir),
		`${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`,
	);
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp,
		cwd: realpathSync(cwd),
		parentSession: parentSessionPath(parentSession),
	};
	const content = `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	// A successful exclusive open establishes ownership before the first write.
	let descriptor: number | undefined = openSync(file, "wx", 0o600);
	try {
		writeFileSync(descriptor, content);
		const opened = descriptor;
		descriptor = undefined;
		closeSync(opened);
		return realpathSync(file);
	} catch (error) {
		const errors: unknown[] = [error];
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch (closeError) {
				errors.push(closeError);
			}
		}
		try {
			unlinkSync(file);
		} catch (unlinkError) {
			errors.push(unlinkError);
		}
		if (errors.length > 1) {
			throw new AggregateError(
				errors,
				errors
					.map((item) => (item instanceof Error ? item.message : String(item)))
					.join("; "),
				{ cause: error },
			);
		}
		throw error;
	}
}

export function forkEntries(
	ctx: { sessionManager: Pick<SessionManager, "getBranch">; isIdle(): boolean },
	toolCallId?: string,
): SessionEntry[] {
	if (toolCallId === undefined) {
		if (!ctx.isIdle()) {
			throw new Error(
				"Wait for the current response to finish before you start a fork subagent.",
			);
		}
		return ctx.sessionManager.getBranch().slice();
	}
	const branch = ctx.sessionManager.getBranch();
	const index = branch.findLastIndex(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(content) => content.type === "toolCall" && content.id === toolCallId,
			),
	);
	const delegation = branch[index];
	if (delegation === undefined) {
		throw new Error(
			"Cannot find the subagent tool call on the current branch.",
		);
	}
	if (delegation.parentId === null) return [];
	const cut = branch.findIndex((entry) => entry.id === delegation.parentId);
	if (cut === -1 || cut >= index) {
		throw new Error(
			`Cannot find fork parent ${delegation.parentId} before the subagent tool call.`,
		);
	}
	return branch.slice(0, cut + 1);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateExtractionFields(
	entry: Record<string, unknown>,
	where: string,
): void {
	const require = (condition: boolean, field: string): void => {
		if (!condition) throw new Error(`${where}: invalid ${field}.`);
	};
	const deliveryId = (details: unknown): void => {
		if (isObject(details) && Object.hasOwn(details, "deliveryId"))
			require(typeof details.deliveryId === "string", "details.deliveryId");
	};
	if (entry.type === "custom" || entry.type === "custom_message") {
		require(typeof entry.customType === "string", "customType");
		if (entry.type === "custom") {
			if (entry.customType === "subagent")
				parseStrict(RegistryRecord, entry.data, where);
			if (entry.customType === "subagent_child")
				parseStrict(ChildEntry, entry.data, where);
			if (entry.customType === "subagent_display_mode")
				parseStrict(DisplayModeEntry, entry.data, where);
		} else deliveryId(entry.details);
	}
	if (entry.type !== "message") return;
	const message = entry.message;
	if (!isObject(message) || typeof message.role !== "string")
		throw new Error(`${where}: invalid message.role.`);
	if (message.role === "toolResult") deliveryId(message.details);
	if (message.role !== "assistant") return;
	if (!Array.isArray(message.content))
		throw new Error(`${where}: invalid assistant content.`);
	for (const [index, content] of message.content.entries()) {
		const field = `assistant content[${index}]`;
		if (!isObject(content)) throw new Error(`${where}: invalid ${field}.`);
		switch (content.type) {
			case "text":
				require(typeof content.text === "string", `${field}.text`);
				break;
			case "thinking":
				require(typeof content.thinking === "string", `${field}.thinking`);
				break;
			case "toolCall":
				require(typeof content.id === "string", `${field}.id`);
				require(typeof content.name === "string", `${field}.name`);
				require(isObject(content.arguments), `${field}.arguments`);
				break;
			default:
				throw new Error(`${where}: invalid ${field}.type.`);
		}
	}
	require(isObject(message.usage) &&
		typeof message.usage.totalTokens === "number" &&
		Number.isFinite(message.usage.totalTokens), "assistant usage.totalTokens");
	require(typeof message.stopReason === "string" &&
		[
			"pending",
			"stop",
			"length",
			"toolUse",
			"error",
			"aborted",
			"deferred",
		].includes(message.stopReason), "assistant stopReason");
	require(message.errorMessage === undefined ||
		typeof message.errorMessage === "string", "assistant errorMessage");
}

export class IncompleteSessionError extends Error {}

export function readBranch(path: string): SessionEntry[] {
	const file = realpathSync(path);
	const text = readFileSync(file, "utf8");
	if (!text.endsWith("\n")) {
		throw new IncompleteSessionError(`${file}: missing final newline.`);
	}
	const lines = text.slice(0, -1).split("\n");
	const byId = new Map<string, SessionEntry>();
	let leaf: SessionEntry | undefined;
	for (const [index, line] of lines.entries()) {
		if (line === "" && index !== 0)
			throw new Error(`${file}: line ${index + 1} is blank.`);
		let value: unknown;
		if (line !== "") {
			try {
				value = JSON.parse(line);
			} catch (error) {
				throw new Error(`${file}: line ${index + 1} is not valid JSON.`, {
					cause: error,
				});
			}
		}
		if (index === 0) {
			if (
				!isObject(value) ||
				value.type !== "session" ||
				value.version !== CURRENT_SESSION_VERSION ||
				typeof value.id !== "string" ||
				value.id.length === 0 ||
				typeof value.timestamp !== "string" ||
				typeof value.cwd !== "string"
			) {
				throw new Error(`${file} is not a Pi session.`);
			}
			continue;
		}
		if (
			!isObject(value) ||
			typeof value.id !== "string" ||
			value.id.length === 0 ||
			(value.parentId !== null && typeof value.parentId !== "string") ||
			typeof value.timestamp !== "string" ||
			typeof value.type !== "string" ||
			![
				"message",
				"thinking_level_change",
				"model_change",
				"usage",
				"compaction",
				"branch_summary",
				"custom",
				"custom_message",
				"context_edit",
				"label",
				"session_info",
			].includes(value.type)
		) {
			throw new Error(`${file}: line ${index + 1} is not a Pi session entry.`);
		}
		validateExtractionFields(value, `${file}: line ${index + 1}`);
		if (byId.has(value.id)) {
			throw new Error(`${file}: duplicate entry id ${value.id}.`);
		}
		const entry = value as unknown as SessionEntry;
		byId.set(entry.id, entry);
		leaf = entry;
	}
	const checked = new Set<string>();
	for (const entry of byId.values()) {
		const visiting = new Set<string>();
		let current: SessionEntry | undefined = entry;
		while (current !== undefined && !checked.has(current.id)) {
			if (visiting.has(current.id)) {
				throw new Error(`${file}: parent cycle at entry ${current.id}.`);
			}
			visiting.add(current.id);
			if (current.parentId === null) break;
			const parent = byId.get(current.parentId);
			if (parent === undefined) {
				throw new Error(
					`${file}: missing parent ${current.parentId} for entry ${current.id}.`,
				);
			}
			current = parent;
		}
		for (const id of visiting) checked.add(id);
	}
	const branch: SessionEntry[] = [];
	while (leaf !== undefined) {
		branch.push(leaf);
		leaf = leaf.parentId === null ? undefined : byId.get(leaf.parentId);
	}
	return branch.reverse();
}

function runData(entry: SessionEntry): Record<string, unknown> | undefined {
	if (
		entry.type === "custom" &&
		entry.customType === "subagent_child" &&
		isObject(entry.data) &&
		entry.data.kind === "run"
	) {
		return entry.data;
	}
	return undefined;
}

export function afterMarker(
	branch: SessionEntry[],
	runId: string,
): SessionEntry[] | undefined {
	const index = branch.findLastIndex(
		(entry) => runData(entry)?.runId === runId,
	);
	return index === -1 ? undefined : branch.slice(index + 1);
}

export function lastAssistant(
	entries: SessionEntry[],
): AssistantMessage | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "message" && entry.message.role === "assistant") {
			return entry.message;
		}
	}
	return undefined;
}

export function finalText(message: AssistantMessage | undefined): string {
	if (message === undefined) return "";
	return message.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("\n");
}

export function persistedIds(entries: SessionEntry[]): Set<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		let details: unknown;
		if (entry.type === "custom_message") {
			details = entry.details;
		} else if (
			entry.type === "message" &&
			entry.message.role === "toolResult"
		) {
			details = entry.message.details;
		}
		if (isObject(details) && typeof details.deliveryId === "string") {
			ids.add(details.deliveryId);
		}
	}
	return ids;
}

export function foldRegistry(
	branch: SessionEntry[],
	ownSessionId: string,
): {
	names: Map<string, { runId: string; launch: Launch }>;
	ownRunIds: Set<string>;
	knownRunIds: Set<string>;
} {
	const cut = branch.findIndex(
		(entry) => runData(entry)?.sessionId === ownSessionId,
	);
	const names = new Map<string, { runId: string; launch: Launch }>();
	const ownRunIds = new Set<string>();
	const knownRunIds = new Set<string>();
	for (const entry of branch.slice(cut + 1)) {
		if (entry.type !== "custom" || entry.customType !== "subagent") continue;
		const record = parseStrict(
			RegistryRecord,
			entry.data,
			`subagent entry ${entry.id}`,
		);
		knownRunIds.add(record.runId);
		if (record.kind !== "adopt") ownRunIds.add(record.runId);
		if (record.kind !== "resume") {
			names.set(record.launch.name, {
				runId: record.runId,
				launch: record.launch,
			});
		}
	}
	return { names, ownRunIds, knownRunIds };
}
