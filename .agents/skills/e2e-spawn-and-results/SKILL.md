---
name: e2e-spawn-and-results
description: Use when changing how Pi starts a subagent, chooses a profile, runs a task, shows status, or delivers a completed result.
---

# Test spawning and results

Run from the repository root. The harness starts real Pi processes in a private tmux server. Its scripted provider makes model replies repeatable.

```sh
npm run check:pi-version
node scripts/run-tests.mjs --isolated-tmux --test --test-concurrency=1 test/e2e/core.test.ts test/e2e/provider.test.ts
```

Check the TAP output for `autonomous result is durable once and done row expires` and `task precedes an immediate steer in the child branch`. The first case checks one durable result and the live-to-done status change. The second checks that the task reaches the child before a message sent at launch. The provider cases check scripted replies and confirm they use no network API.

If spawn or result behavior changes, add an assertion to the relevant end-to-end case. Check the child session file and parent result, not only the pane text. Run `npm run test:e2e` before claiming repo-wide end-to-end coverage.
