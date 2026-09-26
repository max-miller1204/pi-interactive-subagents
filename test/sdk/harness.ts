import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
	type AgentBeforeSettleEvent,
	type AgentSession,
	type CreateAgentSessionRuntimeFactory,
	CURRENT_SESSION_VERSION,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionError,
	type ExtensionFactory,
	type ExtensionUIContext,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

import { createSubagentsExtension, type RuntimeDeps } from "../../src/index.ts";
import { processIdentity } from "../../src/process.ts";
import { type RunSpec, writeJsonAtomic } from "../../src/schema.ts";
import type { PaneState, Tmux } from "../../src/tmux.ts";

export async function until(
	condition: () => boolean,
	message: string,
): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (!condition()) {
		if (Date.now() > deadline) assert.fail(message);
		await delay(5);
	}
}
export class FakeTmux implements Tmux {
	server = { socket: "/fake", process: { pid: 90, start: "server start" } };
	async serverIdentity() {
		return structuredClone(this.server);
	}
	panes = new Map<string, PaneState>();
	killedLiveChildren: string[] = [];
	commands: string[][] = [];
	async listPanes() {
		return new Map(this.panes);
	}
	async capture() {
		return "fixture pane output";
	}
	async run(args: string[]) {
		this.commands.push(args);
		if (args[0] === "kill-pane") {
			const pane = args[2];
			assert.ok(pane);
			if (this.panes.get(pane)?.dead === false)
				this.killedLiveChildren.push(pane);
			this.panes.delete(pane);
			return "";
		}
		if (args[0] === "select-layout") return "";
		throw new Error(`Unexpected tmux command: ${args.join(" ")}`);
	}
	markChildDead() {
		for (const pane of this.panes.values()) {
			pane.dead = true;
			pane.status = 0;
		}
	}
}
export async function createRuntimeHarness(
	t: TestContext,
	options: {
		mode?: ExtensionContext["mode"];
		disabled?: "tmux" | "session";
		tmux?: FakeTmux;
		child?: boolean;
		autoExit?: boolean;
		fault?:
			| "directory"
			| "spec"
			| "session"
			| "tool"
			| "model"
			| "thinking"
			| "prompt";
		identity?: NonNullable<RuntimeDeps["identity"]>;
		prepare?: (fixture: {
			root: string;
			spec: RunSpec;
			runDir: string;
			manager: SessionManager;
			tmux: FakeTmux;
		}) => void;
		extension?: ExtensionFactory;
	} = {},
) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-runtime-")));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);

	const tmux = options.tmux ?? new FakeTmux();
	// The SDK child and its parent need distinct owners, as real processes do.
	const owner = processIdentity(options.child ? process.ppid : process.pid);
	assert.ok(owner);
	const ownerKey = `${owner.pid}-${createHash("sha256").update(owner.start).digest("hex")}`;
	const runsRoot = join(root, "runs");
	const runId = randomUUID();
	const runDir = join(runsRoot, "owners", ownerKey, runId);
	const faux = fauxProvider();
	writeJsonAtomic(join(agentDir, "subagent-profiles.json"), {
		profiles: {
			quick: {
				model: `${faux.getModel().provider}/${faux.getModel().id}`,
				thinking: "off",
				guidance: "Test profile",
				extensions: [resolve(import.meta.dirname, "../../src/index.ts")],
			},
		},
	});
	const childFile = join(root, "child.jsonl");
	const header = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: randomUUID(),
		timestamp: new Date().toISOString(),
		cwd,
	};
	writeFileSync(childFile, `${JSON.stringify(header)}\n`);
	const manager =
		options.disabled === "session"
			? SessionManager.inMemory(cwd)
			: options.child
				? SessionManager.open(childFile)
				: SessionManager.create(cwd, join(root, "sessions"));
	const spec: RunSpec = {
		v: 1,
		runId,
		ownerKey,
		owner,
		startedAt: Date.now(),
		kind: "spawn",
		spawnerSessionId: manager.getSessionId(),
		spawnerSessionFile: manager.getSessionFile() ?? childFile,
		initialPrompt: "Do the task",
		launch: {
			name: "worker-1",
			agent: "worker",
			profile: "quick",
			cwd,
			session: "standalone",
			autoExit: options.autoExit ?? false,
			model: { provider: faux.getModel().provider, id: faux.getModel().id },
			thinking: "off",
			systemPrompt: { mode: "append", text: `Subagent run ${runId}.` },
			tools: ["ask_question"],
			extensions: [],
			skills: [],
			depth: 1,
			nested: null,
			childSessionFile: childFile,
		},
	};
	if (options.child) {
		for (const dir of ["inbox", "outbox", "questions"])
			mkdirSync(join(runDir, dir), { recursive: true });
		if (options.fault === "tool") spec.launch.tools.push("missing_tool");
		if (options.fault === "model") spec.launch.model.id = "another-model";
		if (options.fault === "thinking") spec.launch.thinking = "high";
		if (options.fault === "session")
			spec.launch.childSessionFile = join(root, "other.jsonl");
		writeJsonAtomic(
			join(runDir, "spec.json"),
			options.fault === "spec" ? {} : spec,
		);
	}
	options.prepare?.({ root, spec, runDir, manager, tmux });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(agentDir, "models-cache.json"),
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const deps: RuntimeDeps = {
		tmux,
		ownExtensionPath: resolve(import.meta.dirname, "../../src/index.ts"),
		agentDir,
		runsRoot,
		env:
			options.disabled === "tmux" ? {} : { TMUX: "fake,1,0", TMUX_PANE: "%1" },
		identity: options.identity ?? processIdentity,
		alive: (identity) => identity.pid === process.pid,
		trusted: () => false,
		stderr: (line) => stderr.push(line),
	};
	const stderr: string[] = [];
	const notices: { message: string; type: string | undefined }[] = [];
	const widgets: unknown[] = [];
	const renderers = new Set<string>();
	const events: string[] = [];
	const errors: ExtensionError[] = [];
	let widgetFailure: Error | undefined;
	let shutdowns = 0;
	let renderRequests = 0;
	let api: ExtensionAPI | undefined;
	let context: ExtensionContext | undefined;
	const ui = {
		notify: (message: string, type?: string) => notices.push({ message, type }),
		setStatus: () => {},
		setWidget: (_key: string, widget: unknown) => {
			if (widgetFailure !== undefined) {
				const error = widgetFailure;
				widgetFailure = undefined;
				throw error;
			}
			widgets.push(widget);
			if (typeof widget === "function")
				widget(
					{
						requestRender: () => {
							renderRequests++;
						},
					},
					{ fg: (_color: string, text: string) => text },
				);
		},
	} as unknown as ExtensionUIContext;
	const create: CreateAgentSessionRuntimeFactory = async ({
		sessionManager,
		sessionStartEvent,
	}) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime,
			extensionFlagValues: new Map(
				options.child
					? [
							[
								"subagent-run",
								options.fault === "directory" ? join(root, "missing") : runDir,
							],
						]
					: [],
			),
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: false },
				retry: { enabled: false },
			}),
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				appendSystemPrompt:
					options.child && options.fault !== "prompt"
						? [`Subagent run ${runId}.`]
						: [],
				extensionFactories: [
					{
						name: "subagents",
						factory: (pi) => {
							api = pi;
							const register = pi.registerMessageRenderer.bind(pi);
							pi.registerMessageRenderer = (name, renderer) => {
								renderers.add(name);
								register(name, renderer);
							};
							options.extension?.(pi);
							createSubagentsExtension(pi, deps);
							pi.on("session_start", (_event, ctx) => {
								context = ctx;
								events.push("session_start");
							});
							pi.on("agent_start", () => {
								events.push("agent_start");
							});
							pi.on("agent_settled", () => {
								events.push("agent_settled");
							});
							pi.on("session_shutdown", (event) => {
								events.push(`shutdown:${event.reason}`);
							});
						},
					},
				],
			},
		});
		assert.deepEqual(services.diagnostics, []);
		const result = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: faux.getModel(),
			thinkingLevel: "off",
			tools: options.child
				? ["ask_question"]
				: ["subagent", "subagent_message", "subagents_list"],
			...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
		});
		assert.deepEqual(result.extensionsResult.errors, []);
		return { ...result, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(create, {
		cwd,
		agentDir,
		sessionManager: manager,
	});
	const bind = async (session: AgentSession) => {
		await session.bindExtensions({
			mode: options.mode ?? "tui",
			uiContext: ui,
			shutdownHandler: () => {
				shutdowns++;
			},
			onError: (error) => errors.push(error),
		});
	};
	runtime.setRebindSession(bind);
	await bind(runtime.session);
	t.after(async () => {
		await runtime.dispose();
		assert.deepEqual(errors, []);
		rmSync(root, { recursive: true, force: true });
	});
	assert.deepEqual(errors, []);
	return {
		root,
		runDir,
		spec,
		tmux,
		faux,
		runtime,
		notices,
		widgets,
		renderers,
		events,
		stderr,
		takeErrors: (): ExtensionError[] => errors.splice(0),
		failNextWidget: (error: Error) => {
			widgetFailure = error;
		},
		get session() {
			return runtime.session;
		},
		get pi() {
			assert.ok(api);
			return api;
		},
		get ctx() {
			assert.ok(context);
			return context;
		},
		get shutdowns() {
			return shutdowns;
		},
		get renderRequests() {
			return renderRequests;
		},
		assertNoErrors: () => assert.deepEqual(errors, []),
		messages: (customType: string) =>
			runtime.session.sessionManager
				.getEntries()
				.filter(
					(entry) =>
						entry.type === "custom_message" && entry.customType === customType,
				),
	};
}

