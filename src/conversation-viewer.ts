import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Input,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Runtime } from "./parent.ts";
import {
	ParentMessageDetails,
	parseStrict,
	type ViewRecord,
} from "./schema.ts";
import { afterMarker, readBranch } from "./session-file.ts";

export function projectLiveRecords(records: readonly ViewRecord[]): string[] {
	const lines: string[] = [];
	const messages = new Map<number, number>();
	for (const record of records) {
		if (
			record.kind === "message_start" ||
			record.kind === "message_update" ||
			record.kind === "message_end"
		) {
			const line = `${record.role}: ${record.text}`;
			const index = messages.get(record.messageOrdinal);
			if (index === undefined) {
				messages.set(record.messageOrdinal, lines.length);
				lines.push(line);
			} else lines[index] = line;
		} else if (record.kind === "tool_start") {
			lines.push(`${record.toolName}: ${record.text}`);
		} else {
			lines.push(
				`${record.toolName} ${record.isError ? "✗" : "✓"}: ${record.text}`,
			);
		}
	}
	return lines;
}

export function viewerWindow(
	lines: string[],
	height: number,
	scrollTop: number | null,
): { lines: string[]; top: number } {
	const size = Math.max(1, height);
	const top =
		scrollTop === null
			? Math.max(0, lines.length - size)
			: Math.max(0, Math.min(scrollTop, Math.max(0, lines.length - size)));
	return { lines: lines.slice(top, top + size), top };
}

function messageText(message: unknown): string {
	if (!message || typeof message !== "object")
		throw new Error("Invalid saved conversation message.");
	const row = message as { role?: unknown; content?: unknown };
	if (typeof row.role !== "string")
		throw new Error("Saved conversation message has no role.");
	if (typeof row.content === "string") return `${row.role}: ${row.content}`;
	if (!Array.isArray(row.content)) return `${row.role}:`;
	const text = row.content
		.flatMap((part): string[] => {
			if (!part || typeof part !== "object") return [];
			if ("text" in part && typeof part.text === "string") return [part.text];
			if ("type" in part && part.type === "toolCall") {
				if (
					!("name" in part) ||
					typeof part.name !== "string" ||
					!("arguments" in part)
				)
					throw new Error("Saved tool call is missing its name or arguments.");
				return [`${part.name}: ${JSON.stringify(part.arguments)}`];
			}
			return [];
		})
		.join("\n");
	return `${row.role}: ${text}`;
}

export function conversationLines(runtime: Runtime, name: string): string[] {
	const run = runtime.runs.get(name);
	const branchRecord = runtime.list().branch.get(name);
	const childSessionFile =
		run?.spec.launch.childSessionFile ?? branchRecord?.launch.childSessionFile;
	const runId = branchRecord?.runId ?? run?.spec.runId;
	if (childSessionFile === undefined || runId === undefined)
		throw new Error(`Unknown subagent "${name}".`);
	const branch = afterMarker(readBranch(childSessionFile), runId);
	if (branch === undefined)
		throw new Error(`Saved conversation has no run marker for "${name}".`);
	const lines = branch.flatMap((entry): string[] => {
		if (entry.type === "message") return [messageText(entry.message)];
		if (
			entry.type === "custom_message" &&
			entry.customType === "subagent_parent_message"
		) {
			const details = parseStrict(
				ParentMessageDetails,
				entry.details,
				"parent message",
			);
			return [
				`${details.source === "human" ? "human" : "parent"}: ${details.text}`,
			];
		}
		return [];
	});
	if (run !== undefined && run.phase !== "finished")
		lines.push(...projectLiveRecords(runtime.viewRecords(name)));
	return lines;
}

export interface ConversationViewer extends Component {
	close(): void;
	dispose(): void;
}

