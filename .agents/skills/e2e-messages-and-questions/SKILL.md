---
name: e2e-messages-and-questions
description: Use when changing parent-to-child messages, steering, ask_question, answer routing, inbox order, or unread messages.
---

# Test messages and questions

Run from the repository root:

```sh
npm run check:pi-version
node scripts/run-tests.mjs --isolated-tmux --test --test-concurrency=1 test/e2e/core.test.ts
```

Check the TAP output for `three steers persist in sequence in an interactive child`, `parallel questions pair reverse-order answers by qid`, and `an answer passes two earlier queued instructions without reordering them`. These cases assert the child transcript and durable delivery IDs. They cover visible replies and the order that Pi stores, not only tool return values.

For a new message or question behavior, extend the private-tmux scenario and assert the parent message, child tool result, and on-disk queue state that the behavior requires. Run `npm run test:e2e` before claiming repo-wide end-to-end coverage.
