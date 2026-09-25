import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	watch,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveLaunch } from "../../src/catalog.ts";
import {
	type LaunchContext,
	type LaunchPlan,
	launchRun,
	piArgs,
	piInvocation,
	renderLaunchScript,
	type StartedRun,
} from "../../src/launch.ts";
import { processAlive, processIdentity } from "../../src/process.ts";
import {
	Catalog,
	Launch,
	LaunchDraft,
	PaneFile,
	parseStrict,
	RunSpec,
	readJsonStrict,
} from "../../src/schema.ts";
import { tmuxLayout } from "../fixtures/tmux-layout.ts";

const runId = "9a32db26-97ef-4d95-8d91-fc4f9fe118bf";
function temp(t: { after(fn: () => void): void }): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "launch-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
function launch(dir: string): LaunchDraft {
	return parseStrict(
		LaunchDraft,
		{
			name: "scout-1",
			agent: "scout",
			profile: "quick",
			cwd: dir,
			session: "standalone",
			autoExit: true,
			model: { provider: "provider", id: "model/id" },
			thinking: "low",
			systemPrompt: { mode: "append", text: "Read files." },
			tools: ["read", "ask_question"],
			extensions: [],
			skills: [],
			depth: 1,
			nested: null,
		},
		"test launch",
	);
}

test("piInvocation uses only the parent executable, flags and real CLI path", (t) => {
	const dir = temp(t);
	const cli = join(dir, "cli.mjs");
	writeFileSync(cli, "");
	const link = join(dir, "alias.js");
	symlinkSync(cli, link);
	assert.deepEqual(
		piInvocation({
			execPath: process.execPath,
			execArgv: ["--no-warnings"],
			argv: ["node", link],
		}),
		[process.execPath, "--no-warnings", cli],
	);
	for (const script of [undefined, "cli.js", join(dir, "missing.js"), dir]) {
		assert.throws(
			() =>
				piInvocation({
					execPath: process.execPath,
					execArgv: [],
					argv: script === undefined ? ["node"] : ["node", script],
				}),
			/no CLI script/,
		);
	}
});

test("script preserves hostile argv and environment, inherits pane identity and deletes itself", (t) => {
	const root = temp(t);
	const dir = join(root, "cwd's\n$(touch PWNED)`touch PWNED`");
	mkdirSync(dir, { mode: 0o700 });
	const stub = join(dir, "stub's\n$(touch PWNED).cjs");
	writeFileSync(
		stub,
		"process.stdout.write(JSON.stringify({argv:process.argv.slice(2),env:process.env,cwd:process.cwd()}));",
	);
	const hostile = [
		"apostrophe's",
		"line\nbreak",
		"$(touch PWNED)",
		"`touch PWNED`",
		"",
		"é",
	];
	const env = {
		VALUE: hostile.join("|"),
		"BASH_FUNC_f%%": "() { touch PWNED; }",
		TMUX: "old",
		TMUX_PANE: "%1",
	};
	const script = join(dir, "launch's\n$(touch PWNED).sh");
	writeFileSync(
		script,
		renderLaunchScript({
			runId,
			name: "scout-1",
			cwd: dir,
			env,
			invocation: [process.execPath, stub],
			args: hostile,
		}),
		{ flag: "wx", mode: 0o700 },
	);
	const result = JSON.parse(
		execFileSync("/bin/sh", [script], {
			env: { TMUX: "/socket,1,2", TMUX_PANE: "%77", STALE: "bad" },
			encoding: "utf8",
		}),
	);
	// CoreFoundation adds this variable when Node starts on macOS.
	if (process.platform === "darwin") {
		assert.equal(typeof result.env.__CF_USER_TEXT_ENCODING, "string");
		delete result.env.__CF_USER_TEXT_ENCODING;
	}
	assert.deepEqual(result, {
		argv: hostile,
		env: {
			TMUX: "/socket,1,2",
			TMUX_PANE: "%77",
			VALUE: env.VALUE,
			"BASH_FUNC_f%%": env["BASH_FUNC_f%%"],
		},
		cwd: dir,
	});
	assert.equal(existsSync(script), false);
	assert.equal(existsSync(join(dir, "PWNED")), false);
});

