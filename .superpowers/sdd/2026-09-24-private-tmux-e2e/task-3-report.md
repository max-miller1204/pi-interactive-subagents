# Task 3 report

## Status: BLOCKED

Task 3 is not complete. Scenario 19.3.18 cannot satisfy its required OS argument check with the pinned Pi CLI on this host. Its assertion remains RED. It is not skipped, marked TODO, or replaced with a weaker assertion.

- Branch: `rewrite`.
- Base: `43ebd864049d81709356719b4fde20cdff374fe0`.
- Code commit: `600811b4c0f7cdd39eb1c2978e65d31caa77e708`.
- Commit subject: `test: cover child failures and sandbox in tmux`.
- Binding scope: spec section 19.3, scenarios 11 through 16 and 18 through 24, plus private server and pane identity.

## Blocking evidence

The test starts a real resumed child. It verifies the saved `RunSpec`, the new run kind, the child PID, and the saved pane identity. It runs this command while that child is live:

```text
ps -o args= -p <resumed-child-pid>
```

The command returns:

```text
pi                        \n
```

The pinned dependency is `@earendil-works/pi-coding-agent` version `0.87.1`. Its `dist/cli/setup.js:4` sets `process.title = APP_NAME`. Its bundled `dist/bundle/cli-runtime.js:3` does the same before `main(process.argv.slice(2))`. On this host, `ps -o args=` therefore does not expose the required tools, extension paths, skills, model, or thinking arguments.

The final failure is explicit:

```text
19.3.18: resume uses stored launch arguments and only new output
AssertionError: Pinned Pi replaces OS arguments with its process title: "pi                        \n"
```

The test reaches this assertion after it verifies the resumed output and rendered result. It does not claim that a stored launch file proves the OS arguments. I did not change the pinned CLI, change its process title, substitute another source for `ps`, or add a fallback.

A decision is required. Either the specification must accept another direct argument observation, or the supported CLI must preserve OS-visible arguments. The current commit contains a known failing E2E test and must not be treated as a completed Task 3 change.

## Files

- `test/e2e/lifecycle.test.ts`: Real Pi and private tmux lifecycle tests. Tests use strict schemas for run specs, pane files, registry entries, result details, stopped records, and extension probe details. Tests read active session branches through the reviewed parser.
- `test/e2e/harness.ts`: Add `approval: "ask"` to omit a fixed approval override. Add an explicit `tmuxEnvironment` option for the second private server. Existing socket and server PID validation still applies. Existing callers keep their prior behavior.
- `test/fixtures/lifecycle-tools.ts`: Register a permitted probe tool and an omitted tool. Record an extension load event in the session. Return the actual active tools and `process.argv` from the permitted tool. No module-level mutable state is used.
- `.superpowers/sdd/2026-09-24-private-tmux-e2e/task-3-report.md`: This report.

No production source changed.

## Scenario evidence

