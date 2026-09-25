import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type Static,
	type TProperties,
	type TSchema,
	type TString,
	Type,
} from "typebox";
import { Value } from "typebox/value";

export const MAX_DEPTH = 3;
export const NAME_PATTERN = "^[a-z0-9][a-z0-9-]{0,39}$";

const Obj = <P extends TProperties>(p: P) =>
	Type.Object(p, { additionalProperties: false });
const Rec = <V extends TSchema>(
	key: TString,
	v: V,
	opts: { minProperties?: number } = {},
) => Type.Record(key, v, { additionalProperties: false, ...opts });

export const Name = Type.String({ pattern: NAME_PATTERN });
export const AgentName = Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,31}$" });
export const Qid = Type.String({ pattern: "^q-[0-9a-f]{8}$" });
export const ThinkingLevel = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
] as const);
export const ModelRef = Obj({
	provider: Type.String({ minLength: 1 }),
	id: Type.String({ minLength: 1 }),
});
export const AbsPath = Type.String({ pattern: "^/" });
export const ProcessIdentity = Obj({
	pid: Type.Integer({ minimum: 1 }),
	start: Type.String({ minLength: 1 }),
});

export const AgentDef = Obj({
	name: AgentName,
	file: AbsPath,
	scope: Type.Union([
		Type.Literal("package"),
		Type.Literal("user"),
		Type.Literal("project"),
	]),
	description: Type.String({ minLength: 1 }),
	tools: Type.Array(Type.String(), { uniqueItems: true }),
	skills: Type.Union([
		Type.Literal("all"),
		Type.Literal("none"),
		Type.Array(Type.String(), { minItems: 1, uniqueItems: true }),
	]),
	spawns: Type.Array(AgentName, { uniqueItems: true }),
	session: Type.Union([Type.Literal("standalone"), Type.Literal("fork")]),
	autoExit: Type.Boolean(),
	modelInvocable: Type.Boolean(),
	systemPrompt: Obj({
		mode: Type.Union([Type.Literal("append"), Type.Literal("replace")]),
		text: Type.String({ minLength: 1 }),
	}),
});
export const ProfileDef = Obj({
	model: ModelRef,
	thinking: ThinkingLevel,
	guidance: Type.String({ minLength: 1 }),
	extensions: Type.Array(AbsPath, { uniqueItems: true }),
});
export const ToolSource = Type.Union([
	Obj({ kind: Type.Literal("builtin") }),
	Obj({ kind: Type.Literal("own") }),
	Obj({ kind: Type.Literal("extension"), path: AbsPath }),
	Obj({ kind: Type.Literal("unavailable"), reason: Type.String() }),
]);
export const Catalog = Obj({
	agents: Rec(AgentName, AgentDef),
	profiles: Rec(Name, ProfileDef),
	toolSources: Rec(Type.String({ minLength: 1 }), ToolSource),
	skills: Rec(Type.String({ minLength: 1 }), AbsPath),
});
export const LaunchDraft = Obj({
	name: Name,
	agent: AgentName,
	profile: Name,
	cwd: AbsPath,
	session: Type.Union([Type.Literal("standalone"), Type.Literal("fork")]),
	autoExit: Type.Boolean(),
	model: ModelRef,
	thinking: ThinkingLevel,
	systemPrompt: AgentDef.properties.systemPrompt,
	tools: Type.Array(Type.String(), { uniqueItems: true }),
	extensions: Type.Array(AbsPath, { uniqueItems: true }),
	skills: Type.Array(AbsPath, { uniqueItems: true }),
	depth: Type.Integer({ minimum: 1, maximum: MAX_DEPTH }),
	nested: Type.Union([Catalog, Type.Null()]),
});
export const Launch = Obj({
	...LaunchDraft.properties,
	childSessionFile: AbsPath,
});
export const RunSpec = Obj({
	v: Type.Literal(1),
	runId: Type.String({ format: "uuid" }),
	ownerKey: Type.String(),
	owner: ProcessIdentity,
	startedAt: Type.Number(),
	kind: Type.Union([Type.Literal("spawn"), Type.Literal("resume")]),
	spawnerSessionId: Type.String({ minLength: 1 }),
	spawnerSessionFile: AbsPath,
	initialPrompt: Type.String({ minLength: 1 }),
	launch: Launch,
});
export const PaneFile = Obj({
	v: Type.Literal(1),
	paneId: Type.String({ pattern: "^%[0-9]+$" }),
	process: ProcessIdentity,
});
export const InboxItem = Type.Union([
	Obj({
		v: Type.Literal(1),
		kind: Type.Literal("message"),
		text: Type.String({ minLength: 1 }),
	}),
	Obj({
		v: Type.Literal(1),
		kind: Type.Literal("answer"),
		qid: Qid,
		text: Type.String({ minLength: 1 }),
	}),
]);
export const OutboxItem = Type.Union([
	Obj({
		v: Type.Literal(1),
		kind: Type.Literal("question"),
		qid: Qid,
		text: Type.String({ minLength: 1 }),
	}),
	Obj({ v: Type.Literal(1), kind: Type.Literal("withdrawn"), qid: Qid }),
]);
export const OpenQuestion = Obj({
	v: Type.Literal(1),
	qid: Qid,
	text: Type.String(),
	toolCallId: Type.String(),
	askedAt: Type.Number(),
});
export const ChildStatus = Obj({
	v: Type.Literal(1),
	state: Type.Union([
		Type.Literal("starting"),
		Type.Literal("working"),
		Type.Literal("waiting"),
	]),
	question: Type.Boolean(),
	human: Type.Boolean(),
	contextTokens: Type.Union([Type.Number(), Type.Null()]),
	updatedAt: Type.Number(),
});
export const Fatal = Obj({
	v: Type.Literal(1),
	message: Type.String({ minLength: 1 }),
});
export const ResultStatus = Type.Union([
	Type.Literal("completed"),
	Type.Literal("error"),
	Type.Literal("aborted"),
	Type.Literal("crashed"),
	Type.Literal("closed"),
	Type.Literal("no_output"),
	Type.Literal("failed"),
] as const);
export const ResultDetails = Obj({
	v: Type.Literal(1),
	deliveryId: Type.String(),
	runId: Type.String(),
	name: Name,
	agent: AgentName,
	profile: Name,
	autoExit: Type.Boolean(),
	status: ResultStatus,
	text: Type.String(),
	truncated: Type.Boolean(),
	errorMessage: Type.Optional(Type.String()),
	exitCode: Type.Optional(Type.Integer()),
	signal: Type.Optional(Type.String()),
	paneTail: Type.Optional(Type.String()),
	fatal: Type.Optional(Type.String()),
	note: Type.Optional(Type.String()),
	undelivered: Type.Array(Type.String()),
	openQuestions: Type.Array(Obj({ qid: Qid, text: Type.String() })),
	durationMs: Type.Number(),
	contextTokens: Type.Union([Type.Number(), Type.Null()]),
	childSessionFile: AbsPath,
	spawnerSessionFile: AbsPath,
});
export const RegistryRecord = Type.Union([
	Obj({
		v: Type.Literal(1),
		kind: Type.Literal("spawn"),
		runId: Type.String(),
		launch: Launch,
	}),
	Obj({
		v: Type.Literal(1),
		kind: Type.Literal("resume"),
		runId: Type.String(),
		name: Name,
	}),
	Obj({
		v: Type.Literal(1),
		kind: Type.Literal("adopt"),
		runId: Type.String(),
		launch: Launch,
	}),
]);
export const ChildEntry = Type.Union([
	Obj({
		v: Type.Literal(1),
		kind: Type.Literal("run"),
		runId: Type.String(),
		name: Name,
		sessionId: Type.String({ minLength: 1 }),
	}),
	Obj({
		v: Type.Literal(1),
		kind: Type.Literal("human"),
		runId: Type.String(),
	}),
	Obj({ v: Type.Literal(1), kind: Type.Literal("leaf"), runId: Type.String() }),
]);
export const UndeliveredRecord = Type.Union([
	Obj({
		v: Type.Literal(1),
		kind: Type.Literal("stopped"),
		runId: Type.String(),
		launch: Launch,
		at: Type.Number(),
	}),
	Obj({
		v: Type.Literal(1),
		kind: Type.Literal("result"),
		runId: Type.String(),
		launch: Launch,
		content: Type.String(),
		details: ResultDetails,
	}),
]);
export const AgentFrontmatter = Obj({
	description: Type.String({ minLength: 1, maxLength: 300 }),
	tools: Type.Array(Type.String({ pattern: "^[A-Za-z0-9_-]+$" }), {
		uniqueItems: true,
	}),
	skills: Type.Optional(
		Type.Union([
			Type.Literal("all"),
			Type.Literal("none"),
			Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				uniqueItems: true,
			}),
		]),
	),
	spawns: Type.Optional(Type.Array(AgentName, { uniqueItems: true })),
	session: Type.Optional(
		Type.Union([Type.Literal("standalone"), Type.Literal("fork")]),
	),
	"auto-exit": Type.Optional(Type.Boolean()),
	"system-prompt": Type.Optional(
		Type.Union([Type.Literal("append"), Type.Literal("replace")]),
	),
	"disable-model-invocation": Type.Optional(Type.Boolean()),
});
export const ProfilesFile = Obj({
	profiles: Rec(
		Name,
		Obj({
			model: Type.String({ pattern: "^[^/\\s]+/\\S+$" }),
			thinking: ThinkingLevel,
			guidance: Type.String({ minLength: 1 }),
			extensions: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					minItems: 1,
					uniqueItems: true,
				}),
			),
		}),
		{ minProperties: 1 },
	),
});

