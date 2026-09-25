import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionContext,
	getAgentDir,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import {
	type AgentDef,
	AgentFrontmatter,
	type Catalog,
	type ProfileDef,
	ProfilesFile,
	parseStrict,
	readJsonStrict,
} from "./schema.ts";

export type TrustContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;
export type ConfigContext = TrustContext & {
	modelRegistry: Pick<
		ExtensionContext["modelRegistry"],
		"find" | "getRegisteredProviderIds"
	>;
};
export interface AgentError {
	name: string;
	file: string;
	scope: AgentDef["scope"];
	error: string;
}
export interface AgentDiscovery {
	agents: Map<string, AgentDef | AgentError>;
	ignoredProjectAgents: string[];
	projectFilesIgnored: boolean;
}
export const BUILTIN_EXTENSION_PROVIDERS: readonly string[] = ["llama.cpp"];
const AGENT_FILE = /^[a-z0-9][a-z0-9-]{0,31}\.md$/;
const MANAGED_TOOLS = new Set([
	"subagent",
	"subagent_message",
	"subagents_list",
	"ask_question",
]);

export function projectConfigAllowed(
	ctx: TrustContext,
	agentDir = getAgentDir(),
): boolean {
	const cwd = realpathSync(ctx.cwd);
	return (
		ctx.isProjectTrusted() &&
		(hasTrustRequiringProjectResources(cwd) ||
			new ProjectTrustStore(agentDir).get(cwd) === true)
	);
}

export function trustFlag(
	ctx: TrustContext,
	cwd: string,
	agentDir = getAgentDir(),
): "--approve" | "--no-approve" {
	const realCwd = realpathSync(cwd);
	const trusted =
		realCwd === realpathSync(ctx.cwd)
			? ctx.isProjectTrusted()
			: new ProjectTrustStore(agentDir).get(realCwd) === true;
	return trusted ? "--approve" : "--no-approve";
}

function agentFiles(directory: string, inspectSymlinks = true): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.name.endsWith(".md") &&
				(entry.isFile() ||
					(entry.isSymbolicLink() &&
						(!inspectSymlinks ||
							statSync(join(directory, entry.name)).isFile()))),
		)
		.map((entry) => entry.name)
		.sort();
}