| Scenario | Final result | Evidence |
| --- | --- | --- |
| 11 | PASS | A worker starts a live grandchild. Before parent quit, both saved pane identities match the private server, PID, and session. Quit removes both panes. Strict `UndeliveredRecord` checks prove both stopped records and saved child sessions. The grandchild record belongs to the worker session. Parent stderr reports the stopped worker. |
| 12 | PASS | Only the child profile includes `throws-at-load.ts`. A strict saved `ResultDetails` has `crashed`, exit code 1, and the Pi load error in `paneTail`. The parent stderr does not contain the child load error. Expanded UI contains the full saved result and pane error. |
| 13 | PASS | The child script calls `process.exit(3)`. The saved result has `status === "crashed"` and `exitCode === 3`. Parent capture contains `crashed`; expanded UI contains the exit code and full saved result. |
| 14 | PASS | A provider error persists the exact full diagnostic in `errorMessage`. The result status is `error`. Expanded UI contains the full saved result. |
| 15 | PASS | Before manual `kill-pane`, the test validates saved server identity, PID, and child session with `verifiedPane`. The saved result is `closed`. Expanded UI contains the complete close result. |
| 16 | PASS | A human interrupts a hanging autonomous child and submits a new prompt. Strict status data reports `human` and `waiting`. The verified pane remains live and no result is delivered early. Pane `/quit` delivers the retained text. Expanded UI contains the full saved result. |
| 18 | BLOCKED | A finished name resumes in a new run. Its launch equals the saved launch, including a nonempty tool set, extension paths, and skill path. The same child session is used. The result contains only `Resumed segment only.`. The required `ps` argument assertion fails because the CLI replaces the OS process title. |
| 19 | PASS | After completion, a real Pi process reopens the saved child session in a private pane. The test marks and verifies that session identity. Resume returns an explicit `still open in pane` tool error and renders it. Pane IDs remain unchanged. No resume registry entry is appended. This tests the guard with a human-reopened session, since normal completion removes the original pane. |
| 20 | PASS | A worker rejects an agent outside its copied allowlist with `Unknown agent`. The error is present in its session and UI. The worker then starts a scout, which starts a depth-3 leaf. The leaf's real probe result proves that `subagent`, `subagent_message`, and `subagents_list` are absent. The agent definitions retain a possible next allowed agent, so the depth cap is not tested with an inherently empty spawn list. |
| 21 | PASS | A fork worker starts a fork grandchild. The grandchild physically inherits the ancestor sibling's registry entry. A call to resume that sibling returns `Unknown subagent` in its session and UI. No resume registry entry appears. |
| 22 | PASS | Deep comparison proves that the fork child's copied entries equal the active parent branch before delegation. The delegation assistant entry itself is absent. This includes the current user prompt and earlier branch marker. |
| 23 | PASS | The child calls the permitted extension tool. Its result contains the actual active tool set, exactly matching the stored tools. The omitted tool is absent. The actual child arguments contain `-e` with the extension path. A strict session load marker proves the extension file ran. The child UI shows completion and the parent receives a completed result. |
| 24 | PASS with Pi restart | An untrusted project agent is ignored with a visible notice and an error tool result. No spawn is recorded. `/trust` writes only the test's private trust store. Pi 0.87.1 tells the user to restart. The test follows that instruction and reopens the parent session. The same project agent then runs successfully. |

Scenarios 12 through 16 check actual captured ANSI status colors. Failure and close headers use warning color 226. Completed headers use success color 143. Expanded captures must include the complete saved message text, after whitespace normalization for terminal wrapping. Results also have one exact durable delivery ID.

### Pane identity safety

The dedicated subtest uses a second unique socket named `/tmp/pi-subagents-test-lifecycle-<uuid>.sock`.

1. Save the first server and pane identities.
2. Verify the first pane and server before stopping that server.
3. Start another server on the same private socket. It reuses pane ID `%0` for unrelated test work.
4. Start the test Pi process on this second server through the explicit harness option.
5. Seed strict recovery files with the old server identity and an existing saved child session.
6. Restart the test parent to trigger startup recovery.
7. Check visible `Tmux server identity mismatch` text. Check that the unrelated live PID and session are unchanged. Check that `pane.json` and the child session remain.
8. Set the saved server to the current server but retain the old pane process. Restart recovery. Check visible `Tmux pane %0 identity mismatch` text and the same file and live-pane invariants.
9. Create a separate matching pane. Verify its initial identity before respawn. Save and verify its final process, server, and session identity. Wait for its normal exit.
10. Run startup recovery. Check that the matching pane and run directory are removed. Check that the child session remains. Check the durable and rendered stopped notice.

The runner's own server is never restarted. The outer `t.after` closes the second server even when the nested test fails. Cleanup verifies the current second-server identity first. The runner server identity is checked again afterward. All tmux commands select a private socket. No default server is used. A mismatched pane is never a `kill-pane` target.

## RED and GREEN evidence

### Existing passing behavior

The first lifecycle command covered scenarios 12 through 16 against unchanged production code:

```text
node scripts/run-tests.mjs --isolated-tmux --test --test-concurrency=1 test/e2e/lifecycle.test.ts
 tests 5
 pass 5
 fail 0
```

This is new coverage of existing behavior, not a claimed production RED/GREEN fix.

### New extension probe

The initial probe fixture exported an empty factory. The sandbox test could not spawn a worker with its required probe tool:

