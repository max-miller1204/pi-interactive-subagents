# Task 4 report

## Current status: PASS

The authorized continuation below resolves both original blockers.
Three fresh complete E2E runs on the final code each passed 55 tests, with zero failures and zero skips.
`npm test` passed with 385 unit tests and 80 SDK tests.
The final diff check passed.
The original report below is retained as historical RED evidence.
Its blocked status and scope statements are superseded by the continuation section.

## Initial status: BLOCKED / NEEDS_CONTEXT (historical)

Scenarios 25, 27, and 29 pass with real Pi processes.
Scenarios 26 and 28 fail in all three full E2E runs.
The assertions remain active.
No test is skipped or retried.
The full E2E gate is not green.

Two decisions are required:

1. Scenario 26 requires `ps eww -p <pid>` on macOS. Pinned Pi 0.87.1 sets `process.title = APP_NAME`. With Node 24.21.0 on this host, that operation removes the environment from the `ps` observation. `TMUX` and `TMUX_PANE` cannot be proved by the required command. Authorize a different observation or change the pinned runtime contract. This task does not substitute an in-process observation for scenario 26.
2. Section 7.5 requires `select-layout -E -t <child>` after a vertical split. On tmux 3.7c, that exact command changes the separate user pane from 60 columns to 80 columns. This contradicts scenario 28. Authorize a change to the binding launch and cleanup commands before changing production layout behavior.

## Scope

Base: `c91920d6f61aa890c95ae9a827dd3aaf5209a8b9`.
Branch: `rewrite`.
Host: macOS, Node `v24.21.0`, tmux `3.7c`, Pi `0.87.1`.

- `test/e2e/layout.test.ts`: Add real-process scenarios 25 through 29.
- `.superpowers/sdd/2026-09-24-private-tmux-e2e/task-4-report.md`: Record results and blockers.

Production code and the reviewed harness are unchanged.
No global Pi configuration was changed.
No paid model was used.
All Pi processes use `faux/brain`.
No subagents or reviewers were dispatched.
No merge or push was done.

## Scenario evidence

### 25: PASS, late message after exit decision

A temporary child-only extension waits in `session_shutdown`.
That event occurs after the autonomous child requests shutdown.
It records the real PID, run directory, and child session path.
The test compares all three values with the strict run and pane files.
It verifies that the child process is still in its saved private pane.

The real parent calls `subagent_message` while shutdown is held.
The test parses the inbox with the production queue reader.
It requires exactly one message with the requested text.
The child session has no `parent_message` entry.
The test releases shutdown with a file signal.
The result must have exactly this unread message:

```text
Late steer must be reported, not lost.
```

The result has status `completed` and text `Exit decision reached.`.
The delivery ID equals `<runId>:result` and occurs once.
The run directory is removed after delivery.
The expanded UI contains the complete saved result, including the unread message.

Full-run child PIDs: `44646`, `6444`, `67467`.
The first run recorded queue sequence `00000357544858534625-19c343ff` for run `47916fd7-eb11-48cc-b8bf-3800ef792229`.
The marker, queue item, full result, and readable UI are in each full log.

### 26: BLOCKED, required OS environment observation

The test starts a parent with the reviewed clean environment.
It then sets `STALE=x` in the private server.
`show-environment -g STALE` confirms the stale server variable.
A real child completes its task and remains open.
The saved server, pane, PID, session, and process start identity match.

The required `ps eww -p <childPid>` command does not expose any environment variables.
The first full-run observation was:

```text
  PID   TT  STAT      TIME COMMAND
48075 s008  Ss+    0:00.34 pi
```

The three observed child PIDs were `48075`, `9883`, and `70866`.
Each run fails the positive `TMUX=` assertion.
An absent `STALE=` in this output is not sufficient evidence of environment isolation.
The positive `TMUX=` and `TMUX_PANE=` assertions remain in the test.

A separate minimal Node experiment confirms the cause without Pi:

```text
title=false pid=58431
58431 ... node -e ... TMUX=private-proof TMUX_PANE=%777 STALE=proof

title=true pid=58476
58476 ... pi
```

