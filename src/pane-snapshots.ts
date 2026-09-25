import type { Tmux } from "./tmux.ts";

type Phase = {
	kind: "start" | "snapshot";
	before: Promise<void>;
	done: PromiseWithResolvers<void>;
	active: number;
};

// Keep snapshots outside empty-pane intervals. Operations in one phase can overlap.
export function gatePaneSnapshots(tmux: Tmux) {
	let last: Phase | undefined;
	async function during<T>(
		kind: Phase["kind"],
		action: () => Promise<T>,
	): Promise<T> {
		if (last === undefined || last.active === 0 || last.kind !== kind) {
			last = {
				kind,
				before: last === undefined ? Promise.resolve() : last.done.promise,
				done: Promise.withResolvers<void>(),
				active: 0,
			};
		}
		const phase = last;
		phase.active++;
		await phase.before;
		try {
			return await action();
		} finally {
			phase.active--;
			if (phase.active === 0) phase.done.resolve();
		}
	}
	const guarded: Tmux = {
		serverIdentity: () => tmux.serverIdentity(),
		capture: (pane) => tmux.capture(pane),
		listPanes: () => during("snapshot", () => tmux.listPanes()),
		run: (args) =>
			args[0] === "list-panes"
				? during("snapshot", () => tmux.run(args))
				: tmux.run(args),
	};
	return {
		tmux: guarded,
		startPane: <T>(action: () => Promise<T>) => during("start", action),
	};
}
