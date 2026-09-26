import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readDisplayMode, resolveDisplayMode } from "../../src/display-mode.ts";

test("auto selects panes in tmux and widget outside tmux", () => {
	assert.equal(resolveDisplayMode("auto", true), "pane");
	assert.equal(resolveDisplayMode("auto", false), "widget");
	assert.equal(resolveDisplayMode("widget", true), "widget");
});

test("an explicit pane choice outside tmux fails", () => {
	assert.throws(
		() => resolveDisplayMode("panes", false),
		/Subagent panes need Pi to run inside tmux/,
	);
});

test("the latest display mode entry on this branch wins", () => {
	const manager = SessionManager.inMemory("/tmp");
	assert.equal(readDisplayMode(manager.getBranch()), "auto");
	manager.appendCustomEntry("subagent_display_mode", { v: 1, mode: "widget" });
	manager.appendCustomEntry("subagent_display_mode", { v: 1, mode: "panes" });
	assert.equal(readDisplayMode(manager.getBranch()), "panes");
});

test("an invalid display mode record fails loudly", () => {
	const manager = SessionManager.inMemory("/tmp");
	manager.appendCustomEntry("subagent_display_mode", { v: 1, mode: "other" });
	assert.throws(() => readDisplayMode(manager.getBranch()), /display mode/);
});
