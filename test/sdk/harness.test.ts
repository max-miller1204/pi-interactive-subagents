import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createHarness } from "./harness.ts";

test("harness waits for an async extension factory before binding", {
	timeout: 5_000,
}, async (t) => {
	let startFactory: () => void = () => assert.fail("Factory did not start.");
	const started = new Promise<void>((resolve) => {
		startFactory = resolve;
	});
	let finishFactory: () => void = () => assert.fail("Factory did not start.");
	const gate = new Promise<void>((resolve) => {
		finishFactory = resolve;
	});
	let sessionStart = false;
	const creating = createHarness(t, async (pi) => {
		startFactory();
		await gate;
		pi.on("session_start", () => {
			sessionStart = true;
		});
	});
	try {
		await started;
		const outcome = await Promise.race([
			creating.then(() => "created"),
			delay(100).then(() => "waiting"),
		]);
		assert.equal(
			outcome,
			"waiting",
			"The harness must wait for the factory promise.",
		);
	} finally {
		finishFactory();
	}
	await creating;
	assert.equal(
		sessionStart,
		true,
		"Async registration must precede session_start.",
	);
});

test("harness reports an async extension factory rejection", {
	timeout: 5_000,
}, async (t) => {
	await assert.rejects(
		createHarness(t, async () => {
			await Promise.resolve();
			throw new Error("async factory failure");
		}),
		/async factory failure/,
	);
});

test("controlled boundary releases a completed run without blocking later boundaries", {
	timeout: 5_000,
}, async (t) => {
	const harness = await createHarness(t, () => {}, { controlBoundaries: true });
	harness.faux.setResponses([fauxAssistantMessage("Done.")]);
	const prompt = harness.session.prompt("Complete this run.");
	const first = await harness.boundaryReached;
	assert.equal(first.type, "turn_end");
	harness.releaseBoundary();
	try {
		await Promise.race([
			prompt,
			delay(250).then(() => {
				throw new Error("A later boundary remained blocked after release.");
			}),
		]);
	} finally {
		// A failed test still releases the later boundary before session disposal.
		if (harness.session.isStreaming) harness.releaseBoundary();
	}
	harness.assertNoErrors();
});
