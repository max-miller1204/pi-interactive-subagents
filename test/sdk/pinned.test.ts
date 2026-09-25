import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	AgentSessionRuntime,
	type BoundaryResult,
	CURRENT_SESSION_VERSION,
	createAgentSession,
	createAgentSessionFromServices,
	type ExtensionAPI,
	type ExtensionContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHarness, readSessionFile, runCli } from "./harness.ts";

test("P1: boundary drafts persist before continuation and only message content enters the request", {
	timeout: 20_000,
}, async (t) => {
	const observations = [];
	for (const boundary of ["turn_end", "agent_before_settle"] as const) {
		let offered = false;
		const harness = await createHarness(t, (pi) => {
			const handler = (): BoundaryResult | undefined => {
				if (offered) return;
				offered = true;
				return {
					entries: [
						{
							type: "custom",
							customType: "p1-state",
							data: { marker: `${boundary}-state-marker` },
						},
						{
							type: "custom_message",
							customType: "p1-message",
							content: `${boundary}-message-marker`,
							display: true,
							details: { deliveryId: boundary },
						},
					],
					continue: true,
				};
			};
			if (boundary === "turn_end") pi.on("turn_end", handler);
			else pi.on("agent_before_settle", handler);
		});
		const snapshots: { request: string; memory: string; disk: string }[] = [];
		harness.faux.setResponses([
			fauxAssistantMessage("First response."),
			(context) => {
				snapshots.push({
					request: JSON.stringify(context),
					memory: JSON.stringify(harness.session.sessionManager.getEntries()),
					disk: JSON.stringify(readSessionFile(harness.session)),
				});
				return fauxAssistantMessage("Second response.");
			},
		]);
		await harness.session.prompt("Test the boundary.");
		harness.assertNoErrors();
		assert.equal(
			harness.faux.state.callCount,
			2,
			`${boundary}: continue must add exactly one request`,
		);
		assert.equal(snapshots.length, 1);
		const snapshot = snapshots[0];
		assert.ok(snapshot);
		for (const source of [snapshot.memory, snapshot.disk]) {
			assert.ok(
				source.includes(`${boundary}-state-marker`),
				`${boundary}: custom draft must be committed`,
			);
			assert.ok(
				source.includes(`${boundary}-message-marker`),
				`${boundary}: custom message must be committed`,
			);
		}
		observations.push({ boundary, ...snapshot });
	}
	for (const { boundary, request } of observations) {
		assert.ok(
			request.includes(`${boundary}-message-marker`),
			`${boundary}: next request must include the custom message`,
		);
		assert.equal(
			request.includes(`${boundary}-state-marker`),
			false,
			`${boundary}: custom state must stay outside model context`,
		);
	}
});

test("P2: abort reports an aborted turn boundary without a before-settle boundary", {
	timeout: 20_000,
}, async (t) => {
	const started = Promise.withResolvers<void>();
	const outcomes: string[] = [];
	const events: string[] = [];
	const { session, faux, assertNoErrors } = await createHarness(t, (pi) => {
		pi.on("turn_end", (event) => {
			outcomes.push(event.outcome);
		});
		pi.on("agent_before_settle", () => {
			events.push("agent_before_settle");
		});
		pi.on("agent_settled", () => {
			events.push("agent_settled");
		});
	});
	faux.setResponses([
		async (_context, options) => {
			assert.ok(options?.signal);
			const aborted = new Promise<void>((resolve) => {
				options.signal?.addEventListener("abort", () => resolve(), {
					once: true,
				});
			});
			started.resolve();
			await aborted;
			return fauxAssistantMessage("Aborted response.");
		},
	]);
	const prompt = session.prompt("Abort this request.");
	await started.promise;
	await session.abort();
	await prompt;
	assertNoErrors();
	assert.deepEqual(outcomes, ["aborted"]);
	assert.deepEqual(events, ["agent_settled"]);
	const assistant = session.messages.findLast(
		(message) => message.role === "assistant",
	);
	assert.ok(assistant?.role === "assistant");
	assert.equal(assistant.stopReason, "aborted");
});