export function discoverAgents(
	ctx: TrustContext,
	ownExtensionPath: string,
	agentDir = getAgentDir(),
): AgentDiscovery {
	const cwd = realpathSync(ctx.cwd);
	const own = realpathSync(ownExtensionPath);
	const projectDir = join(cwd, CONFIG_DIR_NAME, "agents");
	const allowed = projectConfigAllowed(ctx, agentDir);
	const agents = new Map<string, AgentDef | AgentError>();
	const directories: [AgentDef["scope"], string][] = [
		["package", join(dirname(dirname(own)), "agents")],
		["user", join(agentDir, "agents")],
	];
	if (allowed) directories.push(["project", projectDir]);
	for (const [scope, directory] of directories) {
		for (const filename of agentFiles(directory)) {
			const name = filename.slice(0, -3);
			const file = realpathSync(join(directory, filename));
			try {
				if (!AGENT_FILE.test(filename))
					throw new Error(
						"an agent file name must be 1 to 32 lowercase letters, digits or dashes, and end in .md.",
					);
				const parsed = parseFrontmatter(readFileSync(file, "utf8"));
				const fm = parseStrict(AgentFrontmatter, parsed.frontmatter, file);
				const body = parsed.body.trim();
				if (!body) throw new Error("the agent body (system prompt) is empty.");
				for (const tool of fm.tools) {
					if (MANAGED_TOOLS.has(tool))
						throw new Error(
							`do not list ${tool} in tools. The extension adds it.`,
						);
				}
				if (fm.spawns?.includes(name))
					throw new Error("an agent cannot spawn itself.");
				agents.set(name, {
					name,
					file,
					scope,
					description: fm.description,
					tools: fm.tools,
					skills: fm.skills ?? "none",
					spawns: fm.spawns ?? [],
					session: fm.session ?? "standalone",
					autoExit: fm["auto-exit"] ?? true,
					modelInvocable: !(fm["disable-model-invocation"] ?? false),
					systemPrompt: { mode: fm["system-prompt"] ?? "append", text: body },
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				agents.set(name, {
					name,
					file,
					scope,
					error: message.startsWith(`${file}:`)
						? message
						: `${file}: ${message}`,
				});
			}
		}
	}
	// Read the selected definitions before replacing entries with reference errors.
	const selected = new Map(agents);
	for (const [name, agent] of selected) {
		if ("error" in agent) continue;
		for (const targetName of agent.spawns) {
			const target = selected.get(targetName);
			let error: string;
			if (!target)
				error = `${agent.file}: spawns lists unknown agent "${targetName}".`;
			else if (!("error" in target) && !target.modelInvocable)
				error = `${agent.file}: spawns lists "${targetName}", but "${targetName}" has disable-model-invocation.`;
			else continue;
			agents.set(name, { name, file: agent.file, scope: agent.scope, error });
			break;
		}
	}
	return {
		agents,
		ignoredProjectAgents: allowed
			? []
			: agentFiles(projectDir, false).map((file) => file.slice(0, -3)),
		projectFilesIgnored:
			!allowed &&
			(existsSync(projectDir) ||
				existsSync(join(cwd, CONFIG_DIR_NAME, "subagent-profiles.json"))),
	};
}

/** Reject distinct spellings before removing repeated extension paths. */
export function resolveExtensionPaths(paths: readonly string[]): string[] {
	const spellings = new Map<string, string>();
	const result: string[] = [];
	for (const path of paths) {
		const real = realpathSync(path);
		const previous = spellings.get(real);
		if (previous !== undefined) {
			if (previous !== path)
				throw new Error(
					`Two extension paths point to one file: ${previous} and ${path}.`,
				);
			continue;
		}
		spellings.set(real, path);
		result.push(real);
	}
	return result;
}

export function loadProfiles(
	ctx: ConfigContext,
	agentDir = getAgentDir(),
	onExtensionPaths?: (profile: string, paths: string[]) => void,
): Catalog["profiles"] {
	const user = join(agentDir, "subagent-profiles.json");
	const project = join(
		realpathSync(ctx.cwd),
		CONFIG_DIR_NAME,
		"subagent-profiles.json",
	);
	let selected: string;
	if (
		projectConfigAllowed(ctx, agentDir) &&
		lstatSync(project, { throwIfNoEntry: false }) !== undefined
	)
		selected = project;
	else if (lstatSync(user, { throwIfNoEntry: false }) !== undefined)
		selected = user;
	else throw new Error(`No subagent profiles. Create ${user} or ${project}.`);
	const file = realpathSync(selected);
	const parsed = readJsonStrict(ProfilesFile, file);
	const profiles: [string, ProfileDef][] = [];
	const registered = ctx.modelRegistry.getRegisteredProviderIds();
	for (const [name, profile] of Object.entries(parsed.profiles)) {
		const slash = profile.model.indexOf("/");
		const provider = profile.model.slice(0, slash);
		const id = profile.model.slice(slash + 1);
		const model = ctx.modelRegistry.find(provider, id);
		if (!model)
			throw new Error(
				`Profile "${name}": model "${profile.model}" is not available in this Pi. If an extension provides it, load that extension in this Pi too.`,
			);
		if (!getSupportedThinkingLevels(model).includes(profile.thinking))
			throw new Error(
				`Profile "${name}": thinking level "${profile.thinking}" is not supported by model "${profile.model}".`,
			);
		const extensionProvider =
			registered.includes(provider) &&
			!BUILTIN_EXTENSION_PROVIDERS.includes(provider);
		if (extensionProvider && !profile.extensions)
			throw new Error(
				`Profile "${name}" uses provider "${provider}", which an extension registers. Add that extension's path to "extensions".`,
			);
		if (!extensionProvider && profile.extensions)
			throw new Error(
				`Profile "${name}": "extensions" is only for providers that an extension registers.`,
			);
		const paths = (profile.extensions ?? []).map((path) =>
			isAbsolute(path) ? path : `${dirname(file)}/${path}`,
		);
		const extensions = resolveExtensionPaths(paths);
		onExtensionPaths?.(name, paths);
		profiles.push([
			name,
			{
				model: { provider, id },
				thinking: profile.thinking,
				guidance: profile.guidance,
				extensions,
			},
		]);
	}
	return Object.fromEntries(profiles);
}
