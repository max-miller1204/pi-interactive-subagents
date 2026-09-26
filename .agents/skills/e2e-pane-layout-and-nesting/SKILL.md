---
name: e2e-pane-layout-and-nesting
description: Use when changing tmux splits, child columns, focus, nested subagents, sibling launches, or pane geometry.
---

# Test pane layout and nesting

Run from the repository root:

```sh
npm run check:pi-version
node scripts/run-tests.mjs --isolated-tmux --test --test-concurrency=1 test/e2e/column.test.ts test/e2e/layout.test.ts test/e2e/pane-start.test.ts
```

Check the TAP output for `three child panes share one even column without resizing the user pane`, `layout regression: root A B, A spawns G, then root C preserves the nested row`, and `a root sibling starts when the newest child has a nested child`. The tests inspect real tmux pane IDs and geometry. They also check launch and cleanup while nested panes exist.

For a layout change, assert pane geometry before and after the action. Include the parent pane and unaffected descendants in that assertion. Run `npm run test:e2e` before claiming repo-wide end-to-end coverage.
