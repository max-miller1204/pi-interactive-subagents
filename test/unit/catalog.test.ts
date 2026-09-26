import assert from "node:assert/strict";
import {
	existsSync,
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
import type {
	ExtensionAPI,
	SlashCommandInfo,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	buildLiveCatalog,
	catalogSummary,
	resolveLaunch,
} from "../../src/catalog.ts";
import type { ConfigContext } from "../../src/config.ts";
import { Catalog, LaunchDraft, parseStrict } from "../../src/schema.ts";

function put(file: string, content = "") {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
	return file;
}
function fixture(t: TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "subagent-catalog-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const agentDir = join(root, "user");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	const own = put(join(root, "package/src/index.ts"));
	const ownAlias = join(root, "own.ts");
	symlinkSync(own, ownAlias);
	const a = put(join(root, "a.ts"));
	const z = put(join(root, "z.ts"));
	const provider = put(join(root, "provider.ts"));
	const skillA = put(join(root, "a/SKILL.md"));
	const skillZ = put(join(root, "z/SKILL.md"));
	const source = (path: string, kind = "extension") => ({
		path,
		source: kind,
		scope: "user" as const,
		origin: "top-level" as const,
	});
	const tool = (name: string, path: string, kind = "extension"): ToolInfo => ({
		name,
		description: name,
		parameters: Type.Object({}),
		sourceInfo: source(path, kind),
	});
	const skill = (name: string, path: string): SlashCommandInfo => ({
		name: `skill:${name}`,
		source: "skill",
		sourceInfo: source(path, "skill"),
	});
	const tools = [
		tool("read", "<builtin>", "builtin"),
		tool("own_tool", ownAlias),
		tool("a_tool", a),
		tool("z_tool", z),
		tool("a_other", a),
		tool("inline", "<inline:test>"),
		tool("relative", "relative.ts"),
	];
	const commands: SlashCommandInfo[] = [
		skill("a", skillA),
		skill("z", skillZ),
		{
			name: "ignore",
			source: "extension",
			sourceInfo: source("<inline:test>"),
		},
	];
	const pi: Pick<ExtensionAPI, "getAllTools" | "getCommands"> = {
		getAllTools: () => tools,
		getCommands: () => commands,
	};
	const ctx: ConfigContext = {
		cwd,
		isProjectTrusted: () => false,
		modelRegistry: {
			find: (provider, id) => ({
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
			}),
			getRegisteredProviderIds: () => ["custom"],
		},
	};
	const agent = (
		name: string,
		fields = "tools: [read]",
		body = "Do the task.",
	) =>
		put(
			join(agentDir, `agents/${name}.md`),
			`---\ndescription: ${name} description\n${fields}\n---\n${body}`,
		);
	const profiles = (extensions = [provider]) =>
		put(
			join(agentDir, "subagent-profiles.json"),
			JSON.stringify({
				profiles: {
					quick: {
						model: "custom/model",
						thinking: "off",
						guidance: "Short tasks.",
						extensions,
					},
				},
			}),
		);
	agent("worker");
	profiles();
	const build = () => buildLiveCatalog(pi, ctx, ownAlias, agentDir);
	const options = {
		name: "worker-1",
		agent: "worker",
		profile: "quick",
		spawnerDepth: 0,
		spawnerAllowlist: ["worker", "helper", "leaf"],
		cwd,
		parentCwd: cwd,
		modelInvocation: true,
	};
	return {
		root,
		cwd,
		agentDir,
		own,
		ownAlias,
		a,
		z,
		provider,
		skillA,
		skillZ,
		tools,
		commands,
		tool,
		skill,
		agent,
		profiles,
		ctx,
		build,
		options,
	};
}

test("live catalog records builtin, real own extension, external and unavailable sources", (t) => {
	const f = fixture(t);
	const live = f.build();
	assert.deepEqual(live.catalog.toolSources.read, { kind: "builtin" });
	assert.deepEqual(live.catalog.toolSources.own_tool, { kind: "own" });
	assert.deepEqual(live.catalog.toolSources.a_tool, {
		kind: "extension",
		path: f.a,
	});
	assert.deepEqual(live.catalog.toolSources.inline, {
		kind: "unavailable",
		reason:
			"tool inline comes from <inline:test>, which a child process cannot load",
	});
	assert.equal(live.catalog.toolSources.relative?.kind, "unavailable");
	assert.deepEqual(live.catalog.skills, { a: f.skillA, z: f.skillZ });
	parseStrict(Catalog, live.catalog, "catalog");
});
test("launch adds managed tools and deduplicates extensions in tool then profile order", (t) => {
	const f = fixture(t);
	f.agent("worker", "tools: [z_tool, a_tool, a_other, own_tool, read]");
	f.profiles([f.z, f.provider, f.a]);
	const launch = resolveLaunch({ ...f.options, catalog: f.build() });
	assert.deepEqual(launch.extensions, [f.a, f.z, f.provider]);
	assert.deepEqual(launch.tools, [
		"z_tool",
		"a_tool",
		"a_other",
		"own_tool",
		"read",
		"ask_question",
	]);
	assert.equal(launch.nested, null);
	assert.equal(launch.depth, 1);
	assert.equal(launch.name, "worker-1");
	parseStrict(LaunchDraft, launch, "launch draft");
	assert.equal(Object.hasOwn(launch, "childSessionFile"), false);
	assert.equal(existsSync(join(f.root, "child.jsonl")), false);
});
for (const [tool, expected] of [
	["inline", /tool inline comes from <inline:test>/],
	[
		"missing",
		/Tool "missing" is not loaded in the parent\. Load the extension that provides it\./,
	],
	["relative", /cannot load/],
] as const) {
	test(`launch rejects ${tool} tool`, (t) => {
		const f = fixture(t);
		f.agent("worker", `tools: [${tool}]`);
		assert.throws(
			() => resolveLaunch({ ...f.options, catalog: f.build() }),
			expected,
		);
	});
}
for (const [mode, names] of [
	["none", []],
	["all", ["a", "z"]],
	["[z, a]", ["z", "a"]],
] as const) {
	test(`skills mode ${mode}`, (t) => {
		const f = fixture(t);
		f.agent("worker", `tools: []\nskills: ${mode}`);
		const live = f.build();
		const launch = resolveLaunch({ ...f.options, catalog: live });
		assert.deepEqual(
			launch.skills,
			names.map((name) => live.catalog.skills[name]),
		);
	});
}
test("unknown skill fails with known names", (t) => {
	const f = fixture(t);
	f.agent("worker", "tools: []\nskills: [unknown]");
	assert.throws(
		() => resolveLaunch({ ...f.options, catalog: f.build() }),
		/Unknown skill "unknown"\. Known: a, z/,
	);
});
for (const path of ["relative/SKILL.md", "/missing/skill.md"]) {
	test(`live catalog rejects unloadable skill path ${path}`, (t) => {
		const f = fixture(t);
		f.commands.push(f.skill("bad", path));
		assert.throws(f.build);
	});
}
test("launch fails for extension or skill files removed after the catalog build", (t) => {
	const f = fixture(t);
	f.agent("worker", "tools: [a_tool]\nskills: [a]");
	const live = f.build();
	rmSync(f.a);
	assert.throws(() => resolveLaunch({ ...f.options, catalog: live }), /ENOENT/);
	put(f.a);
	rmSync(f.skillA);
	assert.throws(() => resolveLaunch({ ...f.options, catalog: live }), /ENOENT/);
});
test("two spellings of one extension file fail instead of collapsing aliases", (t) => {
	const f = fixture(t);
	const alias = join(f.root, "alias.ts");
	symlinkSync(f.a, alias);
	f.tools.push(f.tool("alias", alias));
	f.agent("worker", "tools: [a_tool, alias]");
	assert.throws(
		() => resolveLaunch({ ...f.options, catalog: f.build() }),
		/Two extension paths point to one file:/,
	);
	f.agent("worker", "tools: [a_tool]");
	f.profiles([alias]);
	assert.throws(
		() => resolveLaunch({ ...f.options, catalog: f.build() }),
		/Two extension paths point to one file:/,
	);
});
test("snapshot catalogs also reject raw extension aliases", (t) => {
	const f = fixture(t);
	f.agent("worker", "tools: [a_tool]");
	const catalog = f.build().catalog;
	const alias = join(f.root, "alias.ts");
	symlinkSync(f.a, alias);
	assert.ok(catalog.profiles.quick);
	catalog.profiles.quick.extensions = [alias];
	assert.throws(
		() => resolveLaunch({ ...f.options, catalog }),
		/Two extension paths point to one file:/,
	);
});
test("allowlist intersection creates a closed nested snapshot", (t) => {
	const f = fixture(t);
	f.agent("worker", "tools: [read]\nspawns: [helper, leaf]");
	f.agent("helper", "tools: [a_tool]\nskills: [a]\nspawns: [leaf]");
	f.agent("leaf", "tools: [z_tool]\nskills: [z]");
	const live = f.build();
	const launch = resolveLaunch({
		...f.options,
		catalog: live,
		spawnerAllowlist: ["worker", "helper"],
	});
	assert.deepEqual(launch.tools, [
		"read",
		"ask_question",
		"subagent",
		"subagent_message",
		"subagents_list",
	]);
	assert.ok(launch.nested);
	assert.deepEqual(Object.keys(launch.nested.agents), ["helper"]);
	assert.deepEqual(launch.nested.toolSources, {
		a_tool: { kind: "extension", path: f.a },
	});
	assert.deepEqual(launch.nested.skills, { a: f.skillA });
	assert.deepEqual(launch.nested.profiles, live.catalog.profiles);
	assert.deepEqual(launch.nested.agents.helper?.spawns, ["leaf"]);
	const child = resolveLaunch({
		...f.options,
		catalog: launch.nested,
		agent: "helper",
		spawnerDepth: 1,
		spawnerAllowlist: Object.keys(launch.nested.agents),
	});
	assert.equal(child.nested, null);
	assert.deepEqual(child.tools, ["a_tool", "ask_question"]);
	assert.ok(live.catalog.agents.helper);
	live.catalog.agents.helper.tools.push("inline");
	assert.deepEqual(launch.nested.agents.helper?.tools, ["a_tool"]);
});
test("nested snapshot stores real agent, tool, skill and profile paths", (t) => {
	const f = fixture(t);
	f.agent("worker", "tools: []\nspawns: [helper]");
	f.agent("helper", "tools: [a_tool]\nskills: [a]");
	const catalog = f.build().catalog;
	const helper = catalog.agents.helper;
	const profile = catalog.profiles.quick;
	assert.ok(helper && profile);
	const file = helper.file;
	const fileAlias = join(f.root, "helper-alias.md");
	symlinkSync(file, fileAlias);
	helper.file = fileAlias;
	const skillAlias = join(f.root, "skill-alias.md");
	symlinkSync(f.skillA, skillAlias);
	catalog.skills.a = skillAlias;
	const toolAlias = join(f.root, "tool-alias.ts");
	symlinkSync(f.a, toolAlias);
	catalog.toolSources.a_tool = { kind: "extension", path: toolAlias };
	const providerAlias = join(f.root, "provider-alias.ts");
	symlinkSync(f.provider, providerAlias);
	profile.extensions = [providerAlias];
	const nested = resolveLaunch({ ...f.options, catalog }).nested;
	assert.ok(nested);
	assert.equal(nested.agents.helper?.file, file);
	assert.deepEqual(nested.toolSources.a_tool, { kind: "extension", path: f.a });
	assert.equal(nested.skills.a, f.skillA);
	assert.deepEqual(nested.profiles.quick?.extensions, [f.provider]);
});
test("nested snapshot includes all selected skills for all mode", (t) => {
	const f = fixture(t);
	f.agent("worker", "tools: []\nspawns: [helper]");
	f.agent("helper", "tools: []\nskills: all");
	const launch = resolveLaunch({ ...f.options, catalog: f.build() });
	assert.deepEqual(launch.nested?.skills, { a: f.skillA, z: f.skillZ });
});
for (const fields of [
	"tools: [inline]",
	"tools: [missing]",
	"tools: []\nskills: [missing]",
]) {
	test(`nested agent is validated before launch: ${fields}`, (t) => {
		const f = fixture(t);
		f.agent("worker", "tools: []\nspawns: [helper, leaf]");
		f.agent("helper", "tools: []\nspawns: [leaf]");
		f.agent("leaf", fields);
		assert.throws(() => resolveLaunch({ ...f.options, catalog: f.build() }));
	});
}
test("invalid nested agent does not vanish from spawn rights", (t) => {
	const f = fixture(t);
	f.agent("worker", "tools: []\nspawns: [helper]");
	f.agent("helper", "tools: wrong");
	assert.throws(
		() => resolveLaunch({ ...f.options, catalog: f.build() }),
		/helper\.md:.*tools/,
	);
});
test("depth 3 is allowed but has no nested tools or snapshot; depth 4 fails", (t) => {
	const f = fixture(t);
	f.agent("worker", "tools: []\nspawns: [helper]");
	f.agent("helper", "tools: [inline]");
	const live = f.build();
	const launch = resolveLaunch({
		...f.options,
		catalog: live,
		spawnerDepth: 2,
	});
	assert.equal(launch.depth, 3);
	assert.equal(launch.nested, null);
	assert.deepEqual(launch.tools, ["ask_question"]);
	assert.throws(
		() => resolveLaunch({ ...f.options, catalog: live, spawnerDepth: 3 }),
		/depth.*3/i,
	);
});
test("unknown agent, profile, forbidden agent and hidden model invocation fail", (t) => {
	const f = fixture(t);
	const live = f.build();
	assert.throws(
		() => resolveLaunch({ ...f.options, catalog: live, agent: "missing" }),
		/Unknown agent/,
	);
	assert.throws(
		() => resolveLaunch({ ...f.options, catalog: live, profile: "missing" }),
		/Unknown profile/,
	);
	assert.throws(
		() => resolveLaunch({ ...f.options, catalog: live, spawnerAllowlist: [] }),
		/Agent "worker" is not in the spawn allowlist of this agent\. Allowed:/,
	);
	f.agent("worker", "tools: []\ndisable-model-invocation: true");
	const hidden = f.build();
	assert.throws(
		() => resolveLaunch({ ...f.options, catalog: hidden }),
		/disable-model-invocation/,
	);
	assert.equal(
		resolveLaunch({ ...f.options, catalog: hidden, modelInvocation: false })
			.agent,
		"worker",
	);
});
test("draft cwd becomes a real path without a child session; fork compares real cwd", (t) => {
	const f = fixture(t);
	const alias = join(f.root, "alias");
	symlinkSync(f.cwd, alias);
	const launch = resolveLaunch({
		...f.options,
		catalog: f.build(),
		cwd: "../alias",
	});
	assert.equal(launch.cwd, f.cwd);
	assert.equal(Object.hasOwn(launch, "childSessionFile"), false);
	f.agent("worker", "tools: []\nsession: fork");
	assert.equal(
		resolveLaunch({ ...f.options, catalog: f.build(), cwd: alias }).cwd,
		f.cwd,
	);
	assert.throws(
		() => resolveLaunch({ ...f.options, catalog: f.build(), cwd: f.root }),
		/A fork subagent runs in the parent's directory\./,
	);
	assert.throws(
		() => resolveLaunch({ ...f.options, catalog: f.build(), cwd: f.a }),
		/directory/,
	);
});
test("live diagnostics remain visible in summary and spawn errors", (t) => {
	const f = fixture(t);
	f.agent("bad", "tools: wrong");
	put(join(f.cwd, ".pi/agents/local.md"), "not parsed");
	const live = f.build();
	const text = catalogSummary(live, ["worker"]);
	assert.match(text, /worker.*user.*worker description/);
	assert.match(text, /tools: read/);
	assert.match(text, /skills: none/);
	assert.match(text, /session: standalone/);
	assert.match(text, /auto-exit: true/);
	assert.match(text, /bad\.md:.*tools/);
	assert.match(text, /local/);
	assert.match(text, /quick.*custom\/model.*off.*Short tasks/);
	assert.throws(
		() => resolveLaunch({ ...f.options, catalog: live, agent: "bad" }),
		/bad\.md:.*tools/,
	);
	assert.throws(
		() => resolveLaunch({ ...f.options, catalog: live, agent: "local" }),
		/Project agent "local" is ignored because this folder has no trust decision\. Run \/trust first\./,
	);
	put(join(f.agentDir, "subagent-profiles.json"), "bad JSON");
	const broken = f.build();
	assert.match(catalogSummary(broken), /invalid JSON/);
	assert.throws(
		() => resolveLaunch({ ...f.options, catalog: broken }),
		/invalid JSON/,
	);
});
test("skill all sorts real paths and deduplicates two skill names", (t) => {
	const f = fixture(t);
	f.commands.splice(
		0,
		f.commands.length,
		f.skill("first", f.skillZ),
		f.skill("last", f.skillA),
		f.skill("same", f.skillA),
	);
	f.agent("worker", "tools: []\nskills: all");
	assert.deepEqual(resolveLaunch({ ...f.options, catalog: f.build() }).skills, [
		f.skillA,
		f.skillZ,
	]);
});
test("nested extension files must still exist", (t) => {
	const f = fixture(t);
	f.agent("worker", "tools: []\nspawns: [helper]");
	f.agent("helper", "tools: [a_tool]");
	const live = f.build();
	rmSync(f.a);
	assert.throws(() => resolveLaunch({ ...f.options, catalog: live }), /ENOENT/);
});
test("lookup does not accept inherited object properties as catalog entries", (t) => {
	const f = fixture(t);
	const live = f.build();
	assert.throws(
		() =>
			resolveLaunch({ ...f.options, catalog: live, profile: "constructor" }),
		/Unknown profile/,
	);
	f.agent("worker", "tools: [constructor]");
	assert.throws(
		() => resolveLaunch({ ...f.options, catalog: f.build() }),
		/Tool "constructor" is not loaded/,
	);
});
test("live config is rebuilt on each call while snapshots need no files or trust reads", (t) => {
	const f = fixture(t);
	const catalog = f.build().catalog;
	f.agent("worker", "tools: []", "New prompt.");
	assert.equal(
		f.build().catalog.agents.worker?.systemPrompt.text,
		"New prompt.",
	);
	rmSync(join(f.agentDir, "subagent-profiles.json"));
	assert.equal(
		resolveLaunch({ ...f.options, catalog }).systemPrompt.text,
		"Do the task.",
	);
});