```text
node scripts/run-tests.mjs --isolated-tmux --test --test-name-pattern='19.3.23' test/e2e/lifecycle.test.ts
 tests 1
 pass 0
 fail 1
 Timed out waiting for live run worker after 20000 ms.
```

After the fixture registered its tools and session load marker, the same command returned:

```text
 tests 1
 pass 1
 fail 0
```

### Approval helper

The trust test first requested `approval: "ask"` before the harness supported it:

```text
node scripts/run-tests.mjs --isolated-tmux --test --test-name-pattern='19.3.24' test/e2e/lifecycle.test.ts
 Error: Unknown option: --ask
 tests 1
 pass 0
 fail 1
```

The harness now omits an approval override for that option. The final trust scenario passes. Investigation also showed that `/trust` requires a process restart in pinned Pi; the test follows its explicit notification.

### Second private socket helper

Before `tmuxEnvironment` support, the requested second-socket scenario still selected the runner socket:

```text
node scripts/run-tests.mjs --isolated-tmux --test --test-name-pattern='pane recovery' test/e2e/lifecycle.test.ts
 AssertionError: Expected values to be strictly equal
 actual: /private/tmp/tmux-501/pi-subagents-test-<runner>
 expected: /tmp/pi-subagents-test-lifecycle-<uuid>.sock
```

After the helper change, the parent runs on the requested private socket. The final identity group and nested subtest both pass. Recovery is triggered by parent startup, not `/reload`, as required by the existing runtime.

### Test corrections during implementation

Early nested test data allowed an agent to spawn itself. Configuration correctly rejected that definition. The tests now use distinct worker, scout, leaf, and helper agents. A disallowed external name reports `Unknown agent` because the child catalog excludes it. The test now asserts that actual explicit error.

Initial color assertions expected truecolor sequences and then the wrong green palette index. Private terminal capture showed ANSI 256-color values 226 and 143. Assertions now pin those actual warning and success colors. These were test corrections, not production defects.

The scenario 18 OS-argument failure remains unresolved. There is no GREEN claim for it.

## Final verification

Focused lifecycle command:

```text
node scripts/run-tests.mjs --isolated-tmux --test --test-concurrency=1 test/e2e/lifecycle.test.ts
 tests 14
 pass 13
 fail 1
 skipped 0
 todo 0
```

The only failure is scenario 18's required `ps` assertion. The count includes the identity group's nested subtest. Scenarios 21 and 22 share one test.

Full requested non-E2E suite:

```text
npm test
 check:pi-version: PASS
 typecheck: PASS
 lint: PASS
 unit: 366 tests, 366 pass, 0 fail
 sdk: 80 tests, 80 pass, 0 fail
```

Existing harness regression command:

```text
node scripts/run-tests.mjs --isolated-tmux --test --test-concurrency=1 test/e2e/harness.test.ts
 tests 3
 pass 3
 fail 0
```

`git diff --check` passed. The full E2E suite was not run. The requested focused lifecycle file and full `npm test` were run repeatedly. Local command logs are in `/tmp/task3-verified-focused.log`, `/tmp/task3-verified-npm.log`, and `/tmp/task3-harness-green.log`. The relevant output is included above so this report does not depend on those temporary files.

## Self-review and concerns

- Reviewed all new tests, fixture behavior, harness changes, cleanup paths, and final failure output.
- Kept schema parsing strict. No malformed records are skipped by these tests.
- Kept private `PI_CODING_AGENT_DIR` isolation for every scenario. The trust store is private to its test.
- Added no production fallback and suppressed no test failures.
- Kept all mutable test state inside test or fixture closures.
- Did not change global Pi configuration, global packages, the user's trust store, or the default tmux server.
- Used the scripted local provider only. No paid model was called.
- Did not dispatch subagents or reviewers. Did not merge or push.
- Main concern: the code commit intentionally retains the exact blocked E2E assertion. Task 3 cannot be approved as complete without a decision on scenario 18.
- Compatibility note: `/trust` takes effect after the restart required by Pi 0.87.1. The test does not claim an immediate catalog refresh.
