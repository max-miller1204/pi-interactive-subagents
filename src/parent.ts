import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	rmdirSync,
	rmSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type SessionEntry,
	type SessionShutdownEvent,
	type SessionStartEvent,
	type TurnEndEvent,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Deliverer, type Item, type Source } from "./delivery.ts";
import { type LaunchPlan, launchRun, type StartedRun } from "./launch.ts";
import { processAlive, processIdentity } from "./process.ts";
import * as queue from "./queue.ts";
import {
	ChildStatus,
	Fatal,
	type Launch,
	type LaunchDraft,
	MAX_DEPTH,
	OpenQuestion,
	PaneFile,
	type ProcessIdentity,
	parseStrict,
	ResultDetails,
	type ResultStatus,
	RunSpec,
	readJsonStrict,
	UndeliveredRecord,
	writeJsonAtomic,
} from "./schema.ts";
import {
	afterMarker,
	finalText,
	foldRegistry,
	forkEntries,
	lastAssistant,
	parentSessionPath,
	persistedIds,
	readBranch,
} from "./session-file.ts";
import { checkTmuxVersion, type PaneState, type Tmux } from "./tmux.ts";

export function classifyResult(evidence: {
	branch: SessionEntry[];
	runId: string;
	pane: PaneState | undefined;
	fatal?: string | undefined;
}): { status: ResultStatus; errorMessage?: string } {
	const { pane, fatal, branch, runId } = evidence;
	if (pane?.dead && pane.status === null && pane.signal === null)
		throw new Error(
			`tmux reports pane ${pane.paneId} as dead with no exit status and no signal.`,
		);
	if (fatal !== undefined) return { status: "failed", errorMessage: fatal };
	if (pane === undefined) return { status: "closed" };
	if (!pane.dead) throw new Error(`Pane ${pane.paneId} is still live.`);
	if (pane.signal !== null || pane.status !== 0) return { status: "crashed" };
	const entries = afterMarker(branch, runId);
	const assistant = entries === undefined ? undefined : lastAssistant(entries);
	if (assistant === undefined) return { status: "no_output" };
	switch (assistant.stopReason) {
		case "error":
			return {
				status: "error",
				...(assistant.errorMessage === undefined
					? {}
					: { errorMessage: assistant.errorMessage }),
			};
		case "aborted":
		case "toolUse":
			return { status: "aborted" };
		case "stop":
		case "length":
			return { status: "completed" };
		default:
			throw new Error(
				`Unexpected final assistant stop reason: ${assistant.stopReason}.`,
			);
	}
}
function questions(runDir: string): OpenQuestion[] {
	const dir = join(runDir, "questions");
	return readdirSync(dir)
		.filter((name) => !name.startsWith("."))
		.sort()
		.map((name) => {
			if (!/^q-[0-9a-f]{8}\.json$/.test(name))
				throw new Error(
					`Unexpected file ${join(dir, name)} in a subagent directory.`,
				);
			const question = readJsonStrict(OpenQuestion, join(dir, name));
			if (name !== `${question.qid}.json`)
				throw new Error(`Question id does not match ${join(dir, name)}.`);
			return question;
		});
}
export function routableQuestions(runDir: string): string[] {
	const unseen = new Set(
		queue
			.list(join(runDir, "outbox"), "outbox")
			.filter((entry) => entry.item.kind === "question")
			.map((entry) => entry.item.qid),
	);
	const answered = new Set(
		queue
			.list(join(runDir, "inbox"), "inbox")
			.flatMap((entry) =>
				entry.item.kind === "answer" ? [entry.item.qid] : [],
			),
	);
	return questions(runDir)
		.map((question) => question.qid)
		.filter((qid) => !unseen.has(qid) && !answered.has(qid));
}
export function defaultName(agent: string, used: ReadonlySet<string>): string {
	let n = 1;
	while (used.has(`${agent}-${n}`)) n++;
	return `${agent}-${n}`;
}

