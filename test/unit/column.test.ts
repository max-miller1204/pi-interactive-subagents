import assert from "node:assert/strict";
import { test } from "node:test";
import {
	balancePaneColumn as balanceOwnedColumn,
	type ColumnPane,
	type Tmux,
} from "../../src/tmux.ts";
import { layoutPanes, parseTmuxLayout } from "../../src/tmux-layout.ts";
import { tmuxLayout } from "../fixtures/tmux-layout.ts";

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
		middle: `${[...rows.slice(0, 3), "%3\t103\t151\t0\t89\t20\t/one", "%4\t104\t151\t21\t89\t24\t/two", "%5\t105\t151\t46\t89\t14\t/three"].join("\n")}\n`,
		layouts: [
			"89x30,151,0,3,89x14,151,31,4,89x14,151,46,5",
			"89x20,151,0,3,89x24,151,21,4,89x14,151,46,5",
			"89x20,151,0,3,89x19,151,21,4,89x19,151,41,5",
		].map((children) =>
			tmuxLayout(
				`240x60,0,0{60x60,0,0[60x30,0,0,1,60x29,0,31,2],89x60,61,0,0,89x60,151,0[${children}]}`,
			),
		),
		after: `${[
			...rows.slice(0, 3),
			"%3\t103\t151\t0\t89\t20\t/one",
			"%4\t104\t151\t21\t89\t19\t/two",
			"%5\t105\t151\t41\t89\t19\t/three",
		].join("\n")}\n`,
		fail: false,
		border: "off",
	};
	const calls: string[][] = [];
	let resizes = 0;
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
			if (args[0] === "show-options") return state.border;
			if (args[0] === "list-panes")
				return resizes === 0
					? state.before
					: resizes === 1
						? state.middle
						: state.after;
			if (args[0] === "display-message") {
				assert.equal(args.at(-1), "#{window_layout}");
				const layout = state.layouts[resizes];
				assert.ok(layout);
				return layout;
			}
			assert.equal(
				args[0],
				"resize-pane",
				"no whole-window layout command is allowed",
			);
			if (state.fail) throw new Error("resize failed");
			resizes++;
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

function snapshots(bodies: string[], ids: string[], border = "off") {
	const calls: string[][] = [];
	const server = {
		socket: "/private-test",
		process: { pid: 99, start: "server" },
	};
	let index = 0;
	const tmux: TestTmux = {
		owned: new Map(
			ids.map((id) => [
				id,
				{
					pane: {
						v: 1,
						paneId: id,
						process: { pid: 100 + Number(id.slice(1)), start: "child" },
						server,
					},
					session: `/session${id}`,
				},
			]),
		),
		serverIdentity: async () => structuredClone(server),
		listPanes: async () => {
			throw new Error("Unexpected pane query");
		},
		capture: async () => {
			throw new Error("Unexpected capture");
		},
		run: async (args) => {
			calls.push(args);
			const body = bodies[index];
			assert.ok(body, "Missing independent layout expectation");
			const tree = parseTmuxLayout(tmuxLayout(body));
			if (args[0] === "display-message") return tmuxLayout(body);
			if (args[0] === "show-options") return border;
			if (args[0] === "list-panes")
				return layoutPanes(tree)
					.map((leaf) => {
						const top = border === "top" && leaf.top === tree.top;
						const bottom =
							border === "bottom" &&
							leaf.top + leaf.height === tree.top + tree.height;
						return [
							leaf.paneId,
							100 + Number(leaf.paneId.slice(1)),
							leaf.left,
							leaf.top + Number(top),
							leaf.width,
							leaf.height - Number(top || bottom),
							`/session${leaf.paneId}`,
						].join("\t");
					})
					.join("\n");
			assert.equal(args[0], "resize-pane");
			index++;
			return "";
		},
	};
	return { tmux, calls };
}

for (const border of ["top", "bottom"])
	test(`column balances usable heights with ${border} border status`, async () => {
		const children =
			border === "top"
				? [
						"80x12,0,0,1,80x4,0,13,2,80x5,0,18,3",
						"80x8,0,0,1,80x8,0,9,2,80x5,0,18,3",
						"80x8,0,0,1,80x7,0,9,2,80x6,0,17,3",
					]
				: [
						"80x12,0,0,1,80x4,0,13,2,80x5,0,18,3",
						"80x7,0,0,1,80x9,0,8,2,80x5,0,18,3",
						"80x7,0,0,1,80x7,0,8,2,80x7,0,16,3",
					];
		const f = snapshots(
			children.map((cells) => `80x23,0,0[${cells}]`),
			["%1", "%2", "%3"],
			border,
		);
		await balancePaneColumn(f.tmux, ["%1", "%2", "%3"]);
		assert.deepEqual(
			f.calls.filter((args) => args[0] === "resize-pane"),
			[
				["resize-pane", "-t", "%1", "-y", "7"],
				["resize-pane", "-t", "%2", "-y", "7"],
			],
		);
	});

