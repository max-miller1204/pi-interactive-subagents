import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

const script = resolve(
	import.meta.dirname,
	"../../scripts/patch-pi-declarations.mjs",
);
const installed = resolve(
	import.meta.dirname,
	"../../node_modules/@earendil-works/pi-ai/dist/providers",
);

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "pi-declarations-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const providers = join(root, "dist/providers");
	mkdirSync(providers, { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name: "@earendil-works/pi-ai", version: "0.87.1" }),
	);
	const originals = new Map<string, string>();
	for (const name of readdirSync(installed).filter((name) =>
		name.endsWith(".models.d.ts"),
	)) {
		const text = readFileSync(join(installed, name), "utf8").replace(
			' with { type: "json" };',
			";",
		);
		originals.set(name, text);
		writeFileSync(join(providers, name), text);
	}
	assert.equal(originals.size, 41);
	const run = () =>
		spawnSync(process.execPath, [script, root], {
			encoding: "utf8",
			timeout: 5_000,
		});
	const unchanged = () => {
		for (const [name, text] of originals)
			assert.equal(readFileSync(join(providers, name), "utf8"), text);
	};
	return { root, providers, originals, run, unchanged };
}

test("declaration patch rejects a different Pi AI version before writing", (t) => {
	const f = fixture(t);
	writeFileSync(
		join(f.root, "package.json"),
		JSON.stringify({ name: "@earendil-works/pi-ai", version: "0.87.2" }),
	);
	const result = f.run();
	assert.notEqual(result.status, 0);
	assert.match(
		result.stderr,
		/requires @earendil-works\/pi-ai 0\.87\.1.*0\.87\.2/,
	);
	f.unchanged();
});

test("declaration patch rejects unexpected source before changing any file", (t) => {
	const f = fixture(t);
	const path = join(f.providers, "zai.models.d.ts");
	const changed = readFileSync(path, "utf8").replace(
		'import values from "./data/zai.json";',
		'import values from "./data/unexpected.json";',
	);
	writeFileSync(path, changed);
	f.originals.set("zai.models.d.ts", changed);
	const result = f.run();
	assert.notEqual(result.status, 0);
	assert.match(
		result.stderr,
		/Unexpected declaration content: zai\.models\.d\.ts/,
	);
	f.unchanged();
});

test("declaration patch checks the whole source, not only the JSON import", (t) => {
	const f = fixture(t);
	const path = join(f.providers, "zai.models.d.ts");
	const changed = `${readFileSync(path, "utf8")}\nexport type Unexpected = string;\n`;
	writeFileSync(path, changed);
	f.originals.set("zai.models.d.ts", changed);
	const result = f.run();
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Unexpected declaration content/);
	f.unchanged();
});

test("declaration patch changes exactly 41 imports and is idempotent", (t) => {
	const f = fixture(t);
	const first = f.run();
	assert.equal(first.status, 0, first.stderr);
	assert.match(first.stdout, /Patched 41 of 41/);
	const times = new Map<string, bigint>();
	for (const [name, original] of f.originals) {
		const path = join(f.providers, name);
		assert.equal(
			readFileSync(path, "utf8"),
			original.replace(/\.json";/, '.json" with { type: "json" };'),
		);
		times.set(name, statSync(path, { bigint: true }).mtimeNs);
	}
	const second = f.run();
	assert.equal(second.status, 0, second.stderr);
	assert.match(second.stdout, /Patched 0 of 41/);
	for (const [name, time] of times)
		assert.equal(
			statSync(join(f.providers, name), { bigint: true }).mtimeNs,
			time,
		);
});

test("declaration patch resolves a hoisted Pi AI package without a directory argument", (t) => {
	const f = fixture(t);
	const packageDir = join(f.root, "node_modules/@earendil-works/pi-ai");
	const providers = join(packageDir, "dist/providers");
	mkdirSync(providers, { recursive: true });
	writeFileSync(
		join(packageDir, "package.json"),
		JSON.stringify({
			name: "@earendil-works/pi-ai",
			version: "0.87.1",
			type: "module",
			exports: "./dist/index.js",
		}),
	);
	writeFileSync(join(packageDir, "dist/index.js"), "");
	for (const [name, text] of f.originals)
		writeFileSync(join(providers, name), text);
	const scriptDir = join(f.root, "consumer/scripts");
	mkdirSync(scriptDir, { recursive: true });
	const copiedScript = join(scriptDir, "patch.mjs");
	writeFileSync(copiedScript, readFileSync(script, "utf8"));
	const env = { ...process.env };
	delete env.npm_config_omit;
	const result = spawnSync(process.execPath, [copiedScript], {
		cwd: tmpdir(),
		env,
		encoding: "utf8",
		timeout: 5_000,
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Patched 41 of 41/);
});

function runCopiedScript(t: TestContext, env: NodeJS.ProcessEnv) {
	const root = mkdtempSync(join(tmpdir(), "pi-declarations-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const copiedScript = join(root, "patch.mjs");
	writeFileSync(copiedScript, readFileSync(script, "utf8"));
	return spawnSync(process.execPath, [copiedScript], {
		cwd: root,
		env,
		encoding: "utf8",
		timeout: 5_000,
	});
}

test("declaration patch skips when npm omits dev dependencies", (t) => {
	const env = { ...process.env };
	env.npm_config_omit = "dev";
	const result = runCopiedScript(t, env);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Skipped the Pi AI declaration patch/);
});

test("declaration patch fails when Pi AI is missing and dev dependencies are installed", (t) => {
	const env = { ...process.env };
	delete env.npm_config_omit;
	const result = runCopiedScript(t, env);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Cannot find package '@earendil-works\/pi-ai'/);
});

for (const change of ["missing", "extra", "renamed"] as const) {
	test(`declaration patch rejects target files that are ${change}`, (t) => {
		const f = fixture(t);
		if (change !== "extra") rmSync(join(f.providers, "zai.models.d.ts"));
		if (change !== "missing")
			writeFileSync(join(f.providers, "unexpected.models.d.ts"), "unexpected");
		const result = f.run();
		assert.notEqual(result.status, 0);
		assert.match(
			result.stderr,
			/Expected exactly the 41 Pi AI 0\.87\.1 model declaration files/,
		);
	});
}
