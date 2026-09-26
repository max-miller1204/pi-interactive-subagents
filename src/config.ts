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
import { Value } from "typebox/value";
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

function agentFiles(directory: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.name.endsWith(".md") &&
				(entry.isFile() || entry.isSymbolicLink()),
		)
		.map((entry) => entry.name)
		.sort();
}

function parseAgentFrontmatter(value: unknown, file: string): AgentFrontmatter {
	try {
		return parseStrict(AgentFrontmatter, value, file);
	} catch (error) {
		const errors = [...Value.Errors(AgentFrontmatter, value)];
		const first = errors[0];
		if (!first) throw error;
		const issue =
			first.instancePath === "/skills" &&
			typeof value === "object" &&
			value !== null &&
			"skills" in value &&
			Array.isArray(value.skills)
				? (errors.find(
						(item) =>
							item.schemaPath.startsWith("#/properties/skills/anyOf/2") &&
							item.keyword !== "type",
					) ?? first)
				: first;
		const field = issue.instancePath.slice(1).replace(/\/(\d+)/g, "[$1]");
		let message: string;
		if (
			issue.keyword === "boolean" &&
			issue.schemaPath === "#/additionalProperties"
		)
			message = `unknown field "${field}".`;
		else if (issue.keyword === "required")
			message = `missing required field "${String(issue.params.requiredProperties[0])}".`;
		else if (field === "session")
			message = 'field "session" must be "standalone" or "fork".';
		else if (field === "system-prompt")
			message = 'field "system-prompt" must be "append" or "replace".';
		else if (field === "skills" && issue.keyword === "const")
			message =
				'field "skills" must be "all", "none", or a nonempty list of skill names.';
		else if (issue.keyword === "type") {
			const type = issue.params.type;
			const expected =
				type === "array"
					? "a list"
					: type === "boolean"
						? "true or false"
						: type === "string"
							? "text"
							: String(type);
			message = `field "${field}" must be ${expected}.`;
		} else if (issue.keyword === "uniqueItems")
			message = `field "${field}" has duplicate items.`;
		else if (issue.keyword === "minLength")
			message = `field "${field}" must contain at least ${issue.params.limit} character${issue.params.limit === 1 ? "" : "s"}.`;
		else if (issue.keyword === "maxLength")
			message = `field "${field}" must contain at most ${issue.params.limit} characters.`;
		else if (issue.keyword === "minItems")
			message = `field "${field}" must contain at least ${issue.params.limit} item${issue.params.limit === 1 ? "" : "s"}.`;
		else if (issue.keyword === "pattern" && field.startsWith("tools["))
			message = `field "${field}" must contain only letters, digits, underscores, or dashes.`;
		else if (issue.keyword === "pattern" && field.startsWith("spawns["))
			message = `field "${field}" must be an agent name with 1 to 32 lowercase letters, digits, or dashes.`;
		else message = `field "${field}" ${issue.message}.`;
		throw new Error(`${file}: ${message}`, { cause: error });
	}
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
			let file = join(realpathSync(directory), filename);
			try {
				if (!statSync(file).isFile())
					throw new Error("the agent path is not a regular file.");
				file = realpathSync(file);
				if (!AGENT_FILE.test(filename))
					throw new Error(
						"an agent file name must be 1 to 32 lowercase letters, digits or dashes, and end in .md.",
					);
				const parsed = parseFrontmatter(readFileSync(file, "utf8"));
				const fm = parseAgentFrontmatter(parsed.frontmatter, file);
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
			: agentFiles(projectDir).map((file) => file.slice(0, -3)),
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