Both processes had the same three-variable environment.
The only relevant difference was `process.title='pi'`.
The local pinned CLI contains `process.title=APP_NAME` in `dist/bundle/cli-runtime.js`.
The experiment log is `logs/task4-ps-proof.log`.
It uses a minimal environment and does not record the user's environment.

### 27: PASS, orphan and recovery

The test obtains the parent PID from its private pane.
It requires that PID to equal `RunSpec.owner.pid`.
The saved process start value must still match.
The run's spawner session must equal the real test parent session.
It verifies the private server and pane with `verifiedPane` before signaling.
It rejects the test runner PID, its parent PID, the tmux server PID, and the runner pane.
It calls `SIGKILL` only for that verified test parent PID.
It then verifies that the test runner identity is unchanged.

The child shows the full orphan notice, including the complete session path.
The UI shows `auto-exit off`.
The child process and saved pane remain alive.
No `result.json` exists.
The test quits the orphan and confirms its process exit and retained dead pane.

A new parent opens a different saved session.
This lets the test inspect the recovery record before it is consumed.
Exactly one file exists for the original spawner session.
Strict `UndeliveredRecord` parsing requires `kind: stopped`, the original run ID, and the original launch.
Recovery removes the old run directory and dead pane.
The private server identity remains unchanged.
Reopening the original parent session delivers exactly one `notice:<runId>` message.
The compact and expanded notice UI are captured and checked.

| Full run | Killed test parent | Surviving orphan | Private server PID |
| --- | --- | --- | --- |
| 1 | 50094 | 50458 | 64045 |
| 2 | 11898 | 12295 | 25445 |
| 3 | 72912 | 73277 | 86510 |

First recovery run ID: `54a65132-e21a-4f5d-bd3e-73bba97d1cdf`.
All three logs contain the saved identities and the complete recovery record.

### 28: RED, user pane width changes

The test creates a separate user pane before any child spawn.
It registers tracked cleanup before creating that pane.
Cleanup uses the saved server, pane process identity, and session value.
The user pane starts at 60 columns in a 240-column window.

The first child uses a horizontal split of the parent pane.
The user remains 60 columns wide.
The parent and child are each 89 columns wide.
The second child uses a vertical split and the binding `select-layout -E` command.
The user becomes 80 columns wide.
The test fails immediately rather than accepting the resize.
The third-child checks are present but cannot run past this failure.
No three-child success is claimed.

The test uses the required `list-panes` format:

```text
#{pane_id}\t#{pane_width}\t#{pane_height}\t#{window_width}
```

It strictly parses the four fields and positive safe integer dimensions.
It checks equal child widths, one `pane_left` column, and heights that differ by at most one row.
It compares the user pane dimensions after each split.
It captures readable parent, child, and user UI.

A separate private-server reproduction excludes Pi and isolates `select-layout -E`:

```text
                         pane  width height window left
After both splits:       %1    60    60     240    0
                         %0    89    60     240    61
                         %2    89    30     240    151
                         %3    89    29     240    151
After select-layout -E:  %1    80    60     240    0
                         %0    79    60     240    81
                         %2    79    30     240    161
                         %3    79    29     240    161
```

The reproduction checks the saved private server identity before `kill-server`.
Its log is `logs/task4-layout-proof.log`.
This is a deterministic command-contract conflict, not a timing failure.
No production command was changed without a ruling on section 7.5.

### 29: PASS, explicit symlinks and canonical paths

The macOS temporary root is canonicalized by the harness.
The test does not call that canonical directory a symlink.
It creates and checks actual symlinks for the agent directory, parent session, and repository directory.
`lstatSync(...).isSymbolicLink()` must be true for each.
The root must be under `/private/var/folders/` on macOS.

The parent restarts with `PI_CODING_AGENT_DIR` through the agent-directory symlink.
It opens the parent-session symlink.
It loads the own extension through the repository-directory symlink.
The profile points to the faux provider through that same symlink.

The test checks real paths for:

