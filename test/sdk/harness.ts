import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSessionFromServices,
	createAgentSessionServices,
	type ExtensionFactory,
	type ExtensionUIContext,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

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
			extensionFactories: [{ name: "pinned-contract", factory }],
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
	return { session, faux, services, assertNoErrors };
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
		t.after(() => {
			tmux("kill-server");
		});
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
