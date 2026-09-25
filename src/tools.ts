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

export function questionContent(
	name: string,
	agent: string,
	qid: string,
	text: string,
): string {
	return `Subagent "${name}" (agent ${agent}) asks question ${qid}:\n\n${text}\n\nIt waits for your answer. Reply with subagent_message({ name: "${name}", question_id: "${qid}", message }).`;
}
export function subagentsSection(
	input: CatalogInput,
	allowlist?: readonly string[],
): string {
	return catalogSummary(input, allowlist);
}
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
): { refresh(): void } {
	let guidelines = "";
	const registerStart = () => {
		const input = getCatalog();
		const next = subagentsSection(input, modelAllow(input, child));
		if (next === guidelines) return;
		guidelines = next;
		pi.registerTool({
			name: "subagent",
			label: "Subagent",
			description:
				"Start a subagent in a new tmux pane. It returns at once. The result arrives later as a message.",
			promptSnippet:
				"subagent: start a named subagent in a tmux pane; its result arrives later as a message",
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
				const paneId = started.pane.paneId;
				return {
					content: [
						{
							type: "text" as const,
							text: `Started subagent "${name}" (agent ${args.agent}, profile ${args.profile}) in pane ${paneId}. Its result arrives as a message. Do not poll.${launch.autoExit ? "" : " A human works with it in the pane. The result arrives when the pane closes."}`,
						},
					],
					details: {
						runId,
						name,
						agent: args.agent,
						profile: args.profile,
						paneId,
						childSessionFile: launch.childSessionFile,
					},
				};
			},
			...registerToolRenderers("subagent"),
		});
	};
	registerStart();
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
				subagentsSection(input, modelAllow(input, child)),
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
	return { refresh: registerStart };
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
			const [agent, ...parts] = args.trim().split(/\s+/);
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
					parts.join(" ").trim() ||
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