test("script rejects invalid words and byte limits before the caller writes a file", (t) => {
	const dir = temp(t);
	const input = {
		runId,
		name: "scout-1",
		cwd: dir,
		env: {},
		invocation: ["node"],
		args: [] as string[],
	};
	for (const change of [
		{ args: ["nul\0"] },
		{ invocation: ["node\0"] },
		{ cwd: "bad\0" },
		{ env: { "": "empty" } },
		{ env: { "BAD=NAME": "value" } },
		{ env: { BAD: "nul\0" } },
		{ env: { "BAD\0": "value" } },
		{ args: ["x".repeat(200 * 1024)] },
		{ args: ["é".repeat(65536)] },
		{ env: { BIG: "x".repeat(131068) } },
		{ args: Array.from({ length: 7 }, () => "x".repeat(120000)) },
	]) {
		assert.throws(() =>
			writeFileSync(
				join(dir, "launch.sh"),
				renderLaunchScript({ ...input, ...change }),
				{ flag: "wx" },
			),
		);
		assert.deepEqual(readdirSync(dir), []);
	}
	assert.doesNotThrow(() =>
		renderLaunchScript({ ...input, args: ["x".repeat(131071)] }),
	);
	assert.doesNotThrow(() =>
		renderLaunchScript({
			...input,
			invocation: ["n"],
			args: [...Array<string>(6).fill("x".repeat(131071)), "12345"],
		}),
	);
	assert.throws(
		() =>
			renderLaunchScript({
				...input,
				invocation: ["n"],
				args: [...Array<string>(6).fill("x".repeat(131071)), "123456"],
			}),
		/The task is too long/,
	);
});

test("piArgs has exact sandbox, model, trust and prompt argument order", (t) => {
	const dir = temp(t);
	const value: Launch = {
		...launch(dir),
		childSessionFile: join(dir, "child.jsonl"),
	};
	value.extensions = [join(dir, "tools.ts"), join(dir, "provider.ts")];
	value.skills = [join(dir, "SKILL.md")];
	const options = {
		runDir: dir,
		ownExtensionPath: join(dir, "index.ts"),
		trusted: true,
		initialPrompt: "Task from the parent agent:\n\n@/--work",
	};
	const expected = [
		"--session",
		value.childSessionFile,
		"--model",
		"provider/model/id",
		"--thinking",
		"low",
		"--no-extensions",
		"-e",
		options.ownExtensionPath,
		"-e",
		value.extensions[0],
		"-e",
		value.extensions[1],
		"--tools",
		"read,ask_question",
		"--no-skills",
		"--skill",
		value.skills[0],
		"--append-system-prompt",
		join(dir, "system-prompt.md"),
		"--approve",
		`--subagent-run=${dir}`,
		options.initialPrompt,
	];
	assert.deepEqual(piArgs(value, options), expected);
	value.systemPrompt.mode = "replace";
	const args = piArgs(value, { ...options, trusted: false });
	assert.ok(args.includes("--system-prompt"));
	assert.ok(args.includes("--no-approve"));
	assert.ok(!args.includes("--approve"));
});

