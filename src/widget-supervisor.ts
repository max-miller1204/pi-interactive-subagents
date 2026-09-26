import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { processAlive, processIdentity } from "./process.ts";
import type { RunBackend } from "./run-backend.ts";
import {
	ProcessIdentity,
	parseStrict,
	RunBackendRecord,
	type RunSpec,
	writeJsonAtomic,
} from "./schema.ts";

type WidgetBackend = Extract<RunBackend, { kind: "widget" }>;
type Config = {
	runId: string;
	ownerKey: string;
	prompt: string;
	cwd: string;
	argv: string[];
	env: NodeJS.ProcessEnv;
};

export async function startSupervisor(
	spec: RunSpec,
	runDir: string,
	argv: string[],
	env: NodeJS.ProcessEnv,
): Promise<WidgetBackend> {
	if (!argv.length || !argv[0]) throw new Error("Widget Pi command is empty.");
	if ((statSync(runDir).mode & 0o077) !== 0)
		throw new Error("Widget run directory is not private.");
	const configFile = join(runDir, `widget-start-${randomUUID()}.json`);
	const readyFile = join(runDir, "widget-ready.json");
	const errorFile = join(runDir, "widget-start-error.json");
	const exitFile = join(runDir, "widget-exit.json");
	writeFileSync(
		configFile,
		JSON.stringify({
			runId: spec.runId,
			ownerKey: spec.ownerKey,
			prompt: spec.initialPrompt,
			cwd: spec.launch.cwd,
			argv,
			env,
		} satisfies Config),
		{ flag: "wx", mode: 0o600 },
	);
	const supervisor = spawn(
		process.execPath,
		[fileURLToPath(import.meta.url), configFile, runDir],
		{
			cwd: runDir,
			detached: true,
			stdio: "ignore",
			env: process.env,
		},
	);
	if (!supervisor.pid) throw new Error("Widget supervisor did not start.");
	supervisor.unref();
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (existsSync(errorFile))
			throw new Error(
				`Widget supervisor failed: ${readFileSync(errorFile, "utf8")}`,
			);
		if (existsSync(readyFile)) {
			const record = parseStrict(
				RunBackendRecord,
				JSON.parse(readFileSync(readyFile, "utf8")),
				"widget ready record",
			);
			if (record.kind !== "widget" || record.supervisor.pid !== supervisor.pid)
				throw new Error(
					"Widget supervisor returned an invalid process identity.",
				);
			const exited = existsSync(exitFile);
			if (
				!exited &&
				(!processAlive(record.supervisor) || !processAlive(record.child))
			) {
				await new Promise((done) => setTimeout(done, 20));
				continue;
			}
			return {
				kind: "widget",
				supervisor: record.supervisor,
				child: record.child,
				socket: record.socket,
			};
		}
		await new Promise((done) => setTimeout(done, 20));
	}
	throw new Error(
		existsSync(readyFile)
			? "Widget supervisor exited before writing an exit record."
			: "Widget supervisor did not become ready.",
	);
}