export function readSessionFile(session: AgentSession): unknown[] {
	const file = session.sessionManager.getSessionFile();
	assert.ok(file, "The session must have a file path.");
	const text = readFileSync(file, "utf8");
	assert.ok(text.endsWith("\n"), "The session must end with a newline.");
	return text
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line));
}

export async function createHarness(
	t: TestContext,
	factory: ExtensionFactory,
	options: {
		tools?: string[];
		extensionSource?: string;
		appendSystemPrompt?: string[];
		controlBoundaries?: boolean;
	} = {},
) {
	const root = mkdtempSync(join(tmpdir(), "pi-pinned-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const faux = fauxProvider();
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(agentDir, "models-cache.json"),
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const extensionPaths: string[] = [];
	if (options.extensionSource !== undefined) {
		const extensionPath = join(root, "loaded-extension.ts");
		writeFileSync(extensionPath, options.extensionSource);
		extensionPaths.push(extensionPath);
	}
	let releaseBoundary: (() => void) | undefined;
	let reportBoundary:
		| ((event: TurnEndEvent | AgentBeforeSettleEvent) => void)
		| undefined;
	const boundaryReached = new Promise<TurnEndEvent | AgentBeforeSettleEvent>(
		(resolve) => {
			reportBoundary = resolve;
		},
	);
	const controlledFactory: ExtensionFactory = (pi) => {
		if (options.controlBoundaries) {
			let firstBoundaryHeld = false;
			const hold = async (event: TurnEndEvent | AgentBeforeSettleEvent) => {
				if (firstBoundaryHeld) return;
				firstBoundaryHeld = true;
				const released = new Promise<void>((resolve) => {
					releaseBoundary = resolve;
				});
				assert.ok(reportBoundary, "The boundary observer must be ready.");
				reportBoundary(event);
				await released;
			};
			pi.on("turn_end", hold);
			pi.on("agent_before_settle", hold);
		}
		return factory(pi);
	};
	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		modelRuntime,
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		}),
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [
				{ name: "pinned-contract", factory: controlledFactory },
			],
			additionalExtensionPaths: extensionPaths,
			...(options.appendSystemPrompt
				? { appendSystemPrompt: options.appendSystemPrompt }
				: {}),
		},
	});
	assert.deepEqual(services.diagnostics, []);
	const { session, extensionsResult } = await createAgentSessionFromServices({
		services,
		sessionManager: SessionManager.create(cwd, join(root, "sessions")),
		model: faux.getModel(),
		tools: options.tools ?? [],
	});
	t.after(() => session.dispose());
	assert.deepEqual(extensionsResult.errors, []);
	const errors: unknown[] = [];
	const assertNoErrors = () => assert.deepEqual(errors, []);
	t.after(assertNoErrors);
	const fakeUi = new Proxy({} as ExtensionUIContext, {
		get(_target, key) {
			throw new Error(`Unexpected UI access: ${String(key)}`);
		},
	});
	await session.bindExtensions({
		mode: "tui",
		uiContext: fakeUi,
		shutdownHandler: () => {
			throw new Error("Unexpected shutdown request.");
		},
		onError: (error) => errors.push(error),
	});
	assertNoErrors();
	const sessionFile = session.sessionManager.getSessionFile();
	assert.ok(sessionFile, "The SDK harness needs a writable session path.");
	return {
		session,
		faux,
		services,
		assertNoErrors,
		sessionFile,
		boundaryReached,
		releaseBoundary: () => {
			assert.ok(releaseBoundary, "No boundary is waiting for release.");
			releaseBoundary();
			releaseBoundary = undefined;
		},
	};
}

