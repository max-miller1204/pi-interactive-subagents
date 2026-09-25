import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	createWidget,
	formatDuration,
	formatTokens,
	registerRenderers,
	registerToolRenderers,
	resultContent,
} from "../../src/ui.ts";

test("formatting and result details", () => {
	assert.equal(formatDuration(62000), "1:02");
	assert.equal(formatTokens(18200), "18.2k");
	assert.equal(formatTokens(null), "-");
	const detail = {
		name: "scout-1",
		agent: "scout",
		status: "crashed",
		durationMs: 62000,
		contextTokens: 18200,
		text: "one\ntwo\nthree\nfour",
		childSessionFile: "/child",
		paneTail: "oops",
		undelivered: ["Hi"],
		openQuestions: [{ qid: "q-abcdef12", text: "Help?" }],
		truncated: true,
	};
	assert.match(
		resultContent(detail as any),
		/Pane output \(last 40 lines\):\noops/,
	);
	assert.match(
		resultContent(detail as any),
		/Continue it with subagent_message/,
	);
});

test("widget renders colored, truncated live and finished rows, notices, and stays empty when idle", () => {
	const colors: string[] = [];
	const theme = {
		fg: (color: string, value: string) => {
			colors.push(color);
			return value;
		},
	} as any;
	const tui = { requestRender: () => {} } as any;
	const now = Date.now();
	const runtime: any = { runs: new Map(), done: [], deliverer: undefined };
	const widget = createWidget(runtime, tui, theme, () => now);
	assert.deepEqual(widget.render(30), []);
	for (const [name, state, question, human] of [
		["work", "working", false, false],
		["wait", "waiting", true, false],
		["person", "waiting", false, true],
		["start", "starting", false, false],
	] as const) {
		runtime.runs.set(name, {
			spec: { startedAt: now - 62000, launch: { name, agent: "scout" } },
			phase: "live",
			view: { state, question, human, contextTokens: 18200 },
		});
	}
	runtime.runs.set("broken", {
		spec: {
			startedAt: now - 62000,
			launch: { name: "broken", agent: "scout" },
		},
		broken: new Error("bad"),
		phase: "live",
	});
	runtime.done.push({ name: "done", until: now + 1000 });
	const lines = widget.render(100);
	assert.equal(lines.length, 6);
	assert.match(lines.join("\n"), /waiting question/);
	assert.match(lines.join("\n"), /waiting human/);
	assert.match(lines.join("\n"), /1:02/);
	assert.match(lines.join("\n"), /18.2k/);
	for (const color of ["accent", "warning", "success", "error", "muted"])
		assert.ok(colors.includes(color), color);
	assert.ok(
		widget.render(15).every((line: string) => visibleWidth(line) <= 15),
	);
	runtime.deliverer = {
		promptPreflightSince: now - 3000,
		brokenError: new Error("disk failed"),
	};
	assert.match(
		widget.render(100).join("\n"),
		/waiting for your prompt to start/,
	);
	assert.match(widget.render(100).join("\n"), /delivery stopped: disk failed/);
});

test("message renderers use details and reveal extended result fields", () => {
	const renderers = new Map<string, any>();
	registerRenderers({
		registerMessageRenderer: (name: string, fn: any) => renderers.set(name, fn),
	} as unknown as ExtensionAPI);
	for (const name of [
		"subagent_result",
		"subagent_question",
		"subagent_withdrawn",
		"subagent_started",
		"subagent_notice",
		"subagent_parent_message",
	])
		assert.ok(renderers.has(name));
	const theme = {
		fg: (_color: string, value: string) => value,
		bg: (_color: string, value: string) => value,
	} as any;
	const details = {
		name: "scout-1",
		agent: "scout",
		status: "completed",
		durationMs: 1000,
		contextTokens: 500,
		text: "one\ntwo\nthree\nfour",
		childSessionFile: "/child",
		undelivered: ["Unseen"],
		openQuestions: [],
	};
	const message = { content: "This content must not be read", details };
	const collapsed = renderers
		.get("subagent_result")(message, { expanded: false, outputPad: 0 }, theme)
		.render(100)
		.join("\n");
	const expanded = renderers
		.get("subagent_result")(message, { expanded: true, outputPad: 0 }, theme)
		.render(100)
		.join("\n");
	assert.match(collapsed, /one/);
	assert.doesNotMatch(collapsed, /four|\/child|This content/);
	assert.match(expanded, /four/);
	assert.match(expanded, /\/child/);
	assert.match(expanded, /Unseen/);
	const call = registerToolRenderers("subagent").renderCall!(
		{ agent: "scout", task: "Read", profile: "quick" } as any,
		theme,
		{} as any,
	).render(100);
	assert.equal(call.length, 1);
	const result = registerToolRenderers("subagent_message").renderResult!(
		{
			content: [{ type: "text", text: "Queued." }],
			details: { name: "scout" },
		} as any,
		{} as any,
		theme,
		{} as any,
	).render(100);
	assert.equal(result.length, 1);
});
