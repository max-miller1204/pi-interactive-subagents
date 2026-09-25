#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
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
	const socketPath = tmux([
		"display-message",
		"-p",
		"-t",
		paneId,
		"#{socket_path}",
	]);
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
if (isolated) {
	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.on(signal, () => {
			isolated.stop();
			process.exit(1);
		});
	}
}

let result;
try {
	result = spawnSync(process.execPath, nodeArgs, {
		env: isolated ? isolated.environment : environment,
		stdio: "inherit",
	});
} finally {
	isolated?.stop();
}
if (result.error) {
	console.error(`Cannot start tests: ${result.error.message}`);
	process.exit(1);
}
if (result.signal) {
	console.error(`Tests stopped with signal ${result.signal}.`);
	process.exit(1);
}
process.exit(result.status);
