# Final review fix report

## Status

Implemented both Important layout fixes in one wave.
The scoped controller review remains pending.

- Repository: `/Users/maxmiller/pi-interactive-subagents-new`.
- Branch: `rewrite`.
- Base: `760b6c2`.
- Code and tests: `29ed1770a5f5f5c848c84c5d23f7f33189c490d4`.
- Platform: macOS, Node `v24.21.0`, tmux `3.7c`, pinned Pi `0.87.1`.
- Read the binding spec sections 7.5 and 19.3, the milestone ledger, and the final fix brief before changes.
- No subagents, reviewers, paid model calls, global package changes, default tmux server operations, handoff edits, merge, or push.

## Changes

### Border status

`src/tmux.ts` now reads the effective `pane-border-status` with `show-options -A -w -v`.
It accepts only `off`, `top`, or `bottom`.
It still parses every pane geometry field and the complete checksummed layout tree strictly.
It computes the border inset only at the matching outer edge of the tree.
It compares usable pane geometry with the corresponding adjusted cell geometry.
It does not treat arbitrary geometry differences as valid.

The balance uses usable heights.
The expected tree keeps cell heights and offsets.
The expected pane snapshot keeps usable heights and offsets.
Each resize uses the requested usable height with `resize-pane -y`.
Donor space includes the border inset and the minimum usable height.
Width and left-coordinate checks remain exact.

### Nested rows

`src/tmux-layout.ts` now recognizes a vertical child column that contains fixed nested rows.
A nested row must be horizontal, start with one owned direct parent pane, and contain no other pane owned by that runtime.
Every other direct sibling must be an owned pane.
Unknown siblings, moved owners, and ambiguous row ownership still fail explicitly.
The prior separate-row rejection tests remain unchanged and pass.

`src/tmux.ts` balances consecutive groups of owned direct leaves.
It never targets a nested row or a pane that shares that row.
It holds the group bounds and each nested subtree fixed.
A singleton group needs no resize.
No whole-window layout command or alternate layout command was added.

### Test changes

- `test/e2e/layout.test.ts`: separate real tmux cases for top and bottom border status. Each launches three persistent children, checks even usable heights, verifies saved pane/process/session/server identities, and completes all children in order two, one, three.
- The border tests preserve the root user pane geometry after each later split and each cleanup while the child column remains. Removing the final child naturally returns its space to the root pane.
- `test/e2e/layout.test.ts`: exact sequence root A, root B, A starts G, root C. It checks actual session output and saved identities for all four runs. It compares all four geometry fields for A and G before and after C. It checks the root user pane geometry. Cleanup order is C, G, A, B. C cleanup must also leave A and G unchanged.
- Existing scenario 28 is unchanged. Its two user panes remain fixed after each split and cleanup.
- `test/unit/column.test.ts` and `test/unit/tmux-layout.test.ts`: add 14 tests. They cover border insets, donor minimums, fixed nested rows, groups on both sides of a nested row, changed nested PID/session/tree before another resize, invalid border options, and unsafe ownership shapes.
- `test/unit/launch.test.ts` and `test/unit/parent.test.ts`: mocks return the explicit effective border option. Existing tests remain intact.
- `test/e2e/core.test.ts`: the answer-bypass test now establishes two blocked instructions. It proves the answer passes both and that their exact delivery IDs and text retain relative order, with no duplicates.
- `test/e2e/core.test.ts`: the pending-result stderr assertion now follows the final stderr and `pane_dead` wait.
- `test/e2e/harness.ts`: start the private parent window with a live `/bin/cat -` bootstrap until configuration and respawn. An initial RED run exposed a disappearing empty window before `remain-on-exit` was set. This removes that empty-window interval. It does not claim to fix the deferred teardown issue.

## RED evidence

All production RED runs preceded changes to production code.
Evidence logs are under `.superpowers/sdd/2026-09-24-private-tmux-e2e/final-fix-evidence/`.
These local logs are ignored by Git. This committed report records the commands, output, and final counts.

### Border status RED

Command:

