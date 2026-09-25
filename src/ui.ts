import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Text,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { Deliverer } from "./delivery.ts";
import type { Runtime } from "./parent.ts";
import type { ChildStatus, ResultDetails } from "./schema.ts";

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function formatTokens(tokens: number | null): string {
	return tokens === null
		? "-"
		: tokens >= 1000
			? `${(tokens / 1000).toFixed(1)}k`
			: String(tokens);
}
export function resultContent(details: ResultDetails): string {
	let state: string;
	switch (details.status) {
		case "completed":
			state = "finished";
			break;
		case "aborted":
			state = "was interrupted";
			break;
		case "no_output":
			state = "ended without output";
			break;
		case "closed":
			state = `was closed in its pane${!details.autoExit && details.text.length > 0 ? " by a human" : ""}`;
			break;
		case "failed":
			state = `could not start: ${details.errorMessage}`;
			break;
		case "error":
			state =
				details.errorMessage === undefined
					? "failed"
					: `failed: ${details.errorMessage}`;
			break;
		case "crashed":
			state =
				details.signal === undefined
					? `crashed (exit code ${details.exitCode})`
					: `crashed (signal ${details.signal})`;
			break;
	}
	const lines = [
		`Subagent "${details.name}" (agent ${details.agent}) ${state} after ${(details.durationMs / 1000).toFixed(1)}s, context ${details.contextTokens === null ? "unknown" : details.contextTokens}.`,
	];
	if (details.text) lines.push(details.text);
	if (details.truncated)
		lines.push(
			`[The output is cut. Full transcript: ${details.childSessionFile}]`,
		);
	if (details.note) lines.push(`Note: ${details.note}`);
	if (details.status === "crashed" && details.paneTail)
		lines.push(`Pane output (last 40 lines):\n${details.paneTail}`);
	if (details.undelivered.length)
		lines.push(
			`Messages it did not read:\n${details.undelivered.map((text, i) => `${i + 1}. ${text}`).join("\n")}`,
		);
	if (details.openQuestions.length)
		lines.push(
			`Open questions when it ended:\n${details.openQuestions.map((q) => `- ${q.qid}: ${q.text}`).join("\n")}`,
		);
	lines.push(
		`Continue it with subagent_message({ name: "${details.name}", message }).`,
	);
	return lines.join("\n\n");
}

