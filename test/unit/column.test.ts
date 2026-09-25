import assert from "node:assert/strict";
import { test } from "node:test";
import {
	balancePaneColumn as balanceOwnedColumn,
	type ColumnPane,
	type Tmux,
} from "../../src/tmux.ts";

type TestTmux = Tmux & { owned: Map<string, ColumnPane> };
function balancePaneColumn(tmux: TestTmux, ids: string[]) {
	return balanceOwnedColumn(
		tmux,
		ids.map((id) => {
			const saved = tmux.owned.get(id);
			assert.ok(saved);
			return saved;
		}),
	);
}

function fixture() {
	const server = {
		socket: "/private-test",
		process: { pid: 99, start: "server start" },
	};
	const rows = [
		"%1\t101\t0\t0\t60\t30\t",
		"%2\t102\t0\t31\t60\t29\t",
		"%0\t100\t61\t0\t89\t60\t/parent",
		"%3\t103\t151\t0\t89\t30\t/one",
		"%4\t104\t151\t31\t89\t14\t/two",
		"%5\t105\t151\t46\t89\t14\t/three",
	];
	const state = {
		before: `${rows.join("\n")}\n`,
		after: `${[
			...rows.slice(0, 3),
			"%3\t103\t151\t0\t89\t20\t/one",
			"%4\t104\t151\t21\t89\t19\t/two",
			"%5\t105\t151\t41\t89\t19\t/three",
		].join("\n")}\n`,
		fail: false,
	};
	const calls: string[][] = [];
	let reads = 0;
	const tmux: TestTmux = {
		owned: new Map(
			["one", "two", "three"].map((name, index) => [
				`%${index + 3}`,
				{
					pane: {
						v: 1,
						paneId: `%${index + 3}`,
						process: { pid: index + 103, start: "child start" },
						server,
					},
					session: `/${name}`,
				},
			]),
		),
		serverIdentity: async () => structuredClone(server),
		run: async (args) => {
			calls.push(args);
			if (args[0] === "list-panes")
				return ++reads === 1 ? state.before : state.after;
			assert.equal(
				args[0],
				"resize-pane",
				"no whole-window layout command is allowed",
			);
			if (state.fail) throw new Error("resize failed");
			return "";
		},
		listPanes: async () => {
			throw new Error("Unexpected pane state query");
		},
		capture: async () => {
			throw new Error("Unexpected capture");
		},
	};
	return { tmux, state, calls, server };
}

test("column balance changes only owned heights and preserves multiple user panes", async () => {
	const f = fixture();
	await balancePaneColumn(f.tmux, ["%5", "%3", "%4"]);
	assert.deepEqual(
		f.calls.filter((args) => args[0] === "resize-pane"),
		[
			["resize-pane", "-t", "%3", "-y", "20"],
			["resize-pane", "-t", "%4", "-y", "19"],
		],
	);
	assert.deepEqual(f.calls[0], [
		"list-panes",
		"-t",
		"%5",
		"-F",
		"#{pane_id}\t#{pane_pid}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{@pi_subagent_session}",
	]);
	assert.deepEqual(f.calls.at(-1), f.calls[0]);
});

test("zero or one remaining child needs no layout command", async () => {
	const f = fixture();
	await balancePaneColumn(f.tmux, []);
	await balancePaneColumn(f.tmux, ["%3"]);
	assert.deepEqual(f.calls, []);
});

for (const [label, mutate, pattern] of [
	[
		"missing pane",
		(text: string) => text.replace("%5\t", "%6\t"),
		/pane is missing/,
	],
	[
		"unequal columns",
		(text: string) => text.replace("%4\t104\t151", "%4\t104\t150"),
		/uninterrupted column/,
	],
	[
		"gap",
		(text: string) => text.replace("%4\t104\t151\t31", "%4\t104\t151\t32"),
		/uninterrupted column/,
	],
	[
		"unrelated overlapping pane",
		(text: string) => `${text}%6\t106\t151\t61\t89\t10\t/human\n`,
		/overlaps another pane/,
	],
	[
		"bad number",
		(text: string) => text.replace("\t30\t", "\t30x\t"),
		/Malformed tmux geometry/,
	],
	[
		"unsafe number",
		(text: string) => text.replace("\t30\t", "\t9007199254740992\t"),
		/Malformed tmux geometry/,
	],
	[
		"duplicate",
		(text: string) => text.replace("%5\t", "%4\t"),
		/Malformed tmux geometry/,
	],
] as const)
	test(`column balance rejects ${label} before resizing`, async () => {
		const f = fixture();
		f.state.before = mutate(f.state.before);
		await assert.rejects(
			balancePaneColumn(f.tmux, ["%3", "%4", "%5"]),
			pattern,
		);
		assert.equal(f.calls.filter((args) => args[0] === "resize-pane").length, 0);
	});

test("column balance preserves strict resize errors", async () => {
	const f = fixture();
	f.state.fail = true;
	await assert.rejects(
		balancePaneColumn(f.tmux, ["%3", "%4", "%5"]),
		/resize failed/,
	);
});

test("column balance rejects a changed server before resizing", async () => {
	const f = fixture();
	let calls = 0;
	f.tmux.serverIdentity = async () => ({
		...f.server,
		process: { pid: 99, start: ++calls === 1 ? "server start" : "new server" },
	});
	await assert.rejects(
		balancePaneColumn(f.tmux, ["%3", "%4", "%5"]),
		/server identity mismatch/,
	);
	assert.equal(f.calls.filter((args) => args[0] === "resize-pane").length, 0);
});

for (const [label, from, to] of [
	["process", "%3\t103", "%3\t999"],
	["session", "/one", "/other"],
] as const)
	test(`column balance rejects a changed ${label} before resizing`, async () => {
		const f = fixture();
		f.state.before = f.state.before.replace(from, to);
		await assert.rejects(
			balancePaneColumn(f.tmux, ["%3", "%4", "%5"]),
			/identity mismatch/,
		);
		assert.equal(f.calls.filter((args) => args[0] === "resize-pane").length, 0);
	});

test("column balance rejects saved identities from a different server", async () => {
	const f = fixture();
	const saved = f.tmux.owned.get("%3");
	assert.ok(saved);
	f.tmux.owned.set("%3", {
		...saved,
		pane: {
			...saved.pane,
			server: {
				...saved.pane.server,
				process: { pid: 99, start: "old server" },
			},
		},
	});
	await assert.rejects(
		balancePaneColumn(f.tmux, ["%3", "%4", "%5"]),
		/server identity mismatch/,
	);
	assert.equal(f.calls.length, 0);
});

for (const [label, from, to] of [
	["user width", "%1\t101\t0\t0\t60", "%1\t101\t0\t0\t80"],
	["user height", "%1\t101\t0\t0\t60\t30", "%1\t101\t0\t0\t60\t20"],
	["child identity", "%3\t103", "%3\t999"],
	["child session", "/one", "/other"],
	["child height", "%3\t103\t151\t0\t89\t20", "%3\t103\t151\t0\t89\t21"],
] as const)
	test(`column balance rejects changed ${label} after resizing`, async () => {
		const f = fixture();
		f.state.after = f.state.after.replace(from, to);
		await assert.rejects(
			balancePaneColumn(f.tmux, ["%3", "%4", "%5"]),
			/did not preserve/,
		);
	});
