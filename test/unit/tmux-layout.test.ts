import assert from "node:assert/strict";
import { test } from "node:test";
import {
	isolatedColumn,
	layoutPanes,
	parseTmuxLayout,
} from "../../src/tmux-layout.ts";
import { tmuxLayout } from "../fixtures/tmux-layout.ts";

test("strict layout parsing proves the direct vertical child subtree", () => {
	const tree = parseTmuxLayout(
		tmuxLayout(
			"240x60,0,0{120x60,0,0,1,119x60,121,0[119x30,121,0,2,119x29,121,31,3]}",
		),
	);
	assert.deepEqual(
		layoutPanes(tree).map((pane) => pane.paneId),
		["%1", "%2", "%3"],
	);
	const column = isolatedColumn(tree, ["%3", "%2"]);
	assert.equal(column.kind, "vertical");
	assert.equal(column.width, 119);
	assert.equal(column.height, 60);
});

test("aligned panes in separate row subtrees are not an isolated column", () => {
	const tree = parseTmuxLayout(
		tmuxLayout(
			"240x60,0,0[240x30,0,0{120x30,0,0,1,119x30,121,0,2},240x29,0,31{120x29,0,31,3,119x29,121,31,4}]",
		),
	);
	const children = layoutPanes(tree).filter((pane) =>
		["%2", "%4"].includes(pane.paneId),
	);
	assert.equal(children[0]?.left, children[1]?.left);
	assert.equal(children[0]?.width, children[1]?.width);
	assert.throws(
		() => isolatedColumn(tree, ["%2", "%4"]),
		/isolated column subtree/,
	);
});

test("an owned subset cannot resize a column with an unrelated sibling", () => {
	const tree = parseTmuxLayout(
		tmuxLayout("80x32,0,0[80x10,0,0,1,80x10,0,11,2,80x10,0,22,3]"),
	);
	assert.throws(
		() => isolatedColumn(tree, ["%1", "%2"]),
		/isolated column subtree/,
	);
});

for (const body of [
	"80x24,0,0,0garbage",
	"80x24,0,0[80x24,0,0,0]",
	"80x24,0,0[80x12,0,0,0,80x12,0,13,1]",
	"80x24,0,0[80x12,0,0,0,80x11,0,12,1]",
	"80x24,0,0{40x24,0,0,0,39x23,41,0,1}",
	"80x24,0,0[80x12,0,0,0,80x11,0,13,0]",
	"80x24,0,0[80x12,0,0,0,80x11,0,13,1}",
	"0x24,0,0,0",
	"80x24,-1,0,0",
	"80x24,00,0,0",
	"80x24,9007199254740991,0,0",
	"9007199254740992x24,0,0,0",
] as const)
	test(`strict layout rejects ${body}`, () => {
		assert.throws(() => parseTmuxLayout(tmuxLayout(body)), /layout/);
	});

test("layout checksum and trailing output must match exactly", () => {
	assert.throws(() => parseTmuxLayout("zzzz,80x24,0,0,0"), /checksum/);
	assert.throws(() => parseTmuxLayout("0000,80x24,0,0,0"), /checksum/);
	assert.throws(
		() => parseTmuxLayout(`${tmuxLayout("80x24,0,0,0")}\n\n`),
		/checksum/,
	);
	assert.equal(parseTmuxLayout(`${tmuxLayout("80x24,0,0,0")}\n`).kind, "pane");
});
