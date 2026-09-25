import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { discoverAgents } from "../../src/config.ts";
import {
	questionContent,
	registerCommand,
	registerTools,
	subagentsSection,
} from "../../src/tools.ts";

test("registered tools validate closed parameters and route calls", async () => {
	const tools = new Map<string, any>();
	const pi = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
	} as unknown as ExtensionAPI;
	const calls: unknown[] = [];
	const runtime = {
		list: () => ({ live: [], launching: [], branch: new Map() }),
		spawn: async (draft: any, task: string, id: string) => {
			calls.push([draft, task, id]);
			return {
				spec: {
					runId: "run",
					launch: {
						name: draft.name,
						agent: draft.agent,
						profile: draft.profile,
						childSessionFile: "/child",
						autoExit: true,
					},
				},
				pane: { paneId: "%2" },
			};
		},
		message: async (...args: unknown[]) => {
			calls.push(args);
			return "Queued.";
		},
	};
	const catalog = {
		catalog: {
			agents: {
				scout: {
					name: "scout",
					description: "Read files",
					scope: "package",
					tools: ["read"],
					skills: "none",
					session: "standalone",
					autoExit: true,
					modelInvocable: true,
					spawns: [],
				},
			},
			profiles: {
				quick: {
					model: { provider: "p", id: "m" },
					thinking: "low",
					guidance: "Short tasks.",
				},
			},
		},
		errors: [],
		ignoredProjectAgents: [],
		projectFilesIgnored: false,
		profileError: null,
	} as any;
	const resolve = (options: any) => ({
		name: options.name,
		agent: options.agent,
		profile: options.profile,
		autoExit: true,
	});
	registerTools(pi, runtime as any, () => catalog, resolve as any);
	const start = tools.get("subagent");
	assert.equal(start.executionMode, "sequential");
	assert.equal(
		Value.Check(start.parameters, { agent: "scout", task: "Read" }),
		false,
	);
	assert.equal(
		Value.Check(start.parameters, {
			agent: "scout",
			task: "Read",
			profile: "quick",
			legacy: true,
		}),
		false,
	);
	assert.equal(
		Value.Check(start.parameters, {
			agent: "scout",
			task: "Read",
			profile: "quick",
		}),
		true,
	);
	const ctx = { cwd: "/work" } as any;
	const result = await start.execute(
		"id",
		{ agent: "scout", task: "Read", profile: "quick" },
		undefined,
		undefined,
		ctx,
	);
	assert.match(
		result.content[0].text,
		/Started subagent "scout-1" \(agent scout, profile quick\) in pane %2/,
	);
	assert.deepEqual(result.details, {
		runId: "run",
		name: "scout-1",
		agent: "scout",
		profile: "quick",
		paneId: "%2",
		childSessionFile: "/child",
	});
	assert.equal((calls[0] as any[])[2], "id");
	const message = tools.get("subagent_message");
	assert.equal(message.executionMode, "sequential");
	assert.equal(
		Value.Check(message.parameters, {
			name: "scout-1",
			message: "yes",
			question_id: "q-abcdef12",
			legacy: true,
		}),
		false,
	);
	await message.execute("id", {
		name: "scout-1",
		message: "yes",
		question_id: "q-abcdef12",
	});
	assert.deepEqual(calls[1], ["scout-1", "yes", "q-abcdef12"]);
	const list = tools.get("subagents_list");
	assert.equal(Value.Check(list.parameters, {}), true);
	assert.equal(Value.Check(list.parameters, { legacy: true }), false);
	assert.match((await list.execute("id", {})).content[0].text, /Agents:/);
	assert.match(subagentsSection(catalog), /quick: p\/m/);
	assert.equal(
		questionContent("scout-1", "scout", "q-abcdef12", "Help?"),
		'Subagent "scout-1" (agent scout) asks question q-abcdef12:\n\nHelp?\n\nIt waits for your answer. Reply with subagent_message({ name: "scout-1", question_id: "q-abcdef12", message }).',
	);
});

test("command selects a profile, launches and sends a non-triggering started message", async () => {
	let command: any;
	const sent: unknown[] = [];
	const pi = {
		registerCommand: (_name: string, value: any) => {
			command = value;
		},
		sendMessage: (...args: unknown[]) => sent.push(args),
	} as unknown as ExtensionAPI;
	const runtime = {
		list: () => ({ live: [], launching: [], branch: new Map() }),
		spawn: async (launch: any) => ({
			spec: { runId: "run", launch },
			pane: { paneId: "%2" },
		}),
	};
	const catalog = {
		catalog: {
			agents: { scout: { modelInvocable: true } },
			profiles: { quick: {} },
		},
	} as any;
	registerCommand(pi, runtime as any, () => catalog, ((o: any) => ({
		name: o.name,
		agent: o.agent,
		profile: o.profile,
	})) as any);
	const ctx = {
		cwd: "/work",
		ui: {
			select: async () => "quick",
			editor: async () => "Read files",
			notify: () => {},
		},
	} as any;
	assert.deepEqual(command.getArgumentCompletions("sc"), [
		{ value: "scout", label: "scout" },
	]);
	await command.handler("scout", ctx);
	assert.deepEqual(sent[0], [
		{
			customType: "subagent_started",
			content:
				'The user started subagent "scout-1" (agent scout) with /subagent. Its result arrives as a message.',
			display: true,
			details: {
				name: "scout-1",
				agent: "scout",
				profile: "quick",
				runId: "run",
			},
		},
		{ triggerTurn: false },
	]);
});

test("bundled agents are discovered with their tool lists and spawn rights", () => {
	const own = join(process.cwd(), "src/index.ts");
	// Discovery requires a real extension path. Task 5 adds the factory.
	const discovered = discoverAgents(
		{ cwd: process.cwd(), isProjectTrusted: () => false },
		join(process.cwd(), "src/parent.ts"),
		join(process.cwd(), "test"),
	);
	const scout = discovered.agents.get("scout");
	const worker = discovered.agents.get("worker");
	assert.ok(scout && !("error" in scout));
	assert.ok(worker && !("error" in worker));
	assert.deepEqual(scout.tools, ["read", "grep", "find", "ls"]);
	assert.deepEqual(worker.tools, [
		"read",
		"write",
		"edit",
		"bash",
		"grep",
		"find",
		"ls",
	]);
	assert.deepEqual(worker.spawns, ["scout"]);
});