async function run(configFile: string, runDir: string): Promise<void> {
	const config = JSON.parse(readFileSync(configFile, "utf8")) as Config;
	rmSync(configFile);
	const supervisor = processIdentity(process.pid);
	if (!supervisor) throw new Error("Cannot identify widget supervisor.");
	const child = spawn(config.argv[0] as string, config.argv.slice(1), {
		cwd: config.cwd,
		env: Object.fromEntries(
			Object.entries(config.env).filter(
				([key]) => key !== "TMUX" && key !== "TMUX_PANE",
			),
		),
		stdio: ["pipe", "pipe", "pipe"],
	});
	if (!child.pid) throw new Error("Widget Pi process did not start.");
	const childIdentity = processIdentity(child.pid);
	if (!childIdentity) throw new Error("Cannot identify widget Pi process.");
	const socketAliasDir = mkdtempSync(join(tmpdir(), "pi-widget-socket-"));
	symlinkSync(runDir, join(socketAliasDir, "run"), "dir");
	const socket = join(socketAliasDir, "run", "w.sock");
	const backend: WidgetBackend = {
		kind: "widget",
		supervisor,
		child: childIdentity,
		socket,
	};
	let exited = false;
	let exitCode: number | null = null;
	let signal: string | null = null;
	let rpcError: string | null = null;
	let rpcBuffer = "";
	let listening = false;
	child.stdout.on("data", (chunk: Buffer) => {
		rpcBuffer += chunk.toString("utf8");
		let newline = rpcBuffer.indexOf("\n");
		while (newline >= 0) {
			const line = rpcBuffer.slice(0, newline);
			rpcBuffer = rpcBuffer.slice(newline + 1);
			try {
				JSON.parse(line);
			} catch {
				rpcError = "Pi RPC output was malformed.";
				child.kill("SIGTERM");
				return;
			}
			newline = rpcBuffer.indexOf("\n");
		}
	});
	child.stderr.on("data", () => {});
	child.on("exit", (code, exitSignal) => {
		exited = true;
		exitCode = code;
		signal = exitSignal;
		writeJsonAtomic(join(runDir, "widget-exit.json"), {
			v: 1,
			runId: config.runId,
			exitCode: code,
			signal: exitSignal,
			...(rpcError ? { error: rpcError } : {}),
		});
		if (listening)
			server.close(() =>
				rmSync(socketAliasDir, { recursive: true, force: true }),
			);
		else rmSync(socketAliasDir, { recursive: true, force: true });
	});
	child.on("error", (error) => {
		rpcError = error.message;
	});
	const server = createServer((connection) => {
		let data = "";
		const timer = setTimeout(() => connection.destroy(), 3000);
		connection.on("data", (chunk: Buffer) => {
			data += chunk.toString("utf8");
			if (data.length > 4096) return connection.destroy();
			const newline = data.indexOf("\n");
			if (newline < 0) return;
			clearTimeout(timer);
			try {
				const request = JSON.parse(data.slice(0, newline));
				const same = (a: ProcessIdentity, b: ProcessIdentity) =>
					a.pid === b.pid && a.start === b.start;
				if (
					request.v !== 1 ||
					request.runId !== config.runId ||
					request.ownerKey !== config.ownerKey ||
					!same(
						parseStrict(ProcessIdentity, request.supervisor, "supervisor"),
						supervisor,
					) ||
					!same(
						parseStrict(ProcessIdentity, request.child, "child"),
						childIdentity,
					) ||
					!processAlive(supervisor) ||
					(!exited && !processAlive(childIdentity))
				)
					throw new Error("Widget request identity does not match.");
				if (request.command !== "status" && request.command !== "stop")
					throw new Error("Unknown widget command.");
				if (request.command === "stop" && !exited) child.kill("SIGTERM");
				connection.end(
					`${JSON.stringify({ ok: true, status: { childAlive: !exited, exitCode, signal } })}\n`,
				);
			} catch (error) {
				connection.end(
					`${JSON.stringify({ ok: false, error: String(error) })}\n`,
				);
			}
		});
		connection.on("close", () => clearTimeout(timer));
	});
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socket, () => {
				listening = true;
				resolve();
			});
		});
	} catch (error) {
		if (processAlive(childIdentity)) child.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			if (child.exitCode !== null || child.signalCode !== null)
				return resolve();
			const timer = setTimeout(() => {
				if (processAlive(childIdentity)) child.kill("SIGKILL");
				resolve();
			}, 3000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
		throw error;
	}
	chmodSync(socket, 0o600);
	if ((statSync(runDir).mode & 0o077) !== 0)
		throw new Error("Widget run directory is not private.");
	writeJsonAtomic(join(runDir, "widget-ready.json"), { v: 1, ...backend });
	child.stdin.write(
		`${JSON.stringify({ type: "prompt", id: randomUUID(), message: config.prompt })}\n`,
	);
}

if (
	process.argv[1] === fileURLToPath(import.meta.url) &&
	process.argv.length === 4
) {
	run(process.argv[2] as string, process.argv[3] as string).catch((error) => {
		writeJsonAtomic(
			join(process.argv[3] as string, "widget-start-error.json"),
			{ error: String(error) },
		);
		process.exitCode = 1;
	});
}
