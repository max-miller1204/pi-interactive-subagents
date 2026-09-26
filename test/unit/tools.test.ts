import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { CatalogInput, ResolveLaunchOptions } from "../../src/catalog.ts";
import { discoverAgents } from "../../src/config.ts";
import type { Runtime } from "../../src/parent.ts";
import type { LaunchDraft } from "../../src/schema.ts";
import { type AgentDef, Catalog, parseStrict } from "../../src/schema.ts";
import type { LaunchResolver } from "../../src/tools.ts";
import {
	registerCommand,
	registerSubagentsCommand,
	registerTools,
} from "../../src/tools.ts";

test("/subagents shows session mode and saves a new choice", async () => {
	let handler:
		| ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
		| undefined;
	const pi = {
		registerCommand: (name: string, command: { handler: typeof handler }) => {
			if (name === "subagents") handler = command.handler;
		},
	} as unknown as ExtensionAPI;
	let mode = "auto";
	const runtime = {
		displayMode: () => mode,
		setDisplayMode: (choice: string) => {
			mode = choice;
		},
		list: () => ({ live: [], launching: [], reserved: [], branch: new Map() }),
	} as unknown as Runtime;
	registerSubagentsCommand(pi, runtime);
	assert.ok(handler);
	const titles: string[] = [];
	const answers = ["Mode: auto", "widget", "Close"];
	const ctx = {
		ui: {
			select: async (title: string) => {
				titles.push(title);
				return answers.shift();
			},
			notify: () => {},
		},
	} as unknown as ExtensionCommandContext;
	await handler("", ctx);
	assert.equal(mode, "widget");
	assert.match(titles[0] ?? "", /Subagents/);
});

type CapturedTool = Pick<
	ToolDefinition,
	"name" | "parameters" | "executionMode" | "promptGuidelines"
> & {
	execute: (
		id: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		update?: unknown,
		ctx?: ExtensionContext,
	) => Promise<{
		content: { type: "text"; text: string }[];
		details?: unknown;
	}>;
};

function firstText(
	result: Awaited<ReturnType<CapturedTool["execute"]>>,
): string {
	const content = result.content[0];
	assert.ok(content);
	return content.text;
}