function transaction(t: { after(fn: () => void): void }, vertical = false) {
	const dir = temp(t);
	const sessions = join(dir, "sessions");
	const ownerDir = join(dir, "owner");
	mkdirSync(sessions);
	mkdirSync(ownerDir);
	const parent = join(sessions, "parent.jsonl");
	const own = join(dir, "index.ts");
	const cli = join(dir, "cli.js");
	writeFileSync(parent, "parent");
	writeFileSync(own, "");
	writeFileSync(cli, "");
	const plan: LaunchPlan = {
		kind: "spawn",
		launch: launch(dir),
		initialPrompt: "Task from the parent agent:\n\nDo work.",
	};
	const events: string[] = [];
	const calls: string[][] = [];
	const names = new Set<string>();
	const committed: StartedRun[] = [];
	const state = {
		disposed: false,
		fail: "",
		disposeAt: "",
		pid: "123\n",
		pane: "%9\n",
		identity: true,
		killFails: false,
		killed: false,
		registryFails: false,
	};
	const runDir = join(ownerDir, runId);
	const context: LaunchContext = {
		runId,
		ownerDir,
		ownerKey: "owner",
		owner: { pid: 1, start: "owner-start" },
		spawnerSessionId: "parent",
		spawnerSessionFile: parent,
		sessionDir: sessions,
		mode: "tui",
		ownExtensionPath: own,
		env: {
			TMUX: "/socket,1,0",
			TMUX_PANE: "%1",
			SECRET: "secret-launch-value",
		},
		invocation: () =>
			piInvocation({
				execPath: process.execPath,
				execArgv: [],
				argv: ["node", cli],
			}),
		trusted: (cwd) => {
			assert.equal(cwd, dir);
			events.push("trust");
			return true;
		},
		isDisposed: () => state.disposed,
		reserve: (name) => {
			events.push("reserve");
			assert.ok(!names.has(name), "name already reserved");
			names.add(name);
		},
		release: (name) => {
			events.push("release");
			names.delete(name);
		},
		startPane: (action) => action(),
		newestLivePane: () => (vertical ? "%8" : undefined),
		liveColumnPanes: () =>
			vertical
				? [
						{
							pane: {
								v: 1,
								paneId: "%8",
								process: { pid: 122, start: "previous start" },
								server: {
									socket: "/socket",
									process: { pid: 99, start: "server start" },
								},
							},
							session: "/previous",
						},
					]
				: [],
		commit: (run) => {
			events.push("live");
			assert.deepEqual(
				readJsonStrict(PaneFile, join(runDir, "pane.json")),
				run.pane,
			);
			committed.push(run);
		},
		appendRegistry: (record) => {
			events.push("registry");
			if (state.registryFails) throw new Error("registry failed");
			assert.equal(
				record.kind,
				readJsonStrict(RunSpec, join(runDir, "spec.json")).kind,
			);
			assert.equal(record.runId, runId);
			if (record.kind === "spawn")
				assert.deepEqual(record.launch, committed[0]?.spec.launch);
		},
		startTick: () => {
			events.push("tick");
		},
		identity: (pid) => {
			if (state.killed) return null;
			events.push("identity");
			assert.equal(pid, 123);
			assert.equal(existsSync(join(runDir, "pane.json")), false);
			return state.identity ? { pid, start: "child-start" } : null;
		},
		tmux: {
			async serverIdentity() {
				return {
					socket: "/socket",
					process: { pid: 99, start: "server start" },
				};
			},
			async run(args) {
				calls.push(args);
				const command = args[0];
				assert.ok(command);
				events.push(command);
				if (command === "kill-pane") {
					if (state.killFails) throw new Error("kill failed");
					state.killed = true;
					return "";
				}
				assert.equal(existsSync(join(runDir, "pane.json")), false);
				if (command === "split-window") {
					state.killed = false;
					assert.ok(names.has(plan.launch.name));
					assert.deepEqual(readdirSync(runDir).sort(), [
						"inbox",
						"launch.sh",
						"outbox",
						"questions",
						"spec.json",
						"system-prompt.md",
					]);
					assert.equal(statSync(runDir).mode & 0o777, 0o700);
					assert.equal(statSync(join(runDir, "launch.sh")).mode & 0o777, 0o700);
					const spec = readJsonStrict(RunSpec, join(runDir, "spec.json"));
					assert.ok(existsSync(spec.launch.childSessionFile));
				}
				if (state.disposeAt === command) state.disposed = true;
				if (state.fail === command) throw new Error(`${command} failed`);
				if (command === "split-window") return state.pane;
				if (command === "display-message" && args.at(-1) === "#{window_layout}")
					return tmuxLayout("119x60,121,0[119x30,121,0,8,119x29,121,31,9]");
				if (command === "display-message") return state.pid;
				if (command === "list-panes")
					return `%8\t122\t121\t0\t119\t30\t/previous\n%9\t123\t121\t31\t119\t29\t${readJsonStrict(RunSpec, join(runDir, "spec.json")).launch.childSessionFile}\n`;
				return "";
			},
			async listPanes() {
				return new Map([
					[
						"%9",
						{
							paneId: "%9",
							pid: 123,
							dead: true,
							status: 1,
							signal: null,
							session: readJsonStrict(RunSpec, join(runDir, "spec.json")).launch
								.childSessionFile,
						},
					],
				]);
			},
			async capture() {
				throw new Error("Unexpected capture");
			},
		},
	};
	return {
		dir,
		sessions,
		ownerDir,
		parent,
		own,
		plan: plan as LaunchPlan,
		context,
		state,
		events,
		calls,
		names,
		runDir,
		committed,
	};
}

test("launch transaction prepares private files, preserves focus and commits pane.json last", async (t) => {
	const f = transaction(t);
	const pending = launchRun(f.plan, f.context);
	assert.ok(f.names.has("scout-1"));
	assert.equal(f.calls.length, 0);
	const result = await pending;
	assert.deepEqual(f.calls, [
		[
			"split-window",
			"-d",
			"-h",
			"-l",
			"50%",
			"-t",
			"%1",
			"-P",
			"-F",
			"#{pane_id}",
			"",
		],
		[
			"set-option",
			"-p",
			"-t",
			"%9",
			"remain-on-exit",
			"on",
			";",
			"set-option",
			"-p",
			"-t",
			"%9",
			"@pi_subagent_run",
			runId,
			";",
			"set-option",
			"-p",
			"-t",
			"%9",
			"@pi_subagent_name",
			"scout-1",
			";",
			"set-option",
			"-p",
			"-t",
			"%9",
			"@pi_subagent_session",
			result.spec.launch.childSessionFile,
			";",
			"respawn-pane",
			"-k",
			"-t",
			"%9",
			"--",
			"/bin/sh",
			join(f.runDir, "launch.sh"),
		],
		["display-message", "-p", "-t", "%9", "#{pane_pid}"],
	]);
	assert.deepEqual(f.events, [
		"reserve",
		"trust",
		"split-window",
		"set-option",
		"display-message",
		"identity",
		"live",
		"registry",
		"tick",
	]);
	assert.equal(result.runDir, realpathSync(f.runDir));
	assert.equal(
		result.spec.launch.childSessionFile,
		realpathSync(result.spec.launch.childSessionFile),
	);
	assert.equal(result.spec.initialPrompt, f.plan.initialPrompt);
	assert.equal(
		readFileSync(join(f.runDir, "system-prompt.md"), "utf8"),
		`Read files.\n\nSubagent run ${runId}.\nYou are the subagent "scout-1" (agent scout). A parent Pi agent started you.\nYour last reply is your result. The parent receives it when you finish.\nMessages from the parent start with "Message from the parent agent".\nUse ask_question only when you cannot continue without a decision from the parent.\n`,
	);
	assert.ok(
		!f.calls
			.flat()
			.some(
				(word) =>
					word.includes("secret-launch-value") || word.includes("Do work."),
			),
	);
	assert.equal(Object.hasOwn(f.plan.launch, "childSessionFile"), false);
});

