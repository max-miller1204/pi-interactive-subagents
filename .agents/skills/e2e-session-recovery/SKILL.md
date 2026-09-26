---
name: e2e-session-recovery
description: Use when changing reload, new session, resume, fork, quit, durable result delivery, or recovery after parent interruption.
---

# Test session recovery

Run from the repository root:

```sh
npm run check:pi-version
node scripts/run-tests.mjs --isolated-tmux --test --test-concurrency=1 test/e2e/core.test.ts test/e2e/lifecycle.test.ts
```

Check the TAP output for `reload reattaches a waiting child and delivers its result once`, `new session adopts a child result without starting a turn`, `fork delivers one result to the fork branch with a turn`, and `resume uses stored launch arguments and only new output`. The quit cases check stopped-run notices and saved session behavior.

For a recovery change, assert both the receiving session and the on-disk run or notice record. Count deliveries by ID so a duplicate cannot pass. Run `npm run test:e2e` before claiming repo-wide end-to-end coverage.