export async function cleanupTmuxServer(
	socket: string,
	executable = "tmux",
): Promise<"already-exited" | "stopped"> {
	const run = (command: string) =>
		spawnSync(executable, ["-L", socket, "-f", "/dev/null", command], {
			encoding: "utf8",
			timeout: 5_000,
		});
	const absent = (result: ReturnType<typeof run>) =>
		!result.error &&
		result.signal === null &&
		result.status === 1 &&
		/^(?:no server running on .+|error connecting to .+ \(No such file or directory\))\n?$/.test(
			result.stderr,
		);
	const describe = (result: ReturnType<typeof run>) =>
		`status=${result.status}, signal=${result.signal}, error=${String(result.error)}, stderr=${result.stderr.trim()}`;
	const check = () => {
		const result = run("list-sessions");
		if (absent(result)) return false;
		if (result.error || result.signal !== null || result.status !== 0)
			throw new Error(
				`Cannot verify tmux server ${socket}: ${describe(result)}`,
			);
		return true;
	};
	if (!check()) return "already-exited";
	const killed = run("kill-server");
	if (killed.error || killed.signal !== null || killed.status !== 0) {
		if (absent(killed) && !check()) return "already-exited";
		throw new Error(
			`Failed to stop tmux server ${socket}: ${describe(killed)}`,
		);
	}
	const deadline = Date.now() + 2_000;
	while (check()) {
		if (Date.now() >= deadline)
			throw new Error(`tmux server ${socket} still runs after kill-server.`);
		await delay(10);
	}
	return "stopped";
}