test("registered tools validate closed parameters and route calls", async () => {
	const tools = new Map<string, CapturedTool>();
	const pi = {
		registerTool: (tool: ToolDefinition) =>
			tools.set(tool.name, tool as unknown as CapturedTool),
	} as unknown as ExtensionAPI;
	const calls: unknown[] = [];
	const runtime = {
		list: () => ({
			live: [],
			launching: [],
			reserved: ["scout-1"],
			branch: new Map(),
		}),
		spawn: async (draft: LaunchDraft, task: string, id: string) => {
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
				backend: { kind: "pane", pane: { paneId: "%2" } },
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
	} as unknown as CatalogInput;
	const resolve: LaunchResolver = (options: ResolveLaunchOptions) =>
		({
			name: options.name,
			agent: options.agent,
			profile: options.profile,
			autoExit: true,
		}) as LaunchDraft;
	registerTools(pi, runtime as unknown as Runtime, () => catalog, resolve);
	const start = tools.get("subagent");
	assert.ok(start);
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
	const ctx = { cwd: "/work" } as ExtensionContext;
	const result = await start.execute(
		"id",
		{ agent: "scout", task: "Read", profile: "quick" },
		undefined,
		undefined,
		ctx,
	);
	assert.match(
		firstText(result),
		/Started subagent "scout-2" \(agent scout, profile quick\) in pane %2/,
	);
	assert.deepEqual(result.details, {
		runId: "run",
		name: "scout-2",
		agent: "scout",
		profile: "quick",
		paneId: "%2",
		childSessionFile: "/child",
	});
	assert.equal((calls[0] as readonly unknown[])[2], "id");
	const message = tools.get("subagent_message");
	assert.ok(message);
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
	assert.ok(list);
	assert.equal(Value.Check(list.parameters, {}), true);
	assert.equal(Value.Check(list.parameters, { legacy: true }), false);
	const listed = firstText(await list.execute("id", {}));
	assert.match(listed, /Agents:/);
	assert.match(listed, /scout-1: manual recovery needed/);
});

test("command selects a profile, launches and sends a non-triggering started message", async () => {
	let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	const sent: unknown[] = [];
	const tasks: string[] = [];
	const pi = {
		registerCommand: (
			_name: string,
			value: Parameters<ExtensionAPI["registerCommand"]>[1],
		) => {
			command = value;
		},
		sendMessage: (...args: unknown[]) => sent.push(args),
	} as unknown as ExtensionAPI;
	const runtime = {
		list: () => ({ live: [], launching: [], reserved: [], branch: new Map() }),
		spawn: async (launch: LaunchDraft, task: string) => {
			tasks.push(task);
			return {
				spec: { runId: "run", launch },
				pane: { paneId: "%2" },
			};
		},
	};
	const catalog = {
		catalog: {
			agents: { scout: { modelInvocable: true } },
			profiles: { quick: {} },
		},
	} as unknown as CatalogInput;
	registerCommand(pi, runtime as unknown as Runtime, () => catalog, ((
		o: ResolveLaunchOptions,
	) => ({
		name: o.name,
		agent: o.agent,
		profile: o.profile,
	})) as LaunchResolver);
	const ctx = {
		cwd: "/work",
		ui: {
			select: async () => "quick",
			editor: async () => "Read files",
			notify: () => {},
		},
	} as unknown as ExtensionCommandContext;
	assert.ok(command);
	assert.ok(command.getArgumentCompletions);
	assert.deepEqual(command.getArgumentCompletions("sc"), [
		{ value: "scout", label: "scout" },
	]);
	await command.handler("scout", ctx);
	await command.handler("scout Explain this:\nif ready:\n    run()", ctx);
	assert.deepEqual(tasks, [
		"Read files",
		"Explain this:\nif ready:\n    run()",
	]);
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

test("model guidance hides manual agents while command completion shows them", async () => {
	const agent = (
		name: "scout" | "manual",
		modelInvocable: boolean,
	): AgentDef => ({
		name,
		file: `/${name}.md`,
		description: modelInvocable ? "Read files" : "Human pane",
		scope: "package",
		tools: ["read"],
		skills: "none",
		spawns: [],
		session: "standalone",
		autoExit: modelInvocable,
		modelInvocable,
		systemPrompt: { mode: "append", text: "Do the task." },
	});
	const catalog = parseStrict(
		Catalog,
		{
			agents: { scout: agent("scout", true), manual: agent("manual", false) },
			profiles: {
				quick: {
					model: { provider: "p", id: "m" },
					thinking: "low",
					guidance: "Fast.",
					extensions: [],
				},
			},
			toolSources: { read: { kind: "builtin" } },
			skills: {},
		},
		"test catalog",
	);
	const tools = new Map<string, CapturedTool>();
	let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	const pi = {
		registerTool: (tool: ToolDefinition) =>
			tools.set(tool.name, tool as unknown as CapturedTool),
		registerCommand: (
			_name: string,
			value: Parameters<ExtensionAPI["registerCommand"]>[1],
		) => {
			command = value;
		},
		sendMessage: () => {},
	} as unknown as ExtensionAPI;
	const calls: { agent: string; modelInvocation: boolean }[] = [];
	const resolve: LaunchResolver = (options: ResolveLaunchOptions) => {
		calls.push({
			agent: options.agent,
			modelInvocation: options.modelInvocation,
		});
		return {
			name: options.name,
			agent: options.agent,
			profile: options.profile,
		} as LaunchDraft;
	};
	const runtime = {
		runs: new Map(),
		list: () => ({ live: [], launching: [], reserved: [], branch: new Map() }),
		spawn: async (launch: LaunchDraft) => ({
			spec: {
				runId: "run",
				launch: { ...launch, autoExit: false, childSessionFile: "/child" },
			},
			pane: { paneId: "%2" },
		}),
	};
	registerTools(pi, runtime as unknown as Runtime, () => catalog, resolve);
	registerCommand(pi, runtime as unknown as Runtime, () => catalog, resolve);
	const start = tools.get("subagent");
	assert.ok(start);
	assert.ok(start.promptGuidelines);
	const guidance = start.promptGuidelines.join("\n");
	assert.match(guidance, /scout \(package\)/);
	assert.doesNotMatch(guidance, /manual \(package\)/);
	const list = tools.get("subagents_list");
	assert.ok(list);
	assert.doesNotMatch(
		firstText(await list.execute("id", {})),
		/manual \(package\)/,
	);
	assert.ok(command);
	assert.ok(command.getArgumentCompletions);
	assert.deepEqual(command.getArgumentCompletions("man"), [
		{ value: "manual", label: "manual" },
	]);
	await command.handler("manual Build", {
		cwd: "/work",
		ui: { select: async () => "quick", notify: () => {} },
	} as unknown as ExtensionCommandContext);
	assert.deepEqual(calls, [{ agent: "manual", modelInvocation: false }]);
});

test("bundled agents are discovered with their tool lists and spawn rights", () => {
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