for (const mode of ["standalone", "fork"] as const) {
	test(`fresh parent session launches ${mode} without creating a parent file`, async (t) => {
		const f = transaction(t);
		const alias = join(f.dir, "session-alias");
		symlinkSync(f.sessions, alias);
		const parent = SessionManager.create(f.dir, alias);
		parent.appendMessage({
			role: "user",
			content: "Delegate now.",
			timestamp: 0,
		});
		const intended = parent.getSessionFile();
		assert.ok(intended);
		assert.equal(existsSync(intended), false);
		f.context.spawnerSessionFile = intended;
		f.context.spawnerSessionId = parent.getSessionId();
		f.context.sessionDir = alias;
		assert.equal(f.plan.kind, "spawn");
		f.plan.launch.session = mode;
		if (mode === "fork") f.plan.entries = parent.getBranch();
		const result = await launchRun(f.plan, f.context);
		const canonical = join(f.sessions, basename(intended));
		assert.equal(result.spec.spawnerSessionFile, canonical);
		const child = SessionManager.open(result.spec.launch.childSessionFile);
		assert.equal(child.getHeader()?.parentSession, canonical);
		assert.deepEqual(
			child.getBranch(),
			mode === "fork" ? parent.getBranch() : [],
		);
		assert.equal(existsSync(intended), false);
		assert.equal(f.names.size, 1);
	});
}

test("a newer child gets a vertical split and column-only layout", async (t) => {
	const f = transaction(t, true);
	await launchRun(f.plan, f.context);
	assert.deepEqual(f.calls[0], [
		"split-window",
		"-d",
		"-v",
		"-t",
		"%8",
		"-P",
		"-F",
		"#{pane_id}",
		"",
	]);
	assert.deepEqual(
		f.calls.filter((args) => args[0] === "resize-pane"),
		[["resize-pane", "-t", "%8", "-y", "30"]],
	);
	assert.ok(!f.calls.some((args) => args[0] === "select-layout"));
});

for (const command of [
	"split-window",
	"set-option",
	"display-message",
	"resize-pane",
]) {
	for (const cause of ["failure", "disposed"]) {
		test(`rollback after ${cause} at ${command}`, async (t) => {
			const f = transaction(t, true);
			if (cause === "failure") f.state.fail = command;
			else f.state.disposeAt = command;
			await assert.rejects(
				launchRun(f.plan, f.context),
				cause === "failure"
					? new RegExp(`${command} failed`)
					: /Pi replaced the session.*It was not started/,
			);
			const killed =
				command === "resize-pane" ||
				(command === "display-message" && cause === "disposed");
			const retained =
				!killed && !(command === "split-window" && cause === "failure");
			assert.equal(
				f.calls.some((args) => args[0] === "kill-pane"),
				killed,
			);
			if (killed) assert.deepEqual(f.calls.at(-1), ["kill-pane", "-t", "%9"]);
			assert.deepEqual(readdirSync(f.ownerDir), retained ? [runId] : []);
			assert.equal(readdirSync(f.sessions).length, retained ? 2 : 1);
			assert.equal(f.names.size, retained ? 1 : 0);
			assert.ok(!f.events.includes("live"));
			assert.ok(!f.events.includes("registry"));
		});
	}
}

