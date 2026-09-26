import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
	type ExtensionAPI,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	type AgentError,
	type ConfigContext,
	discoverAgents,
	loadProfiles,
	resolveExtensionPaths,
} from "./config.ts";
import {
	type AgentDef,
	Catalog,
	LaunchDraft,
	MAX_DEPTH,
	type ProfileDef,
	parseStrict,
	type ToolSource,
} from "./schema.ts";

export interface LiveCatalog {
	catalog: Catalog;
	errors: AgentError[];
	ignoredProjectAgents: string[];
	projectFilesIgnored: boolean;
	profileError: string | null;
	ownExtensionPath: string;
	// Keep source spellings outside the snapshot to detect aliases before launch.
	extensionPaths: {
		tools: Record<string, string>;
		profiles: Record<string, string[]>;
	};
}
export type CatalogInput = Catalog | LiveCatalog;
type CatalogAPI = Pick<ExtensionAPI, "getAllTools" | "getCommands">;

export function buildLiveCatalog(
	pi: CatalogAPI,
	ctx: ConfigContext,
	ownExtensionPath: string,
	agentDir = getAgentDir(),
): LiveCatalog {
	const own = realpathSync(ownExtensionPath);
	const discovery = discoverAgents(ctx, own, agentDir);
	const agents: [string, AgentDef][] = [];
	const errors: AgentError[] = [];
	for (const [name, entry] of discovery.agents) {
		if ("error" in entry) errors.push(entry);
		else agents.push([name, entry]);
	}
	const extensionPaths: LiveCatalog["extensionPaths"] = {
		tools: Object.create(null),
		profiles: Object.create(null),
	};
	let profiles: Catalog["profiles"] = {};
	let profileError: string | null = null;
	try {
		profiles = loadProfiles(ctx, agentDir, (name, paths) => {
			extensionPaths.profiles[name] = paths;
		});
	} catch (error) {
		profileError = error instanceof Error ? error.message : String(error);
	}
	const toolSources: [string, ToolSource][] = [];
	for (const tool of pi.getAllTools()) {
		const { path, source } = tool.sourceInfo;
		let entry: ToolSource;
		if (source === "builtin") entry = { kind: "builtin" };
		else if (isAbsolute(path) && existsSync(path)) {
			const real = realpathSync(path);
			entry =
				real === own ? { kind: "own" } : { kind: "extension", path: real };
			if (entry.kind === "extension") extensionPaths.tools[tool.name] = path;
		} else
			entry = {
				kind: "unavailable",
				reason: `tool ${tool.name} comes from ${path}, which a child process cannot load`,
			};
		toolSources.push([tool.name, entry]);
	}
	const skills: [string, string][] = [];
	for (const command of pi.getCommands()) {
		if (command.source !== "skill" || !command.name.startsWith("skill:"))
			continue;
		const path = command.sourceInfo.path;
		if (!isAbsolute(path))
			throw new Error(
				`Skill "${command.name.slice(6)}" has a non-absolute path: ${path}.`,
			);
		skills.push([command.name.slice(6), realpathSync(path)]);
	}
	return {
		catalog: parseStrict(
			Catalog,
			{
				agents: Object.fromEntries(agents),
				profiles,
				toolSources: Object.fromEntries(toolSources),
				skills: Object.fromEntries(skills),
			},
			"Live catalog",
		),
		errors,
		ignoredProjectAgents: discovery.ignoredProjectAgents,
		projectFilesIgnored: discovery.projectFilesIgnored,
		profileError,
		ownExtensionPath: own,
		extensionPaths,
	};
}

