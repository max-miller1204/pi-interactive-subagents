import assert from "node:assert/strict";
import fs, {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type TestContext, test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	CURRENT_SESSION_VERSION,
	type CustomEntry,
	type SessionEntry,
	type SessionHeader,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Launch, parseStrict } from "../../src/schema.ts";
import {
	afterMarker,
	finalText,
	foldRegistry,
	forkEntries,
	lastAssistant,
	persistedIds,
	readBranch,
	writeChildSession,
} from "../../src/session-file.ts";

function fixture(t: TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "subagent-session-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const dir = join(root, "sessions");
	const cwd = join(root, "project");
	mkdirSync(dir);
	mkdirSync(cwd);
	const alias = join(root, "alias");
	symlinkSync(root, alias);
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: "parent-session",
		timestamp: new Date().toISOString(),
		cwd,
	};
	const parent = join(dir, "parent.jsonl");
	writeFileSync(parent, `${JSON.stringify(header)}\n`);
	const put = (rows: unknown[]) => {
		const file = join(dir, "read.jsonl");
		writeFileSync(
			file,
			`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
		return file;
	};
	return { root, dir, cwd, alias, header, parent, put };
}

function custom(
	id: string,
	parentId: string | null,
	customType = "other",
	data: unknown = {},
): CustomEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: "2026-09-25T00:00:00.000Z",
		customType,
		data,
	};
}
function marker(
	id: string,
	parentId: string | null,
	runId: string,
	sessionId: string,
): CustomEntry {
	return custom(id, parentId, "subagent_child", {
		v: 1,
		kind: "run",
		runId,
		sessionId,
		name: "worker",
	});
}

test("reader rejects an invalid display mode record", (t) => {
	const f = fixture(t);
	const file = f.put([
		f.header,
		custom("mode", null, "subagent_display_mode", { v: 1, mode: "unknown" }),
	]);
	assert.throws(() => readBranch(file), /subagent_display_mode|mode/);
});
function assistant(
	id: string,
	parentId: string | null,
	content: AssistantMessage["content"],
): SessionEntry & { type: "message"; message: AssistantMessage } {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-09-25T00:00:00.000Z",
		message: {
			role: "assistant",
			content,
			api: "openai-completions",
			provider: "test",
			model: "test",
			usage: {
				input: 10,
				output: 4,
				cacheRead: 2,
				cacheWrite: 1,
				totalTokens: 17,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		},
	};
}
function forkContext(branch: SessionEntry[], idle: boolean) {
	return { sessionManager: { getBranch: () => branch }, isIdle: () => idle };
}
function launch(cwd: string, childSessionFile: string): Launch {
	return parseStrict(
		Launch,
		{
			name: "worker",
			agent: "worker",
			profile: "quick",
			cwd,
			childSessionFile,
			session: "standalone",
			autoExit: true,
			model: { provider: "test", id: "test" },
			thinking: "off",
			systemPrompt: { mode: "append", text: "Do the task." },
			tools: [],
			extensions: [],
			skills: [],
			depth: 1,
			nested: null,
		},
		"test launch",
	);
}

for (const failure of ["write", "realpath"] as const) {
	test(`child writer removes its new file after ${failure} fails`, (t) => {
		const f = fixture(t);
		const primary = new Error(
			failure === "write" ? "ENOSPC" : "realpath failed",
		);
		const write = fs.writeFileSync;
		const realpath = fs.realpathSync;
		t.after(() => {
			t.mock.restoreAll();
			syncBuiltinESMExports();
		});
		if (failure === "write") {
			t.mock.method(
				fs,
				"writeFileSync",
				(
					file: Parameters<typeof fs.writeFileSync>[0],
					_data: unknown,
					options: Parameters<typeof fs.writeFileSync>[2],
				) => {
					write(file, "partial", options);
					throw primary;
				},
			);
		} else {
			t.mock.method(fs, "realpathSync", (path: string) => {
				if (path.endsWith(".jsonl") && path !== f.parent) throw primary;
				return realpath(path);
			});
		}
		syncBuiltinESMExports();
		assert.throws(
			() => writeChildSession(f.dir, f.cwd, f.parent, []),
			(error) => error === primary,
		);
		assert.deepEqual(readdirSync(f.dir), ["parent.jsonl"]);
		assert.ok(readFileSync(f.parent, "utf8").includes("parent-session"));
	});
}

test("child writer keeps the primary error when removing its partial file fails", (t) => {
	const f = fixture(t);
	const primary = new Error("ENOSPC");
	const cleanup = new Error("unlink failed");
	const write = fs.writeFileSync;
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	t.mock.method(
		fs,
		"writeFileSync",
		(
			file: Parameters<typeof fs.writeFileSync>[0],
			_data: unknown,
			options: Parameters<typeof fs.writeFileSync>[2],
		) => {
			write(file, "partial", options);
			throw primary;
		},
	);
	t.mock.method(fs, "unlinkSync", () => {
		throw cleanup;
	});
	syncBuiltinESMExports();
	assert.throws(
		() => writeChildSession(f.dir, f.cwd, f.parent, []),
		(error) => {
			assert.ok(error instanceof AggregateError);
			assert.deepEqual(error.errors, [primary, cleanup]);
			assert.equal(error.cause, primary);
			assert.match(error.message, /ENOSPC.*unlink failed/s);
			return true;
		},
	);
});

test("child writer never removes a file that already exists", (t) => {
	const f = fixture(t);
	const write = fs.writeFileSync;
	const open = fs.openSync;
	let collision: string | undefined;
	const createCollision = (path: string) => {
		collision = path;
		const fd = open(path, "wx", 0o600);
		try {
			write(fd, "keep existing");
		} finally {
			fs.closeSync(fd);
		}
	};
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	t.mock.method(fs, "openSync", (path: string, flags: string, mode: number) => {
		createCollision(path);
		return open(path, flags, mode);
	});
	t.mock.method(
		fs,
		"writeFileSync",
		(
			file: Parameters<typeof fs.writeFileSync>[0],
			data: string,
			options: Parameters<typeof fs.writeFileSync>[2],
		) => {
			if (typeof file === "string") createCollision(file);
			return write(file, data, options);
		},
	);
	syncBuiltinESMExports();
	assert.throws(() => writeChildSession(f.dir, f.cwd, f.parent, []), /EEXIST/);
	assert.ok(collision);
	assert.equal(readFileSync(collision, "utf8"), "keep existing");
});

test("child writer resolves directory, cwd and parent symlinks and writes a Pi header", (t) => {
	const f = fixture(t);
	const file = writeChildSession(
		join(f.alias, "sessions"),
		join(f.alias, "project"),
		join(f.alias, "sessions/parent.jsonl"),
		[],
	);
	assert.equal(file, realpathSync(file));
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.match(
		basename(file),
		/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f-]+\.jsonl$/,
	);
	const manager = SessionManager.open(file);
	const header = manager.getHeader();
	assert.ok(header);
	assert.equal(header.version, CURRENT_SESSION_VERSION);
	assert.match(
		header.id,
		/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);
	assert.equal(manager.getSessionId(), header.id);
	assert.equal(manager.getCwd(), f.cwd);
	assert.equal(header.parentSession, f.parent);
	assert.ok(basename(file).includes(header.id));
	assert.deepEqual(readBranch(file), []);
	manager.appendCustomEntry("subagent_child", {
		v: 1,
		kind: "run",
		runId: "run",
		sessionId: header.id,
		name: "worker",
	});
	assert.equal(readBranch(file).length, 1);
	assert.equal(readBranch(file)[0]?.id, manager.getLeafId());
	const second = writeChildSession(f.dir, f.cwd, f.parent, []);
	assert.notEqual(second, file);
});

test("child writer preserves fork entries and fails for missing real paths", (t) => {
	const f = fixture(t);
	const entries = [custom("root", null), custom("child", "root")];
	const file = writeChildSession(f.dir, f.cwd, f.parent, entries);
	assert.deepEqual(readBranch(file), entries);
	assert.deepEqual(SessionManager.open(file).getBranch(), entries);
	assert.throws(
		() => writeChildSession(f.dir, join(f.root, "missing"), f.parent, []),
		/ENOENT/,
	);
	assert.throws(
		() =>
			writeChildSession(f.dir, f.cwd, join(f.root, "missing/parent.jsonl"), []),
		/ENOENT/,
	);
});

test("child writer rejects a broken parent symlink and resolves an existing file symlink", (t) => {
	const f = fixture(t);
	const link = join(f.dir, "parent-link.jsonl");
	symlinkSync(join(f.dir, "absent.jsonl"), link);
	assert.throws(() => writeChildSession(f.dir, f.cwd, link, []), /ENOENT/);
	assert.deepEqual(readdirSync(f.dir), ["parent-link.jsonl", "parent.jsonl"]);
	rmSync(link);
	symlinkSync(f.parent, link);
	const child = writeChildSession(f.dir, f.cwd, link, []);
	assert.equal(SessionManager.open(child).getHeader()?.parentSession, f.parent);
});

test("tool fork excludes the delegation assistant, sibling calls and later results", () => {
	const before = custom("root", null);
	const delegation = assistant("delegate", "root", [
		{ type: "text", text: "Delegating." },
		{ type: "toolCall", id: "sibling", name: "read", arguments: {} },
		{ type: "toolCall", id: "delegate-call", name: "subagent", arguments: {} },
	]);
	const branch = [before, delegation, custom("later", "delegate")];
	assert.deepEqual(forkEntries(forkContext(branch, false), "delegate-call"), [
		before,
	]);
	assert.equal(branch.length, 3);
	assert.throws(
		() => forkEntries(forkContext(branch, true), "absent"),
		/Cannot find the subagent tool call on the current branch\./,
	);
});

test("tool fork supports an empty cut and searches backwards", () => {
	const call = {
		type: "toolCall" as const,
		id: "call",
		name: "subagent",
		arguments: {},
	};
	const first = assistant("first", null, [call]);
	assert.deepEqual(forkEntries(forkContext([first], false), "call"), []);
	const second = assistant("second", "first", [call]);
	assert.deepEqual(forkEntries(forkContext([first, second], false), "call"), [
		first,
	]);
});

test("command fork takes the whole branch only when idle", () => {
	const branch = [custom("root", null)];
	assert.deepEqual(forkEntries(forkContext(branch, true)), branch);
	assert.throws(
		() => forkEntries(forkContext(branch, false)),
		/Wait for the current response to finish before you start a fork subagent\./,
	);
});

test("reader follows only the last entry's parent branch, including a leaf marker", (t) => {
	const f = fixture(t);
	const root = custom("root", null);
	const old = custom("old", "root");
	const chosen = custom("chosen", "root");
	const leaf = custom("leaf", "old", "subagent_child", {
		v: 1,
		kind: "leaf",
		runId: "run",
	});
	assert.deepEqual(readBranch(f.put([f.header, root, old, chosen])), [
		root,
		chosen,
	]);
	assert.deepEqual(readBranch(f.put([f.header, root, old, chosen, leaf])), [
		root,
		old,
		leaf,
	]);
	assert.deepEqual(
		readBranch(f.put([f.header, root, custom("new-root", null)])),
		[custom("new-root", null)],
	);
});

test("reader rejects bad JSON in middle and final lines with line numbers", (t) => {
	const f = fixture(t);
	for (const tail of [
		"{bad}\n",
		`{bad}\n${JSON.stringify(custom("last", null))}\n`,
	]) {
		writeFileSync(f.parent, `${JSON.stringify(f.header)}\n${tail}`);
		assert.throws(() => readBranch(f.parent), {
			message: `${f.parent}: line 2 is not valid JSON.`,
		});
	}
});

test("reader rejects a torn final line even when its JSON is complete", (t) => {
	const f = fixture(t);
	for (const tail of ["{", JSON.stringify(custom("last", null))]) {
		writeFileSync(f.parent, `${JSON.stringify(f.header)}\n${tail}`);
		assert.throws(() => readBranch(f.parent), /final newline/);
	}
});

test("reader rejects non-session headers and unsupported versions", (t) => {
	const f = fixture(t);
	for (const header of [
		null,
		{},
		[],
		custom("root", null),
		{ ...f.header, version: 1 },
		{ type: "session" },
	]) {
		assert.throws(() => readBranch(f.put([header])), /not a Pi session/);
	}
	writeFileSync(f.parent, "\n");
	assert.throws(() => readBranch(f.parent), /not a Pi session/);
});

test("reader rejects blank lines after the header", (t) => {
	const f = fixture(t);
	for (const tail of ["\n", `\n${JSON.stringify(custom("root", null))}\n`]) {
		writeFileSync(f.parent, `${JSON.stringify(f.header)}\n${tail}`);
		assert.throws(() => readBranch(f.parent), {
			message: `${f.parent}: line 2 is blank.`,
		});
	}
	assert.deepEqual(readBranch(f.put([f.header])), []);
});

test("reader never skips corrupt entries", (t) => {
	const f = fixture(t);
	for (const entry of [
		null,
		[],
		{},
		{ ...custom("root", null), parentId: undefined },
		{ ...custom("root", null), id: 1 },
		{ ...custom("root", null), type: ["custom"] },
	]) {
		assert.throws(() => readBranch(f.put([f.header, entry])), /line 2/);
	}
});

test("reader rejects missing parents, duplicate ids and cycles on all branches", (t) => {
	const f = fixture(t);
	const cases = [
		[custom("root", "absent")],
		[custom("bad", "absent"), custom("active", null)],
		[custom("same", null), custom("same", null)],
		[custom("one", "two"), custom("two", "one")],
		[custom("one", "two"), custom("two", "one"), custom("active", null)],
	];
	for (const entries of cases) {
		assert.throws(
			() => readBranch(f.put([f.header, ...entries])),
			/parent|duplicate|cycle/i,
		);
	}
});

for (const [label, changes] of [
	["missing content", { content: undefined }],
	["string content", { content: "lost text" }],
	["null block", { content: [null] }],
	["missing text", { content: [{ type: "text" }] }],
	["numeric text", { content: [{ type: "text", text: 42 }] }],
	["unknown block", { content: [{ type: "unknown", text: "lost" }] }],
	["invalid thinking", { content: [{ type: "thinking", thinking: false }] }],
	[
		"invalid tool call",
		{ content: [{ type: "toolCall", id: 1, name: "read", arguments: {} }] },
	],
	[
		"invalid tool arguments",
		{
			content: [{ type: "toolCall", id: "call", name: "read", arguments: [] }],
		},
	],
	["missing usage", { usage: undefined }],
	["invalid total tokens", { usage: { totalTokens: "17" } }],
	["missing stop reason", { stopReason: undefined }],
	["invalid stop reason", { stopReason: "done" }],
	["invalid error message", { errorMessage: 42 }],
] as const) {
	test(`transcript extraction rejects ${label} with file and line`, (t) => {
		const f = fixture(t);
		const reply = assistant("reply", "marker", [
			{ type: "text", text: "answer" },
		]);
		const file = f.put([
			f.header,
			marker("marker", null, "run", "child"),
			{ ...reply, message: { ...reply.message, ...changes } },
		]);
		assert.throws(
			() =>
				finalText(lastAssistant(afterMarker(readBranch(file), "run") ?? [])),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.ok(error.message.startsWith(`${file}: line 3`), error.message);
				return true;
			},
		);
	});
}

test("transcript extraction rejects malformed message envelopes and owned records", (t) => {
	const f = fixture(t);
	for (const entry of [
		{ ...custom("bad", null), type: "message" },
		{ ...custom("bad", null), type: "message", message: { role: 1 } },
		custom("bad", null, "subagent_child", { kind: "run", runId: "run" }),
		custom("bad", null, "subagent_child", {
			v: 1,
			kind: "leaf",
			runId: "run",
			extra: true,
		}),
		custom("bad", null, "subagent", {
			v: 1,
			kind: "resume",
			runId: "run",
			name: 42,
		}),
		{
			...custom("bad", null),
			type: "custom_message",
			details: { deliveryId: 42 },
		},
		{
			...custom("bad", null),
			type: "message",
			message: { role: "toolResult", details: { deliveryId: 42 } },
		},
	]) {
		const file = f.put([f.header, entry]);
		assert.throws(
			() => {
				const branch = readBranch(file);
				persistedIds(branch);
				foldRegistry(branch, "child");
				return finalText(lastAssistant(branch));
			},
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.ok(error.message.startsWith(`${file}: line 2`), error.message);
				return true;
			},
		);
	}
});

test("transcript validation covers inactive branches and accepts Pi assistant shapes", (t) => {
	const f = fixture(t);
	const file = writeChildSession(f.dir, f.cwd, f.parent, []);
	const manager = SessionManager.open(file);
	manager.appendCustomEntry("subagent_child", {
		v: 1,
		kind: "run",
		runId: "run",
		sessionId: manager.getSessionId(),
		name: "worker",
	});
	for (const stopReason of [
		"pending",
		"stop",
		"length",
		"toolUse",
		"error",
		"aborted",
		"deferred",
	] as const) {
		const reply = assistant("reply", null, [
			{
				type: "thinking",
				thinking: "private",
				thinkingSignature: "opaque",
				redacted: true,
			},
			{ type: "text", text: "answer", textSignature: "signature" },
			{
				type: "toolCall",
				id: "call",
				name: "read",
				arguments: { path: "file" },
			},
		]);
		reply.message.stopReason = stopReason;
		manager.appendMessage(reply.message);
		const extracted = lastAssistant(afterMarker(readBranch(file), "run") ?? []);
		assert.equal(finalText(extracted), "answer");
		assert.equal(extracted?.usage.totalTokens, 17);
		assert.equal(extracted?.stopReason, stopReason);
	}
	const corrupt = f.put([
		f.header,
		custom("bad", null, "subagent", { invalid: true }),
		custom("active", null),
	]);
	assert.throws(
		() => readBranch(corrupt),
		(error: unknown) =>
			error instanceof Error && error.message.startsWith(`${corrupt}: line 2`),
	);
});

test("marker slicing matches run entries and excludes prior runs", () => {
	const first = marker("first", null, "first-run", "session");
	const second = marker("second", "first", "second-run", "session");
	const output = custom("output", "second");
	const branch = [
		first,
		custom("not-run", "first", "subagent_child", {
			kind: "human",
			runId: "second-run",
		}),
		second,
		output,
	];
	assert.deepEqual(afterMarker(branch, "second-run"), [output]);
	assert.equal(afterMarker(branch, "absent"), undefined);
	assert.deepEqual(afterMarker([second], "second-run"), []);
});

test("assistant extraction uses the last message, text blocks and totalTokens", () => {
	const first = assistant("first", null, [{ type: "text", text: "old" }]);
	const last = assistant("last", "first", [
		{ type: "thinking", thinking: "private" },
		{ type: "text", text: "one" },
		{ type: "toolCall", id: "call", name: "read", arguments: {} },
		{ type: "text", text: "two" },
	]);
	const entries = [first, last, custom("tail", "last")];
	assert.equal(lastAssistant(entries), last.message);
	assert.equal(finalText(lastAssistant(entries)), "one\ntwo");
	assert.equal(lastAssistant(entries)?.usage.totalTokens, 17);
	assert.equal(lastAssistant([]), undefined);
	assert.equal(finalText(undefined), "");
	assert.equal(lastAssistant([])?.usage.totalTokens ?? null, null);
	assert.equal(finalText(assistant("empty", null, []).message), "");
});

test("persisted delivery ids come only from custom messages and tool results", () => {
	const entries: SessionEntry[] = [
		{
			type: "custom_message",
			id: "message",
			parentId: null,
			timestamp: "now",
			customType: "subagent",
			content: "text",
			display: true,
			details: { deliveryId: "one" },
		},
		{
			type: "message",
			id: "tool",
			parentId: "message",
			timestamp: "now",
			message: {
				role: "toolResult",
				toolCallId: "call",
				toolName: "ask_question",
				content: [],
				isError: false,
				timestamp: 0,
				details: { deliveryId: "two" },
			},
		},
		custom("ignored", "tool", "subagent", { deliveryId: "ignored" }),
		{
			type: "custom_message",
			id: "duplicate",
			parentId: "ignored",
			timestamp: "now",
			customType: "subagent",
			content: "text",
			display: true,
			details: { deliveryId: "one" },
		},
		{
			type: "custom_message",
			id: "no-details",
			parentId: "duplicate",
			timestamp: "now",
			customType: "other",
			content: "text",
			display: false,
		},
	];
	assert.deepEqual(persistedIds(entries), new Set(["one", "two"]));
	assert.deepEqual(persistedIds([]), new Set());
});

test("registry fold isolates two ancestor sessions and tracks spawn, resume and adopt", (t) => {
	const f = fixture(t);
	const definition = launch(f.cwd, f.parent);
	const record = (id: string, parentId: string, data: unknown) =>
		custom(id, parentId, "subagent", data);
	const branch = [
		marker("grandparent", null, "grandparent-run", "grandparent-session"),
		record("grandparent-record", "grandparent", {
			invalid: "ignored before own cut",
		}),
		marker("parent", "grandparent-record", "parent-run", "parent-session"),
		record("parent-record", "parent", {
			v: 1,
			kind: "spawn",
			runId: "parent-spawn",
			launch: definition,
		}),
		marker("own", "parent-record", "own-run", "own-session"),
		record("spawn", "own", {
			v: 1,
			kind: "spawn",
			runId: "spawned",
			launch: definition,
		}),
		record("resume", "spawn", {
			v: 1,
			kind: "resume",
			runId: "resumed",
			name: "worker",
		}),
		record("adopt", "resume", {
			v: 1,
			kind: "adopt",
			runId: "adopted",
			launch: definition,
		}),
	];
	const folded = foldRegistry(branch, "own-session");
	assert.deepEqual(
		folded.names,
		new Map([["worker", { runId: "adopted", launch: definition }]]),
	);
	assert.deepEqual(folded.ownRunIds, new Set(["spawned", "resumed"]));
	assert.deepEqual(
		folded.knownRunIds,
		new Set(["spawned", "resumed", "adopted"]),
	);
	assert.deepEqual(foldRegistry(branch.slice(5), "root-session"), folded);
});

test("registry cut uses the first own marker so resumed runs retain earlier records", (t) => {
	const f = fixture(t);
	const definition = launch(f.cwd, f.parent);
	const branch = [
		marker("first", null, "run-1", "own"),
		custom("record", "first", "subagent", {
			v: 1,
			kind: "spawn",
			runId: "spawned",
			launch: definition,
		}),
		marker("resume", "record", "run-2", "own"),
	];
	assert.deepEqual(foldRegistry(branch, "own").ownRunIds, new Set(["spawned"]));
});

test("registry fold rejects invalid records after its cut with entry context", () => {
	assert.throws(
		() =>
			foldRegistry(
				[
					custom("bad", null, "subagent", {
						v: 1,
						kind: "resume",
						runId: "run",
						name: "worker",
						extra: true,
					}),
				],
				"own",
			),
		/subagent entry bad/,
	);
	assert.deepEqual(foldRegistry([], "own"), {
		names: new Map(),
		ownRunIds: new Set(),
		knownRunIds: new Set(),
	});
});

test("registry fold sees only records on the reader's active branch", (t) => {
	const f = fixture(t);
	const root = custom("root", null);
	const inactive = custom("inactive", "root", "subagent", {
		v: 1,
		kind: "resume",
		runId: "inactive-run",
		name: "worker",
	});
	const active = custom("active", "root", "subagent", {
		v: 1,
		kind: "resume",
		runId: "run",
		name: "worker",
	});
	const file = f.put([f.header, root, inactive, active]);
	assert.deepEqual(
		foldRegistry(readBranch(file), "own").ownRunIds,
		new Set(["run"]),
	);
	assert.ok(readFileSync(file, "utf8").endsWith("\n"));
});
