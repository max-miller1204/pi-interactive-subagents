import { realpathSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
	type ExtensionAPI,
	getAgentDir,
	ProjectTrustStore,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import { buildLiveCatalog, type CatalogInput } from "./catalog.ts";
import {
	type ChildStartup,
	installChildRole,
	preflightChild,
} from "./child.ts";
import { type RuntimeDeps as ParentDeps, Runtime } from "./parent.ts";
import { processAlive, processIdentity } from "./process.ts";
import { MAX_DEPTH } from "./schema.ts";
import { createTmux } from "./tmux.ts";
import { registerCommand, registerTools } from "./tools.ts";
import { createWidget, registerRenderers } from "./ui.ts";

export interface RuntimeDeps extends ParentDeps {
	agentDir?: string;
}
export function defaultDeps(): RuntimeDeps {
	const agentDir = getAgentDir();
	return {
		tmux: {
			serverIdentity: () => createTmux().serverIdentity(),
			run: (args) => createTmux().run(args),
			listPanes: () => createTmux().listPanes(),
			capture: (pane) => createTmux().capture(pane),
		},
		ownExtensionPath: fileURLToPath(import.meta.url),
		agentDir,
		runsRoot: join(agentDir, "subagent-runs"),
		env: process.env,
		identity: processIdentity,
		alive: processAlive,
		now: Date.now,
		delay,
		stderr: (text) => {
			process.stderr.write(text);
		},
		trusted: (cwd) =>
			new ProjectTrustStore(agentDir).get(realpathSync(cwd)) === true,
	};
}
export function checkPiVersion(version: string): void {
	const [major, minor] = version.split(".").map(Number);
	if (major !== 0 || minor !== 87)
		throw new Error(
			`pi-interactive-subagents 4 needs Pi 0.87. This Pi is ${version}. Install Pi 0.87, or update pi-interactive-subagents.`,
		);
}
interface ActiveRuntime {
	parent?: Runtime;
	startup?: ChildStartup;
	child?: ReturnType<typeof installChildRole>;
	disposed: boolean;
	startupCompletion: Promise<void>;
	shutdown(reason: Parameters<Runtime["onShutdown"]>[0]): Promise<void>;
}
export function createSubagentsExtension(
	pi: ExtensionAPI,
	deps: RuntimeDeps,
): void {
	checkPiVersion(VERSION);
	pi.registerFlag("subagent-run", {
		description: "Run directory for a subagent",
		type: "string",
	});
	registerRenderers(pi);
	let runtime: ActiveRuntime | undefined;
	pi.on("session_start", async (event, ctx) => {
		const previous = runtime;
		const completion = Promise.withResolvers<void>();
		const current: ActiveRuntime = {
			disposed: false,
			startupCompletion: completion.promise,
			async shutdown(reason) {
				current.disposed = true;
				const errors: unknown[] = [];
				try {
					await current.parent?.onShutdown(reason);
				} catch (error) {
					errors.push(error);
				}
				await current.startupCompletion;
				try {
					current.child?.dispose();
				} catch (error) {
					errors.push(error);
				}
				if (errors.length === 1) throw errors[0];
				if (errors.length > 1)
					throw new AggregateError(
						errors,
						errors
							.map((error) =>
								error instanceof Error ? error.message : String(error),
							)
							.join("\n"),
					);
			},
		};
		runtime = current;
		try {
			await previous?.shutdown("reload");
			if (runtime !== current || current.disposed) return;
			const path = pi.getFlag("subagent-run");
			if (typeof path === "string") {
				current.startup = preflightChild(ctx, path);
				if (current.startup.spec === undefined) return;
			}
			const spec = current.startup?.spec;
			let requestRender: (() => void) | undefined;
			const parent = new Runtime(pi, ctx, {
				...deps,
				...(spec === undefined ? {} : { childSpec: spec }),
				trusted: (cwd) =>
					realpathSync(cwd) === realpathSync(ctx.cwd)
						? ctx.isProjectTrusted()
						: deps.trusted(cwd),
				requestRender: () => {
					requestRender?.();
					deps.requestRender?.();
				},
			});
			current.parent = parent;
			await parent.start(event);
			if (runtime !== current || current.disposed) return;
			if (parent.deliverer === undefined) return;
			const catalog: CatalogInput =
				spec === undefined
					? buildLiveCatalog(pi, ctx, deps.ownExtensionPath, deps.agentDir)
					: (spec.launch.nested ?? {
							agents: {},
							profiles: {},
							toolSources: {},
							skills: {},
						});
			registerTools(pi, parent, () => catalog, undefined, spec);
			registerCommand(pi, parent, () => catalog, undefined, spec);
			if (
				spec !== undefined &&
				(spec.launch.nested === null || spec.launch.depth >= MAX_DEPTH)
			) {
				pi.setActiveTools(
					pi
						.getActiveTools()
						.filter(
							(name) =>
								!["subagent", "subagent_message", "subagents_list"].includes(
									name,
								),
						),
				);
				pi.registerCommand("subagent", {
					description: "Start a subagent",
					handler: async (_args, commandCtx) => {
						commandCtx.ui.notify(
							"This subagent cannot start subagents.",
							"error",
						);
					},
				});
			}
			if (current.startup !== undefined)
				current.child = installChildRole(pi, ctx, parent, current.startup);
			if ("catalog" in catalog) {
				const errors = [...catalog.errors.map((entry) => entry.error)];
				if (catalog.profileError !== null) errors.push(catalog.profileError);
				if (catalog.projectFilesIgnored)
					errors.push("Project subagent files are ignored. Run /trust first.");
				for (const error of new Set(errors)) ctx.ui.notify(error, "error");
			}
			ctx.ui.setWidget(
				"subagents",
				(tui, theme) => {
					requestRender = () => tui.requestRender();
					return createWidget(parent, tui, theme, deps.now);
				},
				{ placement: "aboveEditor" },
			);
		} finally {
			completion.resolve();
		}
	});
	pi.on("input", (event) => {
		const blocked = runtime?.startup?.onInput();
		if (blocked) return blocked;
		runtime?.parent?.onInput();
		return runtime?.child?.onInput(event);
	});
	pi.on("agent_start", () => {
		runtime?.parent?.onAgentStart();
		runtime?.child?.onAgentStart();
	});
	pi.on("turn_end", (event) => runtime?.parent?.onBoundary(event));
	pi.on("agent_before_settle", (event) => runtime?.parent?.onBoundary(event));
	pi.on("agent_settled", () => {
		runtime?.parent?.onAgentSettled(runtime.child?.wasInterrupted === true);
		runtime?.child?.onAgentSettled();
	});
	pi.on("message_end", (event) => {
		runtime?.child?.onMessageEnd(event);
	});
	pi.on("message_start", (event) => runtime?.child?.onMessageStart(event));
	pi.on("message_update", (event) => runtime?.child?.onMessageUpdate(event));
	pi.on("tool_execution_start", (event) => runtime?.child?.onToolStart(event));
	pi.on("tool_execution_end", (event) => runtime?.child?.onToolEnd(event));
	pi.on("tool_call", () => runtime?.startup?.onToolCall());
	pi.on("session_before_switch", () => runtime?.child?.onBeforeSwitch());
	pi.on("session_before_fork", () => runtime?.child?.onBeforeFork());
	pi.on("session_tree", () => {
		runtime?.child?.onTree();
	});
	pi.on("session_shutdown", async (event) => {
		const previous = runtime;
		runtime = undefined;
		await previous?.shutdown(event.reason);
	});
}
export default function subagentsExtension(pi: ExtensionAPI): void {
	createSubagentsExtension(pi, defaultDeps());
}