function isLive(input: CatalogInput): input is LiveCatalog {
	return "catalog" in input;
}
function getOwn<T>(record: Record<string, T>, name: string): T | undefined {
	return Object.hasOwn(record, name) ? record[name] : undefined;
}
function getAgent(input: CatalogInput, name: string): AgentDef {
	const catalog = isLive(input) ? input.catalog : input;
	const agent = getOwn(catalog.agents, name);
	if (agent) return agent;
	if (isLive(input)) {
		const error = input.errors.find((entry) => entry.name === name);
		if (error) throw new Error(error.error);
		if (input.ignoredProjectAgents.includes(name))
			throw new Error(
				`Project agent "${name}" is ignored because this folder has no trust decision. Run /trust first.`,
			);
	}
	throw new Error(`Unknown agent "${name}".`);
}
function toolPaths(input: CatalogInput, agent: AgentDef): string[] {
	const catalog = isLive(input) ? input.catalog : input;
	const paths: string[] = [];
	for (const tool of agent.tools) {
		const source = getOwn(catalog.toolSources, tool);
		if (!source)
			throw new Error(
				`Tool "${tool}" is not loaded in the parent. Load the extension that provides it.`,
			);
		if (source.kind === "unavailable") throw new Error(source.reason);
		if (source.kind === "extension") {
			const path = isLive(input)
				? getOwn(input.extensionPaths.tools, tool)
				: source.path;
			if (path === undefined)
				throw new Error(`Missing extension provenance for tool "${tool}".`);
			paths.push(path);
		}
	}
	return [...new Set(paths)].sort();
}
function skillNames(catalog: Catalog, agent: AgentDef): string[] {
	if (agent.skills === "none") return [];
	if (agent.skills === "all") return Object.keys(catalog.skills).sort();
	return agent.skills;
}
function skillPaths(catalog: Catalog, agent: AgentDef): string[] {
	const paths = skillNames(catalog, agent).map((name) => {
		const path = getOwn(catalog.skills, name);
		if (path === undefined)
			throw new Error(
				`Unknown skill "${name}". Known: ${Object.keys(catalog.skills).sort().join(", ")}`,
			);
		if (!isAbsolute(path))
			throw new Error(`Skill "${name}" has a non-absolute path: ${path}.`);
		return realpathSync(path);
	});
	return [...new Set(agent.skills === "all" ? paths.sort() : paths)];
}
function extensions(
	input: CatalogInput,
	tools: string[],
	profileName: string,
	profile: ProfileDef,
): string[] {
	const paths = isLive(input)
		? getOwn(input.extensionPaths.profiles, profileName)
		: profile.extensions;
	if (!paths)
		throw new Error(
			`Missing extension provenance for profile "${profileName}".`,
		);
	// Validate original spellings before sorting the real tool paths.
	resolveExtensionPaths([
		...(isLive(input) ? [input.ownExtensionPath] : []),
		...tools,
		...paths,
	]);
	const result = resolveExtensionPaths([
		...resolveExtensionPaths(tools).sort(),
		...resolveExtensionPaths(paths),
	]);
	return isLive(input)
		? result.filter((path) => path !== input.ownExtensionPath)
		: result;
}

export interface ResolveLaunchOptions {
	catalog: CatalogInput;
	name: string;
	agent: string;
	profile: string;
	spawnerDepth: number;
	spawnerAllowlist: readonly string[];
	parentCwd: string;
	cwd: string;
	modelInvocation: boolean;
}

