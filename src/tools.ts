import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type CatalogInput,
	catalogSummary,
	type ResolveLaunchOptions,
	resolveLaunch,
} from "./catalog.ts";
import {
	type ConversationViewer,
	createConversationViewer,
} from "./conversation-viewer.ts";
import { defaultName, type Runtime } from "./parent.ts";
import type { Catalog } from "./schema.ts";
import { registerToolRenderers } from "./ui.ts";

const Obj = <T extends Record<string, import("typebox").TSchema>>(
	properties: T,
) => Type.Object(properties, { additionalProperties: false });
export const subagentParameters = Obj({
	agent: Type.String({
		minLength: 1,
		description: "Agent name. See the guidelines or subagents_list.",
	}),
	task: Type.String({
		minLength: 1,
		description:
			"The complete task. A standalone subagent sees only this text.",
	}),
	profile: Type.String({
		minLength: 1,
		description: "Profile name. It sets the model and the thinking level.",
	}),
	name: Type.Optional(
		Type.String({
			pattern: "^[a-z0-9][a-z0-9-]{0,39}$",
			description: "Unique name. Default: <agent>-<n>.",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			minLength: 1,
			description: "Working directory. Default: the current directory.",
		}),
	),
});
export const messageParameters = Obj({
	name: Type.String({ minLength: 1 }),
	message: Type.String({ minLength: 1 }),
	question_id: Type.Optional(Type.String({ pattern: "^q-[0-9a-f]{8}$" })),
});
export const listParameters = Obj({});

const rules = [
	"Give each subagent a complete task. A standalone subagent sees only the task text.",
	"Pick a profile for every subagent.",
	"Results and questions from subagents arrive as messages. Do not poll, sleep, or call subagents_list to wait for them.",
	"When you have nothing else to do, end your turn. A result starts a new turn.",
	"Answer a question with subagent_message and pass its question_id. A message to a finished subagent resumes it.",
];
export type CatalogProvider = () => CatalogInput;
export type LaunchResolver = (
	options: ResolveLaunchOptions,
) => ReturnType<typeof resolveLaunch>;
function catalogOf(input: CatalogInput): Catalog {
	return "catalog" in input ? input.catalog : input;
}
function allow(
	input: CatalogInput,
	child?: { launch: { depth: number; nested: Catalog | null } },
): string[] {
	return child
		? Object.keys(child.launch.nested?.agents ?? {})
		: Object.keys(catalogOf(input).agents);
}
function modelAllow(
	input: CatalogInput,
	child?: { launch: { depth: number; nested: Catalog | null } },
): string[] {
	const catalog = catalogOf(input);
	return allow(input, child).filter(
		(name) => catalog.agents[name]?.modelInvocable,
	);
}
function usedNames(runtime: Runtime): Set<string> {
	const list = runtime.list();
	return new Set([
		...list.live.map((run) => run.name),
		...list.launching,
		...list.reserved,
		...list.branch.keys(),
	]);
}
function options(
	input: CatalogInput,
	ctx: ExtensionContext,
	agent: string,
	profile: string,
	name: string,
	cwd: string,
	modelInvocation: boolean,
	child?: { launch: { depth: number; nested: Catalog | null } },
): ResolveLaunchOptions {
	return {
		catalog: input,
		name,
		agent,
		profile,
		spawnerDepth: child?.launch.depth ?? 0,
		spawnerAllowlist: allow(input, child),
		parentCwd: ctx.cwd,
		cwd,
		modelInvocation,
	};
}
export function registerTools(
	pi: ExtensionAPI,
	runtime: Runtime,
	getCatalog: CatalogProvider,
	resolve: LaunchResolver = resolveLaunch,
	child?: { launch: { depth: number; nested: Catalog | null } },
): void {
	const input = getCatalog();
	const next = catalogSummary(input, modelAllow(input, child));
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Start an interactive subagent. It returns at once. The result arrives later as a message.",
		promptSnippet:
			"subagent: start a named interactive subagent; its result arrives later as a message",
		promptGuidelines: [...rules, ...next.split("\n")],
		parameters: subagentParameters,
		executionMode: "sequential",
		async execute(toolCallId, args, _signal, _update, ctx) {
			const catalog = getCatalog();
			const name = args.name ?? defaultName(args.agent, usedNames(runtime));
			const draft = resolve(
				options(
					catalog,
					ctx,
					args.agent,
					args.profile,
					name,
					args.cwd ?? ctx.cwd,
					true,
					child,
				),
			);
			const started = await runtime.spawn(draft, args.task, toolCallId);
			const { runId, launch } = started.spec;
			const place =
				started.backend.kind === "pane"
					? `pane ${started.backend.pane.paneId}`
					: "the subagent viewer";
			return {
				content: [
					{
						type: "text" as const,
						text: `Started subagent "${name}" (agent ${args.agent}, profile ${args.profile}) in ${place}. Its result arrives as a message. Do not poll.${launch.autoExit ? "" : started.backend.kind === "pane" ? " A human works with it in the pane. The result arrives when the pane closes." : " A human can work with it in the viewer. The result arrives when the run closes."}`,
					},
				],
				details: {
					runId,
					name,
					agent: args.agent,
					profile: args.profile,
					...(started.backend.kind === "pane"
						? { paneId: started.backend.pane.paneId }
						: {}),
					childSessionFile: launch.childSessionFile,
				},
			};
		},
		...registerToolRenderers("subagent"),
	});
	pi.registerTool({
		name: "subagent_message",
		label: "Subagent message",
		description:
			"Send a message to a subagent. It steers a running subagent, answers its question, or resumes a finished subagent.",
		parameters: messageParameters,
		executionMode: "sequential",
		async execute(_id, args) {
			const text = await runtime.message(
				args.name,
				args.message,
				args.question_id,
			);
			return {
				content: [{ type: "text", text }],
				details: {
					name: args.name,
					...(args.question_id === undefined
						? {}
						: { question_id: args.question_id }),
				},
			};
		},
		...registerToolRenderers("subagent_message"),
	});
	pi.registerTool({
		name: "subagents_list",
		label: "Subagents list",
		description: "List available agents, profiles and subagents.",
		parameters: listParameters,
		async execute() {
			const listing = runtime.list();
			const input = getCatalog();
			const lines = [
				catalogSummary(input, modelAllow(input, child)),
				"Live subagents:",
			];
			for (const run of listing.live) {
				const active = runtime.runs.get(run.name);
				if (active === undefined)
					throw new Error(`Missing live subagent ${run.name}.`);
				const state = run.broken
					? "broken"
					: run.phase === "finished"
						? "done"
						: (run.view?.state ?? "starting");
				lines.push(
					`${run.name} (${run.launch.agent}): ${state}; elapsed: ${Math.max(0, Math.floor((Date.now() - active.spec.startedAt) / 1000))}s; open questions: ${run.openQuestions.join(", ") || "none"}`,
				);
			}
			for (const name of listing.launching) lines.push(`${name}: starting`);
			for (const name of listing.reserved)
				lines.push(`${name}: manual recovery needed`);
			lines.push("Finished subagents on this branch:");
			for (const [name, record] of listing.branch)
				if (!listing.live.some((run) => run.name === name))
					lines.push(`${name} (${record.launch.agent})`);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: undefined,
			};
		},
	});
}
export function registerCommand(
	pi: ExtensionAPI,
	runtime: Runtime,
	getCatalog: CatalogProvider,
	resolve: LaunchResolver = resolveLaunch,
	child?: { launch: { depth: number; nested: Catalog | null } },
): void {
	pi.registerCommand("subagent", {
		description: "Start a subagent. Usage: /subagent <agent> [task]",
		getArgumentCompletions(prefix) {
			const input = getCatalog();
			const names = allow(input, child).filter((name) =>
				name.startsWith(prefix),
			);
			return names.map((name) => ({ value: name, label: name }));
		},
		async handler(args, ctx) {
			const [agent] = args.trim().split(/\s+/, 1);
			if (!agent) {
				ctx.ui.notify("Usage: /subagent <agent> [task]", "error");
				return;
			}
			const input = getCatalog();
			const profiles = Object.keys(catalogOf(input).profiles);
			try {
				const profile = await ctx.ui.select(`Profile for ${agent}`, profiles);
				if (profile === undefined) return;
				const task =
					args.trim().slice(agent.length).trim() ||
					(await ctx.ui.editor(`Task for ${agent}`))?.trim();
				if (!task) return;
				const name = defaultName(agent, usedNames(runtime));
				const draft = resolve(
					options(input, ctx, agent, profile, name, ctx.cwd, false, child),
				);
				const started = await runtime.spawn(draft, task);
				pi.sendMessage(
					{
						customType: "subagent_started",
						content: `The user started subagent "${name}" (agent ${agent}) with /subagent. Its result arrives as a message.`,
						display: true,
						details: { name, agent, profile, runId: started.spec.runId },
					},
					{ triggerTurn: false },
				);
			} catch (error) {
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"error",
				);
			}
		},
	});
}

