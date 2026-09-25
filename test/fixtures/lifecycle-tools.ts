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
		parameters: Type.Object({ environment: Type.Optional(Type.Boolean()) }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionFile = ctx.sessionManager.getSessionFile();
			const runArgs = process.argv.filter((word) =>
				word.startsWith("--subagent-run="),
			);
			if (
				sessionFile === undefined ||
				runArgs.length !== 1 ||
				runArgs[0] === undefined
			)
				throw new Error(
					"The lifecycle probe requires a saved child session and one run argument.",
				);
			const runDir = runArgs[0].slice("--subagent-run=".length);
			if (params.environment) {
				const details = {
					pid: process.pid,
					sessionFile,
					runDir,
					tmux: process.env.TMUX,
					tmuxPane: process.env.TMUX_PANE,
					stalePresent: Object.hasOwn(process.env, "STALE"),
				};
				return {
					content: [{ type: "text", text: JSON.stringify(details) }],
					details,
				};
			}
			const details = {
				active: pi.getActiveTools(),
				argv: process.argv,
				loaded: true,
				pid: process.pid,
				sessionFile,
				runDir,
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