- The parent and child session files.
- The discovered worker agent and the nested helper agent stored in the real child run.
- The own extension and profile extension in the real child arguments.
- The run directory in the stored spec, child process probe, and `--subagent-run` argument.
- The stored spawn launch compared with the strict run launch.

The existing `lifecycle_probe` reports actual child arguments, PID, session, and run directory.
Its typed tool result must succeed in the real child session.
Its PID must equal the verified live pane PID.
This is used for canonical path checks, not as a substitute for scenario 26's required OS environment command.

Full-run probe PIDs: `62526`, `24305`, `84929`.
The full logs retain symlink paths, complete specs, canonical child arguments, and readable UI.
The result has status `completed` and text `Canonical child output.`.

## RED and GREEN sequence

All logs below are under `.superpowers/sdd/2026-09-24-private-tmux-e2e/`.

1. `node scripts/run-tests.mjs --isolated-tmux --test --test-concurrency=1 test/e2e/layout.test.ts` wrote `logs/task4-red.log`. Result: 1 pass, 4 failures. Scenario 25 passed. The OS environment and layout assertions were RED. The initial orphan UI assertion did not account for Pi's `Error: ` prefix. A single-file extension symlink failed because its relative imports no longer had their directory tree.
2. `node scripts/run-tests.mjs --isolated-tmux --test --test-concurrency=1 --test-name-pattern='19.3.27|19.3.29' test/e2e/layout.test.ts` wrote `logs/task4-focused-2.log`. The explicit directory-symlink path test passed. The orphan assertion still rejected the notification prefix. This was a test construction problem, not a production change.
3. `node scripts/run-tests.mjs --isolated-tmux --test --test-concurrency=1 --test-name-pattern='19.3.27' test/e2e/layout.test.ts` wrote `logs/task4-orphan-3.log`. Result: 1 pass, 0 failures. The test now requires the complete actual `Error: <notice>` notification. It does not shorten or discard the notice.
4. All three complete suite runs below use the final test code. Scenarios 25, 27, and 29 are GREEN. Scenarios 26 and 28 remain RED with the same evidence in each run.

No production fix or GREEN result is claimed for either blocker.
No timeout was increased.
No automatic retry or skip was added.

## Three separate full-suite runs

These were separate shell commands, not a retry loop.
Each log includes all stdout and stderr and a final `COMMAND_EXIT=1` marker.

```sh
npm run test:e2e > .superpowers/sdd/2026-09-24-private-tmux-e2e/logs/task4-full-1.log 2>&1
npm run test:e2e > .superpowers/sdd/2026-09-24-private-tmux-e2e/logs/task4-full-2.log 2>&1
npm run test:e2e > .superpowers/sdd/2026-09-24-private-tmux-e2e/logs/task4-full-3.log 2>&1
```

| Run | Tests | Pass | Fail | Skipped | Cancelled | Duration | Exit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 53 | 51 | 2 | 0 | 0 | 100768.528209 ms | 1 |
| 2 | 53 | 51 | 2 | 0 | 0 | 101411.597208 ms | 1 |
| 3 | 53 | 51 | 2 | 0 | 0 | 101758.896666 ms | 1 |

The only failed tests are scenarios 26 and 28.
There are no wait-timeout failures in the three complete logs.

## Task 3 grandchild exit concern

Scenario 11 passed in all three complete runs with the existing 20-second deadline.
It verified both saved descendant process identities, process exits, stopped records, and removed panes.

| Run | Worker PID | Grandchild PID | Scenario duration |
| --- | --- | --- | --- |
| 1 | 94359 | 95121 | 1842.654 ms |
| 2 | 56467 | 57197 | 1846.633208 ms |
| 3 | 17505 | 18236 | 1846.646458 ms |

The earlier unconfirmed timeout did not recur.
This does not prove that it can never recur.
No timing code or deadline was changed.

## Capture inspection and warnings

Each full log has 20 new full readable UI captures and 33 harness pane-tail captures.
All 159 captured blocks were included in the inspection pass.
The local `task4-captures-*.txt` files retain those blocks.
`task4-capture-review.txt` groups 73 distinct readable variants for review.
The original full logs remain unchanged.