test("P3: an idle triggering send starts a run synchronously and persists once", {
	timeout: 20_000,
}, async (t) => {
	let api: ExtensionAPI | undefined;
	let context: ExtensionContext | undefined;
	const settled = Promise.withResolvers<void>();
	const { session, faux, assertNoErrors } = await createHarness(t, (pi) => {
		api = pi;
		pi.on("session_start", (_event, ctx) => {
			context = ctx;
		});
		pi.on("agent_settled", () => {
			settled.resolve();
		});
	});
	assert.ok(api);
	assert.ok(context);
	assert.equal(context.isIdle(), true);
	faux.setResponses([fauxAssistantMessage("Received.")]);
	api.sendMessage(
		{
			customType: "p3",
			content: "P3 delivery",
			display: true,
			details: { deliveryId: "p3" },
		},
		{ triggerTurn: true },
	);
	assert.equal(
		context.isIdle(),
		false,
		"sendMessage must start the run before returning",
	);
	await settled.promise;
	assertNoErrors();
	assert.equal(faux.state.callCount, 1);
	for (const entries of [
		session.sessionManager.getEntries(),
		readSessionFile(session),
	]) {
		assert.equal(
			entries.filter((entry) =>
				JSON.stringify(entry).includes('"deliveryId":"p3"'),
			).length,
			1,
		);
	}
});

test("P4: an idle non-triggering send appends to memory before returning", {
	timeout: 20_000,
}, async (t) => {
	let api: ExtensionAPI | undefined;
	let context: ExtensionContext | undefined;
	const { session, faux, assertNoErrors } = await createHarness(t, (pi) => {
		api = pi;
		pi.on("session_start", (_event, ctx) => {
			context = ctx;
		});
	});
	assert.ok(api);
	assert.ok(context);
	assert.equal(context.isIdle(), true);
	api.sendMessage(
		{
			customType: "p4",
			content: "P4 delivery",
			display: true,
			details: { deliveryId: "p4" },
		},
		{ triggerTurn: false },
	);
	const delivered = session.sessionManager
		.getEntries()
		.filter(
			(entry) => entry.type === "custom_message" && entry.customType === "p4",
		);
	assert.equal(delivered.length, 1);
	assert.equal(context.isIdle(), true);
	assert.equal(faux.state.callCount, 0);
	assertNoErrors();
});

test("P5: header-only sessions persist immediately but new sessions wait for an assistant", {
	timeout: 20_000,
}, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-p5-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const headerFile = join(root, "header.jsonl");
	writeFileSync(
		headerFile,
		`${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "p5-header", timestamp: new Date().toISOString(), cwd: root })}\n`,
	);
	const opened = SessionManager.open(headerFile);
	assert.deepEqual(opened.getEntries(), []);
	const headerEntryId = opened.appendCustomEntry("p5-header-entry", {
		marker: "header-marker",
	});
	const headerDisk = readFileSync(headerFile, "utf8")
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.equal(headerDisk.length, 2);
	assert.equal(headerDisk[1].id, headerEntryId);
	const { session, faux, assertNoErrors } = await createHarness(t, () => {});
	const file = session.sessionManager.getSessionFile();
	assert.ok(file);
	assert.equal(existsSync(file), false);
	const memoryId = session.sessionManager.appendCustomEntry("p5-memory", {
		marker: "memory-marker",
	});
	assert.ok(
		session.sessionManager.getEntries().some((entry) => entry.id === memoryId),
	);
	assert.equal(existsSync(file), false);
	let fileAtRequest: boolean | undefined;
	faux.setResponses([
		() => {
			fileAtRequest = existsSync(file);
			return fauxAssistantMessage("Create the session file.");
		},
	]);
	await session.prompt("Start the first assistant response.");
	assertNoErrors();
	assert.equal(fileAtRequest, false);
	assert.equal(existsSync(file), true);
	assert.ok(JSON.stringify(readSessionFile(session)).includes(memoryId));
	const durableId = session.sessionManager.appendCustomEntry("p5-durable", {
		marker: "durable-marker",
	});
	assert.ok(JSON.stringify(readSessionFile(session)).includes(durableId));
});

