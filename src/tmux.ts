import { execFile } from "node:child_process";

export type PaneState = {
	paneId: string;
	pid: number;
	dead: boolean;
	status: number | null;
	signal: string | null;
	session: string;
};

export interface Tmux {
	run(args: string[]): Promise<string>;
	listPanes(): Promise<Map<string, PaneState>>;
	capture(paneId: string): Promise<string>;
}

export type TmuxExec = (
	file: string,
	args: string[],
	options: { encoding: "utf8" },
) => Promise<{ stdout: string; stderr: string }>;

const exec: TmuxExec = (file, args, options) =>
	new Promise((resolve, reject) => {
		execFile(file, args, options, (error, stdout, stderr) => {
			if (error) {
				reject(Object.assign(error, { stderr }));
				return;
			}
			resolve({ stdout, stderr });
		});
	});

export function tmuxSocket(
	value: string | undefined = process.env.TMUX,
): string {
	const socket = value?.split(",")[0];
	if (!socket) throw new Error("Subagents need Pi to run inside tmux.");
	return socket;
}

function parsePane(line: string): PaneState {
	const fields = line.split("\t");
	if (fields.length !== 6)
		throw new Error(`Malformed tmux pane line: ${JSON.stringify(line)}`);
	const [paneId, pidText, deadText, statusText, signalText, session] = fields;
	if (
		!paneId ||
		!/^%[0-9]+$/.test(paneId) ||
		!pidText ||
		!/^[1-9][0-9]*$/.test(pidText) ||
		(deadText !== "0" && deadText !== "1") ||
		statusText === undefined ||
		(statusText !== "" && !/^[0-9]+$/.test(statusText)) ||
		signalText === undefined ||
		(signalText !== "" && !/^[A-Za-z0-9_]+$/.test(signalText)) ||
		session === undefined
	)
		throw new Error(`Malformed tmux pane line: ${JSON.stringify(line)}`);
	const pid = Number(pidText);
	const status = statusText === "" ? null : Number(statusText);
	if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(status ?? 0)) {
		throw new Error(`Malformed tmux pane line: ${JSON.stringify(line)}`);
	}
	const dead = deadText === "1";
	const signal = signalText || null;
	if (dead && status === null && signal === null) {
		throw new Error(
			`tmux reports pane ${paneId} as dead with no exit status and no signal.`,
		);
	}
	return { paneId, pid, dead, status, signal, session };
}

export function createTmux(
	socket: string = tmuxSocket(),
	execute: TmuxExec = exec,
): Tmux {
	if (!socket) throw new Error("Subagents need Pi to run inside tmux.");
	return {
		async run(args) {
			if (args.length === 0) throw new Error("A tmux command is required.");
			try {
				const { stdout } = await execute("tmux", ["-S", socket, ...args], {
					encoding: "utf8",
				});
				return stdout;
			} catch (error) {
				const stderr =
					error !== null &&
					typeof error === "object" &&
					"stderr" in error &&
					typeof error.stderr === "string"
						? error.stderr.trim()
						: "";
				if (/no space for (a )?new pane/.test(stderr)) {
					throw new Error(
						"No room for another subagent pane in this window. Close a subagent pane or make the terminal larger.",
						{ cause: error },
					);
				}
				throw new Error(`tmux ${args[0]} failed: ${stderr}`, { cause: error });
			}
		},
		async listPanes() {
			const output = await this.run([
				"list-panes",
				"-a",
				"-F",
				"#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_dead_signal}\t#{@pi_subagent_session}",
			]);
			const panes = new Map<string, PaneState>();
			if (output === "") return panes;
			const lines = (
				output.endsWith("\n") ? output.slice(0, -1) : output
			).split("\n");
			for (const line of lines) {
				const pane = parsePane(line);
				if (panes.has(pane.paneId))
					throw new Error(`Duplicate tmux pane ${pane.paneId}.`);
				panes.set(pane.paneId, pane);
			}
			return panes;
		},
		capture(paneId) {
			return this.run(["capture-pane", "-p", "-J", "-S", "-40", "-t", paneId]);
		},
	};
}

export async function checkTmuxVersion(tmux: Tmux): Promise<void> {
	const output = (await tmux.run(["-V"])).trim();
	const match = /^tmux ([0-9]+)\.([0-9]+)([a-z]?)$/.exec(output);
	if (!match) throw new Error(`Invalid tmux version: ${output}`);
	const major = Number(match[1]);
	const minor = Number(match[2]);
	if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) {
		throw new Error(`Invalid tmux version: ${output}`);
	}
	if (major < 3 || (major === 3 && minor < 3)) {
		throw new Error(
			`tmux ${match[1]}.${match[2]}${match[3]} is too old. Subagents need tmux 3.3 or newer.`,
		);
	}
}
