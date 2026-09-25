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
import { readBranch as productionReadBranch } from "../../src/session-file.ts";

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
	while (Date.now() < until) {
		const result = await test();
		if (result) return result;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(
		`Timed out waiting for ${description} after ${deadlineMs} ms.`,
	);
}
export interface ScenarioOptions {
	prompt: string;
	agents?: Record<string, string>;
	extensionPaths?: string[];
	approval?: "approve" | "no-approve";
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
	waitFor<T>(
		test: () => T | Promise<T>,
		description: string,
		deadlineMs?: number,
	): Promise<NonNullable<T>>;
	childRuns(): string[];
}

export async function scenario(
	t: TestContext,
	options: ScenarioOptions,
): Promise<Scenario> {
	const tmuxValue = process.env.TMUX;
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
		`--${options.approval ?? "approve"}`,
		options.prompt,
	];
	const env = {
		HOME: process.env.HOME,
		PATH: process.env.PATH,
		PI_CODING_AGENT_DIR: agentDir,
		PI_SUBAGENT_TEST_ROOT: root,
	};
	for (const [name, value] of Object.entries(env))
		if (value === undefined)
			throw new Error(`Missing ${name} in E2E environment.`);
	writeFileSync(
		script,
		`#!/bin/sh\ncd ${quote(cwd)} || exit 97\nexec /usr/bin/env -i "TMUX=$TMUX" "TMUX_PANE=$TMUX_PANE" ${Object.entries(
			env,
		)
			.map(([name, value]) => quote(`${name}=${value}`))
			.join(" ")} ${argv.map(quote).join(" ")} 2>${quote(stderrFile)}\n`,
		{ mode: 0o700 },
	);
	let pane: string | undefined;
	t.after(async () => {
		try {
			const panes = await tmux(["list-panes", "-a", "-F", "#{pane_id}"]);
			if (pane && panes.split("\n").includes(pane)) {
				t.diagnostic(
					`Pane tail:\n${(await tmux(["capture-pane", "-p", "-J", "-S", "-40", "-t", pane])).slice(-2000)}`,
				);
				await tmux(["kill-window", "-t", pane]);
			}
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
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	pane = (
		await tmux(["new-window", "-d", "-P", "-F", "#{pane_id}", ""])
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
		readParent: () => readBranch(parentFile),
		capture: (target = parentPane) =>
			tmux(["capture-pane", "-p", "-J", "-S", "-80", "-t", target]),
		sendKeys: async (target, text) => {
			await tmux(["send-keys", "-t", target, "-l", text]);
			await tmux(["send-keys", "-t", target, "Enter"]);
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
