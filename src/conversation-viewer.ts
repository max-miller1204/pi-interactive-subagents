import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Input,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Runtime } from "./parent.ts";
import type { ViewRecord } from "./schema.ts";
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
		.flatMap((part): string[] =>
			part &&
			typeof part === "object" &&
			"text" in part &&
			typeof part.text === "string"
				? [part.text]
				: [],
		)
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
	const lines = branch
		.filter((entry) => entry.type === "message")
		.map((entry) => messageText(entry.message));
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
			const width = Math.max(1, rawWidth);
			const questions = openQuestions();
			if (
				selectedQuestion !== undefined &&
				!questions.includes(selectedQuestion)
			)
				selectedQuestion = undefined;
			const header = theme.fg("accent", `Subagent ${name}`);
			const questionLine = questions.length
				? `Questions: ${questions.join(", ")}  Selected: ${selectedQuestion ?? "none"} (Tab to choose)`
				: "No open questions";
			let lines: string[];
			try {
				lines = conversationLines(runtime, name).flatMap((line) =>
					wrapTextWithAnsi(line, width),
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
			pageSize = Math.max(1, Math.min(30, tui.terminal.rows - 9));
			const window = viewerWindow(lines, pageSize, scrollTop);
			const footer = confirmStop
				? "Stop this subagent? y/n"
				: "Esc close  PgUp/PgDn scroll  End latest  Tab question  Ctrl-X stop";
			return [
				truncateToWidth(header, width),
				truncateToWidth(theme.fg("muted", questionLine), width),
				...window.lines.map((line) => truncateToWidth(line, width)),
				truncateToWidth(
					theme.fg(
						"muted",
						scrollTop === null
							? "Latest"
							: `Scrolled to ${window.top + 1}/${lineCount}`,
					),
					width,
				),
				truncateToWidth(
					theme.fg(confirmStop ? "warning" : "muted", footer),
					width,
				),
				...(note ? [truncateToWidth(note, width)] : []),
				...input.render(width).map((line) => truncateToWidth(line, width)),
			];
		},
	};
}