```sh
node scripts/run-tests.mjs --isolated-tmux --test --test-concurrency=1 --test-name-pattern='layout regression:' test/e2e/layout.test.ts
```

Log: `red-e2e.log`.
Exit status: 1.

Both top and bottom cases failed at the second child:

```text
Tmux layout tree does not match pane geometry.
Error: Timed out waiting for active two after 20000 ms.
```

That run had three failures. The third was a harness setup failure, not nested-layout RED evidence:

```text
set-option -p -t %7 remain-on-exit on
no such pane: %7
```

### Nested layout RED

The first isolated draft incorrectly allowed the worker to spawn itself.
It failed catalog validation and is not production RED evidence (`red-nested.log`).
The corrected test uses a separate allowed helper for G.

Command:

```sh
node scripts/run-tests.mjs --isolated-tmux --test --test-concurrency=1 --test-name-pattern='layout regression: root' test/e2e/layout.test.ts
```

Log: `red-nested-valid.log`.
Exit status: 1. One test, zero pass, one fail.
A and B started. A started G. The root launch of C failed with:

```text
Child panes do not form an isolated column subtree.
Error: Timed out waiting for c actual session output after 20000 ms.
```

### Intermediate corrections

These runs are not final verification:

- `green-regressions.log`: both border tests passed. The nested test exposed an empty result from `show-options` for an inherited default. Adding `-A` reads the effective option without a default value or fallback.
- `green-regressions-2.log`: the nested launch and frozen geometry passed. Its cleanup assertion incorrectly expected A's initial reply in the final result. A's final reply followed G's result. The test still proves the initial output in A's session and now checks the actual final reply at cleanup.
- `new-column-unit.log`: hand-written test tree coordinates were inconsistent. Corrected the fixture partition, not the production parser.

## Final GREEN verification

No source or test changes occurred between the final commands below and code commit `29ed177`.
All listed final commands exited 0.

| Command | Result | Log |
| --- | --- | --- |
| `node --test test/unit/column.test.ts test/unit/tmux-layout.test.ts test/unit/tmux.test.ts test/unit/launch.test.ts test/unit/parent.test.ts` | 179 pass, 0 fail, 0 skip | `final-focused-unit.log` |
| `node scripts/run-tests.mjs --isolated-tmux --test --test-concurrency=1 test/e2e/layout.test.ts test/e2e/harness.test.ts` | 21 pass, 0 fail, 0 skip | `final-focused-e2e.log` |
| `npm test` | 422 unit and 80 SDK pass, 0 fail, 0 skip; typecheck and lint pass | `final-npm-test.log` |
| `npm run test:e2e`, run 1 | 60 pass, 0 fail, 0 skip; 124449.662 ms | `final-e2e-1.log` |
| `npm run test:e2e`, run 2 | 60 pass, 0 fail, 0 skip; 125470.35875 ms | `final-e2e-2.log` |
| `npm run test:e2e`, run 3 | 60 pass, 0 fail, 0 skip; 124645.642334 ms | `final-e2e-3.log` |
| `git diff --check` | Pass | Terminal output was empty |

Each full E2E command ran separately on a fresh private server.
The 57 existing E2E tests and the 408 unit/80 SDK baseline remain covered.
The final suite adds three E2E tests and 14 unit tests.
Lint reports the same 34 existing warnings.

An earlier focused GREEN command also passed all five selected tests:

```sh
node scripts/run-tests.mjs --isolated-tmux --test --test-concurrency=1 --test-name-pattern='layout regression:|an answer passes|finished result' test/e2e/layout.test.ts test/e2e/core.test.ts
```

Log: `green-focused.log`.

## Capture and log inspection

Inspected the new nested pane captures, border layout trees, scenario 28 geometry diagnostics, and error matches from all three final full runs.
The scan is saved as `final-error-scan.log`.

No final full-run log contains `Malformed tmux pane line`, `missing step`, `Timed out`, `no such pane`, or `Invalid tmux pane-border-status`.
The phrase `exhausted steps` occurs only in the passing provider test name.
There is no unexpected exhausted-script output.

