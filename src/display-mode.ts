import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type DisplayMode, DisplayModeEntry, parseStrict } from "./schema.ts";

export type { DisplayMode } from "./schema.ts";
export type BackendKind = "pane" | "widget";

export function readDisplayMode(branch: SessionEntry[]): DisplayMode {
	let mode: DisplayMode = "auto";
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== "subagent_display_mode")
			continue;
		mode = parseStrict(
			DisplayModeEntry,
			entry.data,
			`display mode ${entry.id}`,
		).mode;
	}
	return mode;
}

export function resolveDisplayMode(
	mode: DisplayMode,
	inTmux: boolean,
): BackendKind {
	switch (mode) {
		case "auto":
			return inTmux ? "pane" : "widget";
		case "panes":
			if (!inTmux)
				throw new Error("Subagent panes need Pi to run inside tmux.");
			return "pane";
		case "widget":
			return "widget";
		default:
			throw new Error(`Unknown subagent display mode: ${mode}.`);
	}
}
