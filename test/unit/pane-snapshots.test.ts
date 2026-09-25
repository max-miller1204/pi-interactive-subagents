import assert from "node:assert/strict";
import { test } from "node:test";
import { gatePaneSnapshots } from "../../src/pane-snapshots.ts";
import type { Tmux } from "../../src/tmux.ts";

function fixture() {
	const events: string[] = [];
	const raw: Tmux = {
		serverIdentity: async () => ({
			socket: "/private-test",
			process: { pid: 10, start: "server start" },
		}),
		capture: async () => {
			events.push("capture");
			return "Unrelated pane output.";
		},
		listPanes: async () => {
			events.push("snapshot");
			return new Map();
		},
		run: async (args) => {
			events.push(args.join(" "));
			return "";
		},
	};
	return { raw, events, gate: gatePaneSnapshots(raw) };
}

test("an in-flight snapshot finishes before pane creation starts", async () => {
	const f = fixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	f.raw.listPanes = async () => {
		f.events.push("snapshot start");
		entered.resolve();
		await release.promise;
		f.events.push("snapshot end");
		return new Map();
	};
	const snapshot = f.gate.tmux.listPanes();
	await entered.promise;
	const start = f.gate.startPane(async () => {
		f.events.push("start");
	});
	assert.equal(await f.gate.tmux.capture("%1"), "Unrelated pane output.");
	assert.deepEqual(f.events, ["snapshot start", "capture"]);
	release.resolve();
	await Promise.all([snapshot, start]);
	assert.deepEqual(f.events, [
		"snapshot start",
		"capture",
		"snapshot end",
		"start",
	]);
});

test("overlapping pane starts defer only snapshots until both respawns finish", async () => {
	const f = fixture();
	const firstEntered = Promise.withResolvers<void>();
	const secondEntered = Promise.withResolvers<void>();
	const firstRelease = Promise.withResolvers<void>();
	const secondRelease = Promise.withResolvers<void>();
	const first = f.gate.startPane(async () => {
		firstEntered.resolve();
		await firstRelease.promise;
	});
	await firstEntered.promise;
	const second = f.gate.startPane(async () => {
		secondEntered.resolve();
		await secondRelease.promise;
	});
	await secondEntered.promise;
	const snapshot = f.gate.tmux.listPanes();
	const geometry = f.gate.tmux.run(["list-panes", "-t", "%1"]);
	await f.gate.tmux.capture("%1");
	await f.gate.tmux.run(["display-message", "-p", "#{pane_pid}"]);
	assert.deepEqual(f.events, ["capture", "display-message -p #{pane_pid}"]);
	firstRelease.resolve();
	await first;
	assert.equal(f.events.includes("snapshot"), false);
	secondRelease.resolve();
	await Promise.all([second, snapshot, geometry]);
	assert.deepEqual(f.events, [
		"capture",
		"display-message -p #{pane_pid}",
		"snapshot",
		"list-panes -t %1",
	]);
});

test("failed creation releases snapshots and preserves the original error", async () => {
	const f = fixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const failure = new Error("respawn failed");
	const start = f.gate.startPane(async () => {
		entered.resolve();
		await release.promise;
		throw failure;
	});
	const rejected = assert.rejects(start, (error) => error === failure);
	await entered.promise;
	const snapshot = f.gate.tmux.listPanes();
	release.resolve();
	await Promise.all([rejected, snapshot]);
	await f.gate.startPane(async () => {
		f.events.push("next start");
	});
	assert.deepEqual(f.events, ["snapshot", "next start"]);
});

test("a strict snapshot error does not trap later pane creation", async () => {
	const f = fixture();
	const failure = new Error("Malformed tmux pane line");
	f.raw.listPanes = async () => {
		throw failure;
	};
	await assert.rejects(f.gate.tmux.listPanes(), (error) => error === failure);
	await f.gate.startPane(async () => {
		f.events.push("start");
	});
	assert.deepEqual(f.events, ["start"]);
});