The 36 broad error-scan matches are expected negative-test diagnostics:

- The unchanged separate-row test rejects unsafe launch, rollback balancing, and cleanup balancing.
- Run 2 includes a retained rollback record when process exit was not immediate. That test explicitly waits for the saved process identity to exit and confirms the pane is gone.
- The harness retention test reports its deliberately unproved external identity.
- The load-failure tests report `Test extension failed at load`.
- The orphan test reports its expected orphan notice.

Example run 3 evidence:

```text
Border top cells: heights 20, 19, 19. Usable child heights: 19, 19, 19.
Border bottom cells: heights 19, 19, 20. Usable child heights: 19, 19, 19.
Nested row preserved: ["120,0,59,30","180,0,60,30"]
B and C cells: 120x14 at 120,31 and 120x14 at 120,46.
```

The new tests verify process start identities in addition to PID, session path, pane ID, and server identity.
All four nested children have captured actual output.

## Ownership safety self-review

Reviewed the final source and test diff before commit.

1. The complete layout checksum, tree partition, leaf IDs, and pane geometry remain strict.
2. Every saved root child PID/session and server identity is checked in each snapshot.
3. The server identity is checked on both sides of each snapshot.
4. Every resize starts with a fresh snapshot. The complete tree and all pane identities and geometry must equal the expected state.
5. A target is never the final leaf of its group. Its next sibling is an owned direct leaf in the same vertical container.
6. Shrinking cannot cross the target's minimum usable height. Growing consumes only proved available space inside the group. The code throws before the command if that space is insufficient.
7. Group height and separator totals do not change. The next nested row therefore keeps its offset and dimensions.
8. The expected snapshot changes only the group's leaf heights and offsets. Any change to a user pane, nested pane, PID, session, border option, or outside subtree fails verification.
9. The unchanged adversarial E2E test still records zero resize commands for separate row subtrees.
10. No ownership fallback, whole-window layout command, hidden error path, or module-level mutable state was added.

## Deferred minors

Two of the five review minors are addressed: the final stderr wait and the two-instruction answer-bypass oracle.
The other three are explicitly deferred:

- Scenario teardown still does not independently wait for every saved child process identity before deleting files. A complete fix needs saved identity capture across parent reopen, external pane removal, and failed setup, plus retention tests. Do not infer process exit from `kill-window` alone. The new regression cleanup paths explicitly wait for each child's saved process identity, but this does not fix generic harness teardown.
- The startup-failure test still does not observe the run files while result delivery is blocked. This needs a separate delivery gate and file-retention oracle.
- Successful teardown still emits routine pane, stderr, and session tails. The full diagnostics were kept for this wave's capture inspection. A later harness change should suppress routine success output without losing failure or teardown-error diagnostics.

These harness and lifecycle changes were not mixed into the layout ownership proof.

## Limits and concerns

- Scrollbar geometry is unverified and is not claimed as supported. A separate private-server probe confirmed that tmux 3.7c exposes `pane-scrollbars` and defaults it to `off` (`scrollbar-option.log`). The declared tmux 3.3 floor has no scrollbar option in its upstream option table: `https://raw.githubusercontent.com/tmux/tmux/3.3/options-table.c`. The floor binary was not run here. Width and left-coordinate differences still fail loudly rather than accepting an unproved scrollbar adjustment.
- Only macOS tmux 3.7c was exercised. Linux and older supported tmux binaries remain unverified.
- Layout behavior was checked against tmux 3.7c `layout.c` and `cmd-resize-pane.c`. This source inspection is not cross-version E2E coverage.
- Nested shapes outside the proved column form fail explicitly. This includes rearranged owners and columns with only nested rows and no direct owned leaf. There is no approximate layout recovery.
- The earlier one-off grandchild exit timeout did not recur. Its root cause remains unknown and is not declared fixed.
- External pane replacement between a verified snapshot and a separate tmux command remains the documented time-of-check race.
- Real-model smoke, CI, README, migration, merge, and release readiness are outside this wave.
