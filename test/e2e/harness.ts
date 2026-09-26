import { execFile } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	IncompleteSessionError,
	readBranch as productionReadBranch,
} from "../../src/session-file.ts";

const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, "../..");
const cli = realpathSync(
	join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
);
const extension = realpathSync(join(repo, "src/index.ts"));
const fixture = realpathSync(join(repo, "test/fixtures/faux-brain.ts"));

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
export function readBranch(file: string): SessionEntry[] {
	return productionReadBranch(file);
}
export function customMessage(entry: SessionEntry): {
	customType: string;
	content: string;
	details: Record<string, unknown>;
} {
	if (
		entry.type !== "custom_message" ||
		typeof entry.customType !== "string" ||
		typeof entry.content !== "string" ||
		entry.details === null ||
		typeof entry.details !== "object" ||
		Array.isArray(entry.details)
	)
		throw new Error("Expected a typed custom_message with object details.");
	return {
		customType: entry.customType,
		content: entry.content,
		details: entry.details as Record<string, unknown>,
	};
}
export async function waitFor<T>(
	test: () => T | Promise<T>,
	description: string,
	deadlineMs = 20_000,
): Promise<NonNullable<T>> {
	const until = Date.now() + deadlineMs;
	let incomplete: IncompleteSessionError | undefined;
	while (Date.now() < until) {
		try {
			const result = await test();
			incomplete = undefined;
			if (result) return result;
		} catch (error) {
			// Live session files can be observed before the writer adds the newline.
			if (!(error instanceof IncompleteSessionError)) throw error;
			incomplete = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(
		`Timed out waiting for ${description} after ${deadlineMs} ms.`,
		{ cause: incomplete },
	);
}
export async function terminateWindow(
	tmux: (args: string[]) => Promise<string>,
	pane: string,
	diagnostic: (text: string) => void,
): Promise<void> {
	const errors: Error[] = [];
	try {
		diagnostic(
			`Pane tail:\n${(await tmux(["capture-pane", "-p", "-J", "-S", "-40", "-t", pane])).slice(-2000)}`,
		);
	} catch (error) {
		errors.push(
			new Error(`Cannot capture parent pane: ${String(error)}`, {
				cause: error,
			}),
		);
	}
	try {
		await tmux(["kill-window", "-t", pane]);
	} catch (error) {
		errors.push(
			new Error(`Cannot kill parent window ${pane}: ${String(error)}`, {
				cause: error,
			}),
		);
	}
	if (errors.length)
		throw new AggregateError(
			errors,
			errors.map((error) => error.message).join("; "),
		);
}

export function trackedResource<Identity>(
	context: {
		after(cleanup: () => Promise<void>): void;
		diagnostic(text: string): void;
	},
	label: string,
	dispose: (identity: Identity) => Promise<void>,
	retain: (reason: string) => void,
) {
	let state:
		| { kind: "idle" | "acquiring" | "retained" }
		| { kind: "identified"; identity: Identity } = { kind: "idle" };
	const release = async () => {
		if (state.kind === "idle" || state.kind === "retained") return;
		try {
			if (state.kind !== "identified")
				throw new Error("Resource identity is not proved.");
			await dispose(state.identity);
			state = { kind: "idle" };
		} catch (error) {
			state = { kind: "retained" };
			const message = `Retain ${label}: ${String(error)}`;
			const failure = new Error(message, { cause: error });
			const errors: unknown[] = [failure];
			for (const report of [
				() => retain(message),
				() => context.diagnostic(message),
			]) {
				try {
					report();
				} catch (reportError) {
					errors.push(reportError);
				}
			}
			if (errors.length > 1) throw new AggregateError(errors, message);
			throw failure;
		}
	};
	context.after(release);
	return {
		acquiring() {
			if (state.kind !== "idle")
				throw new Error(`Cannot acquire ${label} while ${state.kind}.`);
			state = { kind: "acquiring" };
		},
		identified(identity: Identity) {
			if (state.kind !== "acquiring" && state.kind !== "identified")
				throw new Error(`Cannot identify ${label} while ${state.kind}.`);
			state = { kind: "identified", identity };
		},
		release,
	};
}

export interface ScenarioOptions {
	prompt: string;
	tmuxEnvironment?: string;
	commandPath?: string;
	agents?: Record<string, string>;
	extensionPaths?: string[];
	approval?: "approve" | "no-approve" | "ask";
}
export interface Scenario {
	root: string;
	cwd: string;
	agentDir: string;
	parentPane: string;
	parentFile: string;
	stderrFile: string;
	socket: string;
	tmux(args: string[]): Promise<string>;
	readParent(): SessionEntry[];
	capture(pane?: string): Promise<string>;
	sendKeys(pane: string, text: string): Promise<void>;
	reopen(file: string): Promise<void>;
	waitFor<T>(
		test: () => T | Promise<T>,
		description: string,
		deadlineMs?: number,
	): Promise<NonNullable<T>>;
	childRuns(): string[];
	retainFiles(reason: string): void;
}

export async function scenario(
	t: TestContext,
	options: ScenarioOptions,
): Promise<Scenario> {
	const tmuxValue =
		options.tmuxEnvironment === undefined
			? process.env.TMUX
			: options.tmuxEnvironment;
	if (!tmuxValue)
		throw new Error("E2E tests require the isolated tmux runner.");
	const socket = tmuxValue.split(",")[0];
	if (!socket?.includes("pi-subagents-test-") || !existsSync(socket))
		throw new Error(`Not the private test socket: ${socket}`);
	const tmux = async (args: string[]): Promise<string> =>
		(
			await exec("tmux", ["-S", socket, ...args], {
				encoding: "utf8",
				timeout: 5_000,
			})
		).stdout.trimEnd();
	const pid = (await tmux(["display-message", "-p", "#{pid}"])).trim();
	if (pid !== tmuxValue.split(",")[1] || !/^\d+$/.test(pid))
		throw new Error("Private tmux server identity does not match TMUX.");
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-subagents-e2e-")));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const parentFile = join(root, "parent.jsonl");
	const stderrFile = join(root, "parent.stderr");
	mkdirSync(cwd);
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	writeFileSync(
		join(agentDir, "subagent-profiles.json"),
		JSON.stringify({
			profiles: {
				test: {
					model: "faux/brain",
					thinking: "off",
					guidance: "Test profile.",
					extensions: [fixture],
				},
			},
		}),
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			quietStartup: true,
			compaction: { enabled: false },
			retry: { enabled: false },
		}),
	);
	for (const [name, markdown] of Object.entries(options.agents ?? {})) {
		if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name))
			throw new Error(`Invalid test agent name ${name}`);
		writeFileSync(join(agentDir, "agents", `${name}.md`), markdown);
	}
	const script = join(root, "parent.sh");
	const paths = [
		extension,
		fixture,
		...(options.extensionPaths ?? []).map((path) => realpathSync(path)),
	];
	const argv = [
		process.execPath,
		cli,
		"--no-extensions",
		...paths.flatMap((path) => ["-e", path]),
		"--model",
		"faux/brain",
		"--thinking",
		"off",
		"--session",
		parentFile,
		...(options.approval === "ask"
			? []
			: [`--${options.approval ?? "approve"}`]),
		options.prompt,
	];
	const env = {
		HOME: process.env.HOME,
		PATH: options.commandPath ?? process.env.PATH,
		PI_CODING_AGENT_DIR: agentDir,
		PI_SUBAGENT_TEST_ROOT: root,
	};
	for (const [name, value] of Object.entries(env))
		if (value === undefined)
			throw new Error(`Missing ${name} in E2E environment.`);
	const scriptPrefix = `#!/bin/sh\ncd ${quote(cwd)} || exit 97\nexec /usr/bin/env -i "TMUX=$TMUX" "TMUX_PANE=$TMUX_PANE" ${Object.entries(
		env,
	)
		.map(([name, value]) => quote(`${name}=${value}`))
		.join(" ")} `;
	writeFileSync(
		script,
		`${scriptPrefix}${argv.map(quote).join(" ")} 2>${quote(stderrFile)}\n`,
		{ mode: 0o700 },
	);
	const reopenScript = join(root, "reopen.sh");
	const sessionArg = argv.indexOf("--session") + 1;
	if (sessionArg < 1 || argv[sessionArg] !== parentFile)
		throw new Error("Parent session argument is missing.");
	const reopenArgv = argv.slice(0, -1);
	reopenArgv[sessionArg] = '"$1"';
	writeFileSync(
		reopenScript,
		`${scriptPrefix}${reopenArgv.map((word, index) => (index === sessionArg ? word : quote(word))).join(" ")} 2>>${quote(stderrFile)}\n`,
		{ mode: 0o700 },
	);
	let pane: string | undefined;
	const retentionReasons: string[] = [];
	t.after(async () => {
		const errors: Error[] = [];
		let windowExists = false;
		try {
			const panes = await tmux(["list-panes", "-a", "-F", "#{pane_id}"]);
			windowExists = pane !== undefined && panes.split("\n").includes(pane);
		} catch (error) {
			errors.push(
				new Error("Cannot list private panes during cleanup.", {
					cause: error,
				}),
			);
		}
		try {
			if (existsSync(stderrFile))
				t.diagnostic(`Stderr:\n${readFileSync(stderrFile, "utf8")}`);
			if (existsSync(parentFile))
				t.diagnostic(
					`Session tail:\n${readFileSync(parentFile, "utf8")
						.split("\n")
						.slice(-10)
						.map((line) => line.slice(0, 300))
						.join("\n")}`,
				);
			const runs = join(agentDir, "subagent-runs");
			if (existsSync(runs))
				t.diagnostic(`Run directories: ${readdirSync(runs).join(", ")}`);
		} catch (error) {
			errors.push(
				new Error("Cannot read private run diagnostics.", { cause: error }),
			);
		}
		if (pane && (windowExists || errors.length > 0)) {
			try {
				await terminateWindow(tmux, pane, (text) => t.diagnostic(text));
			} catch (error) {
				if (error instanceof AggregateError) errors.push(...error.errors);
				else errors.push(new Error("Window cleanup failed.", { cause: error }));
			}
		}
		if (
			retentionReasons.length > 0 ||
			errors.some((error) =>
				error.message.startsWith("Cannot kill parent window"),
			)
		)
			t.diagnostic(`Keep ${root} for recovery. ${retentionReasons.join(" ")}`);
		else {
			try {
				rmSync(root, {
					recursive: true,
					force: true,
					maxRetries: 20,
					retryDelay: 50,
				});
			} catch (error) {
				errors.push(
					new Error(`Cannot remove test directory ${root}.`, { cause: error }),
				);
			}
		}
		if (errors.length)
			throw new AggregateError(
				errors,
				`Private scenario cleanup failed: ${errors.map((error) => error.message).join("; ")}`,
			);
	});
	pane = (
		await tmux(["new-window", "-d", "-P", "-F", "#{pane_id}", "/bin/cat -"])
	).trim();
	if (!/^%\d+$/.test(pane)) throw new Error(`Invalid parent pane: ${pane}`);
	await tmux(["set-option", "-p", "-t", pane, "remain-on-exit", "on"]);
	await tmux(["respawn-pane", "-k", "-t", pane, "--", "/bin/sh", script]);
	const parentPane = pane;
	return {
		root,
		cwd,
		agentDir,
		parentPane,
		parentFile,
		stderrFile,
		socket,
		tmux,
		retainFiles: (reason) => {
			retentionReasons.push(reason);
		},
		readParent: () => readBranch(parentFile),
		capture: (target = parentPane) =>
			tmux(["capture-pane", "-p", "-J", "-S", "-80", "-t", target]),
		sendKeys: async (target, text) => {
			await tmux(["send-keys", "-t", target, "-l", text]);
			await tmux(["send-keys", "-t", target, "Enter"]);
		},
		reopen: async (file) => {
			if (!existsSync(file) || !realpathSync(file).startsWith(`${root}/`))
				throw new Error(
					`Cannot reopen a session outside this scenario: ${file}`,
				);
			const dead = await tmux([
				"display-message",
				"-p",
				"-t",
				parentPane,
				"#{pane_dead}",
			]);
			if (dead !== "1")
				throw new Error(`Cannot reopen a live parent pane ${parentPane}.`);
			await tmux([
				"respawn-pane",
				"-k",
				"-t",
				parentPane,
				"--",
				"/bin/sh",
				reopenScript,
				file,
			]);
		},
		waitFor,
		childRuns: () => {
			const owners = join(agentDir, "subagent-runs", "owners");
			return existsSync(owners)
				? readdirSync(owners).flatMap((owner) =>
						readdirSync(join(owners, owner)).map((run) =>
							join(owners, owner, run),
						),
					)
				: [];
		},
	};
}