test("P6: input precedes awaited preflight and agent_start follows preflight", {
	timeout: 20_000,
}, async (t) => {
	const preflight = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const events: string[] = [];
	const idle: boolean[] = [];
	const { session, faux, assertNoErrors } = await createHarness(t, (pi) => {
		pi.on("input", (_event, ctx) => {
			events.push("input");
			idle.push(ctx.isIdle());
		});
		pi.on("before_agent_start", async (_event, ctx) => {
			events.push("preflight_enter");
			idle.push(ctx.isIdle());
			preflight.resolve();
			await release.promise;
			events.push("preflight_exit");
		});
		pi.on("agent_start", (_event, ctx) => {
			events.push("agent_start");
			idle.push(ctx.isIdle());
		});
	});
	let request = "";
	faux.setResponses([
		(context) => {
			events.push("request");
			request = JSON.stringify(context);
			return fauxAssistantMessage("Done.");
		},
	]);
	const prompt = session.prompt("P6 prompt");
	await preflight.promise;
	assert.deepEqual(events, ["input", "preflight_enter"]);
	assert.deepEqual(idle, [true, true]);
	assert.equal(faux.state.callCount, 0);
	release.resolve();
	await prompt;
	assertNoErrors();
	assert.deepEqual(events, [
		"input",
		"preflight_enter",
		"preflight_exit",
		"agent_start",
		"request",
	]);
	assert.deepEqual(idle, [true, true, false]);
	assert.ok(request.includes("P6 prompt"));
});

test("P7: interactive argv input follows session_start with interactive source", {
	timeout: 20_000,
}, async (t) => {
	const result = await runCli(t, {
		interactive: true,
		prompt: "P7 argv prompt",
	});
	const start = result.events.findIndex(
		(event) => event.type === "session_start",
	);
	const input = result.events.findIndex((event) => event.type === "input");
	assert.ok(start >= 0);
	assert.ok(input > start);
	assert.equal(result.events[start]?.mode, "tui");
	assert.equal(result.events[input]?.source, "interactive");
	assert.equal(result.events[input]?.text, "P7 argv prompt");
	assert.ok(result.events.some((event) => event.type === "request"));
	assert.ok(result.events.some((event) => event.type === "agent_settled"));
});

test("P8: session replacement settles the aborted old run before shutdown", {
	timeout: 20_000,
}, async (t) => {
	const events: string[] = [];
	const started = Promise.withResolvers<void>();
	const { session, faux, services, assertNoErrors } = await createHarness(
		t,
		(pi) => {
			pi.on("agent_settled", () => {
				events.push("agent_settled");
			});
			pi.on("session_shutdown", () => {
				events.push("session_shutdown");
			});
		},
	);
	const runtime = new AgentSessionRuntime(
		session,
		services,
		async ({ sessionManager, sessionStartEvent }) => ({
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				model: faux.getModel(),
				tools: [],
				...(sessionStartEvent ? { sessionStartEvent } : {}),
			})),
			services,
			diagnostics: services.diagnostics,
		}),
	);
	t.after(() => runtime.dispose());
	faux.setResponses([
		async (_context, options) => {
			assert.ok(options?.signal);
			const aborted = new Promise<void>((resolve) => {
				options.signal?.addEventListener("abort", () => resolve(), {
					once: true,
				});
			});
			started.resolve();
			await aborted;
			return fauxAssistantMessage("Replaced.");
		},
	]);
	const prompt = session.prompt("Replace the active session.");
	await started.promise;
	assert.equal(session.isIdle, false);
	const oldId = session.sessionId;
	const result = await runtime.newSession();
	await prompt;
	assertNoErrors();
	assert.equal(result.cancelled, false);
	assert.notEqual(runtime.session.sessionId, oldId);
	assert.deepEqual(events, ["agent_settled", "session_shutdown"]);
});

