import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	MessageRenderer,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { Deliverer, type Source } from "../../src/delivery.ts";
import type { ResultDetails } from "../../src/schema.ts";
import {
	createWidget,
	formatDuration,
	formatTokens,
	registerRenderers,
	registerToolRenderers,
	resultContent,
	type ViewRuntime,
} from "../../src/ui.ts";

const baseResult: ResultDetails = {
	v: 1,
	deliveryId: "run:result",
	runId: "run",
	name: "scout-1",
	agent: "scout",
	profile: "quick",
	autoExit: true,
	status: "completed",
	text: "one\ntwo\nthree\nfour",
	truncated: false,
	undelivered: [],
	openQuestions: [],
	durationMs: 1000,
	contextTokens: 500,
	childSessionFile: "/child",
	spawnerSessionFile: "/parent",
};

test("formatting and result details", () => {
	assert.equal(formatDuration(62000), "1:02");
	assert.equal(formatTokens(18200), "18.2k");
	assert.equal(formatTokens(null), "-");
	const detail: ResultDetails = {
		...baseResult,
		status: "crashed",
		durationMs: 62000,
		contextTokens: 18200,
		paneTail: "oops",
		undelivered: ["Hi"],
		openQuestions: [{ qid: "q-abcdef12", text: "Help?" }],
		truncated: true,
	};
	assert.match(resultContent(detail), /Pane output \(last 40 lines\):\noops/);
	assert.match(resultContent(detail), /Continue it with subagent_message/);
});

test("widget renders colored, truncated live and finished rows, notices, and stays empty when idle", () => {
	const colors: string[] = [];
	const theme = {
		fg: (color: string, value: string) => {
			colors.push(color);
			return value;
		},
	} as unknown as Theme;
	const tui = { requestRender: () => {} } as unknown as TUI;
	const now = Date.now();
	type WidgetRun =
		ViewRuntime["runs"] extends ReadonlyMap<string, infer T> ? T : never;
	const runs = new Map<string, WidgetRun>();
	const runtime: ViewRuntime = { runs, done: [], deliverer: undefined };
	const widget = createWidget(runtime, tui, theme, () => now);
	assert.deepEqual(widget.render(30), []);
	for (const [name, state, question, human] of [
		["work", "working", false, false],
		["wait", "waiting", true, false],
		["person", "waiting", false, true],
		["start", "starting", false, false],
	] as const) {
		runs.set(name, {
			spec: { startedAt: now - 62000, launch: { name, agent: "scout" } },
			phase: "live",
			view: { state, question, human, contextTokens: 18200 },
		});
	}
	runs.set("broken", {
		spec: {
			startedAt: now - 62000,
			launch: { name: "broken", agent: "scout" },
		},
		broken: new Error("bad"),
		phase: "live",
	});
	runtime.done.push({
		name: "done",
		agent: "worker",
		startedAt: now - 62000,
		contextTokens: 18200,
		until: now + 1000,
	});
	const lines = widget.render(100);
	assert.equal(lines.length, 6);
	const doneLine = lines.find((line: string) => line.includes("done"));
	assert.ok(doneLine);
	assert.match(doneLine, /done {2}worker {2}done {2}1:02 {2}18.2k/);
	assert.equal(
		createWidget(runtime, tui, theme, () => now + 1000).render(100).length,
		5,
	);
	assert.match(lines.join("\n"), /waiting question/);
	assert.match(lines.join("\n"), /waiting human/);
	assert.match(lines.join("\n"), /1:02/);
	assert.match(lines.join("\n"), /18.2k/);
	for (const color of ["accent", "warning", "success", "error", "muted"])
		assert.ok(colors.includes(color), color);
	assert.ok(
		widget.render(15).every((line: string) => visibleWidth(line) <= 15),
	);
	const pending: { id: string }[] = [];
	const source: Source = {
		key: "test",
		items: () => pending,
		build: (item) => ({
			kind: "message",
			trigger: false,
			message: {
				customType: "test",
				content: "test",
				display: true,
				details: { deliveryId: item.id },
			},
		}),
		confirm: () => {},
	};
	const delivery = new Deliverer(
		{ sendMessage: () => {} } as unknown as ExtensionAPI,
		{
			isIdle: () => true,
			sessionManager: {
				getSessionFile: () => "/missing",
				getEntries: () => [],
			},
		} as unknown as ExtensionContext,
		[source],
		() => false,
		false,
		() => true,
	);
	runtime.deliverer = delivery;
	delivery.onInput();
	assert.doesNotMatch(
		createWidget(runtime, tui, theme, () => Date.now() + 3000)
			.render(100)
			.join("\n"),
		/waiting for your prompt/,
	);
	pending.push({ id: "ready" });
	assert.match(
		createWidget(runtime, tui, theme, () => Date.now() + 3000)
			.render(100)
			.join("\n"),
		/waiting for your prompt to start/,
	);
	delivery.shutdown();
	const broken = new Deliverer(
		{ sendMessage: () => {} } as unknown as ExtensionAPI,
		{
			isIdle: () => true,
			sessionManager: {
				getSessionFile: () => "/missing",
				getEntries: () => [],
			},
		} as unknown as ExtensionContext,
		[source],
		() => false,
		false,
		() => true,
	);
	runtime.deliverer = broken;
	assert.throws(() => broken.pump(), /did not append/);
	assert.match(
		createWidget(runtime, tui, theme, () => Date.now() + 3000)
			.render(100)
			.join("\n"),
		/delivery stopped: Pi did not append subagent message ready/,
	);
	broken.shutdown();
});

