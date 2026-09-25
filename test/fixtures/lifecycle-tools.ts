import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function lifecycleTools(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		pi.appendEntry("lifecycle_extension_loaded", { loaded: true });
	});
	pi.registerTool({
		name: "lifecycle_probe",
		label: "Lifecycle probe",
		description: "Report the actual active tools and process arguments.",
		parameters: Type.Object({}),
		async execute() {
			const details = {
				active: pi.getActiveTools(),
				argv: process.argv,
				loaded: true,
			};
			return {
				content: [{ type: "text", text: JSON.stringify(details) }],
				details,
			};
		},
	});
	pi.registerTool({
		name: "lifecycle_omitted",
		label: "Omitted lifecycle tool",
		description: "This tool must not be active in the test child.",
		parameters: Type.Object({}),
		async execute() {
			throw new Error("The omitted tool executed.");
		},
	});
}