for (const failure of [
	"kill",
	"live",
	"before-pid",
	"unknown-pid",
	"exited",
] as const) {
	test(`rollback exit confirmation: ${failure}`, {
		timeout: 20_000,
	}, async (t) => {
		const f = transaction(t);
		const child = spawn(
			process.execPath,
			["-e", "process.send('ready'); setInterval(() => {}, 1000);"],
			{
				stdio: ["ignore", "ignore", "ignore", "ipc"],
			},
		);
		t.after(async () => {
			if (child.exitCode === null && child.signalCode === null) {
				const exited = once(child, "exit");
				child.kill("SIGKILL");
				await exited;
			}
		});
		await once(child, "message");
		assert.ok(child.pid);
		const identity = processIdentity(child.pid);
		assert.ok(identity);
		f.state.pid = String(child.pid);
		f.context.identity = processIdentity;
		if (failure === "before-pid" || failure === "unknown-pid")
			f.state.fail = "display-message";
		else f.state.registryFails = true;
		const run = f.context.tmux.run;
		f.context.tmux.run = async (args) => {
			if (args[0] !== "kill-pane") return run(args);
			if (failure === "kill") throw new Error("kill failed");
			if (failure === "exited") {
				const exited = once(child, "exit");
				child.kill("SIGTERM");
				await exited;
			}
			return "";
		};
		f.context.tmux.listPanes = async () => {
			if (failure === "unknown-pid") throw new Error("cannot inspect pane");
			return new Map([
				[
					"%9",
					{
						paneId: "%9",
						pid: identity.pid,
						dead: false,
						status: null,
						signal: null,
						session: readJsonStrict(RunSpec, join(f.runDir, "spec.json")).launch
							.childSessionFile,
					},
				],
			]);
		};
		await assert.rejects(launchRun(f.plan, f.context), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /registry failed|display-message failed/);
			if (failure !== "exited")
				assert.match(
					error.message,
					/confirm child exit|still alive|kill failed/i,
				);
			return true;
		});
		if (failure === "exited") {
			assert.equal(processAlive(identity), false);
			assert.deepEqual(readdirSync(f.ownerDir), []);
			assert.deepEqual(readdirSync(f.sessions), ["parent.jsonl"]);
			assert.equal(f.names.size, 0);
		} else {
			assert.equal(processAlive(identity), true);
			assert.equal(existsSync(f.runDir), true);
			const spec = readJsonStrict(RunSpec, join(f.runDir, "spec.json"));
			assert.equal(existsSync(spec.launch.childSessionFile), true);
			assert.equal(f.names.has(f.plan.launch.name), true);
			if (failure === "unknown-pid" || failure === "before-pid")
				assert.equal(existsSync(join(f.runDir, "pane.json")), false);
			else
				assert.deepEqual(
					readJsonStrict(PaneFile, join(f.runDir, "pane.json")),
					{
						v: 1,
						paneId: "%9",
						process: identity,
						server: await f.context.tmux.serverIdentity(),
					},
				);
			await assert.rejects(launchRun(f.plan, f.context), /already reserved/);
		}
	});
}

test("unverified pre-PID rollback retains files, session and reserved name", async (t) => {
	const f = transaction(t);
	f.state.fail = "display-message";
	await assert.rejects(launchRun(f.plan, f.context), (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.match(error.message, /identity.*unknown|unknown.*identity/);
		assert.ok(error.message.includes(f.runDir));
		return true;
	});
	assert.equal(
		f.calls.some((args) => args[0] === "kill-pane"),
		false,
	);
	assert.equal(existsSync(f.runDir), true);
	const spec = readJsonStrict(RunSpec, join(f.runDir, "spec.json"));
	assert.equal(existsSync(spec.launch.childSessionFile), true);
	assert.equal(f.names.has(f.plan.launch.name), true);
});

for (const mismatch of ["pid", "session", "server", "unknown"] as const)
	test(`verified launch rollback retains a pane after ${mismatch} identity changes`, async (t) => {
		const f = transaction(t);
		const list = f.context.tmux.listPanes;
		const server = f.context.tmux.serverIdentity;
		f.context.appendRegistry = () => {
			if (mismatch === "server")
				f.context.tmux.serverIdentity = async () => ({
					socket: "/socket",
					process: { pid: 99, start: "restarted server" },
				});
			else if (mismatch === "unknown")
				f.context.tmux.serverIdentity = async () => {
					throw new Error("server identity unavailable");
				};
			else
				f.context.tmux.listPanes = async () => {
					const panes = await list();
					const pane = panes.get("%9");
					assert.ok(pane);
					if (mismatch === "pid") pane.pid++;
					else pane.session = "/unrelated";
					return panes;
				};
			throw new Error("registry failed");
		};
		await assert.rejects(
			launchRun(f.plan, f.context),
			/registry failed.*identity.*Kept/s,
		);
		assert.equal(
			f.calls.some((args) => args[0] === "kill-pane"),
			false,
		);
		assert.equal(f.names.size, 1);
		assert.deepEqual(
			readJsonStrict(PaneFile, join(f.runDir, "pane.json")).server,
			await server(),
		);
		const spec = readJsonStrict(RunSpec, join(f.runDir, "spec.json"));
		assert.equal(existsSync(spec.launch.childSessionFile), true);
	});

test("verified early rollback checks pane ownership and cleans files", async (t) => {
	const f = transaction(t, true);
	f.state.fail = "resize-pane";
	await assert.rejects(launchRun(f.plan, f.context), /resize-pane failed/);
	assert.equal(
		f.calls.some((args) => args[0] === "kill-pane"),
		true,
	);
	assert.equal(existsSync(f.runDir), false);
	assert.equal(f.names.size, 0);
});

