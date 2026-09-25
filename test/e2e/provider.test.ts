import assert from "node:assert/strict";
import { Socket } from "node:net";
import { test } from "node:test";
import {
	type Message,
	type Model,
	normalizeContext,
} from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import fauxBrain, { scriptStep } from "../fixtures/faux-brain.ts";

const user = (text: string): Message => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp: 1,
});
const assistant = (text: string): Message => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "faux",
	provider: "faux",
	model: "brain",
	stopReason: "stop",
	timestamp: 1,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
});
const prompt =
	'#script [{"say":"hello"},{"call":"subagent","args":{"agent":"scout"}}]';

function provider(): ProviderConfig {
	let config: ProviderConfig | undefined;
	fauxBrain({
		registerProvider(name: string, value: ProviderConfig) {
			assert.equal(name, "faux");
			config = value;
		},
	} as Parameters<typeof fauxBrain>[0]);
	assert.ok(config);
	return config;
}
async function response(
	messages: Message[],
	signal?: AbortSignal,
	events?: string[],
) {
	const config = provider();
	assert.equal(config.baseUrl, "http://localhost:0");
	assert.ok(config.models?.[0]);
	const model = {
		...config.models[0],
		api: "faux",
		provider: "faux",
		baseUrl: config.baseUrl,
	} as Model<"faux">;
	const payloads: unknown[] = [];
	const responses: unknown[] = [];
	assert.ok(config.streamSimple);
	const stream = config.streamSimple(model, normalizeContext({ messages }), {
		...(signal ? { signal } : {}),
		onPayload: async (payload) => {
			events?.push("payload-start");
			await Promise.resolve();
			events?.push("payload-end");
			payloads.push(payload);
			return payload;
		},
		onResponse: (value) => {
			events?.push("response");
			responses.push(value);
		},
	});
	const result = await stream.result();
	assert.equal(payloads.length, 1);
	assert.equal(responses.length, 1);
	return result;
}

test("script selects the first and later steps from the transcript", async () => {
	assert.deepEqual(scriptStep([user(prompt)]), { say: "hello" });
	const first = await response([user(prompt)]);
	assert.equal(first.stopReason, "stop");
	assert.deepEqual(first.content, [{ type: "text", text: "hello" }]);
	const next = await response([user(prompt), assistant("hello")]);
	assert.equal(next.stopReason, "toolUse");
	assert.equal(next.content[0]?.type, "toolCall");
	if (next.content[0]?.type === "toolCall") {
		assert.equal(next.content[0].name, "subagent");
		assert.deepEqual(next.content[0].arguments, { agent: "scout" });
	}
});

test("two calls use distinct ids in one assistant message", async () => {
	const result = await response([
		user(
			'#script [{"calls":[{"call":"read","args":{}},{"call":"grep","args":{"pattern":"x"}}]}]',
		),
	]);
	assert.equal(result.stopReason, "toolUse");
	assert.equal(result.content.length, 2);
	assert.ok(result.content.every((block) => block.type === "toolCall"));
	assert.notEqual(
		result.content[0]?.type === "toolCall" && result.content[0].id,
		result.content[1]?.type === "toolCall" && result.content[1].id,
	);
});

test("invalid and exhausted steps fail with a step index", () => {
	assert.throws(
		() => scriptStep([user('#script [{"say":"ok","extra":1}]')]),
		/step 0/,
	);
	assert.throws(
		() => scriptStep([user('#script [{"say":"ok"}]'), assistant("ok")]),
		/step 1/,
	);
});

test("no script acknowledges the newest message", async () => {
	const result = await response([user("probe\nmore")]);
	assert.equal(result.stopReason, "stop");
	assert.deepEqual(result.content, [{ type: "text", text: "ack: probe" }]);
});

test("provider completes payload before response", async () => {
	const events: string[] = [];
	await response([user("probe")], undefined, events);
	assert.deepEqual(events, ["payload-start", "payload-end", "response"]);
});

test("scripted requests use no network API", async (t) => {
	let requests = 0;
	const block = () => {
		requests++;
		throw new Error("Provider attempted a network request.");
	};
	t.mock.method(globalThis, "fetch", block);
	t.mock.method(Socket.prototype, "connect", block);
	await response([user("probe")]);
	await response([user('#script [{"call":"read","args":{}}]')]);
	assert.equal(requests, 0);
});

test("error response and hang abort do not request a network", async () => {
	const error = await response([user('#script [{"error":"broken"}]')]);
	assert.equal(error.stopReason, "error");
	assert.equal(error.errorMessage, "broken");
	const controller = new AbortController();
	const pending = response(
		[user('#script [{"hang":true}]')],
		controller.signal,
	);
	setTimeout(() => controller.abort(), 10);
	const aborted = await pending;
	assert.equal(aborted.stopReason, "aborted");
});
