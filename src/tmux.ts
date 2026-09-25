import { execFile } from "node:child_process";
import { processIdentity } from "./process.ts";
import { type PaneFile, parseStrict, TmuxServerIdentity } from "./schema.ts";

export type PaneState = {
	paneId: string;
	pid: number;
	dead: boolean;
	status: number | null;
	signal: string | null;
	session: string;
};

export interface Tmux {
	serverIdentity(): Promise<TmuxServerIdentity>;
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
	identify: typeof processIdentity = processIdentity,
): Tmux {
	if (!socket) throw new Error("Subagents need Pi to run inside tmux.");
	return {
		async serverIdentity() {
			const text = (await this.run(["display-message", "-p", "#{pid}"])).trim();
			const pid = Number(text);
			if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(pid))
				throw new Error(`Invalid tmux server pid: ${JSON.stringify(text)}.`);
			const process = identify(pid);
			if (process === null || process.pid !== pid)
				throw new Error(`Cannot identify tmux server process ${pid}.`);
			return parseStrict(
				TmuxServerIdentity,
				{ socket, process },
				"tmux server identity",
			);
		},
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

export function assertServerIdentity(
	saved: TmuxServerIdentity,
	current: TmuxServerIdentity,
): void {
	if (
		saved.socket !== current.socket ||
		saved.process.pid !== current.process.pid ||
		saved.process.start !== current.process.start
	)
		throw new Error(
			`Tmux server identity mismatch for ${saved.socket}. Keep the recovery files and inspect the original server.`,
		);
}

export function assertPaneIdentity(
	saved: PaneFile,
	session: string,
	current: PaneState | undefined,
): void {
	if (
		current !== undefined &&
		(current.paneId !== saved.paneId ||
			current.pid !== saved.process.pid ||
			current.session !== session)
	)
		throw new Error(
			`Tmux pane ${saved.paneId} identity mismatch. Keep the recovery files and inspect the pane.`,
		);
}

export async function verifiedPane(
	tmux: Tmux,
	saved: PaneFile,
	session: string,
): Promise<PaneState | undefined> {
	assertServerIdentity(saved.server, await tmux.serverIdentity());
	const pane = (await tmux.listPanes()).get(saved.paneId);
	assertServerIdentity(saved.server, await tmux.serverIdentity());
	assertPaneIdentity(saved, session, pane);
	return pane;
}

type PaneGeometry = {
	paneId: string;
	pid: number;
	left: number;
	top: number;
	width: number;
	height: number;
	session: string;
};

async function paneGeometry(
	tmux: Tmux,
	target: string,
): Promise<PaneGeometry[]> {
	const output = await tmux.run([
		"list-panes",
		"-t",
		target,
		"-F",
		"#{pane_id}\t#{pane_pid}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{@pi_subagent_session}",
	]);
	const lines = (output.endsWith("\n") ? output.slice(0, -1) : output).split(
		"\n",
	);
	const seen = new Set<string>();
	return lines.map((line) => {
		const fields = line.split("\t");
		const [paneId, pid, left, top, width, height, session] = fields;
		if (
			fields.length !== 7 ||
			paneId === undefined ||
			!/^%[0-9]+$/.test(paneId) ||
			seen.has(paneId) ||
			session === undefined ||
			[pid, width, height].some(
				(value) => value === undefined || !/^[1-9][0-9]*$/.test(value),
			) ||
			[left, top].some(
				(value) => value === undefined || !/^(0|[1-9][0-9]*)$/.test(value),
			) ||
			[pid, left, top, width, height].some(
				(value) => !Number.isSafeInteger(Number(value)),
			)
		)
			throw new Error(`Malformed tmux geometry: ${JSON.stringify(line)}.`);
		seen.add(paneId);
		return {
			paneId,
			pid: Number(pid),
			left: Number(left),
			top: Number(top),
			width: Number(width),
			height: Number(height),
			session,
		};
	});
}

export type ColumnPane = { pane: PaneFile; session: string };

// Resize only the owned vertical column. Never spread the window's other cells.
export async function balancePaneColumn(
	tmux: Tmux,
	owned: ColumnPane[],
): Promise<void> {
	const paneIds = owned.map((item) => item.pane.paneId);
	if (
		new Set(paneIds).size !== paneIds.length ||
		paneIds.some((id) => !/^%[0-9]+$/.test(id))
	)
		throw new Error("Invalid child column pane IDs.");
	if (paneIds.length < 2) return;
	const target = paneIds[0];
	if (target === undefined) throw new Error("Missing child column target.");
	const server = await tmux.serverIdentity();
	for (const item of owned) assertServerIdentity(item.pane.server, server);
	const before = await paneGeometry(tmux, target);
	for (const item of owned) {
		const current = before.find((pane) => pane.paneId === item.pane.paneId);
		if (current === undefined)
			throw new Error("A child column pane is missing.");
		if (
			current.pid !== item.pane.process.pid ||
			current.session !== item.session
		)
			throw new Error(`Child column pane ${current.paneId} identity mismatch.`);
	}
	assertServerIdentity(server, await tmux.serverIdentity());
	const column = before
		.filter((pane) => paneIds.includes(pane.paneId))
		.sort((a, b) => a.top - b.top);
	const first = column[0];
	if (column.length !== paneIds.length || first === undefined)
		throw new Error("A child column pane is missing.");
	let top = first.top;
	for (const pane of column) {
		if (
			pane.left !== first.left ||
			pane.width !== first.width ||
			pane.top !== top
		)
			throw new Error("Child panes do not form one uninterrupted column.");
		top += pane.height + 1;
	}
	for (const pane of before) {
		if (
			!paneIds.includes(pane.paneId) &&
			pane.left < first.left + first.width &&
			pane.left + pane.width > first.left
		)
			throw new Error(
				"The child column overlaps another pane. Keep its layout unchanged.",
			);
	}
	const height = column.reduce((total, pane) => total + pane.height, 0);
	if (!Number.isSafeInteger(height))
		throw new Error("Invalid child column height.");
	const base = Math.floor(height / column.length);
	const extra = height % column.length;
	top = first.top;
	const expected = new Map(before.map((pane) => [pane.paneId, { ...pane }]));
	for (const [index, pane] of column.entries()) {
		const desired = base + (index < extra ? 1 : 0);
		expected.set(pane.paneId, { ...pane, top, height: desired });
		top += desired + 1;
		if (index < column.length - 1) {
			assertServerIdentity(server, await tmux.serverIdentity());
			await tmux.run(["resize-pane", "-t", pane.paneId, "-y", String(desired)]);
		}
	}
	const after = await paneGeometry(tmux, target);
	assertServerIdentity(server, await tmux.serverIdentity());
	if (
		after.length !== expected.size ||
		after.some(
			(pane) =>
				JSON.stringify(pane) !== JSON.stringify(expected.get(pane.paneId)),
		)
	)
		throw new Error(
			"Tmux did not preserve the requested child column layout and pane identities.",
		);
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