test("column growth preserves a bottom border donor minimum", async () => {
	const f = snapshots(
		[
			"80x25,0,0[80x1,0,0,1,80x1,0,2,2,80x21,0,4,3]",
			"80x25,0,0[80x8,0,0,1,80x1,0,9,2,80x14,0,11,3]",
			"80x25,0,0[80x8,0,0,1,80x7,0,9,2,80x8,0,17,3]",
		],
		["%1", "%2", "%3"],
		"bottom",
	);
	await balancePaneColumn(f.tmux, ["%1", "%2", "%3"]);
	assert.deepEqual(
		f.calls.filter((args) => args[0] === "resize-pane"),
		[
			["resize-pane", "-t", "%1", "-y", "8"],
			["resize-pane", "-t", "%2", "-y", "7"],
		],
	);
});

test("nested row stays fixed while the following owned group grows", async () => {
	const prefix =
		"120x40,0,0{39x40,0,0,0,80x40,40,0[80x17,40,0{39x17,40,0,1,40x17,80,0,4},";
	const f = snapshots(
		[
			`${prefix}80x2,40,18,2,80x19,40,21,3]}`,
			`${prefix}80x11,40,18,2,80x10,40,30,3]}`,
		],
		["%1", "%2", "%3"],
	);
	await balancePaneColumn(f.tmux, ["%1", "%2", "%3"]);
	assert.deepEqual(
		f.calls.filter((args) => args[0] === "resize-pane"),
		[["resize-pane", "-t", "%2", "-y", "11"]],
	);
});

test("owned groups on either side of a nested row balance without crossing it", async () => {
	const row = "80x8,0,22{39x8,0,22,3,40x8,40,22,6}";
	const f = snapshots(
		[
			`80x52,0,0[80x1,0,0,1,80x19,0,2,2,${row},80x18,0,31,4,80x2,0,50,5]`,
			`80x52,0,0[80x10,0,0,1,80x10,0,11,2,${row},80x18,0,31,4,80x2,0,50,5]`,
			`80x52,0,0[80x10,0,0,1,80x10,0,11,2,${row},80x10,0,31,4,80x10,0,42,5]`,
		],
		["%1", "%2", "%3", "%4", "%5"],
	);
	await balancePaneColumn(f.tmux, ["%1", "%2", "%3", "%4", "%5"]);
	assert.deepEqual(
		f.calls.filter((args) => args[0] === "resize-pane"),
		[
			["resize-pane", "-t", "%1", "-y", "10"],
			["resize-pane", "-t", "%4", "-y", "10"],
		],
	);
});

for (const mutation of ["nested pid", "nested session", "nested layout"])
	test(`nested group rejects changed ${mutation} before its second resize`, async () => {
		const row = "80x8,0,22{39x8,0,22,3,40x8,40,22,6}";
		const f = snapshots(
			[
				`80x52,0,0[80x1,0,0,1,80x19,0,2,2,${row},80x18,0,31,4,80x2,0,50,5]`,
				`80x52,0,0[80x10,0,0,1,80x10,0,11,2,${row},80x18,0,31,4,80x2,0,50,5]`,
			],
			["%1", "%2", "%3", "%4", "%5"],
		);
		const run = f.tmux.run;
		let resized = false;
		f.tmux.run = async (args) => {
			let output = await run(args);
			if (args[0] === "resize-pane") resized = true;
			if (resized && args[0] === "list-panes") {
				if (mutation === "nested pid")
					output = output.replace("%6\t106", "%6\t999");
				if (mutation === "nested session")
					output = output.replace("/session%6", "/replacement");
			}
			if (
				resized &&
				args[0] === "display-message" &&
				mutation === "nested layout"
			)
				output = tmuxLayout(
					output
						.slice(5)
						.replace("39x8,0,22,3,40x8,40,22,6", "38x8,0,22,3,41x8,39,22,6"),
				);
			return output;
		};
		await assert.rejects(
			balancePaneColumn(f.tmux, ["%1", "%2", "%3", "%4", "%5"]),
			/did not preserve|does not match/,
		);
		assert.equal(f.calls.filter((args) => args[0] === "resize-pane").length, 1);
	});

