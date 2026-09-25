import assert from "node:assert/strict";
import { test } from "node:test";
import {
	checkTmuxVersion,
	createTmux,
	type TmuxExec,
	tmuxSocket,
} from "../../src/tmux.ts";

const format =
	"#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_dead_signal}\t#{@pi_subagent_session}";

function fake(output: string, calls: string[][] = []) {
	const exec: TmuxExec = async (file, args, options) => {
		assert.equal(file, "tmux");
		assert.deepEqual(options, { encoding: "utf8" });
		calls.push(args);
		return { stdout: output, stderr: "" };
	};
	return createTmux("/tmp/isolated-tmux-test.sock", exec);
}

test("socket is the first field of TMUX and rejects missing sockets", () => {
	assert.equal(tmuxSocket("/tmp/isolated.sock,100,4"), "/tmp/isolated.sock");
	assert.throws(() => tmuxSocket(""), /Subagents need Pi to run inside tmux\./);
	assert.throws(
		() => tmuxSocket(",100,4"),
		/Subagents need Pi to run inside tmux\./,
	);
});

test("server identity uses the actual server pid and start, not a reused socket", async () => {
	let start = "original start";
	const calls: string[][] = [];
	const tmux = createTmux(
		"/socket",
		async (_file, args) => {
			calls.push(args);
			return { stdout: "123\n", stderr: "" };
		},
		(pid) => ({ pid, start }),
	);
	const saved = await tmux.serverIdentity();
	assert.deepEqual(saved, { socket: "/socket", process: { pid: 123, start } });
	start = "restarted server";
	assert.notDeepEqual(await tmux.serverIdentity(), saved);
	assert.deepEqual(calls[0], [
		"-S",
		"/socket",
		"display-message",
		"-p",
		"#{pid}",
	]);
});

for (const output of ["", "0", "abc", "9007199254740992", "123"])
	test(`unknown tmux server identity fails loudly: ${JSON.stringify(output)}`, async () => {
		const tmux = createTmux(
			"/socket",
			async () => ({ stdout: output, stderr: "" }),
			() => null,
		);
		await assert.rejects(tmux.serverIdentity(), /server/);
	});

test("each command uses the isolated socket and capture is diagnostics text", async () => {
	const calls: string[][] = [];
	const tmux = fake("human text\n", calls);
	assert.equal(await tmux.run(["display-message", "-p"]), "human text\n");
	assert.equal(await tmux.capture("%7"), "human text\n");
	assert.deepEqual(calls, [
		["-S", "/tmp/isolated-tmux-test.sock", "display-message", "-p"],
		[
			"-S",
			"/tmp/isolated-tmux-test.sock",
			"capture-pane",
			"-p",
			"-J",
			"-S",
			"-40",
			"-t",
			"%7",
		],
	]);
});

test("listPanes parses all six fields, numeric statuses and signals", async () => {
	const calls: string[][] = [];
	const tmux = fake(
		"%1\t123\t0\t\t\t/s1\n%2\t456\t1\t0\t\t/s2\n%3\t789\t1\t\tSIGTERM\t\n",
		calls,
	);
	assert.deepEqual(
		[...(await tmux.listPanes())],
		[
			[
				"%1",
				{
					paneId: "%1",
					pid: 123,
					dead: false,
					status: null,
					signal: null,
					session: "/s1",
				},
			],
			[
				"%2",
				{
					paneId: "%2",
					pid: 456,
					dead: true,
					status: 0,
					signal: null,
					session: "/s2",
				},
			],
			[
				"%3",
				{
					paneId: "%3",
					pid: 789,
					dead: true,
					status: null,
					signal: "SIGTERM",
					session: "",
				},
			],
		],
	);
	assert.deepEqual(calls, [
		["-S", "/tmp/isolated-tmux-test.sock", "list-panes", "-a", "-F", format],
	]);
});

test("empty list is valid; every malformed pane line fails loudly", async () => {
	assert.equal((await fake("").listPanes()).size, 0);
	for (const line of [
		"%1\t2\t0\t\t",
		"%1\t2\t0\t\t\t\textra",
		"%1\t0\t0\t\t\t",
		"%1\tx\t0\t\t\t",
		"%1\t2\t2\t\t\t",
		"%1\t2\t0\t-1\t\t",
		"%1\t2\t0\t\tSIG TERM\t",
		"bad\t2\t0\t\t\t",
		"%1\t2\t1\t\t\t",
		"%1\t2\t0\t\t\t\n\n",
	]) {
		await assert.rejects(fake(`${line}\n`).listPanes(), /pane|line/i, line);
	}
	await assert.rejects(
		fake("%1\t2\t1\t\t\t\n").listPanes(),
		/tmux reports pane %1 as dead with no exit status and no signal\./,
	);
	await assert.rejects(
		fake("%1\t2\t0\t\t\t\n%1\t3\t0\t\t\t\n").listPanes(),
		/duplicate/i,
	);
});

test("version check rejects 3.2 and accepts 3.3 and later", async () => {
	await assert.rejects(
		checkTmuxVersion(fake("tmux 3.2a\n")),
		/tmux 3\.2a is too old\. Subagents need tmux 3\.3 or newer\./,
	);
	await checkTmuxVersion(fake("tmux 3.3\n"));
	await checkTmuxVersion(fake("tmux 3.3a\n"));
	await checkTmuxVersion(fake("tmux 3.7\n"));
	const calls: string[][] = [];
	await checkTmuxVersion(fake("tmux 3.3\n", calls));
	assert.deepEqual(calls, [["-S", "/tmp/isolated-tmux-test.sock", "-V"]]);
	await assert.rejects(checkTmuxVersion(fake("unknown\n")), /version/i);
});

test("nonzero exits, signals, and both no-room errors reject", async () => {
	for (const [stderr, expected] of [
		["permission denied\n", /tmux split-window failed: permission denied/],
		[
			"no space for new pane\n",
			/No room for another subagent pane in this window\. Close a subagent pane or make the terminal larger\./,
		],
		[
			"no space for a new pane\n",
			/No room for another subagent pane in this window\. Close a subagent pane or make the terminal larger\./,
		],
	] as const) {
		const exec: TmuxExec = async () => {
			throw Object.assign(new Error("exit 1"), { stderr, code: 1 });
		};
		await assert.rejects(
			createTmux("/tmp/isolated.sock", exec).run(["split-window"]),
			expected,
		);
	}
	const killed: TmuxExec = async () => {
		throw Object.assign(new Error("killed"), { stderr: "", signal: "SIGKILL" });
	};
	await assert.rejects(
		createTmux("/tmp/isolated.sock", killed).run(["list-panes"]),
		/tmux list-panes failed:/,
	);
});
