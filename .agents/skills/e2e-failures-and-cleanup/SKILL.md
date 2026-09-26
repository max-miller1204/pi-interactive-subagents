---
name: e2e-failures-and-cleanup
description: Use when changing child crashes, timer failures, pane cleanup, orphan recovery, failed launches, or result error reporting.
---

# Test failures and cleanup

Run from the repository root:

```sh
npm run check:pi-version
node scripts/run-tests.mjs --isolated-tmux --test --test-concurrency=1 test/e2e/child-timer.test.ts test/e2e/harness.test.ts test/e2e/lifecycle.test.ts
```

Check the TAP output for `child inbox timer failure stops its grandchild and delivers the exact fatal to its parent`, `explicit process exit reports crashed and exit code 3`, `provider error persists and renders its full message`, and `pane recovery proves server and pane identity before cleanup`. The harness cases check that test cleanup itself reports failures and keeps evidence when ownership is uncertain.

For a failure path, assert the reported status and error text, then check the child pane and retained or removed run files. Do not treat a failed cleanup as a passing test. Run `npm run test:e2e` before claiming repo-wide end-to-end coverage.