export interface ViewRuntime {
	runs: ReadonlyMap<
		string,
		{
			spec: { startedAt: number; launch: { name: string; agent: string } };
			phase: "live" | "finishing" | "finished";
			view?: Pick<
				ChildStatus,
				"state" | "question" | "human" | "contextTokens"
			>;
			broken?: Error;
		}
	>;
	done: Runtime["done"];
	deliverer: Pick<Deliverer, "view"> | undefined;
}
export function createWidget(
	runtime: ViewRuntime,
	tui: TUI,
	theme: Theme,
	now: () => number = Date.now,
): Component {
	return {
		invalidate() {
			tui.requestRender();
		},
		render(width: number) {
			const lines: string[] = [];
			const time = now();
			for (const run of runtime.runs.values()) {
				const { name, agent } = run.spec.launch;
				const status = run.view;
				const state = run.broken
					? "broken"
					: run.phase === "finished"
						? "done"
						: (status?.state ?? "starting");
				const suffix =
					state === "waiting"
						? status?.question
							? " question"
							: status?.human
								? " human"
								: ""
						: "";
				const color =
					state === "working"
						? "accent"
						: state === "done"
							? "success"
							: state === "broken"
								? "error"
								: "warning";
				const icon =
					state === "working"
						? "●"
						: state === "done"
							? "✓"
							: state === "broken"
								? "✗"
								: "○";
				const row = `${theme.fg(color, icon)} ${theme.fg("muted", name)}  ${theme.fg("muted", agent)}  ${theme.fg(color, state + suffix)}  ${theme.fg("muted", formatDuration(time - run.spec.startedAt))}  ${theme.fg("muted", formatTokens(status?.contextTokens ?? null))}`;
				lines.push(truncateToWidth(row, width));
			}
			for (const row of runtime.done)
				if (row.until > time)
					lines.push(
						truncateToWidth(
							`${theme.fg("success", "✓")} ${theme.fg("muted", row.name)}  ${theme.fg("muted", row.agent)}  ${theme.fg("success", "done")}  ${theme.fg("muted", formatDuration(time - row.startedAt))}  ${theme.fg("muted", formatTokens(row.contextTokens))}`,
							width,
						),
					);
			const delivery = runtime.deliverer?.view(time);
			if (delivery?.promptBlocked)
				lines.push(
					truncateToWidth(
						theme.fg("warning", "waiting for your prompt to start"),
						width,
					),
				);
			if (delivery?.brokenError)
				lines.push(
					truncateToWidth(
						theme.fg("error", `delivery stopped: ${delivery.brokenError}`),
						width,
					),
				);
			return lines;
		},
	};
}
export function registerWidget(
	ctx: ExtensionContext,
	runtime: ViewRuntime,
): void {
	ctx.ui.setWidget(
		"subagents",
		(tui, theme) => createWidget(runtime, tui, theme),
		{ placement: "aboveEditor" },
	);
}
function detailsOf<T>(details: unknown): T {
	if (details === null || typeof details !== "object")
		throw new Error("Subagent message has no details.");
	return details as T;
}
export function registerRenderers(
	pi: Pick<ExtensionAPI, "registerMessageRenderer">,
): void {
	pi.registerMessageRenderer(
		"subagent_result",
		(message, { expanded }, theme) => {
			const details = detailsOf<ResultDetails>(message.details);
			const success =
				details.status === "completed" ||
				(details.status === "closed" &&
					!details.autoExit &&
					details.text.length > 0);
			const header = `${success ? "✓" : "●"} ${details.name}  ${details.agent}  ${details.status}  ${formatDuration(details.durationMs)}  ${formatTokens(details.contextTokens)}`;
			const body = expanded
				? `${resultContent(details)}\nFull transcript: ${details.childSessionFile}`
				: details.text.split("\n").slice(0, 3).join("\n");
			return new Text(
				`${theme.fg(success ? "success" : "warning", header)}\n${body}`,
				0,
				0,
			);
		},
	);
	pi.registerMessageRenderer(
		"subagent_question",
		(message, _options, theme) => {
			const d = detailsOf<{
				name: string;
				agent: string;
				qid: string;
				question: string;
			}>(message.details);
			return new Text(
				`${theme.fg("warning", `? ${d.name} (${d.agent}) asks ${d.qid}`)}\n${d.question}`,
				0,
				0,
			);
		},
	);
	pi.registerMessageRenderer(
		"subagent_withdrawn",
		(message, _options, theme) => {
			const d = detailsOf<{ name: string; qid: string }>(message.details);
			return new Text(
				theme.fg("muted", `${d.name} withdrew question ${d.qid}.`),
				0,
				0,
			);
		},
	);
	pi.registerMessageRenderer("subagent_started", (message, _options, theme) => {
		const d = detailsOf<{ name: string; agent: string; profile: string }>(
			message.details,
		);
		return new Text(
			theme.fg("accent", `● ${d.name} (${d.agent}, ${d.profile}) started`),
			0,
			0,
		);
	});
	pi.registerMessageRenderer(
		"subagent_notice",
		(message, { expanded }, theme) => {
			const d = detailsOf<{ stopped: string[]; undelivered: ResultDetails[] }>(
				message.details,
			);
			return new Text(
				theme.fg(
					"warning",
					`Subagent delivery notice: ${d.stopped.join(", ")}`,
				) +
					(expanded ? `\n${d.undelivered.map(resultContent).join("\n")}` : ""),
				0,
				0,
			);
		},
	);
	pi.registerMessageRenderer(
		"subagent_parent_message",
		(message, _options, theme) => {
			const d = detailsOf<{ kind: string; qid?: string }>(message.details);
			return new Text(
				theme.fg(
					"accent",
					`Parent message: ${d.kind}${d.qid ? ` ${d.qid}` : ""}`,
				),
				0,
				0,
			);
		},
	);
}
export function registerToolRenderers(name: "subagent" | "subagent_message") {
	return {
		renderCall(
			args: { agent?: string; name?: string; profile?: string },
			theme: Theme,
			_context?: unknown,
		): Component {
			return new Text(
				theme.fg(
					"accent",
					name === "subagent"
						? `subagent ${args.agent} (${args.profile})`
						: `subagent_message ${args.name}`,
				),
				0,
				0,
			);
		},
		renderResult(
			result: {
				details?: { name?: string };
				content: { type: string; text?: string }[];
			},
			_options: unknown,
			theme: Theme,
			_context: { isError: boolean },
		): Component {
			if (_context.isError) {
				const diagnostic = result.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join(" ")
					.replace(/\s+/g, " ")
					.trim();
				if (!diagnostic)
					throw new Error(`The ${name} tool error has no diagnostic.`);
				return new Text(theme.fg("error", diagnostic), 0, 0);
			}
			const target = result.details?.name;
			if (!target)
				throw new Error(`The ${name} tool result has no subagent name.`);
			return new Text(
				theme.fg(
					"muted",
					name === "subagent" ? `Started ${target}` : `Message to ${target}`,
				),
				0,
				0,
			);
		},
	};
}
