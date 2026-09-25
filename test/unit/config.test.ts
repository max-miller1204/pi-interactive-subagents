import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import {
	ProjectTrustStore,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import {
	type ConfigContext,
	discoverAgents,
	loadProfiles,
	projectConfigAllowed,
	trustFlag,
} from "../../src/config.ts";

function put(file: string, text: string) {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
	return file;
}
function fixture(t: TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "subagent-config-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "user");
	const cwd = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	const own = put(join(root, "package/src/index.ts"), "");
	const ctx: ConfigContext = {
		cwd,
		isProjectTrusted: () => true,
		modelRegistry: {
			find: (provider, id) =>
				id === "missing"
					? undefined
					: {
							provider,
							id,
							name: id,
							api: "openai-completions",
							baseUrl: "https://example.invalid",
							reasoning: false,
							input: ["text"],
							contextWindow: 1000,
							maxTokens: 100,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
			getRegisteredProviderIds: () => ["custom", "llama.cpp"],
		},
	};
	const agent = (
		scope: "package" | "user" | "project",
		name: string,
		text: string,
	) =>
		put(
			join(
				scope === "package"
					? join(root, "package/agents")
					: scope === "user"
						? join(agentDir, "agents")
						: join(cwd, ".pi/agents"),
				name,
			),
			text,
		);
	const profiles = (value: unknown, project = false) =>
		put(
			join(project ? join(cwd, ".pi") : agentDir, "subagent-profiles.json"),
			JSON.stringify(value),
		);
	return { root, agentDir, cwd, own, ctx, agent, profiles };
}
const markdown = (
	fields = "description: Scout\ntools: [read]",
	body = "Read the code.",
) => `---\n${fields}\n---\n${body}`;
const profile = (changes = {}) => ({
	profiles: {
		quick: {
			model: "openai/gpt-4o",
			thinking: "off",
			guidance: "Use for short tasks.",
			...changes,
		},
	},
});

for (const [label, text, expected] of [
	[
		"unknown field",
		markdown("description: Scout\ntools: []\nname: scout"),
		/\/name/,
	],
	["wrong type", markdown("description: Scout\ntools: read"), /\/tools/],
	[
		"bad YAML",
		markdown("description: [broken\ntools: []"),
		/YAML|flow|collection/i,
	],
	[
		"empty body",
		markdown(undefined, "  \n"),
		/the agent body \(system prompt\) is empty/,
	],
	[
		"self spawn",
		markdown("description: Scout\ntools: []\nspawns: [scout]"),
		/an agent cannot spawn itself/,
	],
	["missing fields", markdown("skills: none"), /description|tools/],
	["scalar YAML", markdown("false"), /must be object/],
	["empty description", markdown("description: ''\ntools: []"), /description/],
	[
		"duplicate skills",
		markdown("description: Scout\ntools: []\nskills: [code, code]"),
		/skills/,
	],
	[
		"empty skill name",
		markdown("description: Scout\ntools: []\nskills: ['']"),
		/skills/,
	],
	[
		"unknown skill mode",
		markdown("description: Scout\ntools: []\nskills: some"),
		/skills/,
	],
	[
		"bad spawn name",
		markdown("description: Scout\ntools: []\nspawns: [Bad]"),
		/spawns/,
	],
	[
		"duplicate spawns",
		markdown("description: Scout\ntools: []\nspawns: [other, other]"),
		/spawns/,
	],
	[
		"duplicate tools",
		markdown("description: Scout\ntools: [read, read]"),
		/duplicate/,
	],
	[
		"bad tool name",
		markdown("description: Scout\ntools: [bad.tool]"),
		/pattern/,
	],
	[
		"empty skills",
		markdown("description: Scout\ntools: []\nskills: []"),
		/skills/,
	],
	[
		"bad session",
		markdown("description: Scout\ntools: []\nsession: bad"),
		/session/,
	],
	[
		"bad boolean",
		markdown("description: Scout\ntools: []\nauto-exit: 'yes'"),
		/auto-exit/,
	],
	[
		"bad prompt mode",
		markdown("description: Scout\ntools: []\nsystem-prompt: bad"),
		/system-prompt/,
	],
	[
		"bad hidden flag",
		markdown(
			"description: Scout\ntools: []\ndisable-model-invocation: 'false'",
		),
		/disable-model-invocation/,
	],
	[
		"long description",
		markdown(`description: ${"a".repeat(301)}\ntools: []`),
		/description/,
	],
] as const) {
	test(`frontmatter rejects ${label}`, (t) => {
		const f = fixture(t);
		const file = f.agent("user", "scout.md", text);
		const entry = discoverAgents(f.ctx, f.own, f.agentDir).agents.get("scout");
		assert.ok(entry && "error" in entry);
		assert.equal(entry.file, file);
		assert.equal(entry.scope, "user");
		assert.match(entry.error, expected);
		assert.ok(entry.error.startsWith(`${file}:`));
	});
}
for (const tool of [
	"subagent",
	"subagent_message",
	"subagents_list",
	"ask_question",
]) {
	test(`frontmatter rejects managed tool ${tool}`, (t) => {
		const f = fixture(t);
		const file = f.agent(
			"user",
			"scout.md",
			markdown(`description: Scout\ntools: [${tool}]`),
		);
		assert.deepEqual(
			discoverAgents(f.ctx, f.own, f.agentDir).agents.get("scout"),
			{
				name: "scout",
				file,
				scope: "user",
				error: `${file}: do not list ${tool} in tools. The extension adds it.`,
			},
		);
	});
}
for (const filename of [
	"Bad.md",
	"-bad.md",
	`${"a".repeat(33)}.md`,
	"a_b.md",
]) {
	test(`discovery rejects file name ${filename}`, (t) => {
		const f = fixture(t);
		const file = f.agent("user", filename, markdown());
		const entry = discoverAgents(f.ctx, f.own, f.agentDir).agents.get(
			filename.slice(0, -3),
		);
		assert.deepEqual(entry, {
			name: filename.slice(0, -3),
			file,
			scope: "user",
			error: `${file}: an agent file name must be 1 to 32 lowercase letters, digits or dashes, and end in .md.`,
		});
	});
}
test("installed parser accepts BOM and CRLF; defaults follow strict validation", (t) => {
	const f = fixture(t);
	const text = `\uFEFF${markdown().replaceAll("\n", "\r\n")}`;
	assert.deepEqual(parseFrontmatter(text).frontmatter, {
		description: "Scout",
		tools: ["read"],
	});
	const file = f.agent("user", "scout.md", text);
	assert.deepEqual(
		discoverAgents(f.ctx, f.own, f.agentDir).agents.get("scout"),
		{
			name: "scout",
			file,
			scope: "user",
			description: "Scout",
			tools: ["read"],
			skills: "none",
			spawns: [],
			session: "standalone",
			autoExit: true,
			modelInvocable: true,
			systemPrompt: { mode: "append", text: "Read the code." },
		},
	);
});
test("explicit optional fields are retained and files use real paths", (t) => {
	const f = fixture(t);
	const target = put(
		join(f.root, "definition.md"),
		markdown(
			"description: Scout\ntools: []\nskills: [coding]\nspawns: []\nsession: fork\nauto-exit: false\nsystem-prompt: replace\ndisable-model-invocation: true",
		),
	);
	mkdirSync(join(f.agentDir, "agents"));
	symlinkSync(target, join(f.agentDir, "agents/scout.md"));
	const entry = discoverAgents(f.ctx, f.own, f.agentDir).agents.get("scout");
	assert.ok(entry && !("error" in entry));
	assert.equal(entry.file, target);
	assert.equal(entry.autoExit, false);
	assert.equal(entry.modelInvocable, false);
	assert.equal(entry.session, "fork");
	assert.equal(entry.systemPrompt.mode, "replace");
	assert.deepEqual(entry.skills, ["coding"]);
});
test("scope precedence keeps invalid higher files and ignores non-markdown files", (t) => {
	const f = fixture(t);
	new ProjectTrustStore(f.agentDir).set(f.cwd, true);
	f.agent("package", "scout.md", markdown());
	f.agent("user", "scout.md", markdown("description: User\ntools: []"));
	assert.equal(
		discoverAgents(f.ctx, f.own, f.agentDir).agents.get("scout")?.scope,
		"user",
	);
	const file = f.agent("project", "scout.md", markdown("tools: []"));
	f.agent("user", "notes.txt", "ignored");
	const result = discoverAgents(f.ctx, f.own, f.agentDir);
	assert.equal(result.agents.size, 1);
	const entry = result.agents.get("scout");
	assert.ok(entry && "error" in entry);
	assert.equal(entry.file, file);
	assert.equal(entry.scope, "project");
});
test("spawns rejects unknown and hidden names after all scopes are selected", (t) => {
	const f = fixture(t);
	const unknown = f.agent(
		"user",
		"unknown.md",
		markdown("description: Scout\ntools: []\nspawns: [missing]"),
	);
	f.agent("package", "hidden.md", markdown());
	f.agent(
		"user",
		"hidden.md",
		markdown(
			"description: Hidden\ntools: []\ndisable-model-invocation: true\nspawns: [missing]",
		),
	);
	const caller = f.agent(
		"user",
		"caller.md",
		markdown("description: Caller\ntools: []\nspawns: [hidden]"),
	);
	const result = discoverAgents(f.ctx, f.own, f.agentDir);
	assert.deepEqual(result.agents.get("unknown"), {
		name: "unknown",
		file: unknown,
		scope: "user",
		error: `${unknown}: spawns lists unknown agent "missing".`,
	});
	assert.deepEqual(result.agents.get("caller"), {
		name: "caller",
		file: caller,
		scope: "user",
		error: `${caller}: spawns lists "hidden", but "hidden" has disable-model-invocation.`,
	});
});
for (const [label, trusted, resources, saved, allowed] of [
	["trusted with resources", true, true, null, true],
	["trusted without decision", true, false, null, false],
	["saved true", true, false, true, true],
	["saved false", false, false, false, false],
	["session denied despite saved true", false, false, true, false],
	["saved false despite session trust", true, false, false, false],
] as const) {
	test(`project trust: ${label}`, (t) => {
		const f = fixture(t);
		f.ctx.isProjectTrusted = () => trusted;
		f.agent("project", "local.md", markdown());
		f.profiles(profile(), true);
		if (resources) put(join(f.cwd, ".pi/settings.json"), "{}");
		if (saved !== null) new ProjectTrustStore(f.agentDir).set(f.cwd, saved);
		assert.equal(projectConfigAllowed(f.ctx, f.agentDir), allowed);
		const result = discoverAgents(f.ctx, f.own, f.agentDir);
		assert.equal(result.agents.has("local"), allowed);
		assert.deepEqual(result.ignoredProjectAgents, allowed ? [] : ["local"]);
		assert.equal(result.projectFilesIgnored, !allowed);
	});
}
test("closed gate lists project names without resolving their file links", (t) => {
	const f = fixture(t);
	mkdirSync(join(f.cwd, ".pi/agents"), { recursive: true });
	symlinkSync(join(f.root, "missing.md"), join(f.cwd, ".pi/agents/local.md"));
	assert.deepEqual(
		discoverAgents(f.ctx, f.own, f.agentDir).ignoredProjectAgents,
		["local"],
	);
});
test("closed gate does not parse project agents or project profiles", (t) => {
	const f = fixture(t);
	f.agent("project", "local.md", markdown("[bad yaml"));
	f.profiles(profile());
	put(join(f.cwd, ".pi/subagent-profiles.json"), "not JSON");
	assert.deepEqual(
		discoverAgents(f.ctx, f.own, f.agentDir).ignoredProjectAgents,
		["local"],
	);
	assert.equal(loadProfiles(f.ctx, f.agentDir).quick?.model.provider, "openai");
	new ProjectTrustStore(f.agentDir).set(f.cwd, true);
	assert.throws(() => loadProfiles(f.ctx, f.agentDir), /invalid JSON/);
});
test("profile selection reports missing files and lets the project replace the user", (t) => {
	const f = fixture(t);
	assert.throws(
		() => loadProfiles(f.ctx, f.agentDir),
		/No subagent profiles\. Create .* or .*\./,
	);
	f.profiles(profile());
	f.profiles(profile({ guidance: "Project" }), true);
	new ProjectTrustStore(f.agentDir).set(f.cwd, true);
	assert.equal(loadProfiles(f.ctx, f.agentDir).quick?.guidance, "Project");
	f.profiles({ profiles: {} }, true);
	assert.throws(() => loadProfiles(f.ctx, f.agentDir), /properties/);
});
for (const changes of [
	{ extra: true },
	{ model: "invalid" },
	{ thinking: "bad" },
	{ guidance: "" },
	{ extensions: [] },
	{ thinking: "high" },
	{ model: "openai/missing" },
	{ model: "custom/model" },
	{ extensions: ["provider.ts"] },
	{ model: "llama.cpp/model", extensions: ["provider.ts"] },
]) {
	test(`profiles reject ${JSON.stringify(changes)}`, (t) => {
		const f = fixture(t);
		put(join(f.agentDir, "provider.ts"), "");
		f.profiles(profile(changes));
		assert.throws(() => loadProfiles(f.ctx, f.agentDir));
	});
}
test("profiles resolve relative extension files and slash-containing model IDs", (t) => {
	const f = fixture(t);
	const path = put(join(f.root, "provider.ts"), "");
	symlinkSync(path, join(f.agentDir, "provider.ts"));
	f.profiles(
		profile({ model: "custom/org/model", extensions: ["provider.ts"] }),
	);
	assert.deepEqual(loadProfiles(f.ctx, f.agentDir).quick, {
		model: { provider: "custom", id: "org/model" },
		thinking: "off",
		guidance: "Use for short tasks.",
		extensions: [path],
	});
});
test("llama.cpp needs no extension in either CLI or bare SDK registry", (t) => {
	const f = fixture(t);
	f.profiles(profile({ model: "llama.cpp/model" }));
	assert.deepEqual(loadProfiles(f.ctx, f.agentDir).quick?.extensions, []);
	f.ctx.modelRegistry.getRegisteredProviderIds = () => [];
	assert.deepEqual(loadProfiles(f.ctx, f.agentDir).quick?.extensions, []);
});
test("profiles fail when extension files are missing or alias the same file", (t) => {
	const f = fixture(t);
	f.profiles(profile({ model: "custom/model", extensions: ["missing.ts"] }));
	assert.throws(() => loadProfiles(f.ctx, f.agentDir), /ENOENT/);
	const path = put(join(f.agentDir, "provider.ts"), "");
	symlinkSync(path, join(f.agentDir, "alias.ts"));
	f.profiles(
		profile({ model: "custom/model", extensions: ["provider.ts", "alias.ts"] }),
	);
	assert.throws(
		() => loadProfiles(f.ctx, f.agentDir),
		/Two extension paths point to one file:/,
	);
});
test("profile extension spellings are checked before lexical normalization", (t) => {
	const f = fixture(t);
	put(join(f.agentDir, "provider.ts"), "");
	f.profiles(
		profile({
			model: "custom/model",
			extensions: ["provider.ts", "./provider.ts"],
		}),
	);
	assert.throws(
		() => loadProfiles(f.ctx, f.agentDir),
		/Two extension paths point to one file:/,
	);
});
test("profile errors give the provider source instructions", (t) => {
	const f = fixture(t);
	f.profiles(profile({ model: "custom/model" }));
	assert.throws(() => loadProfiles(f.ctx, f.agentDir), {
		message:
			'Profile "quick" uses provider "custom", which an extension registers. Add that extension\'s path to "extensions".',
	});
	f.profiles(profile({ extensions: ["provider.ts"] }));
	assert.throws(() => loadProfiles(f.ctx, f.agentDir), {
		message:
			'Profile "quick": "extensions" is only for providers that an extension registers.',
	});
	f.profiles(profile({ model: "custom/missing", extensions: ["provider.ts"] }));
	assert.throws(() => loadProfiles(f.ctx, f.agentDir), {
		message:
			'Profile "quick": model "custom/missing" is not available in this Pi. If an extension provides it, load that extension in this Pi too.',
	});
});
test("all profiles are validated and profile records reject unknown fields and bad names", (t) => {
	const f = fixture(t);
	for (const value of [
		{ ...profile(), extra: true },
		{ profiles: { Bad: profile().profiles.quick } },
		{
			profiles: {
				...profile().profiles,
				other: { ...profile().profiles.quick, thinking: "high" },
			},
		},
	]) {
		f.profiles(value);
		assert.throws(() => loadProfiles(f.ctx, f.agentDir));
	}
});
test("thinking validation uses the model's supported levels", (t) => {
	const f = fixture(t);
	const find = f.ctx.modelRegistry.find;
	f.ctx.modelRegistry.find = (provider, id) => {
		const model = find(provider, id);
		assert.ok(model);
		return {
			...model,
			reasoning: true,
			thinkingLevelMap: { high: null, xhigh: "xhigh" },
		};
	};
	f.profiles(profile({ thinking: "xhigh" }));
	assert.equal(loadProfiles(f.ctx, f.agentDir).quick?.thinking, "xhigh");
	f.profiles(profile({ thinking: "high" }));
	assert.throws(
		() => loadProfiles(f.ctx, f.agentDir),
		/thinking level "high" is not supported/,
	);
});
test("trustFlag uses current context for equal real cwd and saved trust elsewhere", (t) => {
	const f = fixture(t);
	const alias = join(f.root, "alias");
	symlinkSync(f.cwd, alias);
	const other = join(f.root, "other");
	mkdirSync(other);
	assert.equal(trustFlag(f.ctx, alias, f.agentDir), "--approve");
	f.ctx.isProjectTrusted = () => false;
	assert.equal(trustFlag(f.ctx, alias, f.agentDir), "--no-approve");
	assert.equal(trustFlag(f.ctx, other, f.agentDir), "--no-approve");
	new ProjectTrustStore(f.agentDir).set(other, true);
	assert.equal(trustFlag(f.ctx, other, f.agentDir), "--approve");
	new ProjectTrustStore(f.agentDir).set(other, false);
	assert.equal(trustFlag(f.ctx, other, f.agentDir), "--no-approve");
});
