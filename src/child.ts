import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Deliverer, Item, Source } from "./delivery.ts";
import { processAlive } from "./process.ts";
import * as queue from "./queue.ts";
import {
	ChildEntry,
	ChildStatus,
	Fatal,
	OpenQuestion,
	parseStrict,
	RunSpec,
	readJsonStrict,
	writeJsonAtomic,
} from "./schema.ts";
import { afterMarker, lastAssistant } from "./session-file.ts";

export interface ExitState {
	autoExit: boolean;
	human: boolean;
	orphaned: boolean;
	exiting: boolean;
	fatal: boolean;
	stopReason: AssistantMessage["stopReason"] | undefined;
	inboxCount: number;
	offeredCount: number;
	nestedRunCount: number;
	waiterCount: number;
	pendingMessages: boolean;
}
export function canExit(state: ExitState): boolean {
	return (
		state.autoExit &&
		!state.human &&
		!state.orphaned &&
		!state.exiting &&
		!state.fatal &&
		(state.stopReason === "stop" ||
			state.stopReason === "length" ||
			state.stopReason === "error") &&
		state.inboxCount === 0 &&
		state.offeredCount === 0 &&
		state.nestedRunCount === 0 &&
		state.waiterCount === 0 &&
		!state.pendingMessages
	);
}

export interface ChildRuntime {
	sources: Source[];
	runs: ReadonlyMap<string, unknown>;
	deliverer: Pick<Deliverer, "pump" | "reconcile" | "offeredCount"> | undefined;
}
type QuestionResult = {
	content: { type: "text"; text: string }[];
	details: { deliveryId: string; qid: string };
};
type Waiter = {
	state: "open" | "answered" | "withdrawn" | "disposed";
	answer(deliveryId: string, text: string): void;
	dispose(): void;
};

export class ChildStartup {
	readonly ctx: ExtensionContext;
	runDir: string | undefined;
	spec: RunSpec | undefined;
	fatal: string | undefined;
	constructor(ctx: ExtensionContext, path: string) {
		this.ctx = ctx;
		try {
			this.runDir = realpathSync(path);
			const spec = readJsonStrict(RunSpec, join(this.runDir, "spec.json"));
			if (spec.runId !== basename(this.runDir))
				throw new Error(`Run identity does not match ${this.runDir}.`);
			const file = ctx.sessionManager.getSessionFile();
			if (
				file === undefined ||
				realpathSync(file) !== spec.launch.childSessionFile
			)
				throw new Error(
					"This subagent session does not match its run specification.",
				);
			this.spec = spec;
		} catch (error) {
			this.fail(error);
		}
	}
	fail(error: unknown): void {
		if (this.fatal !== undefined) return;
		this.fatal = error instanceof Error ? error.message : String(error);
		if (this.runDir !== undefined)
			writeJsonAtomic(
				join(this.runDir, "fatal.json"),
				parseStrict(Fatal, { v: 1, message: this.fatal }, "child fatal"),
			);
		this.ctx.ui.notify(this.fatal, "error");
		this.ctx.shutdown();
	}
	onInput(): { action: "handled" } | undefined {
		if (this.fatal !== undefined) return { action: "handled" };
	}
	onToolCall(): { block: true; reason: string } | undefined {
		if (this.fatal !== undefined) return { block: true, reason: this.fatal };
	}
}
export function preflightChild(
	ctx: ExtensionContext,
	path: string,
): ChildStartup {
	return new ChildStartup(ctx, path);
}