test("tool error lines show the diagnostic and not an undefined success label", () => {
	const theme = {
		fg: (color: string, value: string) => `${color}:${value}`,
	} as unknown as Theme;
	for (const tool of ["subagent", "subagent_message"] as const) {
		const text = registerToolRenderers(tool)
			.renderResult(
				{ content: [{ type: "text", text: `Unknown ${tool} request.` }] },
				{},
				theme,
				{ isError: true },
			)
			.render(120)
			.join("\n");
		assert.match(text, /error:Unknown/);
		assert.doesNotMatch(text, /undefined|Started |Message to /);
	}
});

test("closed human results show success while auto-exit closure remains a warning", () => {
	const renderers = new Map<string, any>();
	registerRenderers({
		registerMessageRenderer: (name: string, fn: any) => renderers.set(name, fn),
	} as unknown as ExtensionAPI);
	const theme = {
		fg: (color: string, value: string) => `${color}:${value}`,
	} as any;
	const details: ResultDetails = {
		...baseResult,
		name: "worker-1",
		agent: "worker",
		status: "closed",
		contextTokens: 11,
		text: "Human reply",
	};
	for (const autoExit of [false, true]) {
		const d = { ...details, autoExit };
		const collapsed = renderers
			.get("subagent_result")(
				{ content: "wrong", details: d },
				{ expanded: false },
				theme,
			)
			.render(120)
			.join("\n");
		const expanded = renderers
			.get("subagent_result")(
				{ content: "wrong", details: d },
				{ expanded: true },
				theme,
			)
			.render(120)
			.join("\n");
		assert.match(collapsed, new RegExp(autoExit ? "warning:" : "success:"));
		assert.match(
			expanded,
			autoExit
				? /was closed in its pane after/
				: /was closed in its pane by a human after/,
		);
		assert.match(collapsed, /Human reply/);
		assert.doesNotMatch(expanded, /wrong/);
	}
	const noText = { ...details, autoExit: false, text: "" };
	assert.match(
		renderers
			.get("subagent_result")(
				{ content: "wrong", details: noText },
				{ expanded: true },
				theme,
			)
			.render(120)
			.join("\n"),
		/warning:.*closed/,
	);
	assert.doesNotMatch(resultContent(noText), /by a human/);
});

for (const kind of ["message", "answer"] as const)
	test(`parent ${kind} renderer shows strict instruction details when expanded`, () => {
		const renderers = new Map<string, MessageRenderer>();
		registerRenderers({
			registerMessageRenderer: (name: string, fn: MessageRenderer) =>
				renderers.set(name, fn),
		} as unknown as ExtensionAPI);
		const render = renderers.get("subagent_parent_message");
		assert.ok(render);
		const theme = { fg: (_color: string, text: string) => text } as Theme;
		const message = {
			role: "custom" as const,
			customType: "subagent_parent_message",
			content: "DO NOT PARSE CONTENT",
			display: true,
			timestamp: 0,
		};
		const details = {
			deliveryId: "run:inbox:1",
			kind,
			text: "Read the required file.\nKeep this instruction.",
			...(kind === "answer" ? { qid: "q-abcdef12" } : {}),
		};
		for (const expanded of [false, true]) {
			const component = render(
				{ ...message, details },
				{ expanded, outputPad: 0 },
				theme,
			);
			assert.ok(component);
			const output = component.render(100).join("\n");
			assert.match(output, new RegExp(`Parent message: ${kind}`));
			assert.doesNotMatch(output, /DO NOT PARSE CONTENT/);
			if (expanded)
				assert.match(
					output,
					/Read the required file\.\s+Keep this instruction\./,
				);
			else assert.doesNotMatch(output, /Read the required file/);
		}
		const { text: _text, ...oldDetails } = details;
		for (const expanded of [false, true])
			assert.throws(
				() =>
					render(
						{ ...message, details: oldDetails },
						{ expanded, outputPad: 0 },
						theme,
					),
				/parent message details/,
			);
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
	const details: ResultDetails = { ...baseResult, undelivered: ["Unseen"] };
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
	const call = registerToolRenderers("subagent")
		.renderCall({ agent: "scout", profile: "quick" }, theme, {})
		.render(100);
	assert.equal(call.length, 1);
	const result = registerToolRenderers("subagent_message")
		.renderResult(
			{
				content: [{ type: "text", text: "Queued." }],
				details: { name: "scout" },
			},
			{},
			theme,
			{ isError: false },
		)
		.render(100);
	assert.equal(result.length, 1);
});
