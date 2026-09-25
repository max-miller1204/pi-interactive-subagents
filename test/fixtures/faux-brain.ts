import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
	type JsonObject,
	type Message,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Call = { call: string; args: JsonObject };
export type Step =
	| { say: string }
	| Call
	| { calls: Call[] }
	| { error: string }
	| { exit: number }
	| { hang: true };

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function json(value: unknown): boolean {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value)) ||
		(Array.isArray(value) && value.every(json)) ||
		(object(value) && Object.values(value).every(json))
	);
}
function validCall(value: unknown): value is Call {
	return (
		object(value) &&
		Object.keys(value).sort().join() === "args,call" &&
		typeof value.call === "string" &&
		object(value.args) &&
		json(value.args)
	);
}
function validStep(value: unknown): value is Step {
	if (!object(value)) return false;
	const keys = Object.keys(value).sort().join();
	return (
		(keys === "say" && typeof value.say === "string") ||
		(keys === "args,call" && validCall(value)) ||
		(keys === "calls" &&
			Array.isArray(value.calls) &&
			value.calls.length > 0 &&
			value.calls.every(validCall)) ||
		(keys === "error" && typeof value.error === "string") ||
		(keys === "exit" && Number.isInteger(value.exit)) ||
		(keys === "hang" && value.hang === true)
	);
}
function text(message: Message): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export function scriptStep(messages: Message[]): Step {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "user") continue;
		const match = text(message)
			.split("\n")
			.find((line) => line.startsWith("#script "));
		if (match === undefined) continue;
		const stepIndex = messages
			.slice(index + 1)
			.filter((entry) => entry.role === "assistant").length;
		const where = `session script at message ${index}, step ${stepIndex}`;
		let steps: unknown;
		try {
			steps = JSON.parse(match.slice(8));
		} catch (error) {
			throw new Error(`${where}: invalid JSON`, { cause: error });
		}
		if (!Array.isArray(steps)) throw new Error(`${where}: expected an array`);
		for (const [position, value] of steps.entries())
			if (!validStep(value))
				throw new Error(
					`session script at message ${index}, step ${position}: invalid step`,
				);
		if (stepIndex >= steps.length) throw new Error(`${where}: missing step`);
		const step: Step = steps[stepIndex];
		return step;
	}
	const last = messages.at(-1);
	if (last === undefined)
		throw new Error("session has no message to acknowledge");
	return { say: `ack: ${text(last).split("\n")[0]}` };
}

function toFauxMessage(
	step: Exclude<Step, { hang: true } | { exit: number }>,
): AssistantMessage {
	if ("say" in step) return fauxAssistantMessage(step.say);
	if ("error" in step)
		return fauxAssistantMessage([], {
			stopReason: "error",
			errorMessage: step.error,
		});
	const calls = "calls" in step ? step.calls : [step];
	return fauxAssistantMessage(
		calls.map(({ call, args }) => fauxToolCall(call, args)),
		{ stopReason: "toolUse" },
	);
}

export default function fauxBrain(pi: ExtensionAPI): void {
	const core = createFauxCore({
		api: "faux",
		provider: "faux",
		models: [{ id: "brain", reasoning: false }],
	});
	pi.registerProvider("faux", {
		api: "faux",
		baseUrl: "http://localhost:0",
		apiKey: "faux",
		models: [
			{
				id: "brain",
				name: "Scripted brain",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
		],
		streamSimple(model, context, options) {
			const step = scriptStep(context.messages);
			if ("exit" in step) process.exit(step.exit);
			const outer = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				try {
					await options?.onPayload?.(
						{ model: model.id, messages: context.messages },
						model,
					);
					if ("hang" in step) {
						if (!options?.signal)
							throw new Error("hang requires an abort signal");
						const signal = options.signal;
						core.setResponses([
							async () => {
								if (!signal.aborted)
									await new Promise<void>((resolve) =>
										signal.addEventListener("abort", () => resolve(), {
											once: true,
										}),
									);
								return fauxAssistantMessage([], { stopReason: "aborted" });
							},
						]);
					} else core.setResponses([toFauxMessage(step)]);
					const inner = core.streamSimple(model, context, options);
					for await (const event of inner) outer.push(event);
					outer.end(await inner.result());
				} catch (error) {
					const message = fauxAssistantMessage([], {
						stopReason: "error",
						errorMessage:
							error instanceof Error ? error.message : String(error),
					});
					outer.push({ type: "error", reason: "error", error: message });
					outer.end(message);
				}
			});
			return outer;
		},
	});
}
