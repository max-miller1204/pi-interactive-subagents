import { existsSync } from "node:fs";
import type {
	AgentBeforeSettleEvent,
	BoundaryResult,
	ExtensionAPI,
	ExtensionContext,
	SessionBoundaryDraft,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { RegistryRecord } from "./schema.ts";

export type Item = { id: string };
export type RegistryDraft = { customType: "subagent"; data: RegistryRecord };
export type Outgoing =
	| {
			kind: "message";
			message: {
				customType: string;
				content: string;
				display: true;
				details: { deliveryId: string } & object;
			};
			trigger: boolean;
	  }
	| {
			kind: "answer";
			text: string;
			resolve: (deliveryId: string, text: string) => void;
	  };
export interface Source {
	key: string;
	items(): Item[];
	build(item: Item): Outgoing | "drop";
	prelude?(item: Item): RegistryDraft[];
	confirm(item: Item): void;
}

export class Deliverer {
	private readonly offered = new Set<string>();
	private readonly held = new Set<string>();
	private promptStarting: { since: number } | null = null;
	private runActive: boolean;
	private taskStarted = false;
	private broken: Error | undefined;
	private disposed = false;
	private readonly pi: ExtensionAPI;
	private readonly ctx: ExtensionContext;
	private readonly sources: Source[];
	private readonly isDisposed: () => boolean;
	private readonly child: boolean;
	constructor(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		sources: Source[],
		isDisposed: () => boolean,
		child: boolean,
	) {
		this.pi = pi;
		this.ctx = ctx;
		this.sources = sources;
		this.isDisposed = isDisposed;
		this.child = child;
		this.runActive = !ctx.isIdle();
	}
	get offeredCount(): number {
		return this.offered.size;
	}
	view(
		now: number,
	): Readonly<{ promptBlocked: boolean; brokenError: string | null }> {
		return {
			promptBlocked:
				!this.disposed &&
				this.promptStarting !== null &&
				now - this.promptStarting.since > 2000 &&
				this.sources.some((source) =>
					source.items().some((item) => !this.offered.has(item.id)),
				),
			brokenError: this.broken?.message ?? null,
		};
	}
	private sessionIds(): { inSession: Set<string>; durable: boolean } {
		const inSession = new Set<string>();
		if (this.sources.some((source) => source.items().length > 0)) {
			for (const entry of this.ctx.sessionManager.getEntries()) {
				const details =
					entry.type === "custom_message"
						? entry.details
						: entry.type === "message" && entry.message.role === "toolResult"
							? entry.message.details
							: undefined;
				if (
					details !== null &&
					typeof details === "object" &&
					"deliveryId" in details &&
					typeof details.deliveryId === "string"
				)
					inSession.add(details.deliveryId);
			}
		}
		const file = this.ctx.sessionManager.getSessionFile();
		return { inSession, durable: file !== undefined && existsSync(file) };
	}
	reconcile(): void {
		const { inSession, durable } = this.sessionIds();
		for (const source of this.sources)
			for (const item of source.items()) {
				if (!inSession.has(item.id)) continue;
				if (durable) {
					source.confirm(item);
					this.offered.delete(item.id);
					this.held.delete(item.id);
				} else this.offered.add(item.id);
			}
	}
	private mode(): "run" | "idle" | "busy" {
		if (this.promptStarting) return "busy";
		if (this.runActive) return "run";
		if (!this.ctx.isIdle() || (this.child && !this.taskStarted)) return "busy";
		return "idle";
	}
	pump(): void {
		if (this.disposed || this.isDisposed()) return;
		if (this.broken) throw this.broken;
		this.reconcile();
		if (
			this.promptStarting &&
			this.ctx.isIdle() &&
			Date.now() - this.promptStarting.since > 30_000
		)
			this.promptStarting = null;
		const mode = this.mode();
		let started = false;
		for (const source of this.sources)
			for (const item of source.items()) {
				if (this.offered.has(item.id)) continue;
				const out = source.build(item);
				if (out === "drop") {
					source.confirm(item);
					this.held.delete(item.id);
					continue;
				}
				if (out.kind === "answer") {
					this.offered.add(item.id);
					out.resolve(item.id, out.text);
					continue;
				}
				if (mode !== "idle" || started) break;
				for (const draft of source.prelude?.(item) ?? [])
					this.pi.appendEntry(draft.customType, draft.data);
				this.offered.add(item.id);
				if (out.trigger && !this.held.has(item.id)) {
					this.pi.sendMessage(out.message, { triggerTurn: true });
					started = true;
				} else {
					this.pi.sendMessage(out.message, { triggerTurn: false });
					if (!this.sessionIds().inSession.has(item.id)) {
						this.broken = new Error(
							`Pi did not append subagent message ${item.id}.`,
						);
						throw this.broken;
					}
				}
			}
	}
	onInput(): void {
		this.promptStarting = { since: Date.now() };
	}
	onAgentStart(): void {
		this.runActive = true;
		this.promptStarting = null;
		this.taskStarted = true;
	}
	onBoundary(
		event: Pick<TurnEndEvent | AgentBeforeSettleEvent, "outcome">,
	): BoundaryResult | undefined {
		if (this.disposed || this.isDisposed() || event.outcome !== "completed")
			return;
		this.reconcile();
		const entries: SessionBoundaryDraft[] = [];
		let cont = false;
		for (const source of this.sources)
			for (const item of source.items()) {
				if (this.offered.has(item.id)) continue;
				const out = source.build(item);
				if (out === "drop") {
					source.confirm(item);
					this.held.delete(item.id);
					continue;
				}
				if (out.kind === "answer") continue;
				for (const draft of source.prelude?.(item) ?? [])
					entries.push({
						type: "custom",
						customType: draft.customType,
						data: draft.data,
					});
				entries.push({ type: "custom_message", ...out.message });
				this.offered.add(item.id);
				if (out.trigger && !this.held.has(item.id)) cont = true;
			}
		return entries.length ? { entries, continue: cont } : undefined;
	}
	onAgentSettled(): void {
		if (this.disposed || this.isDisposed()) return;
		this.reconcile();
		const { inSession } = this.sessionIds();
		for (const id of this.offered)
			if (!inSession.has(id)) this.offered.delete(id);
		const lastAssistant = this.ctx.sessionManager
			.getBranch()
			.filter(
				(entry) =>
					entry.type === "message" && entry.message.role === "assistant",
			)
			.at(-1);
		if (
			lastAssistant?.type === "message" &&
			lastAssistant.message.role === "assistant" &&
			lastAssistant.message.stopReason === "aborted"
		) {
			for (const source of this.sources)
				for (const item of source.items())
					if (!this.offered.has(item.id)) this.held.add(item.id);
		}
		this.runActive = false;
		setImmediate(() => {
			if (!this.disposed && !this.isDisposed()) this.pump();
		});
	}
	shutdown(): void {
		this.disposed = true;
		this.reconcile();
	}
}
