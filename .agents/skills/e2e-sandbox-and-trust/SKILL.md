---
name: e2e-sandbox-and-trust
description: Use when changing agent discovery, project trust, tool or skill allowlists, profile selection, child extensions, or nested spawn rights.
---

# Test sandbox and trust

Run from the repository root:

```sh
npm run check:pi-version
node scripts/run-tests.mjs --isolated-tmux --test --test-concurrency=1 test/e2e/lifecycle.test.ts
```

Check the TAP output for `child tools and extension effects enforce the sandbox`, `nested allowlists and depth three constrain actual tools`, and `project agents stay unavailable until private project trust`. These cases start child Pi sessions and inspect the tools and spawn rights actually available there.

For a permission change, test both a permitted action and a rejected action in the child process. Assert the exact rejection or available tool list. Run `npm run test:e2e` before claiming repo-wide end-to-end coverage.
