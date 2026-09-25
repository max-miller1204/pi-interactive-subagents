import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Deliverer, type Item, type Source } from "../../src/delivery.ts";

function fixture(
	options: { child?: boolean; appendQuiet?: boolean; disk?: boolean } = {},
) {
	const root = mkdtempSync(join(tmpdir(), "delivery-"));
	const sessionFile = join(root, "session.jsonl");
	if (options.disk) writeFileSync(sessionFile, "session header\n");
	const entries: unknown[] = [];
	const sent: { id: string; trigger: boolean }[] = [];
	const items: Item[] = [];
	const confirmed: string[] = [];
	const source: Source = {
		key: "queue",
		items: () => [...items],
		build: (item) => ({
			kind: "message",
			trigger: true,
			message: {
				customType: "subagent_message",
				content: item.id,
				display: true,
				details: { deliveryId: item.id },
			},
		}),
		confirm: (item) => {
			confirmed.push(item.id);
			rmSync(join(root, `${item.id}.json`));
			items.splice(
				items.findIndex((i) => i.id === item.id),
				1,
			);
		},
	};
	let idle = true;
	const pi = {
		sendMessage: (
			message: { details: { deliveryId: string } },
			sendOptions: { triggerTurn: boolean },
		) => {
			sent.push({
				id: message.details.deliveryId,
				trigger: sendOptions.triggerTurn,
			});
			if (sendOptions.triggerTurn) idle = false;
			else if (options.appendQuiet !== false)
				entries.push({ type: "custom_message", details: message.details });
		},
		appendEntry: () => {},
	} as unknown as ExtensionAPI;
	const ctx = {
		isIdle: () => idle,
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
			getSessionFile: () => sessionFile,
		},
	} as unknown as ExtensionContext;
	const deliverer = new Deliverer(
		pi,
		ctx,
		[source],
		() => false,
		options.child ?? false,
	);
	const add = (name: string) => {
		const id = `run:outbox:${name}`;
		writeFileSync(join(root, `${id}.json`), JSON.stringify({ id }));
		items.push({ id });
	};
	return {
		root,
		sessionFile,
		entries,
		sent,
		items,
		confirmed,
		source,
		deliverer,
		add,
		setIdle: (value: boolean) => {
			idle = value;
		},
		cleanup: () => {
			deliverer.shutdown();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test("keeps an offered item until its receiving session exists on disk", () => {
	const f = fixture();
	try {
		f.add("00000000000000000001-abcd1234");
		f.entries.push({
			type: "custom_message",
			details: { deliveryId: "run:outbox:00000000000000000001-abcd1234" },
		});
		f.deliverer.reconcile();
		assert.equal(f.items.length, 1);
		assert.ok(
			existsSync(join(f.root, "run:outbox:00000000000000000001-abcd1234.json")),
		);
		assert.deepEqual(f.confirmed, []);
		writeFileSync(f.sessionFile, "session header\n");
		f.deliverer.reconcile();
		assert.equal(f.items.length, 0);
		assert.equal(f.confirmed.length, 1);
	} finally {
		f.cleanup();
	}
});

test("confirms an item once the session file exists", () => {
	const f = fixture({ disk: true });
	try {
		f.add("1");
		f.entries.push({
			type: "message",
			message: { role: "toolResult", details: { deliveryId: "run:outbox:1" } },
		});
		f.deliverer.reconcile();
		f.deliverer.reconcile();
		assert.deepEqual(f.confirmed, ["run:outbox:1"]);
	} finally {
		f.cleanup();
	}
});

test("offeredCount reports actual unconfirmed offers without exposing the set", () => {
	const f = fixture({ disk: true });
	try {
		assert.equal(f.deliverer.offeredCount, 0);
		f.add("00000000000000000001-abcd1234");
		f.deliverer.pump();
		assert.equal(f.deliverer.offeredCount, 1);
		assert.throws(
			() => Object.assign(f.deliverer, { offeredCount: 0 }),
			TypeError,
		);
		f.entries.push({
			type: "custom_message",
			details: { deliveryId: "run:outbox:00000000000000000001-abcd1234" },
		});
		f.deliverer.reconcile();
		assert.equal(f.deliverer.offeredCount, 0);
	} finally {
		f.cleanup();
	}
});

const completed = { outcome: "completed" as const };

test("three ready messages at idle start one turn and draft the remaining two in order", () => {
	const f = fixture();
	try {
		f.add("1");
		f.add("2");
		f.add("3");
		f.deliverer.pump();
		assert.deepEqual(f.sent, [{ id: "run:outbox:1", trigger: true }]);
		f.deliverer.onAgentStart();
		const result = f.deliverer.onBoundary(completed);
		assert.deepEqual(
			result?.entries?.map((e) =>
				e.type === "custom_message" ? e.details : undefined,
			),
			[{ deliveryId: "run:outbox:2" }, { deliveryId: "run:outbox:3" }],
		);
		assert.equal(result?.continue, true);
	} finally {
		f.cleanup();
	}
});

test("a completed boundary with only quiet drafts does not continue", () => {
	const f = fixture();
	try {
		f.add("1");
		f.source.build = (item) => ({
			kind: "message",
			trigger: false,
			message: {
				customType: "subagent",
				content: item.id,
				display: true,
				details: { deliveryId: item.id },
			},
		});
		f.deliverer.onAgentStart();
		const result = f.deliverer.onBoundary(completed);
		assert.deepEqual(
			result?.entries?.map((entry) => entry.type),
			["custom_message"],
		);
		assert.equal(result?.continue, false);
	} finally {
		f.cleanup();
	}
});

test("a completed boundary with only held triggers does not continue", () => {
	const f = fixture();
	try {
		f.deliverer.onAgentStart();
		f.entries.push({
			type: "message",
			message: { role: "assistant", stopReason: "aborted" },
		});
		f.add("1");
		f.deliverer.onAgentSettled();
		f.deliverer.onAgentStart();
		const result = f.deliverer.onBoundary(completed);
		assert.deepEqual(
			result?.entries?.map((entry) => entry.type),
			["custom_message"],
		);
		assert.equal(result?.continue, false);
	} finally {
		f.cleanup();
	}
});

test("an offered boundary draft absent from session entries becomes ready at settlement", async () => {
	const f = fixture();
	try {
		f.deliverer.onAgentStart();
		f.add("1");
		assert.equal(f.deliverer.onBoundary(completed)?.entries?.length, 1);
		f.entries.push({
			type: "message",
			message: { role: "assistant", stopReason: "stop" },
		});
		f.setIdle(true);
		f.deliverer.onAgentSettled();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(f.sent, [{ id: "run:outbox:1", trigger: true }]);
		assert.equal(f.items.length, 1);
	} finally {
		f.cleanup();
	}
});

test("a quiet message is appended synchronously without starting a turn", () => {
	const f = fixture();
	try {
		f.add("1");
		f.source.build = (item) => ({
			kind: "message",
			trigger: false,
			message: {
				customType: "subagent",
				content: item.id,
				display: true,
				details: { deliveryId: item.id },
			},
		});
		f.deliverer.pump();
		assert.deepEqual(f.sent, [{ id: "run:outbox:1", trigger: false }]);
		assert.equal(f.entries.length, 1);
	} finally {
		f.cleanup();
	}
});

test("aborted and error boundaries return no drafts", () => {
	const f = fixture();
	try {
		f.add("1");
		f.deliverer.onAgentStart();
		assert.equal(f.deliverer.onBoundary({ outcome: "aborted" }), undefined);
		assert.equal(f.deliverer.onBoundary({ outcome: "error" }), undefined);
		assert.equal(f.items.length, 1);
	} finally {
		f.cleanup();
	}
});

test("aborted settlement holds ready ids and a later id starts a turn", async () => {
	const f = fixture();
	try {
		f.deliverer.onAgentStart();
		f.add("1");
		f.entries.push({
			type: "message",
			message: { role: "assistant", stopReason: "aborted" },
		});
		f.setIdle(true);
		f.deliverer.onAgentSettled();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(f.sent, [{ id: "run:outbox:1", trigger: false }]);
		f.add("2");
		f.deliverer.pump();
		assert.deepEqual(f.sent[1], { id: "run:outbox:2", trigger: true });
	} finally {
		f.cleanup();
	}
});

test("a broken quiet-send invariant throws on every later pump", () => {
	const f = fixture({ appendQuiet: false });
	try {
		f.add("1");
		f.source.build = (item) => ({
			kind: "message",
			trigger: false,
			message: {
				customType: "subagent",
				content: item.id,
				display: true,
				details: { deliveryId: item.id },
			},
		});
		assert.throws(
			() => f.deliverer.pump(),
			/Pi did not append subagent message run:outbox:1/,
		);
		assert.throws(
			() => f.deliverer.pump(),
			/Pi did not append subagent message run:outbox:1/,
		);
	} finally {
		f.cleanup();
	}
});

test("a question answer waiter resolves in busy and run modes", () => {
	const f = fixture();
	const answered: string[] = [];
	try {
		f.add("1");
		f.source.build = () => ({
			kind: "answer",
			text: "yes",
			resolve: (id, text) => answered.push(`${id}:${text}`),
		});
		f.setIdle(false);
		f.deliverer.pump();
		assert.deepEqual(answered, ["run:outbox:1:yes"]);
		f.deliverer.onAgentStart();
		f.add("2");
		f.deliverer.pump();
		assert.deepEqual(answered, ["run:outbox:1:yes", "run:outbox:2:yes"]);
	} finally {
		f.cleanup();
	}
});

test("a dropped source item is confirmed without delivery", () => {
	const f = fixture();
	try {
		f.add("1");
		f.source.build = () => "drop";
		f.deliverer.pump();
		assert.deepEqual(f.confirmed, ["run:outbox:1"]);
		assert.deepEqual(f.sent, []);
	} finally {
		f.cleanup();
	}
});

test("an adopt prelude precedes its message draft", () => {
	const f = fixture();
	try {
		f.add("1");
		f.source.prelude = () => [
			{
				customType: "subagent",
				data: { v: 1, kind: "resume", runId: "run", name: "agent" },
			},
		];
		f.deliverer.onAgentStart();
		const result = f.deliverer.onBoundary(completed);
		assert.deepEqual(
			result?.entries?.map((e) => e.type),
			["custom", "custom_message"],
		);
	} finally {
		f.cleanup();
	}
});

test("prompt preflight blocks a run before completion", () => {
	const f = fixture();
	try {
		f.add("1");
		f.deliverer.onInput();
		f.deliverer.pump();
		assert.deepEqual(f.sent, []);
		f.deliverer.onAgentStart();
		const result = f.deliverer.onBoundary(completed);
		assert.equal(result?.entries?.length, 1);
	} finally {
		f.cleanup();
	}
});

test("a stale prompt guard releases after thirty seconds", () => {
	const f = fixture();
	const now = Date.now;
	try {
		let time = 100_000;
		Date.now = () => time;
		f.deliverer.onInput();
		f.add("1");
		f.deliverer.pump();
		assert.deepEqual(f.sent, []);
		time += 30_001;
		f.deliverer.pump();
		assert.equal(f.sent.length, 1);
	} finally {
		Date.now = now;
		f.cleanup();
	}
});

test("child task gate stays closed until its first agent_start", () => {
	const f = fixture({ child: true });
	try {
		f.add("1");
		f.deliverer.pump();
		assert.equal(f.sent.length, 0);
		f.deliverer.onAgentStart();
		f.setIdle(true);
		f.deliverer.onAgentSettled();
		f.deliverer.pump();
		assert.equal(f.sent.length, 1);
	} finally {
		f.cleanup();
	}
});