test("rollback preserves the primary and kill errors and keeps recovery files", async (t) => {
	const f = transaction(t);
	f.state.registryFails = true;
	f.state.killFails = true;
	await assert.rejects(launchRun(f.plan, f.context), (error: unknown) => {
		assert.ok(error instanceof AggregateError);
		assert.match(error.message, /registry failed.*kill failed/s);
		assert.equal(error.errors.length, 3);
		assert.match(error.message, /Kept its name and recovery files/);
		return true;
	});
	assert.deepEqual(readdirSync(f.ownerDir), [runId]);
	const spec = readJsonStrict(RunSpec, join(f.runDir, "spec.json"));
	assert.equal(existsSync(spec.launch.childSessionFile), true);
	assert.equal(f.names.size, 1);
});

for (const [pane, pid, identity, pattern] of [
	["bad", "123", true, /pane id/],
	["%9", "0", true, /pid/],
	["%9", "12x", true, /pid/],
	["%9", "9007199254740992", true, /pid/],
	["%9", "123", false, /exited before it could start/],
] as const) {
	test(`rejects invalid pane identity ${pane}/${pid}/${identity}`, async (t) => {
		const f = transaction(t);
		Object.assign(f.state, { pane, pid, identity });
		await assert.rejects(launchRun(f.plan, f.context), pattern);
		assert.equal(
			f.calls.some((args) => args[0] === "kill-pane"),
			false,
		);
		assert.equal(f.names.size, 1);
		assert.deepEqual(readdirSync(f.ownerDir), [runId]);
	});
}

test("resume keeps its session on rollback and appends a resume record on success", async (t) => {
	const f = transaction(t);
	f.plan = {
		kind: "resume",
		launch: { ...f.plan.launch, childSessionFile: join(f.dir, "child.jsonl") },
		initialPrompt: "Message from the parent agent:\n\nContinue.",
	};
	writeFileSync(f.plan.launch.childSessionFile, "existing session");
	f.state.registryFails = true;
	await assert.rejects(launchRun(f.plan, f.context), /registry failed/);
	assert.equal(
		readFileSync(f.plan.launch.childSessionFile, "utf8"),
		"existing session",
	);
	f.state.registryFails = false;
	const result = await launchRun(f.plan, f.context);
	assert.equal(
		result.spec.launch.childSessionFile,
		f.plan.launch.childSessionFile,
	);
	assert.deepEqual(readdirSync(f.sessions), ["parent.jsonl"]);
});

test("preflight rejects invalid command words before any filesystem change", async (t) => {
	for (const change of [
		(f: ReturnType<typeof transaction>) => {
			f.plan.initialPrompt = "bad\0";
		},
		(f: ReturnType<typeof transaction>) => {
			f.plan.initialPrompt = "x".repeat(200 * 1024);
		},
		(f: ReturnType<typeof transaction>) => {
			f.context.env.BIG = "x".repeat(200 * 1024);
		},
		(f: ReturnType<typeof transaction>) => {
			for (let i = 0; i < 7; i++) f.context.env[`BIG${i}`] = "x".repeat(120000);
		},
	]) {
		const f = transaction(t);
		change(f);
		const parentContentBefore = readFileSync(f.parent);
		const parentBefore = statSync(f.parent, { bigint: true });
		const sessionEntriesBefore = readdirSync(f.sessions);
		const ownerEntriesBefore = readdirSync(f.ownerDir);
		chmodSync(f.parent, 0o400);
		chmodSync(f.sessions, 0o500);
		chmodSync(f.ownerDir, 0o500);
		try {
			await assert.rejects(launchRun(f.plan, f.context), /NUL|too long/);
			assert.equal(readFileSync(f.parent).compare(parentContentBefore), 0);
			const parentAfter = statSync(f.parent, { bigint: true });
			assert.equal(parentAfter.dev, parentBefore.dev);
			assert.equal(parentAfter.ino, parentBefore.ino);
			assert.equal(parentAfter.size, parentBefore.size);
			assert.equal(parentAfter.mtimeNs, parentBefore.mtimeNs);
			assert.deepEqual(readdirSync(f.sessions), sessionEntriesBefore);
			assert.deepEqual(readdirSync(f.ownerDir), ownerEntriesBefore);
		} finally {
			chmodSync(f.parent, 0o600);
			chmodSync(f.sessions, 0o700);
			chmodSync(f.ownerDir, 0o700);
		}
		assert.equal(f.calls.length, 0);
		assert.equal(f.names.size, 0);
	}
});