export interface ParentRun extends StartedRun {
	phase: "live" | "finishing" | "finished";
	paneCleanup: "unknown" | "pending" | "complete";
	paneGoneAt?: number | undefined;
	view?: ChildStatus;
	broken?: Error;
	sourceFailed?: boolean;
	finishPane?: PaneState | undefined;
}
export interface RuntimeDeps {
	tmux: Tmux;
	ownExtensionPath: string;
	trusted(cwd: string): boolean;
	runsRoot?: string;
	env?: NodeJS.ProcessEnv;
	identity?: (pid: number) => ProcessIdentity | null;
	alive?: (identity: ProcessIdentity) => boolean;
	now?: () => number;
	delay?: (ms: number) => Promise<void>;
	stderr?: (text: string) => void;
	stopProcess?: (identity: ProcessIdentity) => void;
	invocation?: () => string[];
	childSpec?: RunSpec;
	requestRender?: () => void;
}
function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
const DeliveryAck = Type.Object(
	{
		v: Type.Literal(1),
		runId: RunSpec.properties.runId,
		deliveryId: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

function ownerHash(start: string): string {
	return createHash("sha256").update(start).digest("hex");
}
function resultContent(details: ResultDetails, launch: Launch): string {
	let first: string;
	switch (details.status) {
		case "failed":
			first = `could not start: ${details.errorMessage}`;
			break;
		case "closed":
			first = `was closed in its pane${!launch.autoExit && details.text ? " by a human" : ""}`;
			break;
		case "crashed":
			first =
				details.signal !== undefined
					? `crashed (signal ${details.signal})`
					: `crashed (exit code ${details.exitCode})`;
			break;
		case "no_output":
			first = "ended without output";
			break;
		case "error":
			first =
				details.errorMessage === undefined
					? "failed"
					: `failed: ${details.errorMessage}`;
			break;
		case "aborted":
			first = "was interrupted";
			break;
		case "completed":
			first = "finished";
			break;
	}
	const lines = [
		`Subagent "${details.name}" (agent ${details.agent}) ${first} after ${(details.durationMs / 1000).toFixed(1)}s, context ${details.contextTokens === null ? "unknown" : details.contextTokens}.`,
	];
	if (details.text) lines.push(details.text);
	if (details.truncated)
		lines.push(
			`[The output is cut. Full transcript: ${details.childSessionFile}]`,
		);
	if (details.note !== undefined) lines.push(`Note: ${details.note}`);
	if (details.status === "crashed" && details.paneTail !== undefined)
		lines.push(`Pane output (last 40 lines):\n${details.paneTail}`);
	if (details.undelivered.length)
		lines.push(
			`Messages it did not read:\n${details.undelivered.map((text, i) => `${i + 1}. ${text}`).join("\n")}`,
		);
	if (details.openQuestions.length)
		lines.push(
			`Open questions when it ended:\n${details.openQuestions.map((q) => `- ${q.qid}: ${q.text}`).join("\n")}`,
		);
	lines.push(
		`Continue it with subagent_message({ name: "${details.name}", message }).`,
	);
	return lines.join("\n\n");
}

export class Runtime {
	readonly runs = new Map<string, ParentRun>();
	readonly sources: Source[] = [];
	readonly owner: ProcessIdentity;
	readonly ownerKey: string;
	readonly ownerDir: string;
	readonly runsRoot: string;
	readonly done: { name: string; until: number }[] = [];
	private readonly pi: ExtensionAPI;
	private ctx: ExtensionContext;
	private readonly deps: RuntimeDeps;
	private readonly env: NodeJS.ProcessEnv;
	private readonly identify: (pid: number) => ProcessIdentity | null;
	private readonly alive: (identity: ProcessIdentity) => boolean;
	private readonly now: () => number;
	private readonly launching = new Map<string, LaunchPlan>();
	private readonly notified = new Set<string>();
	private readonly retiredSources = new Set<Source>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private inFlight: Promise<void> | undefined;
	private shutdownTask: Promise<void> | undefined;
	private disposed = false;
	private enabled = false;
	private started = false;
	private versionCheck: Promise<void> | undefined;
	deliverer: Deliverer | undefined;
	constructor(pi: ExtensionAPI, ctx: ExtensionContext, deps: RuntimeDeps) {
		this.pi = pi;
		this.ctx = ctx;
		this.deps = deps;
		this.env = deps.env ?? process.env;
		this.identify = deps.identity ?? processIdentity;
		this.alive = deps.alive ?? processAlive;
		this.now = deps.now ?? Date.now;
		const owner = this.identify(process.pid);
		if (owner === null)
			throw new Error(`Cannot identify the parent process ${process.pid}.`);
		this.owner = owner;
		this.ownerKey = `${owner.pid}-${ownerHash(owner.start)}`;
		this.runsRoot = deps.runsRoot ?? join(getAgentDir(), "subagent-runs");
		this.ownerDir = join(this.runsRoot, "owners", this.ownerKey);
	}
	private fold() {
		return foldRegistry(
			this.ctx.sessionManager.getBranch(),
			this.ctx.sessionManager.getSessionId(),
		);
	}
	private notify(error: unknown): void {
		const message = errorText(error);
		if (this.notified.has(message)) return;
		this.notified.add(message);
		this.ctx.ui.notify(message, "error");
	}
	async start(
		event: Pick<SessionStartEvent, "reason">,
		ctx = this.ctx,
	): Promise<void> {
		if (this.started || this.disposed)
			throw new Error("This subagent runtime cannot start again.");
		this.started = true;
		this.ctx = ctx;
		const sessionFile = ctx.sessionManager.getSessionFile();
		const reason =
			ctx.mode !== "tui"
				? "this mode is not the interactive Pi TUI"
				: !this.env.TMUX || !this.env.TMUX_PANE
					? "Pi is not inside tmux"
					: sessionFile === undefined
						? "this session has no session file path"
						: undefined;
		if (reason !== undefined || sessionFile === undefined) {
			this.pi.setActiveTools(
				this.pi
					.getActiveTools()
					.filter(
						(name) =>
							!["subagent", "subagent_message", "subagents_list"].includes(
								name,
							),
					),
			);
			ctx.ui.notify(`Subagents are off: ${reason}.`, "info");
			return;
		}
		// A defined path is valid before Pi persists its first reply.
		parentSessionPath(sessionFile);
		for (const dir of [
			this.runsRoot,
			join(this.runsRoot, "owners"),
			this.ownerDir,
		])
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		for (const name of readdirSync(this.ownerDir)
			.filter((name) => !name.startsWith("."))
			.sort()) {
			const runDir = join(this.ownerDir, name);
			if (!existsSync(join(runDir, "pane.json"))) continue;
			try {
				const spec = readJsonStrict(RunSpec, join(runDir, "spec.json"));
				const pane = readJsonStrict(PaneFile, join(runDir, "pane.json"));
				if (spec.runId !== name || spec.ownerKey !== this.ownerKey)
					throw new Error(`Run identity does not match ${runDir}.`);
				this.attach({ runDir, spec, pane });
			} catch (error) {
				this.notify(error);
			}
		}
		if (event.reason === "startup") await this.recoverDeadOwners();
		this.sources.push(this.noticeSource());
		this.deliverer = new Deliverer(
			this.pi,
			ctx,
			this.sources,
			() => this.disposed,
			this.deps.childSpec !== undefined,
		);
		this.deliverer.reconcile();
		this.enabled = true;
		this.startTick();
	}
	private attach(started: StartedRun): void {
		const name = started.spec.launch.name;
		if (this.runs.has(name))
			throw new Error(`Subagent name "${name}" is already in use.`);
		const run: ParentRun = {
			...started,
			paneCleanup: "unknown",
			phase: existsSync(join(started.runDir, "result.json"))
				? "finished"
				: "live",
		};
		this.runs.set(name, run);
		this.sources.push(this.runSource(run));
	}
	private baseResult(run: ParentRun): ResultDetails {
		const { spec } = run;
		const { launch } = spec;
		return {
			v: 1,
			deliveryId: `${spec.runId}:result`,
			runId: spec.runId,
			name: launch.name,
			agent: launch.agent,
			profile: launch.profile,
			status: "failed",
			text: "",
			truncated: false,
			undelivered: [],
			openQuestions: [],
			durationMs: Math.max(0, this.now() - spec.startedAt),
			contextTokens: null,
			childSessionFile: launch.childSessionFile,
			spawnerSessionFile: spec.spawnerSessionFile,
		};
	}
	private saveResult(run: ParentRun, details: ResultDetails): void {
		writeJsonAtomic(
			join(run.runDir, "result.json"),
			parseStrict(ResultDetails, details, "result"),
		);
		run.phase = "finished";
	}
	private finalizeFailed(run: ParentRun, error: unknown): void {
		try {
			this.saveResult(run, {
				...this.baseResult(run),
				errorMessage: errorText(error),
			});
		} catch (writeError) {
			run.broken = new Error(
				`${errorText(error)}; Could not write result: ${errorText(writeError)}`,
			);
			this.notify(run.broken);
		}
	}
	private finalizeSync(
		run: ParentRun,
		pane: PaneState | undefined,
		paneTail?: string,
	): void {
		const file = run.spec.launch.childSessionFile;
		const live = this.alive(run.pane.process);
		const fatalFile = join(run.runDir, "fatal.json");
		const fatal = existsSync(fatalFile)
			? readJsonStrict(Fatal, fatalFile).message
			: undefined;
		// Never inspect a transcript while its writer is still alive.
		const branch = !live && existsSync(file) ? readBranch(file) : [];
		const entries = afterMarker(branch, run.spec.runId);
		const assistant =
			entries === undefined ? undefined : lastAssistant(entries);
		const ids = persistedIds(entries ?? []);
		const text = truncateHead(finalText(assistant), {
			maxBytes: DEFAULT_MAX_BYTES,
			maxLines: DEFAULT_MAX_LINES,
		});
		const statusFile = join(run.runDir, "status.json");
		const view = existsSync(statusFile)
			? readJsonStrict(ChildStatus, statusFile)
			: undefined;
		this.saveResult(run, {
			...this.baseResult(run),
			...classifyResult({ branch, runId: run.spec.runId, pane, fatal }),
			text: text.content,
			truncated: text.truncated,
			...(fatal === undefined ? {} : { fatal }),
			...(pane?.status == null ? {} : { exitCode: pane.status }),
			...(pane?.signal == null ? {} : { signal: pane.signal }),
			...(paneTail === undefined ? {} : { paneTail }),
			...(live && !pane
				? {
						note: `The pane closed, but the process ${run.pane.process.pid} did not end within 30 s.`,
					}
				: {}),
			contextTokens:
				view === undefined
					? (assistant?.usage.totalTokens ?? null)
					: view.contextTokens,
			undelivered: queue
				.list(join(run.runDir, "inbox"), "inbox")
				.filter(
					(entry) => !ids.has(queue.itemId(run.spec.runId, "inbox", entry.seq)),
				)
				.map(({ item }) =>
					item.kind === "answer"
						? `Answer to ${item.qid}: ${item.text}`
						: item.text,
				),
			openQuestions: questions(run.runDir).map(({ qid, text }) => ({
				qid,
				text,
			})),
		});
	}
	private async rebalance(excludePaneId: string): Promise<void> {
		const target = this.newestLivePane(excludePaneId);
		if (target !== undefined)
			await this.deps.tmux.run(["select-layout", "-E", "-t", target]);
	}
	private async closePane(run: ParentRun): Promise<string | undefined> {
		run.paneCleanup = "pending";
		try {
			await this.deps.tmux.run(["kill-pane", "-t", run.pane.paneId]);
		} catch (error) {
			this.notify(error);
			return errorText(error);
		}
		run.paneCleanup = "complete";
		if (!this.disposed) {
			try {
				await this.rebalance(run.pane.paneId);
			} catch (error) {
				this.notify(error);
			}
		}
		return undefined;
	}
	private async finalize(
		run: ParentRun,
		pane: PaneState | undefined,
	): Promise<void> {
		run.phase = "finishing";
		run.finishPane = pane;
		let tail: string | undefined;
		if (pane?.dead && (pane.signal !== null || pane.status !== 0)) {
			tail = await this.deps.tmux.capture(pane.paneId);
			if (this.disposed) return;
		}
		this.finalizeSync(run, pane, tail);
		if (pane !== undefined) await this.closePane(run);
	}
	tick(): Promise<void> {
		if (this.disposed || !this.enabled) return Promise.resolve();
		if (this.inFlight !== undefined) return this.inFlight;
		this.inFlight = this.tickOnce().finally(() => {
			this.inFlight = undefined;
		});
		return this.inFlight;
	}
	private async tickOnce(): Promise<void> {
		try {
			const panes = await this.deps.tmux.listPanes();
			if (this.disposed) return;
			for (const run of [...this.runs.values()].sort(
				(a, b) => a.spec.startedAt - b.spec.startedAt,
			)) {
				try {
					const pane = panes.get(run.pane.paneId);
					run.paneCleanup = pane === undefined ? "complete" : "pending";
					if (this.acknowledged(run)) {
						if (pane !== undefined) await this.closePane(run);
						if (this.disposed) return;
						if (run.paneCleanup === "complete" && !this.alive(run.pane.process))
							this.removeRun(run);
						continue;
					}
					if (run.phase === "live") {
						if (pane && !pane.dead) {
							run.paneGoneAt = undefined;
							const file = join(run.runDir, "status.json");
							if (existsSync(file))
								run.view = readJsonStrict(ChildStatus, file);
							continue;
						}
						if (pane === undefined) {
							run.paneGoneAt ??= this.now();
							if (
								this.alive(run.pane.process) &&
								this.now() - run.paneGoneAt < 30_000
							)
								continue;
						} else if (this.alive(run.pane.process)) continue;
						await this.finalize(run, pane);
						if (this.disposed) return;
					} else if (run.phase === "finished" && pane !== undefined) {
						await this.closePane(run);
						if (this.disposed) return;
					}
				} catch (error) {
					this.finalizeFailed(run, error);
				}
			}
			if (this.deliverer === undefined)
				throw new Error("The subagent deliverer has not started.");
			this.deliverer.pump();
			for (let index = this.sources.length - 1; index >= 0; index--) {
				const source = this.sources[index];
				if (source !== undefined && this.retiredSources.delete(source))
					this.sources.splice(index, 1);
			}
			this.done.splice(
				0,
				this.done.length,
				...this.done.filter((row) => row.until > this.now()),
			);
			this.deps.requestRender?.();
			if (
				this.runs.size === 0 &&
				!this.sources.some((source) => source.items().length)
			)
				this.stopTick();
		} catch (error) {
			this.notify(error);
		}
	}
	private startTick(): void {
		if (this.disposed || this.timer !== undefined) return;
		if (
			this.runs.size === 0 &&
			!this.sources.some((source) => source.items().length)
		)
			return;
		this.timer = setInterval(() => {
			void this.tick();
		}, 500);
		this.timer.unref();
	}
	private stopTick(): void {
		if (this.timer !== undefined) clearInterval(this.timer);
		this.timer = undefined;
	}
	private runSource(run: ParentRun): Source {
		type RunItem = Item & { seq?: string; outbox?: queue.Item<"outbox"> };
		const result = (): ResultDetails =>
			readJsonStrict(ResultDetails, join(run.runDir, "result.json"));
		const source: Source = {
			key: run.spec.runId,
			items: (): RunItem[] => {
				if (
					this.runs.get(run.spec.launch.name) !== run ||
					run.broken !== undefined
				)
					return [];
				try {
					if (this.acknowledged(run)) return [];
					if (!run.sourceFailed) {
						const items = queue.list(join(run.runDir, "outbox"), "outbox");
						if (items.length)
							return items.map((entry) => ({
								id: queue.itemId(run.spec.runId, "outbox", entry.seq),
								seq: entry.seq,
								outbox: entry.item,
							}));
					}
					return existsSync(join(run.runDir, "result.json"))
						? [{ id: result().deliveryId }]
						: [];
				} catch (error) {
					run.sourceFailed = true;
					this.finalizeFailed(run, error);
					return run.broken === undefined
						? [{ id: `${run.spec.runId}:result` }]
						: [];
				}
			},
			build: (item: RunItem) => {
				const { spec } = run;
				const { name, agent } = spec.launch;
				const trigger = this.fold().ownRunIds.has(spec.runId);
				if (item.outbox !== undefined) {
					if (run.phase !== "live") return "drop";
					const { qid, kind } = item.outbox;
					return {
						kind: "message",
						trigger,
						message: {
							customType:
								kind === "question"
									? "subagent_question"
									: "subagent_withdrawn",
							display: true,
							content:
								kind === "question"
									? `Subagent "${name}" (agent ${agent}) asks question ${qid}:\n\n${item.outbox.text}\n\nIt waits for your answer. Reply with subagent_message({ name: "${name}", question_id: "${qid}", message }).`
									: `Subagent "${name}" withdrew question ${qid}. Do not answer it.`,
							details: {
								deliveryId: item.id,
								runId: spec.runId,
								name,
								qid,
								...(kind === "question"
									? { agent, question: item.outbox.text }
									: {}),
							},
						},
					};
				}
				const details = result();
				return {
					kind: "message",
					trigger,
					message: {
						customType: "subagent_result",
						content: resultContent(details, spec.launch),
						display: true,
						details,
					},
				};
			},
			prelude: (item: RunItem) => {
				if (this.fold().knownRunIds.has(run.spec.runId)) return [];
				this.ctx.ui.notify(
					`Subagent ${run.spec.launch.name} was started in another session. Its ${item.outbox === undefined ? "result" : "question"} is shown here without a new turn.`,
					"info",
				);
				return [
					{
						customType: "subagent",
						data: {
							v: 1,
							kind: "adopt",
							runId: run.spec.runId,
							launch: run.spec.launch,
						},
					},
				];
			},
			confirm: (item: RunItem) => {
				if (item.seq !== undefined)
					queue.deleteConsumed(join(run.runDir, "outbox"), item.seq);
				else {
					// Delivery and resource cleanup have separate completion states.
					if (run.paneCleanup !== "complete" || this.alive(run.pane.process)) {
						const ack = parseStrict(
							DeliveryAck,
							{ v: 1, runId: run.spec.runId, deliveryId: item.id },
							"delivery acknowledgement",
						);
						writeJsonAtomic(join(run.runDir, "delivery-ack.json"), ack);
					} else this.removeRun(run);
				}
			},
		};
		return source;
	}
	private acknowledged(run: StartedRun): boolean {
		const file = join(run.runDir, "delivery-ack.json");
		if (!existsSync(file)) return false;
		const ack = readJsonStrict(DeliveryAck, file);
		if (
			ack.runId !== run.spec.runId ||
			ack.deliveryId !== `${run.spec.runId}:result`
		)
			throw new Error(`Delivery acknowledgement does not match ${run.runDir}.`);
		return true;
	}
	private removeRun(run: ParentRun): void {
		if (run.paneCleanup !== "complete" || this.alive(run.pane.process))
			throw new Error(
				`Cannot remove subagent ${run.spec.launch.name} before pane cleanup and process exit.`,
			);
		rmSync(run.runDir, { recursive: true });
		this.runs.delete(run.spec.launch.name);
		const source = this.sources.find((source) => source.key === run.spec.runId);
		if (source !== undefined) this.retiredSources.add(source);
		this.done.push({ name: run.spec.launch.name, until: this.now() + 10_000 });
	}
	list() {
		return {
			live: [...this.runs.values()].map((run) => ({
				name: run.spec.launch.name,
				phase: run.phase,
				launch: run.spec.launch,
				view: run.view,
				broken: run.broken,
				openQuestions:
					run.phase === "live" ? routableQuestions(run.runDir) : [],
			})),
			launching: [...this.launching.keys()],
			branch: this.fold().names,
		};
	}
	private requireEnabled(): void {
		if (!this.enabled || this.disposed)
			throw new Error("Subagents are off in this session.");
	}
	private newestLivePane(exclude?: string): string | undefined {
		return [...this.runs.values()]
			.filter((run) => run.phase === "live" && run.pane.paneId !== exclude)
			.sort((a, b) => b.spec.startedAt - a.spec.startedAt)[0]?.pane.paneId;
	}
	async spawn(
		launch: LaunchDraft,
		task: string,
		toolCallId?: string,
	): Promise<StartedRun> {
		this.requireEnabled();
		return this.launch({
			kind: "spawn",
			launch,
			initialPrompt: task,
			...(launch.session === "fork"
				? { entries: forkEntries(this.ctx, toolCallId) }
				: {}),
		});
	}
	private async launch(plan: LaunchPlan): Promise<StartedRun> {
		this.versionCheck ??= checkTmuxVersion(this.deps.tmux);
		await this.versionCheck;
		return launchRun(plan, {
			runId: randomUUID(),
			ownerDir: this.ownerDir,
			ownerKey: this.ownerKey,
			owner: this.owner,
			spawnerSessionId: this.ctx.sessionManager.getSessionId(),
			spawnerSessionFile: this.ctx.sessionManager.getSessionFile(),
			sessionDir: this.ctx.sessionManager.getSessionDir(),
			mode: this.ctx.mode,
			ownExtensionPath: this.deps.ownExtensionPath,
			env: this.env,
			tmux: this.deps.tmux,
			identity: this.identify,
			...(this.deps.invocation === undefined
				? {}
				: { invocation: this.deps.invocation }),
			trusted: (cwd) => this.deps.trusted(cwd),
			isDisposed: () => this.disposed,
			reserve: (name) => {
				if (
					this.runs.has(name) ||
					this.launching.has(name) ||
					(plan.kind === "spawn" && this.fold().names.has(name))
				)
					throw new Error(`Subagent name "${name}" is already in use.`);
				this.launching.set(name, plan);
			},
			release: (name) => {
				this.launching.delete(name);
				const run = this.runs.get(name);
				if (run) {
					this.runs.delete(name);
					const index = this.sources.findIndex(
						(source) => source.key === run.spec.runId,
					);
					if (index !== -1) this.sources.splice(index, 1);
				}
			},
			newestLivePane: (exclude) => this.newestLivePane(exclude),
			commit: (run) => {
				this.launching.delete(run.spec.launch.name);
				this.attach(run);
			},
			appendRegistry: (record) => this.pi.appendEntry("subagent", record),
			startTick: () => this.startTick(),
		});
	}
	async message(
		name: string,
		text: string,
		question_id?: string,
	): Promise<string> {
		this.requireEnabled();
		if (this.launching.has(name))
			throw new Error(`Subagent "${name}" is still starting.`);
		const run = this.runs.get(name);
		if (run !== undefined) {
			if (run.phase !== "live")
				throw new Error(
					`Subagent "${name}" has finished. Its result is on the way. Send your message after the result arrives. That resumes it.`,
				);
			const open = routableQuestions(run.runDir);
			if (question_id !== undefined && !open.includes(question_id))
				throw new Error(
					`Question ${question_id} of "${name}" is not open. Open questions: ${open.join(", ") || "none"}.`,
				);
			if (question_id === undefined && open.length > 1)
				throw new Error(
					`Subagent "${name}" has ${open.length} open questions: ${open.join(", ")}. Pass question_id.`,
				);
			const qid = question_id ?? open[0];
			queue.put(
				join(run.runDir, "inbox"),
				"inbox",
				qid === undefined
					? { v: 1, kind: "message", text }
					: { v: 1, kind: "answer", qid, text },
			);
			return qid === undefined
				? `Queued for "${name}". It reads the message at its next step.`
				: `Sent as the answer to question ${qid} of "${name}".`;
		}
		const fold = this.fold();
		const rec = fold.names.get(name);
		if (!rec)
			throw new Error(
				`Unknown subagent "${name}". Live: ${[...this.runs.keys(), ...this.launching.keys()].join(", ") || "none"}. On this branch: ${[...fold.names.keys()].join(", ") || "none"}.`,
			);
		if (question_id !== undefined)
			throw new Error(
				`Subagent "${name}" has finished, so question ${question_id} is closed. Send the message without question_id to resume it.`,
			);
		const { launch } = rec;
		if (!existsSync(launch.childSessionFile))
			throw new Error(
				`The session file of "${name}" is missing: ${launch.childSessionFile}.`,
			);
		if (
			[...this.runs.values()].some(
				(run) => run.spec.launch.childSessionFile === launch.childSessionFile,
			) ||
			[...this.launching.values()].some(
				(plan) =>
					plan.kind === "resume" &&
					plan.launch.childSessionFile === launch.childSessionFile,
			)
		)
			throw new Error(
				`The session of "${name}" is already in use by a subagent.`,
			);
		const panes = await this.deps.tmux.listPanes();
		for (const pane of panes.values())
			if (!pane.dead && pane.session === launch.childSessionFile)
				throw new Error(
					`The session of "${name}" is still open in pane ${pane.paneId}. Close that pane first.`,
				);
		const spec = this.deps.childSpec;
		if (
			spec &&
			(!spec.launch.nested?.agents[launch.agent] ||
				spec.launch.depth + 1 > MAX_DEPTH)
		)
			throw new Error(
				`Agent "${launch.agent}" is not in the spawn allowlist of this agent.`,
			);
		for (const path of [...launch.extensions, ...launch.skills])
			if (!existsSync(path))
				throw new Error(`The path for subagent "${name}" is missing: ${path}.`);
		const started = await this.launch({
			kind: "resume",
			launch,
			initialPrompt: `Message from the parent agent:\n\n${text}`,
		});
		return `Resumed subagent "${name}" in pane ${started.pane.paneId}. Its result arrives as a message.`;
	}
	onInput(): void {
		this.deliverer?.onInput();
	}
	onAgentStart(): void {
		this.deliverer?.onAgentStart();
	}
	onBoundary(event: Pick<TurnEndEvent, "outcome">) {
		return this.deliverer?.onBoundary(event);
	}
	onAgentSettled(): void {
		this.deliverer?.onAgentSettled();
	}
	private undeliveredDir(sessionId: string): string {
		if (
			!sessionId ||
			sessionId === "." ||
			sessionId === ".." ||
			/[\\/]/.test(sessionId)
		)
			throw new Error(`Invalid session id: ${sessionId}.`);
		return join(this.runsRoot, "undelivered", sessionId);
	}
	private storeUndelivered(
		run: StartedRun,
		sessionId: string,
		kind: "stopped" | "result",
	): void {
		const { runId, launch } = run.spec;
		let record: UndeliveredRecord;
		if (kind === "result") {
			const details = readJsonStrict(
				ResultDetails,
				join(run.runDir, "result.json"),
			);
			record = {
				v: 1,
				kind,
				runId,
				launch,
				details,
				content: resultContent(details, launch),
			};
		} else record = { v: 1, kind, runId, launch, at: this.now() };
		const dir = this.undeliveredDir(sessionId);
		mkdirSync(join(this.runsRoot, "undelivered"), {
			recursive: true,
			mode: 0o700,
		});
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeJsonAtomic(
			join(dir, `${runId}.json`),
			parseStrict(UndeliveredRecord, record, "undelivered record"),
		);
	}
	private removeEmpty(dir: string): void {
		if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
	}
	private async recoverDeadOwners(): Promise<void> {
		let panes: Map<string, PaneState> | undefined;
		const owners = join(this.runsRoot, "owners");
		for (const name of readdirSync(owners)
			.filter((name) => !name.startsWith("."))
			.sort()) {
			if (name === this.ownerKey) continue;
			const match = /^([1-9][0-9]*)-([0-9a-f]{64})$/.exec(name);
			if (match === null || !Number.isSafeInteger(Number(match[1])))
				throw new Error(`Invalid subagent owner key: ${name}.`);
			const owner = this.identify(Number(match[1]));
			if (owner !== null && ownerHash(owner.start) === match[2]) continue;
			const ownerDir = join(owners, name);
			for (const id of readdirSync(ownerDir)
				.filter((id) => !id.startsWith("."))
				.sort()) {
				const runDir = join(ownerDir, id);
				if (!existsSync(join(runDir, "pane.json"))) continue;
				try {
					const spec = readJsonStrict(RunSpec, join(runDir, "spec.json"));
					const pane = readJsonStrict(PaneFile, join(runDir, "pane.json"));
					if (spec.runId !== id)
						throw new Error(`Run identity does not match ${runDir}.`);
					if (this.alive(pane.process)) continue;
					panes ??= await this.deps.tmux.listPanes();
					if (panes.has(pane.paneId)) {
						await this.deps.tmux.run(["kill-pane", "-t", pane.paneId]);
						panes.delete(pane.paneId);
					}
					if (this.acknowledged({ runDir, spec, pane })) {
						rmSync(runDir, { recursive: true });
						continue;
					}
					const kind = existsSync(join(runDir, "result.json"))
						? "result"
						: "stopped";
					this.storeUndelivered(
						{ runDir, spec, pane },
						spec.spawnerSessionId,
						kind,
					);
					rmSync(runDir, { recursive: true });
				} catch (error) {
					this.notify(error);
				}
			}
			this.removeEmpty(ownerDir);
		}
	}
	private noticeSource(): Source {
		type NoticeItem = Item & {
			records: { file: string; record: UndeliveredRecord }[];
		};
		const dir = this.undeliveredDir(this.ctx.sessionManager.getSessionId());
		return {
			key: "notice",
			items: (): NoticeItem[] => {
				if (!existsSync(dir)) return [];
				const records = readdirSync(dir)
					.filter((name) => !name.startsWith("."))
					.sort()
					.map((name) => {
						const file = join(dir, name);
						if (
							!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/.test(
								name,
							)
						)
							throw new Error(
								`Unexpected file ${file} in a subagent directory.`,
							);
						const record = readJsonStrict(UndeliveredRecord, file);
						if (name !== `${record.runId}.json`)
							throw new Error(`Run identity does not match ${file}.`);
						return { file, record };
					});
				return records.length
					? [
							{
								id: `notice:${records.map(({ record }) => record.runId).join(",")}`,
								records,
							},
						]
					: [];
			},
			build: (item: Item) => {
				const { records } = item as NoticeItem;
				const stopped = records
					.filter(({ record }) => record.kind === "stopped")
					.map(({ record }) => record.launch.name);
				const undelivered = records.flatMap(({ record }) =>
					record.kind === "result" ? [record] : [],
				);
				const lines = ["Pi stopped while subagents were running."];
				if (stopped.length)
					lines.push(
						`Stopped: ${stopped.join(", ")}. Their sessions are saved. Resume one with subagent_message({ name, message }).`,
					);
				if (undelivered.length)
					lines.push(
						"Results that were not delivered:",
						...undelivered.map((record) => record.content),
					);
				return {
					kind: "message",
					trigger: false,
					message: {
						customType: "subagent_notice",
						content: lines.join("\n\n"),
						display: true,
						details: {
							deliveryId: item.id,
							runIds: records.map(({ record }) => record.runId),
							stopped,
							undelivered: undelivered.map((record) => record.details),
						},
					},
				};
			},
			prelude: (item: Item) =>
				(item as NoticeItem).records.map(({ record }) => ({
					customType: "subagent",
					data: {
						v: 1,
						kind: "adopt",
						runId: record.runId,
						launch: record.launch,
					},
				})),
			confirm: (item: Item) => {
				for (const { file } of (item as NoticeItem).records) unlinkSync(file);
				this.removeEmpty(dir);
			},
		};
	}
	onShutdown(reason: SessionShutdownEvent["reason"]): Promise<void> {
		if (this.shutdownTask !== undefined) return this.shutdownTask;
		this.disposed = true;
		this.stopTick();
		this.shutdownTask = (async () => {
			await this.inFlight;
			try {
				this.deliverer?.shutdown();
			} catch (error) {
				this.notify(error);
			}
			if (reason === "quit") await this.quit();
		})();
		return this.shutdownTask;
	}
	private async quit(): Promise<void> {
		if (!this.enabled) return;
		const fold = this.fold();
		const runs = [...this.runs.values()];
		const notStarted = [...this.launching.keys()];
		const killed = new Set<ParentRun>();
		const killFailed = new Set<ParentRun>();
		const errors: string[] = [];
		let panes: Map<string, PaneState> | undefined;
		if (runs.length) {
			try {
				panes = await this.deps.tmux.listPanes();
			} catch (error) {
				const message = `Could not list panes during quit: ${errorText(error)}.`;
				errors.push(message);
				this.notify(message);
			}
		}
		for (const run of runs) {
			let missingPaneProcess = false;
			try {
				const live = this.alive(run.pane.process);
				// An unavailable snapshot proves neither pane absence nor cleanup.
				run.paneCleanup =
					panes === undefined
						? "unknown"
						: panes.has(run.pane.paneId)
							? "pending"
							: "complete";
				missingPaneProcess =
					live && panes !== undefined && run.paneCleanup === "complete";
				if (missingPaneProcess) {
					// Recheck the recorded identity before signaling a process without a pane.
					const stop =
						this.deps.stopProcess ??
						((identity: ProcessIdentity) => {
							process.kill(identity.pid, "SIGHUP");
						});
					if (this.alive(run.pane.process)) stop(run.pane.process);
				} else if (run.paneCleanup !== "complete") {
					const error = await this.closePane(run);
					if (error !== undefined) throw new Error(error);
				}
				if (live || run.phase === "live") killed.add(run);
			} catch (error) {
				killFailed.add(run);
				errors.push(
					missingPaneProcess
						? `Could not stop process ${run.pane.process.pid}: ${errorText(error)}.`
						: `Could not close pane ${run.pane.paneId}: ${errorText(error)}.`,
				);
			}
		}
		const deadline = this.now() + 5000;
		const delay =
			this.deps.delay ??
			((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
		while (
			[...killed].some((run) => this.alive(run.pane.process)) &&
			this.now() < deadline
		)
			await delay(Math.min(50, deadline - this.now()));
		const stopped: string[] = [];
		const results: string[] = [];
		const stillLive: ParentRun[] = [];
		for (const run of runs) {
			try {
				if (this.alive(run.pane.process)) {
					stillLive.push(run);
					continue;
				}
				if (run.phase === "finishing") {
					try {
						this.finalizeSync(run, run.finishPane);
					} catch (error) {
						this.finalizeFailed(run, error);
					}
				}
				if (killFailed.has(run) || run.paneCleanup !== "complete") continue;
				if (this.acknowledged(run)) {
					this.removeRun(run);
					if (killed.has(run)) stopped.push(run.spec.launch.name);
					continue;
				}
				if (run.broken !== undefined) throw run.broken;
				const kind =
					run.phase === "finished"
						? "result"
						: killed.has(run)
							? "stopped"
							: undefined;
				if (kind === undefined) continue;
				const target = fold.knownRunIds.has(run.spec.runId)
					? this.ctx.sessionManager.getSessionId()
					: run.spec.spawnerSessionId;
				this.storeUndelivered(run, target, kind);
				rmSync(run.runDir, { recursive: true });
				this.runs.delete(run.spec.launch.name);
				(kind === "result" ? results : stopped).push(run.spec.launch.name);
			} catch (error) {
				errors.push(
					`Could not preserve subagent ${run.spec.launch.name}: ${errorText(error)}.`,
				);
				this.notify(error);
			}
		}
		this.removeEmpty(this.ownerDir);
		if (runs.length === 0 && notStarted.length === 0) return;
		const file = this.ctx.sessionManager.getSessionFile();
		const saved = file !== undefined && existsSync(parentSessionPath(file));
		let line = stopped.length
			? `Pi quit, so it stopped ${stopped.length} running subagents: ${stopped.join(", ")}. Their sessions are saved.`
			: "Pi quit.";
		if (saved && stopped.length)
			line +=
				" Open this session again and use subagent_message to resume them.";
		if (results.length)
			line += ` It kept ${results.length} result${results.length === 1 ? "" : "s"} that ${results.length === 1 ? "was" : "were"} not delivered: ${results.join(", ")}.${saved ? " You see it when you open this session again." : ""}`;
		if (!saved)
			line += ` This session was not saved, because it has no reply yet. The subagent sessions are: ${runs.map((run) => run.spec.launch.childSessionFile).join(", ")}.`;
		if (notStarted.length)
			line += ` These did not start: ${notStarted.join(", ")}.`;
		for (const run of stillLive)
			line += ` Subagent ${run.spec.launch.name} (pid ${run.pane.process.pid}) ${this.now() >= deadline ? "did not stop within 5 s" : "is still running"}.`;
		for (const error of errors) line += ` ${error}`;
		const stderr =
			this.deps.stderr ??
			((text: string) => {
				process.stderr.write(text);
			});
		stderr(`pi-interactive-subagents: ${line}\n`);
	}
}
