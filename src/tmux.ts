import { execFile } from "node:child_process";
import { processIdentity } from "./process.ts";
import { type PaneFile, parseStrict, TmuxServerIdentity } from "./schema.ts";
import { isolatedColumn, layoutPanes, parseTmuxLayout } from "./tmux-layout.ts";

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
		!/^(0|[1-9][0-9]*)$/.test(pidText) ||
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
	if (dead && status === null && signal === null)
		throw new UnreapedPaneError(paneId);
	return { paneId, pid, dead, status, signal, session };
}

// Linux tmux links libutempter. That library replaces the SIGCHLD handler
// while it updates utmp. tmux can miss the child exit and leave a zombie.
// The pane then looks dead with no status and no signal.
class UnreapedPaneError extends Error {
	constructor(paneId: string) {
		super(
			`tmux reports pane ${paneId} as dead with no exit status and no signal.`,
		);
		this.name = "UnreapedPaneError";
	}
}

export function createTmux(
	socket: string = tmuxSocket(),
	execute: TmuxExec = exec,
	identify: typeof processIdentity = processIdentity,
	signalServer: (pid: number) => void = (pid) => {
		process.kill(pid, "SIGCHLD");
	},
): Tmux {
	if (!socket) throw new Error("Subagents need Pi to run inside tmux.");
	const client: Tmux = {
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
			const read = async () => {
				const output = await client.run([
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
			};
			try {
				return await read();
			} catch (error) {
				if (!(error instanceof UnreapedPaneError)) throw error;
				// Ask tmux to run its child handler. One signal reaps every zombie.
				// Read the list again. A pane that is still unreaped is a hard error.
				const text = (
					await client.run(["display-message", "-p", "#{pid}"])
				).trim();
				const pid = Number(text);
				if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(pid))
					throw new Error(`Invalid tmux server pid: ${JSON.stringify(text)}.`, {
						cause: error,
					});
				const server = identify(pid);
				if (server === null || server.pid !== pid)
					throw new Error(`Cannot identify tmux server process ${pid}.`, {
						cause: error,
					});
				signalServer(pid);
				return await read();
			}
		},
		capture(paneId) {
			return this.run(["capture-pane", "-p", "-J", "-S", "-40", "-t", paneId]);
		},
	};
	return client;
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
			[width, height].some(
				(value) => value === undefined || !/^[1-9][0-9]*$/.test(value),
			) ||
			[pid, left, top].some(
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

async function columnSnapshot(tmux: Tmux, owned: ColumnPane[], target: string) {
	const server = await tmux.serverIdentity();
	for (const item of owned) assertServerIdentity(item.pane.server, server);
	const panes = await paneGeometry(tmux, target);
	for (const item of owned) {
		const current = panes.find((pane) => pane.paneId === item.pane.paneId);
		if (current === undefined)
			throw new Error("A child column pane is missing.");
		if (
			current.pid !== item.pane.process.pid ||
			current.session !== item.session
		)
			throw new Error(`Child column pane ${current.paneId} identity mismatch.`);
	}
	const border = (
		await tmux.run([
			"show-options",
			"-A",
			"-w",
			"-v",
			"-t",
			target,
			"pane-border-status",
		])
	).trim();
	if (border !== "off" && border !== "top" && border !== "bottom")
		throw new Error(
			`Invalid tmux pane-border-status: ${JSON.stringify(border)}.`,
		);
	const tree = parseTmuxLayout(
		await tmux.run(["display-message", "-p", "-t", target, "#{window_layout}"]),
	);
	const leaves = layoutPanes(tree);
	if (
		leaves.length !== panes.length ||
		panes.some((pane) => {
			const leaf = leaves.find((cell) => cell.paneId === pane.paneId);
			if (leaf === undefined) return true;
			const inset =
				border === "top" && leaf.top === tree.top
					? 1
					: border === "bottom" &&
							leaf.top + leaf.height === tree.top + tree.height
						? 1
						: 0;
			return (
				leaf.width !== pane.width ||
				leaf.height - inset !== pane.height ||
				leaf.left !== pane.left ||
				leaf.top + (border === "top" ? inset : 0) !== pane.top
			);
		})
	)
		throw new Error("Tmux layout tree does not match pane geometry.");
	isolatedColumn(
		tree,
		owned.map((item) => item.pane.paneId),
	);
	assertServerIdentity(server, await tmux.serverIdentity());
	panes.sort((a, b) => a.paneId.localeCompare(b.paneId));
	return { panes, tree, border };
}

export async function childSplitTarget(
	tmux: Tmux,
	owned: ColumnPane[],
): Promise<string | undefined> {
	const target = owned.at(-1)?.pane.paneId;
	if (owned.length < 2) return target;
	if (target === undefined) throw new Error("Missing child column target.");
	const snapshot = await columnSnapshot(tmux, owned, target);
	const column = isolatedColumn(
		snapshot.tree,
		owned.map((item) => item.pane.paneId),
	);
	// Split a direct leaf so nested rows keep their size and position.
	const leaf = column.children.findLast((cell) => cell.kind === "pane");
	if (leaf?.kind !== "pane")
		throw new Error("The child column has no pane that can be split.");
	return leaf.paneId;
}

// Check the whole tree and all identities before each change to the owned subtree.
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
	const expected = await columnSnapshot(tmux, owned, target);
	const column = isolatedColumn(expected.tree, paneIds);
	// Resize only consecutive owned leaves. A nested row is a fixed boundary.
	const groups: (typeof column.children)[] = [];
	let group: typeof column.children = [];
	for (const child of column.children) {
		if (child.kind === "pane") group.push(child);
		else {
			if (group.length > 1) groups.push(group);
			group = [];
		}
	}
	if (group.length > 1) groups.push(group);
	const verify = async () => {
		const current = await columnSnapshot(tmux, owned, target);
		if (JSON.stringify(current) !== JSON.stringify(expected))
			throw new Error(
				"Tmux did not preserve the requested child column layout and pane identities.",
			);
	};
	for (const cells of groups) {
		const groupTop = cells[0]?.top;
		if (groupTop === undefined)
			throw new Error("Missing child group position.");
		const geometry = (cell: (typeof cells)[number]) => {
			if (cell.kind !== "pane") throw new Error("Invalid child column leaf.");
			const pane = expected.panes.find((pane) => pane.paneId === cell.paneId);
			if (pane === undefined) throw new Error("Missing child column geometry.");
			return pane;
		};
		const insets = new Map(
			cells.map((cell) => [
				cell,
				{
					top: geometry(cell).top - cell.top,
					height: cell.height - geometry(cell).height,
				},
			]),
		);
		const inset = (cell: (typeof cells)[number]) => {
			const value = insets.get(cell);
			if (value === undefined) throw new Error("Missing child column inset.");
			return value;
		};
		const height = cells.reduce(
			(total, cell) => total + geometry(cell).height,
			0,
		);
		if (!Number.isSafeInteger(height))
			throw new Error("Invalid child column height.");
		const base = Math.floor(height / cells.length);
		const extra = height % cells.length;
		for (let index = 0; index < cells.length - 1; index++) {
			await verify();
			const cell = cells[index];
			const next = cells[index + 1];
			if (cell?.kind !== "pane" || next === undefined)
				throw new Error("Invalid child column leaf.");
			const desired = base + (index < extra ? 1 : 0);
			let change = desired + inset(cell).height - cell.height;
			cell.height = desired + inset(cell).height;
			// tmux shrinks into the next sibling, or grows from following siblings.
			if (change < 0) next.height -= change;
			else {
				for (const donor of cells.slice(index + 1)) {
					const amount = Math.min(
						change,
						donor.height - inset(donor).height - 1,
					);
					donor.height -= amount;
					change -= amount;
				}
				if (change !== 0)
					throw new Error("Insufficient space in the child column.");
			}
			let top = groupTop;
			for (const child of cells) {
				if (child.kind !== "pane")
					throw new Error("Invalid child column leaf.");
				child.top = top;
				top += child.height + 1;
				const pane = expected.panes.find(
					(pane) => pane.paneId === child.paneId,
				);
				if (pane === undefined)
					throw new Error("Missing child column geometry.");
				pane.top = child.top + inset(child).top;
				pane.height = child.height - inset(child).height;
			}
			await tmux.run(["resize-pane", "-t", cell.paneId, "-y", String(desired)]);
		}
	}
	await verify();
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