class ChildRole {
	private readonly pi: ExtensionAPI;
	private readonly ctx: ExtensionContext;
	private readonly runtime: ChildRuntime;
	private runDir: string | undefined;
	private spec: RunSpec | undefined;
	private readonly waiters = new Map<string, Waiter>();
	private readonly startup: ChildStartup;
	private get fatal(): string | undefined {
		return this.startup.fatal;
	}
	private disposed = false;
	private orphaned = false;
	private exiting = false;
	private initialSeen = false;
	private interrupted = false;
	private human = false;
	private state: ChildStatus["state"] = "starting";
	private contextTokens: number | null = null;
	private pumpTimer: ReturnType<typeof setInterval> | undefined;
	private ownerTimer: ReturnType<typeof setInterval> | undefined;
	constructor(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		runtime: ChildRuntime,
		path: string | ChildStartup,
	) {
		this.pi = pi;
		this.ctx = ctx;
		this.runtime = runtime;
		this.startup = typeof path === "string" ? preflightChild(ctx, path) : path;
		this.runDir = this.startup.runDir;
		this.spec = this.startup.spec;
		if (this.fatal !== undefined) return;
		try {
			this.registerQuestion();
			this.selfCheck();
		} catch (error) {
			this.startup.fail(error);
			return;
		}
		const { spec, runDir } = this.ready();
		if (afterMarker(ctx.sessionManager.getBranch(), spec.runId) === undefined)
			this.append({
				v: 1,
				kind: "run",
				runId: spec.runId,
				name: spec.launch.name,
				sessionId: ctx.sessionManager.getSessionId(),
			});
		const branch = afterMarker(ctx.sessionManager.getBranch(), spec.runId);
		if (branch === undefined)
			throw new Error(`Missing run marker ${spec.runId}.`);
		this.initialSeen = branch.some(
			(entry) => entry.type === "message" && entry.message.role === "user",
		);
		for (const entry of branch) {
			if (entry.type !== "custom" || entry.customType !== "subagent_child")
				continue;
			const data = parseStrict(ChildEntry, entry.data, "child entry");
			if (data.runId === spec.runId && data.kind === "human") this.human = true;
		}
		for (const name of readdirSync(join(runDir, "questions")).filter(
			(name) => !name.startsWith("."),
		)) {
			if (!/^q-[0-9a-f]{8}\.json$/.test(name))
				throw new Error(`Unexpected question file ${name}.`);
			const file = join(runDir, "questions", name);
			const question = readJsonStrict(OpenQuestion, file);
			if (`${question.qid}.json` !== name)
				throw new Error(`Question identity does not match ${file}.`);
			unlinkSync(file);
			queue.put(join(runDir, "outbox"), "outbox", {
				v: 1,
				kind: "withdrawn",
				qid: question.qid,
			});
		}
		this.statusBar();
		this.writeStatus();
		runtime.sources.push(this.inboxSource());
		this.deliverer().reconcile();
		this.pumpTimer = setInterval(() => this.deliverer().pump(), 250);
		this.ownerTimer = setInterval(() => this.checkOwner(), 2000);
	}
	private ready(): { spec: RunSpec; runDir: string } {
		if (this.spec === undefined || this.runDir === undefined)
			throw new Error("The subagent did not start.");
		return { spec: this.spec, runDir: this.runDir };
	}
	private deliverer() {
		if (this.runtime.deliverer === undefined)
			throw new Error("The subagent runtime has no Deliverer.");
		return this.runtime.deliverer;
	}
	private selfCheck(): void {
		const { spec } = this.ready();
		const { launch } = spec;
		const active = new Set(this.pi.getActiveTools());
		for (const tool of launch.tools)
			if (!active.has(tool))
				throw new Error(`Tool "${tool}" is not active in this subagent.`);
		const model = this.ctx.model;
		if (
			model?.provider !== launch.model.provider ||
			model.id !== launch.model.id
		)
			throw new Error(
				`This subagent runs model ${model === undefined ? "undefined" : `${model.provider}/${model.id}`}, but its profile chose ${launch.model.provider}/${launch.model.id}.`,
			);
		const thinking = this.pi.getThinkingLevel();
		if (thinking !== launch.thinking)
			throw new Error(
				`This subagent runs thinking level ${thinking}, but its profile chose ${launch.thinking}.`,
			);
		if (!this.ctx.getSystemPrompt().includes(`Subagent run ${spec.runId}.`))
			throw new Error("The system prompt file of this subagent was not read.");
	}
	private append(data: ChildEntry): void {
		this.pi.appendEntry(
			"subagent_child",
			parseStrict(ChildEntry, data, "child entry"),
		);
	}
	private statusBar(): void {
		const { spec } = this.ready();
		this.ctx.ui.setStatus(
			"subagent",
			`subagent ${spec.launch.name} · auto-exit ${spec.launch.autoExit && !this.human && !this.orphaned ? "on" : "off"}`,
		);
	}
	private writeStatus(): void {
		const { runDir } = this.ready();
		writeJsonAtomic(
			join(runDir, "status.json"),
			parseStrict(
				ChildStatus,
				{
					v: 1,
					state: this.waiters.size > 0 ? "waiting" : this.state,
					question: this.waiters.size > 0,
					human: this.human,
					contextTokens: this.contextTokens,
					updatedAt: Date.now(),
				},
				"child status",
			),
		);
	}
	private inboxSource(): Source {
		const { spec, runDir } = this.ready();
		const inbox = join(runDir, "inbox");
		return {
			key: `${spec.runId}:inbox`,
			items: () =>
				this.disposed ||
				this.fatal !== undefined ||
				this.orphaned ||
				this.exiting
					? []
					: queue.list(inbox, "inbox").map(({ seq }) => ({
							id: queue.itemId(spec.runId, "inbox", seq),
						})),
			build: (item: Item) => {
				const entry = queue
					.list(inbox, "inbox")
					.find(
						({ seq }) => queue.itemId(spec.runId, "inbox", seq) === item.id,
					);
				if (!entry) throw new Error(`Missing inbox item ${item.id}.`);
				const message = entry.item;
				if (message.kind === "answer") {
					const waiter = this.waiters.get(message.qid);
					if (waiter)
						return {
							kind: "answer",
							text: message.text,
							resolve: waiter.answer,
						};
				}
				return {
					kind: "message",
					trigger: true,
					message: {
						customType: "subagent_parent_message",
						display: true,
						content:
							message.kind === "answer"
								? `Answer from the parent agent to question ${message.qid}, which you withdrew:\n\n${message.text}`
								: `Message from the parent agent:\n\n${message.text}`,
						details: {
							deliveryId: item.id,
							kind: message.kind,
							...(message.kind === "answer" ? { qid: message.qid } : {}),
						},
					},
				};
			},
			confirm: (item: Item) => {
				const prefix = `${spec.runId}:inbox:`;
				if (!item.id.startsWith(prefix))
					throw new Error(`Invalid inbox item ${item.id}.`);
				queue.deleteConsumed(inbox, item.id.slice(prefix.length));
			},
		};
	}
	private registerQuestion(): void {
		this.pi.registerTool({
			name: "ask_question",
			label: "Ask parent",
			description: "Ask the parent agent a question and wait for the answer.",
			promptGuidelines: [
				"Use ask_question only when you cannot continue without a decision from the parent agent.",
			],
			parameters: Type.Object(
				{ question: Type.String({ minLength: 1 }) },
				{ additionalProperties: false },
			),
			execute: (toolCallId, { question }, signal) =>
				this.askQuestion(toolCallId, question, signal),
		});
	}
	private async askQuestion(
		toolCallId: string,
		question: string,
		signal?: AbortSignal,
	): Promise<QuestionResult> {
		if (this.fatal !== undefined) throw new Error(this.fatal);
		if (this.disposed || this.exiting)
			throw new Error("The subagent runtime stopped.");
		if (this.orphaned)
			throw new Error("ask_question works only inside a subagent.");
		if (signal?.aborted)
			throw new Error("The question was cancelled before it was sent.");
		const { runDir } = this.ready();
		const qid = `q-${randomBytes(4).toString("hex")}`;
		const file = join(runDir, "questions", `${qid}.json`);
		if (this.waiters.has(qid) || existsSync(file))
			throw new Error(`Question ${qid} already exists.`);
		writeJsonAtomic(
			file,
			parseStrict(
				OpenQuestion,
				{ v: 1, qid, text: question, toolCallId, askedAt: Date.now() },
				"open question",
			),
		);
		queue.put(join(runDir, "outbox"), "outbox", {
			v: 1,
			kind: "question",
			qid,
			text: question,
		});
		this.state = "working";
		return await new Promise<QuestionResult>((resolve, reject) => {
			const close = (state: "answered" | "withdrawn" | "disposed") => {
				if (waiter.state !== "open")
					throw new Error(`Question ${qid} is already ${waiter.state}.`);
				waiter.state = state;
				signal?.removeEventListener("abort", onAbort);
				this.waiters.delete(qid);
				unlinkSync(file);
				this.writeStatus();
			};
			const onAbort = () => {
				if (waiter.state !== "open") return;
				this.interrupted = true;
				close("withdrawn");
				queue.put(join(runDir, "outbox"), "outbox", {
					v: 1,
					kind: "withdrawn",
					qid,
				});
				reject(new Error(`Question ${qid} was withdrawn.`));
			};
			const waiter: Waiter = {
				state: "open",
				answer: (deliveryId, text) => {
					close("answered");
					resolve({
						content: [{ type: "text", text }],
						details: { deliveryId, qid },
					});
				},
				dispose: () => {
					close("disposed");
					reject(new Error("The subagent runtime stopped."));
				},
			};
			this.waiters.set(qid, waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
			this.writeStatus();
		});
	}
	onInput(
		event: Pick<InputEvent, "source" | "text">,
	): { action: "handled" } | undefined {
		if (this.fatal !== undefined) return { action: "handled" };
		if (
			this.disposed ||
			this.orphaned ||
			this.exiting ||
			event.source !== "interactive"
		)
			return;
		const { spec } = this.ready();
		if (!this.initialSeen && event.text === spec.initialPrompt) {
			this.initialSeen = true;
			return;
		}
		if (!this.human) {
			this.human = true;
			this.append({ v: 1, kind: "human", runId: spec.runId });
			if (!this.initialSeen)
				this.ctx.ui.notify(
					"The first input of this subagent was not its task. Auto-exit is off.",
					"error",
				);
			this.statusBar();
			this.writeStatus();
		}
	}
	onToolCall(): { block: true; reason: string } | undefined {
		if (this.fatal !== undefined) return { block: true, reason: this.fatal };
	}
	onAgentStart(): void {
		if (!this.active()) return;
		this.interrupted = false;
		this.state = "working";
		this.writeStatus();
	}
	onMessageEnd(event: { message: { role: string } }): void {
		if (!this.active() || event.message.role !== "assistant") return;
		this.contextTokens = this.ctx.getContextUsage()?.tokens ?? null;
		this.writeStatus();
	}
	// Call this after Deliverer.onAgentSettled, before its scheduled pump.
	onAgentSettled(): void {
		if (!this.active()) return;
		const { spec, runDir } = this.ready();
		const branch = afterMarker(this.ctx.sessionManager.getBranch(), spec.runId);
		const last = branch === undefined ? undefined : lastAssistant(branch);
		if (
			canExit({
				autoExit: spec.launch.autoExit,
				human: this.human,
				orphaned: this.orphaned,
				exiting: this.exiting,
				fatal: this.fatal !== undefined,
				// Pi can report an abort during a tool call as a provider error.
				stopReason: this.interrupted ? "aborted" : last?.stopReason,
				inboxCount: queue.count(join(runDir, "inbox")),
				offeredCount: this.deliverer().offeredCount,
				nestedRunCount: this.runtime.runs.size,
				waiterCount: this.waiters.size,
				pendingMessages: this.ctx.hasPendingMessages(),
			})
		) {
			this.exiting = true;
			this.stopTimers();
			this.ctx.shutdown();
			return;
		}
		this.state = "waiting";
		this.writeStatus();
	}
	onBeforeSwitch(): { cancel: true } {
		return this.guardSession();
	}
	onBeforeFork(): { cancel: true } {
		return this.guardSession();
	}
	private guardSession(): { cancel: true } {
		this.ctx.ui.notify(
			"This pane is a subagent. Pi cannot switch or fork its session.",
			"error",
		);
		return { cancel: true };
	}
	onTree(): void {
		if (!this.active()) return;
		this.append({ v: 1, kind: "leaf", runId: this.ready().spec.runId });
	}
	private active(): boolean {
		return (
			!this.disposed &&
			!this.orphaned &&
			!this.exiting &&
			this.fatal === undefined
		);
	}
	private checkOwner(): void {
		const { spec, runDir } = this.ready();
		if (!processAlive(spec.owner)) {
			this.orphaned = true;
			this.stopTimers();
			this.statusBar();
			this.ctx.ui.notify(
				`The parent Pi process ended without a quit. This pane is now a normal Pi session. Its result is not delivered. Session: ${spec.launch.childSessionFile}`,
				"error",
			);
			return;
		}
		if (realpathSync(runDir) !== runDir)
			throw new Error(`The subagent run directory changed: ${runDir}.`);
	}
	private stopTimers(): void {
		if (this.pumpTimer !== undefined) clearInterval(this.pumpTimer);
		if (this.ownerTimer !== undefined) clearInterval(this.ownerTimer);
		this.pumpTimer = undefined;
		this.ownerTimer = undefined;
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stopTimers();
		for (const waiter of this.waiters.values()) waiter.dispose();
	}
}

// Call this only from session_start. The factory owns shared Deliverer events.
export function installChildRole(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: ChildRuntime,
	runDir: string | ChildStartup,
): ChildRole {
	return new ChildRole(pi, ctx, runtime, runDir);
}