for (const border of ["", "bogus", "top\nbottom"])
	test(`invalid border option fails before resizing: ${JSON.stringify(border)}`, async () => {
		const f = fixture();
		f.state.border = border;
		await assert.rejects(
			balancePaneColumn(f.tmux, ["%3", "%4", "%5"]),
			/Invalid tmux pane-border-status/,
		);
		assert.equal(f.calls.filter((args) => args[0] === "resize-pane").length, 0);
	});

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
	assert.deepEqual(
		f.calls.find((args) => args[0] === "show-options"),
		["show-options", "-A", "-w", "-v", "-t", "%5", "pane-border-status"],
	);
	assert.deepEqual(f.calls.at(-1), [
		"display-message",
		"-p",
		"-t",
		"%5",
		"#{window_layout}",
	]);
	assert.equal(f.calls.filter((args) => args[0] === "list-panes").length, 4);
});

test("column balance permits unrelated empty panes", async () => {
	const f = fixture();
	for (const key of ["before", "middle", "after"] as const)
		f.state[key] = f.state[key].replace("%1\t101\t", "%1\t0\t");
	await balancePaneColumn(f.tmux, ["%3", "%4", "%5"]);
	assert.equal(f.calls.filter((args) => args[0] === "resize-pane").length, 2);
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
		/tree does not match pane geometry/,
	],
	[
		"gap",
		(text: string) => text.replace("%4\t104\t151\t31", "%4\t104\t151\t32"),
		/tree does not match pane geometry/,
	],
	[
		"unrelated overlapping pane",
		(text: string) => `${text}%6\t106\t151\t61\t89\t10\t/human\n`,
		/tree does not match pane geometry/,
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
			/identity mismatch|tree does not match pane geometry/,
		);
	});

for (const [label, from, to] of [
	["respawn", "%4\t104", "%4\t999"],
	["session change", "/two", "/replacement"],
] as const)
	test(`column stops before the second resize after target ${label}`, async () => {
		const f = fixture();
		f.state.middle = f.state.middle.replace(from, to);
		f.state.after = f.state.after.replace(from, to);
		await assert.rejects(
			balancePaneColumn(f.tmux, ["%3", "%4", "%5"]),
			/identity mismatch/,
		);
		assert.deepEqual(
			f.calls.filter((args) => args[0] === "resize-pane"),
			[["resize-pane", "-t", "%3", "-y", "20"]],
		);
	});

test("column growth predicts intermediate space taken from later siblings", async () => {
	const f = fixture();
	f.state.before = f.state.before
		.replace("%3\t103\t151\t0\t89\t30", "%3\t103\t151\t0\t89\t1")
		.replace("%4\t104\t151\t31\t89\t14", "%4\t104\t151\t2\t89\t1")
		.replace("%5\t105\t151\t46\t89\t14", "%5\t105\t151\t4\t89\t56");
	f.state.middle = f.state.middle
		.replace("%4\t104\t151\t21\t89\t24", "%4\t104\t151\t21\t89\t1")
		.replace("%5\t105\t151\t46\t89\t14", "%5\t105\t151\t23\t89\t37");
	f.state.layouts[0] = tmuxLayout(
		"240x60,0,0{60x60,0,0[60x30,0,0,1,60x29,0,31,2],89x60,61,0,0,89x60,151,0[89x1,151,0,3,89x1,151,2,4,89x56,151,4,5]}",
	);
	f.state.layouts[1] = tmuxLayout(
		"240x60,0,0{60x60,0,0[60x30,0,0,1,60x29,0,31,2],89x60,61,0,0,89x60,151,0[89x20,151,0,3,89x1,151,21,4,89x37,151,23,5]}",
	);
	await balancePaneColumn(f.tmux, ["%3", "%4", "%5"]);
	assert.equal(f.calls.filter((args) => args[0] === "resize-pane").length, 2);
});

test("column stops before the second resize if an intermediate boundary changes", async () => {
	const f = fixture();
	f.state.middle = f.state.middle
		.replace("%4\t104\t151\t21\t89\t24", "%4\t104\t151\t21\t89\t23")
		.replace("%5\t105\t151\t46\t89\t14", "%5\t105\t151\t45\t89\t15");
	f.state.layouts[1] = tmuxLayout(
		"240x60,0,0{60x60,0,0[60x30,0,0,1,60x29,0,31,2],89x60,61,0,0,89x60,151,0[89x20,151,0,3,89x23,151,21,4,89x15,151,45,5]}",
	);
	await assert.rejects(
		balancePaneColumn(f.tmux, ["%3", "%4", "%5"]),
		/did not preserve/,
	);
	assert.equal(f.calls.filter((args) => args[0] === "resize-pane").length, 1);
});
