#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { rmSync } from "node:fs";

const flag = "--isolated-tmux";
const args = process.argv.slice(2);
const isolatedTmux = args.includes(flag);
const nodeArgs = args.filter((arg) => arg !== flag);
const environment = Object.fromEntries(
	Object.entries(process.env).filter(
		([name]) => !name.startsWith("PI_SUBAGENT_"),
	),
);

function startPrivateServer() {
	const socketName = `pi-subagents-test-${process.pid}`;
	const serverEnvironment = { ...environment };
	delete serverEnvironment.TMUX;
	delete serverEnvironment.TMUX_PANE;
	const tmux = (tmuxArgs) =>
		execFileSync("tmux", ["-L", socketName, "-f", "/dev/null", ...tmuxArgs], {
			encoding: "utf8",
			env: serverEnvironment,
		}).trim();
	const [paneId, serverPid, sessionId] = tmux([
		"new-session",
		"-d",
		"-s",
		"tests",
		"-x",
		"240",
		"-y",
		"60",
		"-P",
		"-F",
		"#{pane_id} #{pid} #{session_id}",
	]).split(" ");
	let socketPath;
	try {
		socketPath = tmux([
			"display-message",
			"-p",
			"-t",
			paneId,
			"#{socket_path}",
		]);
	} catch (error) {
		tmux(["kill-server"]);
		throw error;
	}
	let stopped = false;
	return {
		environment: {
			...serverEnvironment,
			TMUX: `${socketPath},${serverPid},${sessionId.replace(/^\$/, "")}`,
			TMUX_PANE: paneId,
		},
		stop() {
			if (stopped) return;
			stopped = true;
			try {
				tmux(["kill-server"]);
			} finally {
				rmSync(socketPath, { force: true });
			}
		},
	};
}

const isolated = isolatedTmux ? startPrivateServer() : null;
let escalation;
let interrupted = false;
try {
	const child = spawn(process.execPath, nodeArgs, {
		env: isolated ? isolated.environment : environment,
		stdio: "inherit",
	});
	const exit = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
	if (isolated) {
		for (const signal of ["SIGINT", "SIGTERM"]) {
			process.on(signal, () => {
				if (interrupted) return;
				interrupted = true;
				child.kill(signal);
				escalation = setTimeout(() => child.kill("SIGKILL"), 500);
			});
		}
	}
	const result = await exit;
	if (result.signal) {
		console.error(`Tests stopped with signal ${result.signal}.`);
	}
	process.exitCode = interrupted || result.signal ? 1 : result.code;
} catch (error) {
	console.error(`Cannot start tests: ${error.message}`);
	process.exitCode = 1;
} finally {
	clearTimeout(escalation);
	isolated?.stop();
}
