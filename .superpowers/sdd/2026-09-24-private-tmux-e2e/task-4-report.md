# Task 4 report

## Status: BLOCKED / NEEDS_CONTEXT

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