export function registerSubagentsCommand(
	pi: ExtensionAPI,
	runtime: Runtime,
): { close(): void } {
	let viewer: ConversationViewer | undefined;
	pi.registerCommand("subagents", {
		description: "View subagents and choose the session display mode.",
		async handler(_args, ctx) {
			for (;;) {
				const listing = runtime.list();
				const rows = [
					`Mode: ${runtime.displayMode()}`,
					...listing.live.map((run) => `Run: ${run.name} (${run.phase})`),
					...[...listing.branch]
						.filter(([name]) => !listing.live.some((run) => run.name === name))
						.map(([name]) => `Run: ${name} (finished)`),
					"Close",
				];
				const selection = await ctx.ui.select("Subagents", rows);
				if (selection === undefined || selection === "Close") return;
				if (selection.startsWith("Mode: ")) {
					const mode = await ctx.ui.select("Display mode for new subagents", [
						"auto",
						"panes",
						"widget",
					]);
					if (mode === undefined) continue;
					try {
						runtime.setDisplayMode(mode as "auto" | "panes" | "widget");
					} catch (error) {
						ctx.ui.notify(
							error instanceof Error ? error.message : String(error),
							"error",
						);
					}
					continue;
				}
				const match = /^Run: ([a-z0-9][a-z0-9-]*) \(/.exec(selection);
				if (match === null)
					throw new Error(`Invalid subagent selection: ${selection}.`);
				const name = match[1] as string;
				await ctx.ui.custom<void>(
					(tui, theme, _keybindings, done) => {
						viewer = createConversationViewer(runtime, name, tui, theme, () =>
							done(),
						);
						return viewer;
					},
					{
						overlay: true,
						overlayOptions: { width: "90%", maxHeight: "90%", margin: 1 },
					},
				);
				viewer = undefined;
			}
		},
	});
	return {
		close() {
			viewer?.close();
			viewer = undefined;
		},
	};
}