The new UI checks require complete expected text after terminal wrapping.
They check raw line widths against the actual pane width.
They also check left alignment of the expected renderer or notification prefix.
Expanded result and notice checks require the full saved message, not only a header.

Warnings and concerns:

- Pi warns that the private server has `extended-keys` off. Plain Enter, Escape, and control-key operations used by these tests work. No user tmux configuration was changed.
- The existing `task precedes an immediate steer in the child branch` case has an exhausted faux parent script. The first two complete run captures show `session script at message 1, step 3: missing step`. The parent script has spawn, steer, and ready steps but no result-turn response. Its existing child-order oracle still passes. The third capture ends before that final UI state. This inherited error is reported here, not treated as a green UI assertion or suppressed. It needs a separate core-test fixture correction. No core-test change is included in this task's file scope.
- The existing load-failure and provider-error cases show their expected errors.
- Harness cleanup tails are intentionally short diagnostics. Some start mid-line. The new tests use full readable captures for their assertions and do not use these short tails as proof that text is complete.
- Scenario 28 stops at the second split. The three-child final layout remains unverified until the command-contract conflict is resolved.
- Linux `/proc` behavior is implemented but was not run on this macOS host.

## Other verification and self-review

`npm test` passed with exit 0:

- Pi version check passed.
- Typecheck passed.
- Biome check passed.
- Unit tests: 366 passed, 0 failed, 0 skipped.
- SDK tests: 80 passed, 0 failed, 0 skipped.

Full log: `logs/task4-npm-test.log`.
`git diff --check` passed.
The new file also passed `git diff --check --no-index /dev/null test/e2e/layout.test.ts`.

Self-review checked the strict queue and schema readers, late-exit boundary, real symlink evidence, notification text, runner PID exclusions, server and pane verification, and full message capture checks.
New tracked pane cleanup is registered before acquisition.
The stale-variable cleanup is registered before the private server environment is changed.
The existing reviewed scenario harness owns the parent window and its temporary files.
No module-level mutable state was added.
No fallback was added.

The report is committed with the tests.
The complete command and capture logs remain in the local ignored `logs/` directory named above.
The report includes the blocking evidence so the decision does not depend only on temporary process state.

## Authorized continuation and final result

The continuation started from `89a435a4ee4f0d7fee95863b381bd7488473f99e`.
The user supplied two rulings on 2026-09-25 at 11:25:51:

1. Replace the impossible macOS `ps eww` oracle with a permitted test-only `lifecycle_probe` in the live, verified child. Return only the two tmux environment values and the presence of `STALE`, plus the required process and session binding fields. Do not add a `ps` fallback or full-environment logging.
2. Treat preservation of the user's pane width as the behavior authority. Replace `select-layout -E` with a safe targeted column balance. Preserve strict command errors and pane identity checks. Verify multiple user panes after splits and cleanup.

The user also required a fix for scenario 2's exhausted faux script.
All three requirements are implemented.
No handoff or global file was changed.

### Continuation changes

- `src/tmux.ts`: Add `balancePaneColumn` and strict pane geometry parsing.
- `src/launch.ts`: Use targeted balance after vertical splits and verified rollback cleanup.
- `src/parent.ts`: Supply saved pane ownership and use targeted balance after child cleanup.
- `test/unit/column.test.ts`: Add 19 adapter tests for commands, geometry, ownership, errors, and unrelated panes.
- `test/unit/launch.test.ts`: Update the transaction fixture and error assertions for targeted resize commands.
- `test/fixtures/lifecycle-tools.ts`: Add a restricted environment mode to the existing permitted probe.
- `test/e2e/layout.test.ts`: Bind the environment observation to the live child. Check two user panes through all three splits and all three child removals. Wait for complete aligned UI output, not quoted script text.
- `test/e2e/core.test.ts`: Supply scenario 2's result turn. Assert no provider error. Fix two UI readiness races with deterministic regression tests.
- `test/e2e/lifecycle.test.ts`: Wait for saved tool results before asserting three denial outcomes.

### Scenario 26: authorized RED and GREEN

The environment probe returns this strict shape:

```text
pid, sessionFile, runDir, tmux, tmuxPane, stalePresent
```

The probe reads the two values directly from `process.env`.
It checks `STALE` with `Object.hasOwn(process.env, "STALE")`.
It does not enumerate the environment or return unrelated variables.
Its environment mode does not return arguments or active tools.

The test permits `lifecycle_probe` in the child agent's tool list.
The real child calls it with `{ environment: true }`.
The saved child session must contain exactly one successful probe tool result.
The strict result must have the saved child PID, canonical session, and run directory.
The PID's process start identity must still match.
`verifiedPane` must report a live child before and after the observation.
`tmux` must equal the exact private socket, private server PID, and actual tmux session number.
`tmuxPane` must equal the saved child pane ID.
`stalePresent` must be false.

For RED, a temporary test-fixture mutation set `process.env.STALE = "x"` inside the actual child immediately before the probe read.
The test failed on `stalePresent: true` versus `false` for child PID `87139`.
The mutation was removed before the GREEN runs.
This was not a fake observation or a production launch override.
The private server still contained `STALE=x` in the GREEN case.

Command and evidence:

```sh
node scripts/run-tests.mjs --isolated-tmux --test --test-name-pattern='19.3.26' test/e2e/layout.test.ts
```

RED log: `logs/task4-env-probe-red.log`.
GREEN logs: `logs/task4-continued-focused-1.log`, `logs/task4-continued-focused-2.log`, and all three final complete logs.
No `ps` fallback remains in scenario 26.

### Scenario 28: targeted column algorithm

The chosen operation is `resize-pane -t <owned-pane> -y <height>`.
No production `select-layout -E` call remains.
The algorithm never requests a width change.

The caller supplies each live child's saved `PaneFile` and session path.
The adapter performs these steps:

1. Reject duplicate or invalid pane IDs.
2. Return without a command when fewer than two children remain.
3. Compare each saved server identity with the current server.
4. Read the window geometry with strict numeric and field-count checks.
5. Match each selected pane's PID and session with the saved ownership data.
6. Require one contiguous vertical column with equal left edges and widths.
7. Reject another pane that overlaps the column's horizontal interval.
8. Divide the sum of child heights evenly. Assign the remainder to the top panes.
9. Resize the top panes in order. Leave the last pane to receive the remaining rows.
10. Read the final geometry and compare it with the exact expected state.

The final comparison covers every pane in the window.
It requires all unrelated panes to retain their full geometry and identity.
It requires each child to retain its identity and horizontal geometry.
It requires the planned child top positions and heights.
The adapter checks the server again around the snapshots and before resize commands.
Malformed data, changed identities, ambiguous layouts, command failures, and unexpected results throw.
There is no whole-window fallback.
The existing verified kill and exit-confirmation logic remains in place.

A separate private tmux experiment confirmed the resize sequence before using it in production.
It used two user panes in a 60-column side column.
Their heights were 30 and 29 rows.
Three child heights changed from `30,14,14` to `20,19,19` through two targeted resize commands.
The two user panes stayed at `60x30` and `60x29`.
Log: `logs/task4-targeted-experiment.log`.

The pre-change real-process scenario and `logs/task4-layout-proof.log` are the RED evidence for the old command.
The final scenario now reaches all three children.
It also removes the middle child first, then the top child, then the last child.
After each removal it verifies the delivered strict result, confirmed run cleanup, removed pane, unchanged user dimensions, and even remaining child heights.

Final observed geometry in all three complete runs:

| State | User pane 1 | User pane 2 | Child widths | Child heights |
| --- | --- | --- | --- | --- |
| Before children | 60x30 | 60x29 | none | none |
| One child | 60x30 | 60x29 | 89 | 60 |
| Two children | 60x30 | 60x29 | 89, 89 | 30, 29 |
| Three children | 60x30 | 60x29 | 89, 89, 89 | 20, 19, 19 |
| Middle child removed | 60x30 | 60x29 | 89, 89 | 30, 29 |
| Top child removed | 60x30 | 60x29 | 89 | 60 |
| Last child removed | 60x30 | 60x29 | none | none |