test("draft preflight keeps the exact total byte limit before the session exists", async (t) => {
	const f = transaction(t);
	const candidate = join(
		f.sessions,
		"2000-01-01T00-00-00-000Z_00000000-0000-0000-0000-000000000000.jsonl",
	);
	assert.ok(f.context.invocation);
	const words = [
		...Object.entries(f.context.env).map(([name, value]) => `${name}=${value}`),
		...f.context.invocation(),
		...piArgs(
			{ ...f.plan.launch, childSessionFile: candidate },
			{
				runDir: f.runDir,
				ownExtensionPath: f.own,
				trusted: true,
				initialPrompt: f.plan.initialPrompt,
			},
		),
	];
	let remaining =
		786432 - words.reduce((sum, word) => sum + Buffer.byteLength(word), 0);
	let last = "";
	for (let i = 0; remaining > 0; i++) {
		last = `PAD${i}`;
		const size = Math.min(131071, remaining);
		f.context.env[last] = "x".repeat(size - Buffer.byteLength(`${last}=`));
		remaining -= size;
	}
	const padding = f.context.env[last];
	assert.ok(padding);
	f.context.env[last] = `${padding}x`;
	const changes: string[] = [];
	const watchers = [f.ownerDir, f.sessions].map((dir) =>
		watch(dir, (event, name) => changes.push(`${event}:${name}`)),
	);
	try {
		await assert.rejects(launchRun(f.plan, f.context), /too long/);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(changes, []);
	} finally {
		for (const watcher of watchers) watcher.close();
	}
	assert.equal(f.calls.length, 0);
	f.context.env[last] = padding;
	const result = await launchRun(f.plan, f.context);
	assert.equal(
		Buffer.byteLength(result.spec.launch.childSessionFile),
		Buffer.byteLength(candidate),
	);
	assert.notEqual(result.spec.launch.childSessionFile, candidate);
	assert.equal(existsSync(candidate), false);
});

test("reservations prevent concurrent launches of one name", async (t) => {
	const f = transaction(t);
	const pending = launchRun(f.plan, f.context);
	await assert.rejects(launchRun(f.plan, f.context), /already reserved/);
	assert.equal(f.names.size, 1);
	await pending;
	assert.equal(f.calls.filter((args) => args[0] === "split-window").length, 1);
});

test("an existing run directory is never removed on rollback", async (t) => {
	const f = transaction(t);
	mkdirSync(f.runDir);
	writeFileSync(join(f.runDir, "keep"), "existing");
	await assert.rejects(launchRun(f.plan, f.context), /EEXIST/);
	assert.equal(readFileSync(join(f.runDir, "keep"), "utf8"), "existing");
	assert.equal(f.names.size, 0);
});

test("synchronous commit failure rolls back a started pane", async (t) => {
	const f = transaction(t);
	f.state.registryFails = true;
	await assert.rejects(launchRun(f.plan, f.context), /registry failed/);
	assert.deepEqual(f.calls.at(-1), ["kill-pane", "-t", "%9"]);
	assert.equal(f.names.size, 0);
	assert.deepEqual(readdirSync(f.ownerDir), []);
	assert.ok(!f.events.includes("tick"));
});

for (const [field, value, pattern] of [
	["mode", "rpc", /interactive Pi TUI/],
	["spawnerSessionFile", undefined, /saved Pi session/],
] as const) {
	test(`rejects launch precondition ${field}`, async (t) => {
		const f = transaction(t);
		Object.assign(f.context, { [field]: value });
		await assert.rejects(launchRun(f.plan, f.context), pattern);
		assert.deepEqual(f.events, []);
		assert.deepEqual(readdirSync(f.ownerDir), []);
	});
}

test("missing tmux and an already disposed context cannot start a pane", async (t) => {
	const f = transaction(t);
	f.context.env.TMUX = "";
	await assert.rejects(launchRun(f.plan, f.context), /inside tmux/);
	assert.deepEqual(f.events, []);
	f.context.env.TMUX = "/socket,1,0";
	f.state.disposed = true;
	await assert.rejects(launchRun(f.plan, f.context), /Pi replaced the session/);
	assert.equal(f.names.size, 0);
	assert.deepEqual(f.calls, []);
	assert.deepEqual(readdirSync(f.ownerDir), []);
});