export function createConversationViewer(
	runtime: Runtime,
	name: string,
	tui: TUI,
	theme: Theme,
	done: () => void,
): ConversationViewer {
	const input = new Input({ prompt: "> ", placeholder: "Send a message" });
	input.focused = true;
	let closed = false;
	let scrollTop: number | null = null;
	let lineCount = 0;
	let pageSize = 1;
	let selectedQuestion: string | undefined;
	let confirmStop = false;
	let note = "";
	let sending = false;
	const openQuestions = () =>
		runtime.list().live.find((row) => row.name === name)?.openQuestions ?? [];
	const interval = setInterval(() => tui.requestRender(), 250);
	interval.unref();
	const close = () => {
		if (closed) return;
		closed = true;
		clearInterval(interval);
		done();
	};
	input.onSubmit = (value) => {
		if (sending || !value.trim()) return;
		sending = true;
		note = "Sending...";
		void runtime
			.message(name, value.trim(), selectedQuestion, "human")
			.then((result) => {
				input.setValue("");
				note = result;
			})
			.catch((error) => {
				note = error instanceof Error ? error.message : String(error);
			})
			.finally(() => {
				sending = false;
				tui.requestRender();
			});
	};
	return {
		close,
		dispose() {
			clearInterval(interval);
		},
		invalidate() {
			tui.requestRender();
		},
		handleInput(data) {
			if (matchesKey(data, Key.escape)) {
				close();
				return;
			}
			if (confirmStop) {
				if (data === "y" || data === "Y") {
					confirmStop = false;
					void runtime
						.stop(name)
						.then(() => {
							note = "Stop requested.";
							tui.requestRender();
						})
						.catch((error) => {
							note = error instanceof Error ? error.message : String(error);
							tui.requestRender();
						});
				} else if (data === "n" || data === "N") confirmStop = false;
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.ctrl("x"))) {
				confirmStop = true;
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.tab)) {
				const questions = openQuestions();
				const choices = [undefined, ...questions];
				selectedQuestion =
					choices[(choices.indexOf(selectedQuestion) + 1) % choices.length];
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.up)) {
				if (scrollTop === null) scrollTop = Math.max(0, lineCount - pageSize);
				scrollTop = Math.max(
					0,
					scrollTop - (matchesKey(data, Key.pageUp) ? pageSize : 1),
				);
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.down)) {
				if (scrollTop !== null) {
					scrollTop += matchesKey(data, Key.pageDown) ? pageSize : 1;
					if (scrollTop >= Math.max(0, lineCount - pageSize)) scrollTop = null;
				}
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.end)) {
				scrollTop = null;
				tui.requestRender();
				return;
			}
			input.handleInput(data);
			tui.requestRender();
		},
		render(rawWidth) {
			if (rawWidth < 6) return [];
			const width = rawWidth;
			const innerWidth = width - 4;
			const height = Math.max(11, Math.floor(tui.terminal.rows * 0.7));
			const row = (content: string) => {
				const clipped = truncateToWidth(content, innerWidth);
				return `${theme.fg("border", "│")} ${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))} ${theme.fg("border", "│")}`;
			};
			const top = theme.fg("border", `╭${"─".repeat(width - 2)}╮`);
			const bottom = theme.fg("border", `╰${"─".repeat(width - 2)}╯`);
			const divider = row(theme.fg("border", "─".repeat(innerWidth)));
			const questions = openQuestions();
			const selectedClosed =
				selectedQuestion !== undefined && !questions.includes(selectedQuestion);
			const header = theme.fg("accent", `Subagent ${name}`);
			const questionLine = `${questions.length ? `Questions: ${questions.join(", ")}` : "No open questions"}  Selected: ${selectedQuestion ?? "none"}${selectedClosed ? " (closed)" : ""} (Tab to choose)`;
			let lines: string[];
			try {
				lines = conversationLines(runtime, name).flatMap((line) =>
					wrapTextWithAnsi(line, innerWidth),
				);
			} catch (error) {
				lines = [
					theme.fg(
						"error",
						error instanceof Error ? error.message : String(error),
					),
				];
			}
			lineCount = lines.length;
			pageSize = height - 10;
			const window = viewerWindow(lines, pageSize, scrollTop);
			const footer = confirmStop
				? "Stop this subagent? y/n"
				: "Esc close  PgUp/PgDn scroll  End latest  Tab question  Ctrl-X stop";
			return [
				top,
				row(header),
				row(theme.fg("muted", questionLine)),
				divider,
				...Array.from({ length: pageSize }, (_, index) =>
					row(window.lines[index] ?? ""),
				),
				divider,
				row(
					theme.fg(
						"muted",
						scrollTop === null
							? "Latest"
							: `Scrolled to ${window.top + 1}/${lineCount}`,
					),
				),
				row(theme.fg(confirmStop ? "warning" : "muted", footer)),
				row(note),
				row(input.render(innerWidth)[0] ?? ""),
				bottom,
			];
		},
	};
}