All three child panes have left edge 151 before cleanup.
The parent grows back to 179 columns after the last child closes.
Neither user pane changes width or height.
The test captures parent, child, and both user UI states throughout.

Focused command:

```sh
node --test test/unit/column.test.ts test/unit/launch.test.ts
```

Result: 65 passed, zero failed.
Log: `logs/task4-column-unit-2.log`.
The adapter tests cover exact resize commands, malformed geometry, missing panes, gaps, overlapping unrelated panes, stale server/PID/session data, command errors, and unexpected post-resize user or child changes.

### Scenario 2: provider error fixed

The new no-provider-error assertion was RED before the fixture fix.
The actual saved parent response had:

```text
stopReason: error
errorMessage: session script at message 1, step 3: missing step
```

Log: `logs/task4-core-result-red.log`.
The parent script now has an explicit `Immediate result received.` step after spawn, steer, and ready.
The test waits for the actual saved assistant response after the result message.
It requires `stopReason: stop` and zero parent assistant error messages.
It also checks the visible response.
Focused GREEN log: `logs/task4-core-result-green.log`.
The final three complete logs contain no `missing step` message.

### Timing defects found during the new full runs

The required repeats exposed three test-readiness defects.
Each was investigated before running a new full gate.
No deadline was increased.
No skip or automatic retry was added.

#### Quoted script text was mistaken for rendered output

`logs/task4-green-full-1.log` failed scenario 2's new UI assertion.
The helper returned when the expected reply was present inside the submitted JSON script.
The actual aligned reply had not rendered yet.

A deterministic two-frame test reproduced this defect without relying on timing.
The first frame contains only quoted script text.
The second contains the actual aligned response.
The old helper failed on the first frame.
`logs/task4-ui-readiness-red.log` records that failure.

The readiness predicate now requires the same aligned rendered line that the final oracle checks.
The layout test's full-text readiness check uses the same principle.
The full text and width checks remain intact.
The deterministic test and real scenario then passed.
Log: `logs/task4-ui-readiness-green.log`.

#### The `/new` wait matched the old question

`logs/task4-final-full-2.log` failed while waiting for the new parent session file.
The old readiness check searched for `New session`.
It matched the still-visible `New session question?` before `/new` completed.
The answer prompt could be sent into the session while Pi was clearing it.
The final capture showed a fresh empty session and the still-waiting child.

A deterministic regression test supplies that question frame before the actual success notification.
The old predicate returns the question and fails.
Log: `logs/task4-new-session-red.log`.

All three `/new` test paths now wait for the complete aligned `✓ New session started` notification.
The pinned Pi displays this notification after `runtimeHost.newSession()` completes.
The deterministic regression test and the real adoption scenario pass.
Log: `logs/task4-new-session-green.log`.

#### A denial assertion ran before its saved tool result

`logs/task4-verified-full-2.log` failed scenario 19's nested guard test.
`Guard checked.` was already visible inside the submitted script.
The test then read the tool-result list before the denial existed.
The failed value was `undefined`, not an incorrect success response.

The guard now waits for the saved `subagent_message` tool result before asserting `isError` and the exact denial text.
The two other denial assertions with the same ordering pattern now use their saved tool-result boundary.
Their existing pane, registry, error-text, and UI assertions remain intact.
Focused GREEN command:

```sh
node scripts/run-tests.mjs --isolated-tmux --test --test-concurrency=1 --test-name-pattern='19.3.19|19.3.21|19.3.24' test/e2e/lifecycle.test.ts
```

Result: four tests passed, zero failed.
Log: `logs/task4-denial-readiness-green.log`.
The three final full runs followed this last code change.

Earlier discovery-run logs remain available.
They are not counted as successful final repeats:

- `task4-green-full-1.log`: UI readiness failure.
- `task4-final-full-1.log`: pass before the next defect was found.
- `task4-final-full-2.log`: `/new` readiness failure.
- `task4-verified-full-1.log`: pass before the denial defect was found.
- `task4-verified-full-2.log`: denial readiness failure, counted at the nested test and parent test levels.