test("P9: clearing queues and compacting an active run preserve appended entries exactly once", {
	timeout: 20_000,
}, async (t) => {
	let api: ExtensionAPI | undefined;
	const { session, faux, services, assertNoErrors } = await createHarness(
		t,
		(pi) => {
			api = pi;
		},
	);
	services.settingsManager.applyOverrides({
		compaction: { keepRecentTokens: 1, reserveTokens: 128 },
	});
	assert.ok(api);
	faux.setResponses([
		fauxAssistantMessage("First answer. ".repeat(100)),
		fauxAssistantMessage("Second answer. ".repeat(100)),
	]);
	await session.prompt("First prompt. ".repeat(100));
	await session.prompt("Second prompt. ".repeat(100));
	api.appendEntry("p9-state", { deliveryId: "p9-state" });
	api.sendMessage(
		{
			customType: "p9-message",
			content: "Already delivered.",
			display: true,
			details: { deliveryId: "p9-message" },
		},
		{ triggerTurn: false },
	);
	const before = session.sessionManager.getEntries();
	const started = Promise.withResolvers<void>();
	faux.setResponses([
		async (_context, options) => {
			assert.ok(options?.signal);
			const aborted = new Promise<void>((resolve) => {
				options.signal?.addEventListener("abort", () => resolve(), {
					once: true,
				});
			});
			started.resolve();
			await aborted;
			return fauxAssistantMessage("Interrupted.");
		},
		fauxAssistantMessage("Summary of the first two prompts and answers."),
	]);
	const prompt = session.prompt("Third prompt.");
	await started.promise;
	await session.steer("Queued steer.");
	await session.followUp("Queued follow-up.");
	assert.equal(session.getSteeringMessages().length, 1);
	assert.equal(session.getFollowUpMessages().length, 1);
	session.clearQueue();
	assert.deepEqual(session.getSteeringMessages(), []);
	assert.deepEqual(session.getFollowUpMessages(), []);
	for (const entry of before)
		assert.equal(
			session.sessionManager
				.getEntries()
				.filter((current) => current.id === entry.id).length,
			1,
		);
	await session.compact();
	await prompt;
	assertNoErrors();
	const after = session.sessionManager.getEntries();
	assert.equal(after.filter((entry) => entry.type === "compaction").length, 1);
	for (const entry of before) {
		assert.deepEqual(
			after.filter((current) => current.id === entry.id),
			[entry],
		);
		assert.equal(
			readSessionFile(session).filter(
				(current) => JSON.stringify(current) === JSON.stringify(entry),
			).length,
			1,
		);
	}
});

test("P10: re-registering an active tool refreshes its system prompt guidelines", {
	timeout: 20_000,
}, async (t) => {
	let api: ExtensionAPI | undefined;
	const tool = (guideline: string) => ({
		name: "p10",
		label: "P10",
		description: "Check guidelines.",
		promptGuidelines: [guideline],
		parameters: Type.Object({}),
		execute: async () => ({
			content: [{ type: "text" as const, text: "Done." }],
			details: undefined,
		}),
	});
	const { session, faux, assertNoErrors } = await createHarness(
		t,
		(pi) => {
			api = pi;
			pi.registerTool(tool("P10 old guideline"));
		},
		{ tools: ["p10"] },
	);
	assert.ok(api);
	api.setActiveTools(["p10"]);
	const requests: string[] = [];
	faux.setResponses([
		(context) => {
			requests.push(JSON.stringify(context));
			return fauxAssistantMessage("First.");
		},
		(context) => {
			requests.push(JSON.stringify(context));
			return fauxAssistantMessage("Second.");
		},
	]);
	await session.prompt("Use the first guidelines.");
	assert.ok(session.systemPrompt.includes("P10 old guideline"));
	api.registerTool(tool("P10 new guideline"));
	assert.ok(session.systemPrompt.includes("P10 new guideline"));
	assert.equal(session.systemPrompt.includes("P10 old guideline"), false);
	await session.prompt("Use the new guidelines.");
	assertNoErrors();
	assert.equal(requests.length, 2);
	assert.ok(requests[0]?.includes("P10 old guideline"));
	assert.ok(requests[1]?.includes("P10 new guideline"));
});

test("P11: CLI append-system-prompt reads existing files and treats missing paths as text", {
	timeout: 20_000,
}, async (t) => {
	for (const exists of [true, false]) {
		const result = await runCli(t, {
			prompt: "P11 prompt",
			appendPrompt: { exists, content: "P11 file contents marker" },
		});
		const start = result.events.find((event) => event.type === "session_start");
		assert.ok(start);
		assert.equal(typeof start.systemPrompt, "string");
		assert.ok(result.appendPath);
		const expected = exists ? "P11 file contents marker" : result.appendPath;
		assert.ok(String(start.systemPrompt).includes(expected));
		assert.ok(
			JSON.stringify(
				result.events.find((event) => event.type === "request"),
			).includes(expected),
		);
	}
});