test("fork copies only the supplied entries and adds the human guidance", async (t) => {
	const f = transaction(t);
	assert.equal(f.plan.kind, "spawn");
	f.plan.launch.session = "fork";
	f.plan.launch.autoExit = false;
	f.plan.entries = [
		{
			type: "custom",
			id: "branch",
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: "test",
			data: {},
		},
	];
	const result = await launchRun(f.plan, f.context);
	const lines = readFileSync(result.spec.launch.childSessionFile, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.equal(lines[0].cwd, f.dir);
	assert.equal(lines[0].parentSession, f.parent);
	assert.deepEqual(lines.slice(1), f.plan.entries);
	assert.match(
		readFileSync(join(f.runDir, "system-prompt.md"), "utf8"),
		/A human works with you in this pane/,
	);
});

test("canonical paths are stored and extension aliases fail before writes", async (t) => {
	const f = transaction(t);
	const alias = join(f.dir, "alias");
	symlinkSync(f.dir, alias);
	f.plan.launch.cwd = alias;
	f.context.ownerDir = join(alias, "owner");
	f.context.sessionDir = join(alias, "sessions");
	f.context.spawnerSessionFile = join(alias, "sessions", "parent.jsonl");
	f.context.ownExtensionPath = join(alias, "index.ts");
	const extension = join(f.dir, "extension.ts");
	writeFileSync(extension, "");
	f.plan.launch.extensions = [extension, join(alias, "extension.ts")];
	await assert.rejects(
		launchRun(f.plan, f.context),
		/Two extension paths point to one file/,
	);
	assert.deepEqual(readdirSync(f.ownerDir), []);
	f.plan.launch.extensions = [join(alias, "extension.ts")];
	f.plan.launch.skills = [join(alias, "index.ts")];
	const result = await launchRun(f.plan, f.context);
	assert.equal(result.runDir, f.runDir);
	assert.equal(result.spec.spawnerSessionFile, f.parent);
	assert.equal(result.spec.launch.cwd, f.dir);
	assert.deepEqual(result.spec.launch.extensions, [extension]);
	assert.deepEqual(result.spec.launch.skills, [f.own]);
});

test("a path-free catalog draft starts a fresh session and its stored launch resumes", async (t) => {
	const f = transaction(t);
	const catalog = parseStrict(
		Catalog,
		{
			agents: {
				scout: {
					name: "scout",
					file: f.own,
					scope: "user",
					description: "Read files",
					tools: ["read"],
					skills: "none",
					spawns: [],
					session: "standalone",
					autoExit: true,
					modelInvocable: true,
					systemPrompt: { mode: "append", text: "Read files." },
				},
			},
			profiles: {
				quick: {
					model: { provider: "provider", id: "model/id" },
					thinking: "low",
					guidance: "Short tasks",
					extensions: [],
				},
			},
			toolSources: { read: { kind: "builtin" } },
			skills: {},
		},
		"catalog",
	);
	const draft = resolveLaunch({
		catalog,
		name: "scout-1",
		agent: "scout",
		profile: "quick",
		spawnerDepth: 0,
		spawnerAllowlist: ["scout"],
		parentCwd: f.dir,
		cwd: f.dir,
		modelInvocation: true,
	});
	assert.equal(Object.hasOwn(draft, "childSessionFile"), false);
	assert.deepEqual(readdirSync(f.sessions), ["parent.jsonl"]);
	assert.deepEqual(readdirSync(f.ownerDir), []);
	const spawned = await launchRun(
		{ kind: "spawn", launch: draft, initialPrompt: f.plan.initialPrompt },
		f.context,
	);
	assert.deepEqual(
		parseStrict(Launch, spawned.spec.launch, "stored launch"),
		spawned.spec.launch,
	);
	assert.equal(
		spawned.spec.launch.childSessionFile,
		realpathSync(spawned.spec.launch.childSessionFile),
	);
	assert.equal(Object.hasOwn(draft, "childSessionFile"), false);
	const before = readFileSync(spawned.spec.launch.childSessionFile, "utf8");
	const resume = transaction(t);
	resume.context.trusted = (cwd) => {
		assert.equal(cwd, f.dir);
		return false;
	};
	const resumed = await launchRun(
		{
			kind: "resume",
			launch: spawned.spec.launch,
			initialPrompt: "Message from the parent agent:\n\nContinue.",
		},
		resume.context,
	);
	assert.deepEqual(resumed.spec.launch, spawned.spec.launch);
	assert.equal(
		readFileSync(spawned.spec.launch.childSessionFile, "utf8"),
		before,
	);
	assert.deepEqual(readdirSync(resume.sessions), ["parent.jsonl"]);
});

test("trust is recomputed for each launch, including resume", async (t) => {
	const f = transaction(t);
	f.plan = {
		kind: "resume",
		launch: { ...f.plan.launch, childSessionFile: join(f.dir, "child.jsonl") },
		initialPrompt: "Message from the parent agent:\n\nContinue.",
	};
	writeFileSync(f.plan.launch.childSessionFile, "existing");
	let trust = true;
	f.context.trusted = () => trust;
	f.state.registryFails = true;
	const run = f.context.tmux.run;
	f.context.tmux.run = async (args) => {
		if (args[0] === "split-window") {
			const script = readFileSync(join(f.runDir, "launch.sh"), "utf8");
			assert.ok(script.includes(trust ? "'--approve'" : "'--no-approve'"));
		}
		return run(args);
	};
	await assert.rejects(launchRun(f.plan, f.context), /registry failed/);
	trust = false;
	f.state.registryFails = false;
	await launchRun(f.plan, f.context);
});