### Three fresh final full-suite runs

These are three distinct commands on the final code after all fixes:

```sh
npm run test:e2e > .superpowers/sdd/2026-09-24-private-tmux-e2e/logs/task4-complete-full-1.log 2>&1
npm run test:e2e > .superpowers/sdd/2026-09-24-private-tmux-e2e/logs/task4-complete-full-2.log 2>&1
npm run test:e2e > .superpowers/sdd/2026-09-24-private-tmux-e2e/logs/task4-complete-full-3.log 2>&1
```

| Run | Tests | Pass | Fail | Skipped | Cancelled | Duration | Exit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 55 | 55 | 0 | 0 | 0 | 105729.58925 ms | 0 |
| 2 | 55 | 55 | 0 | 0 | 0 | 105282.741875 ms | 0 |
| 3 | 55 | 55 | 0 | 0 | 0 | 105104.892417 ms | 0 |

All scenarios 25 through 29 pass in each final run.
The two new deterministic readiness tests account for the increase from 53 to 55 tests.
No final log contains a wait timeout, exhausted script, malformed geometry, or failed column invariant.

Real-process samples from the final runs:

| Run | Late-message child | Environment child | Killed test parent | Live orphan | Private server |
| --- | --- | --- | --- | --- | --- |
| 1 | 67155 | 70554 | 73783 | 74157 | 85372 |
| 2 | 39996 | 43433 | 46631 | 47029 | 58475 |
| 3 | 12971 | 16408 | 19598 | 19996 | 31717 |

The real-path probes used PIDs `96217`, `69159`, and `42079`.
The explicit symlink, canonical path, strict result, and complete UI checks remain unchanged in substance.
The late-message queue and orphan stopped-record checks also remain intact.

### Grandchild exit and final capture review

The prior grandchild timeout did not recur in the final runs.
The existing 20-second deadline is unchanged.

| Run | Worker PID | Grandchild PID | Scenario 11 duration |
| --- | --- | --- | --- |
| 1 | 28420 | 29149 | 1833.606584 ms |
| 2 | 1480 | 2226 | 1847.651584 ms |
| 3 | 74439 | 75175 | 1904.763334 ms |

Each final log contains 44 full readable UI captures and 33 harness pane tails.
All 231 blocks were included in the inspection pass.
`logs/task4-complete-capture-review.txt` groups 84 distinct readable variants for review.
The full original logs remain available.
The new full captures show complete late-message results, restricted environment observations, orphan notices, recovery notices, three-child layouts, cleanup states, and canonical-path results.

The remaining Pi `extended-keys` warning is expected on the private server.
The load-failure, provider-error, and orphan cases show their intended diagnostic messages.
No new test relies on a shortened cleanup tail as its full UI oracle.

### Final verification, safety, and caveats

`npm test` passed after the third final E2E run:

- Pi version check passed.
- Typecheck passed.
- Biome check passed.
- Unit tests: 385 passed, zero failed or skipped.
- SDK tests: 80 passed, zero failed or skipped.

Log: `logs/task4-complete-npm.log`, with `COMMAND_EXIT=0`.
`git diff --check` passed.

Self-review covered the exact targeted command sequence, saved server and pane ownership, geometry parsing, post-resize invariants, launch rollback, runtime cleanup, restricted probe output, and each readiness fix.
Cleanup registration and private-resource ownership checks remain in place.
The second user pane has its own cleanup registration before acquisition.
No timeout increase, fallback, module-level mutable state, paid model, default-server tmux operation, global Pi change, subagent dispatch, merge, or push was added.

Caveats:

- The targeted adapter deliberately rejects a rearranged or subdivided set of child panes that no longer forms one owned uninterrupted column. It reports the error rather than changing unrelated panes. Existing nested E2E scenarios pass.
- The three complete runs were on macOS with pinned Pi 0.87.1 and tmux 3.7c. This continuation does not claim a Linux run.
- The historical grandchild timeout remains an earlier unconfirmed event. These repeats did not reproduce it.

There are no remaining Task 4 blockers under the supplied rulings.