export type Name = Static<typeof Name>;
export type AgentName = Static<typeof AgentName>;
export type Qid = Static<typeof Qid>;
export type ThinkingLevel = Static<typeof ThinkingLevel>;
export type ModelRef = Static<typeof ModelRef>;
export type AbsPath = Static<typeof AbsPath>;
export type ProcessIdentity = Static<typeof ProcessIdentity>;
export type AgentDef = Static<typeof AgentDef>;
export type ProfileDef = Static<typeof ProfileDef>;
export type ToolSource = Static<typeof ToolSource>;
export type Catalog = Static<typeof Catalog>;
export type LaunchDraft = Static<typeof LaunchDraft>;
export type Launch = Static<typeof Launch>;
export type RunSpec = Static<typeof RunSpec>;
export type PaneFile = Static<typeof PaneFile>;
export type InboxItem = Static<typeof InboxItem>;
export type OutboxItem = Static<typeof OutboxItem>;
export type OpenQuestion = Static<typeof OpenQuestion>;
export type ChildStatus = Static<typeof ChildStatus>;
export type Fatal = Static<typeof Fatal>;
export type ResultStatus = Static<typeof ResultStatus>;
export type ResultDetails = Static<typeof ResultDetails>;
export type RegistryRecord = Static<typeof RegistryRecord>;
export type ChildEntry = Static<typeof ChildEntry>;
export type UndeliveredRecord = Static<typeof UndeliveredRecord>;
export type AgentFrontmatter = Static<typeof AgentFrontmatter>;
export type ProfilesFile = Static<typeof ProfilesFile>;

export function parseStrict<T extends TSchema>(
	schema: T,
	value: unknown,
	where: string,
): Static<T> {
	if (!Value.Check(schema, value)) {
		const errors = [...Value.Errors(schema, value)]
			.slice(0, 3)
			.map((error) => `${error.instancePath || "/"} ${error.message}`);
		throw new Error(`${where}: ${errors.join("; ")}`);
	}
	return value as Static<T>;
}

export function readJsonStrict<T extends TSchema>(
	schema: T,
	file: string,
): Static<T> {
	const content = readFileSync(file, "utf8");
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch (error) {
		throw new Error(`${file}: invalid JSON`, { cause: error });
	}
	return parseStrict(schema, value, file);
}

export function writeJsonAtomic(file: string, value: unknown): void {
	const temporary = join(dirname(file), `.tmp-${randomUUID()}`);
	writeFileSync(temporary, JSON.stringify(value), { flag: "wx" });
	renameSync(temporary, file);
}