export function resolveLaunch(options: ResolveLaunchOptions): LaunchDraft {
	const { catalog: input, spawnerDepth, spawnerAllowlist } = options;
	const catalog = isLive(input) ? input.catalog : input;
	const agent = getAgent(input, options.agent);
	if (options.modelInvocation && !agent.modelInvocable)
		throw new Error(`Agent "${agent.name}" has disable-model-invocation.`);
	if (!spawnerAllowlist.includes(options.agent))
		throw new Error(
			`Agent "${options.agent}" is not in the spawn allowlist of this agent. Allowed: ${spawnerAllowlist.join(", ")}`,
		);
	const depth = spawnerDepth + 1;
	if (!Number.isInteger(spawnerDepth) || spawnerDepth < 0 || depth > MAX_DEPTH)
		throw new Error(`Subagent depth must be between 1 and ${MAX_DEPTH}.`);
	if (isLive(input) && input.profileError !== null)
		throw new Error(input.profileError);
	const profile = getOwn(catalog.profiles, options.profile);
	if (!profile) throw new Error(`Unknown profile "${options.profile}".`);
	const paths = toolPaths(input, agent);
	const skills = skillPaths(catalog, agent);
	const launchExtensions = extensions(input, paths, options.profile, profile);
	const childAllow = agent.spawns.filter(
		(name) =>
			spawnerAllowlist.includes(name) &&
			(spawnerDepth === 0 || Object.hasOwn(catalog.agents, name)),
	);
	const spawnRights = depth < MAX_DEPTH && childAllow.length > 0;
	let nested: Catalog | null = null;
	if (spawnRights) {
		const nestedAgents: [string, AgentDef][] = [];
		const nestedTools = new Map<string, ToolSource>();
		const nestedSkills = new Map<string, string>();
		for (const name of childAllow) {
			const child = getAgent(input, name);
			const childTools = toolPaths(input, child);
			skillPaths(catalog, child);
			// All profiles remain selectable in the child.
			for (const [profileName, childProfile] of Object.entries(
				catalog.profiles,
			))
				extensions(input, childTools, profileName, childProfile);
			nestedAgents.push([name, { ...child, file: realpathSync(child.file) }]);
			for (const tool of child.tools) {
				const source = getOwn(catalog.toolSources, tool);
				if (!source) throw new Error(`Missing validated tool "${tool}".`);
				nestedTools.set(
					tool,
					source.kind === "extension"
						? { kind: "extension", path: realpathSync(source.path) }
						: source,
				);
			}
			for (const skill of skillNames(catalog, child)) {
				const path = getOwn(catalog.skills, skill);
				if (path === undefined)
					throw new Error(`Missing validated skill "${skill}".`);
				nestedSkills.set(skill, realpathSync(path));
			}
		}
		nested = {
			agents: Object.fromEntries(nestedAgents),
			profiles: Object.fromEntries(
				Object.entries(catalog.profiles).map(([name, value]) => [
					name,
					{ ...value, extensions: resolveExtensionPaths(value.extensions) },
				]),
			),
			toolSources: Object.fromEntries(nestedTools),
			skills: Object.fromEntries(nestedSkills),
		};
	}
	const parentCwd = realpathSync(options.parentCwd);
	const cwd = realpathSync(resolve(parentCwd, options.cwd));
	if (!statSync(cwd).isDirectory())
		throw new Error(`Subagent cwd is not a directory: ${cwd}.`);
	if (agent.session === "fork" && cwd !== parentCwd)
		throw new Error("A fork subagent runs in the parent's directory.");
	return structuredClone(
		parseStrict(
			LaunchDraft,
			{
				name: options.name,
				agent: options.agent,
				profile: options.profile,
				cwd,
				session: agent.session,
				autoExit: agent.autoExit,
				model: profile.model,
				thinking: profile.thinking,
				systemPrompt: agent.systemPrompt,
				tools: [
					...agent.tools,
					"ask_question",
					...(spawnRights
						? ["subagent", "subagent_message", "subagents_list"]
						: []),
				],
				extensions: launchExtensions,
				skills,
				depth,
				nested,
			},
			"LaunchDraft",
		),
	);
}

export function catalogSummary(
	input: CatalogInput,
	allowlist?: readonly string[],
): string {
	const catalog = isLive(input) ? input.catalog : input;
	const lines = ["Agents:"];
	for (const [name, agent] of Object.entries(catalog.agents).sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		if (allowlist ? !allowlist.includes(name) : !agent.modelInvocable) continue;
		lines.push(
			`${name} (${agent.scope}): ${agent.description}; tools: ${agent.tools.join(", ")}; skills: ${Array.isArray(agent.skills) ? agent.skills.join(", ") : agent.skills}; session: ${agent.session}; auto-exit: ${agent.autoExit}`,
		);
	}
	if (isLive(input)) {
		for (const error of input.errors) lines.push(`Error: ${error.error}`);
		if (input.projectFilesIgnored)
			lines.push(
				"Project subagent files are ignored because this folder has no trust decision. Run /trust to use them.",
			);
		for (const name of input.ignoredProjectAgents)
			lines.push(`Ignored project agent: ${name}`);
	}
	lines.push("Profiles:");
	if (isLive(input) && input.profileError !== null)
		lines.push(`Error: ${input.profileError}`);
	else
		for (const [name, profile] of Object.entries(catalog.profiles).sort(
			([a], [b]) => a.localeCompare(b),
		))
			lines.push(
				`${name}: ${profile.model.provider}/${profile.model.id}; thinking: ${profile.thinking}; ${profile.guidance}`,
			);
	return lines.join("\n");
}