test("P12: CLI model patterns can select another ID and thinking is clamped", {
	timeout: 20_000,
}, async (t) => {
	const result = await runCli(t, {
		prompt: "P12 prompt",
		flags: ["--model", "pinned-cli/fixture", "--thinking", "xhigh"],
	});
	const start = result.events.find((event) => event.type === "session_start");
	assert.ok(start);
	assert.deepEqual(
		{
			provider: (start.model as { provider: string }).provider,
			id: (start.model as { id: string }).id,
		},
		{ provider: "pinned-cli", id: "fixture-model" },
	);
	assert.equal(start.thinking, "off");
	assert.equal(result.output.includes("Error:"), false);
	const unknown = await runCli(t, {
		prompt: "P12 custom model prompt",
		flags: ["--model", "pinned-cli/not-in-catalog"],
	});
	const unknownStart = unknown.events.find(
		(event) => event.type === "session_start",
	);
	assert.ok(unknownStart);
	assert.equal((unknownStart.model as { id: string }).id, "not-in-catalog");
	assert.match(
		unknown.output,
		/Warning: Model "not-in-catalog" not found for provider "pinned-cli"\. Using custom model id\./,
	);
	t.diagnostic(
		"A fuzzy model ID selected another catalog ID silently. An unknown ID ran as a custom model with a warning. Non-reasoning thinking was clamped to off.",
	);
});

test("P13: bare SDK has no registered providers and CLI loads built-in llama.cpp", {
	timeout: 20_000,
}, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-p13-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const { session, extensionsResult } = await createAgentSession({
		cwd: root,
		agentDir: join(root, "agent"),
	});
	t.after(() => session.dispose());
	assert.deepEqual(extensionsResult.errors, []);
	await session.bindExtensions({ mode: "tui" });
	assert.deepEqual(session.modelRuntime.getRegisteredProviderIds(), []);
	const result = await runCli(t, { prompt: "P13 CLI prompt" });
	const start = result.events.find((event) => event.type === "session_start");
	assert.ok(start);
	assert.deepEqual(start.registeredProviderIds, ["llama.cpp", "pinned-cli"]);
});

test("P14: Pi supplies typebox imports to extensions and Value.Check applies no defaults", {
	timeout: 20_000,
}, async (t) => {
	const { session, assertNoErrors } = await createHarness(t, () => {}, {
		extensionSource: `
import { Type } from "typebox";
import { Value } from "typebox/value";
export default function (pi) {
  const schema = Type.Object({ name: Type.String({ default: "default-name" }) });
  const value = {};
  const valid = Value.Check(schema, value);
  pi.on("session_start", () => {
    pi.appendEntry("p14", { valid, value, populatedValid: Value.Check(schema, { name: "explicit-name" }) });
  });
}
`,
	});
	assertNoErrors();
	const entries = session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "p14");
	assert.equal(entries.length, 1);
	const entry = entries[0];
	assert.ok(entry?.type === "custom");
	assert.deepEqual(entry.data, {
		valid: false,
		value: {},
		populatedValid: true,
	});
});

test("P15: ctx.getSystemPrompt includes appended text and the model receives it", {
	timeout: 20_000,
}, async (t) => {
	let systemPrompt: string | undefined;
	const marker = "P15 appended system prompt marker";
	const { session, faux, assertNoErrors } = await createHarness(
		t,
		(pi) => {
			pi.on("session_start", (_event, ctx) => {
				systemPrompt = ctx.getSystemPrompt();
			});
		},
		{ appendSystemPrompt: [marker] },
	);
	assert.ok(systemPrompt);
	assert.ok(systemPrompt.includes(marker));
	assert.ok(systemPrompt.includes("You are an expert coding assistant"));
	assert.equal(systemPrompt, session.systemPrompt);
	let request = "";
	faux.setResponses([
		(context) => {
			request = JSON.stringify(context);
			return fauxAssistantMessage("Done.");
		},
	]);
	await session.prompt("P15 prompt");
	assertNoErrors();
	assert.ok(request.includes(marker));
});
