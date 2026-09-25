import assert from "node:assert/strict";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { Value } from "typebox/value";
import * as schemas from "../../src/schema.ts";

const validRun = () => ({
	v: 1,
	runId: "01234567-89ab-4def-8abc-0123456789ab",
	ownerKey: "owner",
	owner: { pid: 12, start: "Fri Sep 25 10:00:00 2026" },
	startedAt: 1,
	kind: "spawn",
	spawnerSessionId: "session",
	spawnerSessionFile: "/tmp/parent.jsonl",
	initialPrompt: "Task",
	launch: {
		name: "worker",
		agent: "worker",
		profile: "quick",
		cwd: "/tmp",
		childSessionFile: "/tmp/child.jsonl",
		session: "standalone",
		autoExit: true,
		model: { provider: "test", id: "model" },
		thinking: "low",
		systemPrompt: { mode: "append", text: "Prompt" },
		tools: ["read"],
		extensions: [],
		skills: [],
		depth: 1,
		nested: null,
	},
});

test("RunSpec rejects unknown properties at the root and nested objects", () => {
	const run = validRun();
	assert.equal(Value.Check(schemas.RunSpec, run), true);
	assert.throws(
		() =>
			schemas.parseStrict(schemas.RunSpec, { ...run, extra: 1 }, "spec.json"),
		/spec\.json: \/extra schema is false/,
	);
	assert.throws(
		() =>
			schemas.parseStrict(
				schemas.RunSpec,
				{ ...run, owner: { ...run.owner, extra: 1 } },
				"spec.json",
			),
		/spec\.json: \/owner\/extra schema is false/,
	);
});

test("Record validates both key patterns and matching-key values", () => {
	const catalog = { agents: {}, profiles: {}, toolSources: {}, skills: {} };
	assert.equal(Value.Check(schemas.Catalog, catalog), true);
	assert.equal(
		Value.Check(schemas.Catalog, { ...catalog, agents: { Bad_Name: {} } }),
		false,
	);
	assert.equal(
		Value.Check(schemas.Catalog, { ...catalog, skills: { valid: 42 } }),
		false,
	);
	assert.equal(
		Value.Check(schemas.Catalog, { ...catalog, skills: { "": 42 } }),
		false,
	);
	assert.throws(
		() =>
			schemas.parseStrict(
				schemas.Catalog,
				{ ...catalog, skills: { "": 42 } },
				"catalog",
			),
		/catalog:/,
	);
});

test("all exported object and Record schema nodes close extra keys", () => {
	const visited = new WeakSet<object>();
	let objects = 0;
	let records = 0;
	function walk(node: unknown): void {
		if (!node || typeof node !== "object" || visited.has(node)) return;
		visited.add(node);
		if ("type" in node && node.type === "object") {
			objects++;
			assert.equal(
				Reflect.get(node, "additionalProperties"),
				false,
				JSON.stringify(node),
			);
			if ("patternProperties" in node) records++;
		}
		for (const value of Object.values(node)) walk(value);
	}
	for (const [name, schema] of Object.entries(schemas)) {
		if (
			name !== "MAX_DEPTH" &&
			name !== "NAME_PATTERN" &&
			typeof schema !== "function"
		)
			walk(schema);
	}
	assert.ok(objects >= 20, `only ${objects} object nodes checked`);
	assert.ok(records >= 5, `only ${records} Record nodes checked`);
});

test("Value.Errors exposes instancePath and message; parseStrict reports at most three and never applies defaults", () => {
	const schema = Type.Object(
		{ value: Type.Number({ default: 9 }) },
		{ additionalProperties: false },
	);
	const error = [...Value.Errors(schema, { value: "wrong" })][0];
	assert.equal(error?.instancePath, "/value");
	assert.equal(typeof error?.message, "string");
	const value = {};
	assert.throws(
		() => schemas.parseStrict(schema, value, "input"),
		/input: \/ must have required properties value/,
	);
	assert.deepEqual(value, {});
	const many = Type.Object(
		{ a: Type.Number(), b: Type.Number(), c: Type.Number(), d: Type.Number() },
		{ additionalProperties: false },
	);
	assert.throws(
		() => schemas.parseStrict(many, { a: "", b: "", c: "", d: "" }, "input"),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.equal(error.message.split("; ").length, 3);
			return true;
		},
	);
});

test("frontmatter and profiles enforce their closed schemas", () => {
	const frontmatter = { description: "Scout", tools: ["read"] };
	assert.equal(Value.Check(schemas.AgentFrontmatter, frontmatter), true);
	assert.equal(
		Value.Check(schemas.AgentFrontmatter, { ...frontmatter, unknown: true }),
		false,
	);
	const profiles = {
		profiles: { quick: { model: "a/b", thinking: "low", guidance: "Short" } },
	};
	assert.equal(Value.Check(schemas.ProfilesFile, profiles), true);
	assert.equal(
		Value.Check(schemas.ProfilesFile, {
			profiles: { Bad_Name: profiles.profiles.quick },
		}),
		false,
	);
	assert.equal(
		Value.Check(schemas.ProfilesFile, {
			profiles: { quick: { ...profiles.profiles.quick, unknown: true } },
		}),
		false,
	);
});

test("readJsonStrict identifies invalid JSON path and atomic writes replace only the target", () => {
	const dir = mkdtempSync(join(tmpdir(), "schema-test-"));
	try {
		const file = join(dir, "status.json");
		const ignored = join(dir, ".tmp-stale");
		writeFileSync(ignored, "bad json");
		writeFileSync(file, "{");
		assert.throws(
			() => schemas.readJsonStrict(schemas.Fatal, file),
			(error: unknown) =>
				error instanceof Error && error.message.includes(file),
		);
		schemas.writeJsonAtomic(file, { v: 1, message: "first" });
		schemas.writeJsonAtomic(file, { v: 1, message: "second" });
		assert.deepEqual(schemas.readJsonStrict(schemas.Fatal, file), {
			v: 1,
			message: "second",
		});
		assert.deepEqual(readdirSync(dir).sort(), [".tmp-stale", "status.json"]);
		assert.equal(readFileSync(ignored, "utf8"), "bad json");
		writeFileSync(file, JSON.stringify({ v: 1, message: "ok", extra: true }));
		assert.throws(
			() => schemas.readJsonStrict(schemas.Fatal, file),
			/status\.json:/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