interface CliOptions {
	interactive?: boolean;
	prompt: string;
	flags?: string[];
	appendPrompt?: { exists: boolean; content: string };
}

export async function runCli(t: TestContext, options: CliOptions) {
	const root = mkdtempSync(join(tmpdir(), "pi-sdk-cli-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			quietStartup: true,
			compaction: { enabled: false },
			retry: { enabled: false },
		}),
	);
	const eventsFile = join(root, "events.jsonl");
	const extensionFile = join(root, "observer.ts");
	writeFileSync(
		extensionFile,
		`
import { appendFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
export default function (pi) {
  const record = (event) => appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify(event) + "\\n");
  const faux = fauxProvider({ provider: "pinned-cli", models: [{ id: "fixture-model", reasoning: false }] });
  faux.setResponses([(context) => { record({ type: "request", context }); return fauxAssistantMessage("CLI fixture response."); }]);
  pi.registerProvider(faux.provider);
  pi.on("session_start", (_event, ctx) => record({ type: "session_start", mode: ctx.mode, model: ctx.model, thinking: pi.getThinkingLevel(), systemPrompt: ctx.getSystemPrompt(), registeredProviderIds: ctx.modelRegistry.getRegisteredProviderIds().toSorted() }));
  pi.on("input", (event) => { record(event); });
  pi.on("agent_start", (event) => { record(event); });
  pi.on("message_end", (event) => { record(event); });
  pi.on("agent_settled", (event, ctx) => { record(event); if (ctx.mode === "tui") ctx.shutdown(); });
  pi.on("session_shutdown", (event) => { record(event); });
}
`,
	);
	const cli = resolve(
		import.meta.dirname,
		"../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
	);
	const args = [
		cli,
		"--offline",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--no-themes",
		"--no-session",
		"--no-tools",
		"-e",
		extensionFile,
		"--model",
		"pinned-cli/fixture-model",
	];
	if (!options.interactive) args.push("--print");
	let appendPath: string | undefined;
	if (options.appendPrompt) {
		appendPath = join(root, "system-prompt.txt");
		if (options.appendPrompt.exists)
			writeFileSync(appendPath, options.appendPrompt.content);
		args.push("--append-system-prompt", appendPath);
	}
	if (options.flags) args.push(...options.flags);
	args.push(options.prompt);
	assert.ok(process.env.PATH, "PATH must be set for the CLI fixture.");
	const env = {
		HOME: root,
		PATH: process.env.PATH,
		TERM: "xterm-256color",
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
	};
	let output = "";
	if (options.interactive) {
		const socket = `pi-sdk-${process.pid}-${randomUUID()}`;
		const tmux = (...command: string[]) =>
			spawnSync("tmux", ["-L", socket, "-f", "/dev/null", ...command], {
				encoding: "utf8",
				timeout: 5_000,
			});
		t.after(() => cleanupTmuxServer(socket));
		const exitFile = join(root, "exit-code");
		const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
		const invocation = [
			"env",
			"-i",
			...Object.entries(env).map(([key, value]) => `${key}=${value}`),
			process.execPath,
			...args,
		]
			.map(quote)
			.join(" ");
		const result = tmux(
			"new-session",
			"-d",
			"-s",
			"sdk",
			"-x",
			"100",
			"-y",
			"30",
			"-c",
			root,
			`${invocation}; code=$?; printf '%s' "$code" > ${quote(exitFile)}`,
		);
		assert.equal(result.status, 0, result.stderr);
		const deadline = Date.now() + 15_000;
		while (!existsSync(exitFile)) {
			if (Date.now() >= deadline) {
				assert.fail(
					`CLI did not exit. ${tmux("capture-pane", "-p", "-t", "sdk").stdout}`,
				);
			}
			await delay(10);
		}
		assert.equal(readFileSync(exitFile, "utf8"), "0");
	} else {
		const result = spawnSync(process.execPath, args, {
			cwd: root,
			env,
			encoding: "utf8",
			timeout: 15_000,
		});
		output = result.stdout + result.stderr;
		assert.equal(result.status, 0, output);
	}
	const events = readFileSync(eventsFile, "utf8")
		.trimEnd()
		.split("\n")
		.map((line): Record<string, unknown> => JSON.parse(line));
	const errors = events.filter(
		(event) =>
			event.type === "message_end" &&
			JSON.stringify(event).includes('"stopReason":"error"'),
	);
	assert.deepEqual(errors, []);
	return { events, output, appendPath };
}
