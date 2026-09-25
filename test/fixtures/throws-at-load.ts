import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function throwsAtLoad(_pi: ExtensionAPI): void {
	throw new Error("Test extension failed at load.");
}
