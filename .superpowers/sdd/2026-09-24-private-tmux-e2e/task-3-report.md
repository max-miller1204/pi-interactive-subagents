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

## Continuation: approved live argument observation

### Current status: COMPLETE

The initial BLOCKED status above is historical. The ruling supplied on 2026-09-25 at 10:33:22 authorizes a direct in-process argument observation for scenario 18. All lifecycle tests now pass.

### Approved specification deviation

Scenario 18 now obtains actual `process.argv` through the already permitted `lifecycle_probe` tool in the live resumed child. It no longer uses `ps -o args=` as its acceptance oracle. Pi deliberately sets its OS process title to `pi`, so that command cannot expose the flags on this host.

This is one direct observation method, not a fallback. No pinned Pi code, process title, handoff file, or global Pi configuration changed. The other scenarios and private socket identity checks remain intact.

### Changes and ownership checks

- `test/fixtures/lifecycle-tools.ts` now returns the actual process PID, the session manager's saved session path, and the child run argument with its existing active tools and `process.argv`. The fixture rejects a missing saved session or an absent or duplicate run argument.
- `test/e2e/lifecycle.test.ts` strictly validates those additional probe fields.
- The initial child calls the probe before it finishes. That saved result remains in the child session as a deliberate earlier-segment test case.
- The resumed child calls the probe again and then hangs. The test verifies that its pane remains live on the expected private server. The saved probe PID must equal the verified resumed pane PID. The session path and run directory must match the resumed run. The PID and run directory must differ from the earlier observation.
- The parent session must contain no probe tool result.
- The test strictly parses the child run marker for the resumed run ID. Exactly one probe result must follow that marker. Its saved details must equal the observation used for assertions.
- Exact argument-value arrays are compared for `--tools`, every `-e`, every `--skill`, `--model`, `--thinking`, and `--session`. The `-e` comparison includes the subagent extension itself plus the stored Launch extension paths. Missing, extra, duplicate, or changed values fail these comparisons.
- The child run argument must identify the current resumed run directory. The final result must still contain only `Resumed segment only.`. The session and full rendered result checks remain in place.

### RED evidence

All focused commands used:

```text
node scripts/run-tests.mjs --isolated-tmux --test --test-name-pattern='19.3.18' test/e2e/lifecycle.test.ts
```

First, the stricter result schema ran against the original probe fixture before the metadata implementation:

```text
 tests 1
 pass 0
 fail 1
 Error: probe result: / must have required properties pid, sessionFile, runDir
```

Next, the scenario deliberately selected probe index 0, from the original completed segment, while the resumed child was live:

```text
 tests 1
 pass 0
 fail 1
 AssertionError: probe must come from the live resumed child PID
 94277 !== 95639
```

After selecting the resumed segment, the test deliberately expected the wrong `--thinking` flag value:

```text
 tests 1
 pass 0
 fail 1
 AssertionError: Expected values to be strictly deep-equal
 actual: [ 'off' ]
 expected: [ 'high' ]
```

These failures prove that the assertions reject an earlier segment and a wrong flag. The temporary wrong index and wrong expectation were removed. The final expectation comes from the stored Launch.

### GREEN verification

The corrected focused scenario returned:

```text
 tests 1
 pass 1
 fail 0
 skipped 0
 todo 0
```

The complete lifecycle file returned:

```text
node scripts/run-tests.mjs --isolated-tmux --test --test-concurrency=1 test/e2e/lifecycle.test.ts
 tests 14
 pass 14
 fail 0
 skipped 0
 todo 0
```

The full requested suite returned:

```text
npm test
 check:pi-version: PASS
 typecheck: PASS
 lint: PASS
 unit: 366 tests, 366 pass, 0 fail
 sdk: 80 tests, 80 pass, 0 fail
```

`git diff --check` passed. Self-review checked exact flag comparisons, persisted segment ownership, and the unchanged private socket checks. No subagent or reviewer was dispatched. No merge or push occurred.

Local logs: `/tmp/task3-resume-probe-schema-red.log`, `/tmp/task3-resume-wrong-segment-red.log`, `/tmp/task3-resume-wrong-flag-red.log`, `/tmp/task3-resume-green.log`, `/tmp/task3-continuation-focused.log`, and `/tmp/task3-continuation-npm.log`. Relevant output is preserved above.

### Remaining concerns

No open blocker remains under the approved ruling. The documented deviations remain explicit: scenario 18 uses live in-process arguments, and scenario 24 follows the restart instruction from pinned Pi after `/trust`. The full E2E suite was not run in this continuation; the requested lifecycle file and full `npm test` passed.

## FIX ROUND 1

### Status

Both Important findings are addressed. Final lifecycle, harness, and `npm test` checks pass. An earlier unmutated grandchild exit timeout is recorded under concerns below. The approved scenario 18 argument proof is unchanged.

### Finding 1: prove both descendant processes exit

`test/e2e/lifecycle.test.ts` now captures strict `ProcessIdentity` values from both saved pane files before parent quit. It checks that both processes are alive before quit. It also waits for the worker's delegation reply and the grandchild's strict on-disk `working` status.

After quit, it waits for `processAlive(identity) === false` for each captured identity. Both waits must finish before either stopped record is accepted. Existing stopped-record, saved-session, and absent-pane assertions remain.

The test logs both captured identities. If an exit wait fails, it retains the scenario files and reports the remaining process PID, parent PID, state, and arguments. A diagnostic failure preserves both errors in an `AggregateError`. The normal exit deadline remains 20 seconds.

#### Focused mutation RED

The test temporarily substituted the known-live test runner identity into one descendant's exit observation. The actual descendants still received normal parent quit. Each mutation used a 1500 ms deadline to keep the negative test bounded.

```text
node scripts/run-tests.mjs --isolated-tmux --test --test-name-pattern='19.3.11' test/e2e/lifecycle.test.ts
```

Worker mutation:

```text
 tests 1
 pass 0
 fail 1
 Timed out waiting for descendant process exit worker after 1500 ms.
```

Grandchild mutation:

```text
 tests 1
 pass 0
 fail 1
 Timed out waiting for descendant process exit grandchild after 1500 ms.
```

The substitutions and shorter deadlines were removed. The final test uses only the two strict identities from the saved pane files. Six additional isolated scenario 11 runs passed, as did the subsequent complete lifecycle runs.

### Finding 2: register cleanup before resource acquisition

`test/e2e/harness.ts` adds the focused `trackedResource` helper. Its cleanup hook registers when the helper is constructed, before acquisition starts. The helper tracks acquisition and proven identity separately. A successful release clears the saved identity. A later acquisition cannot reuse the previous identity.

If acquisition or identity discovery fails, cleanup does not issue a destructive command with an unknown identity. It reports `Retain <resource>: Resource identity is not proved.` and calls the retention handler. Verification and kill failures also report retention and throw. A retained resource is not retried. Failures in retention or diagnostic reporting preserve the original cleanup error and the reporting error.

The reopened Pi window in scenario 19 now uses this helper before `new-window`. It saves the first proven pane PID, server, and current session before setting its child-session marker. After that command succeeds, it updates the expected session. Cleanup calls `verifiedPane` before `kill-pane`. If setup succeeds only in part and identity cannot be proved, the pane and session files are retained.

The window test now has a nested test scope. Its cleanup runs before the outer scenario can remove the files. `Scenario.retainFiles(reason)` prevents file removal and reports the retained root path.

The second private server also registers its cleanup before the first start. Each start marks acquisition before the tmux command. Each verified release checks the current server identity, stops that server, and waits for its saved process identity to exit. The next start begins with no saved identity from the old generation. The first start rejects an existing socket path. Restart uses only the same test-owned socket after verified server exit.

No default tmux server is used. The runner server remains alive. All destructive window and server cleanup still requires matching identity.

#### Focused cleanup RED/GREEN

The initial helper tests failed before the helper existed:

```text
node --test --test-name-pattern='tracked cleanup' test/e2e/harness.test.ts
 SyntaxError: The requested module './harness.ts' does not provide an export named 'trackedResource'
```

After implementation, a mutation moved hook registration until after identity discovery. The focused tests caught the original registration-order risk:

```text
node --test --test-name-pattern='tracked cleanup' test/e2e/harness.test.ts
 tests 6
 pass 1
 fail 5
 AssertionError: cleanup must register before acquisition
 0 !== 1
```

That mutation was removed. Focused tests cover acquisition failure, identity-discovery failure, setup failure after proven identity, verification mismatch, kill failure, and failed restart without reuse of the old identity. They assert no kill with unknown or mismatched identity and no retry after retention.

Two reporting tests were RED before error aggregation was added:

```text
node --test --test-name-pattern='tracked cleanup preserves errors' test/e2e/harness.test.ts
 tests 2
 pass 0
 fail 2
 assert.ok(error instanceof AggregateError)
```

The implementation now attempts retention and diagnostic reporting and preserves both errors. Both reporting tests pass.

A separate mutation disabled the retained-files condition in scenario cleanup:

```text
node scripts/run-tests.mjs --isolated-tmux --test --test-name-pattern='scenario retains files' test/e2e/harness.test.ts
 tests 2
 pass 1
 fail 1
 assert.ok(root !== undefined && existsSync(root))
```

The condition was restored. The test now proves that the saved session survives scenario cleanup when external pane identity is not proved. Its own outer cleanup removes only the test's retained directory after the assertions.

### Final verification

```text
node scripts/run-tests.mjs --isolated-tmux --test --test-concurrency=1 test/e2e/lifecycle.test.ts
 tests 15
 pass 15
 fail 0
 skipped 0
 todo 0
```

The lifecycle count increased by one because scenario 19 now has a nested cleanup scope. No prior scenario was removed.

```text
node scripts/run-tests.mjs --isolated-tmux --test --test-concurrency=1 test/e2e/harness.test.ts
 tests 13
 pass 13
 fail 0
 skipped 0
 todo 0
```

```text
npm test
 check:pi-version: PASS
 typecheck: PASS
 lint: PASS
 unit: 366 tests, 366 pass, 0 fail
 sdk: 80 tests, 80 pass, 0 fail
```

`git diff --check` passed. Self-review covered hook registration order, acquisition-state transitions, both descendant waits, retention ordering, error propagation, and preservation of the live-child argument oracle. No production source, global file, handoff file, or fixture provider changed. No subagent or reviewer was used. No merge or push occurred.

### Investigation notes and concerns

An early combined unmutated run returned 23 passes and two failures. One failure came from treating the old private socket file as an unowned path on restart. The server can leave that path behind. The test now rejects an existing path only on first acquisition and allows only a verified restart of its own socket. Server release also waits for the old process identity to exit.

The other failure was a 20-second grandchild exit timeout. This occurred before per-process failure diagnostics and file retention were added, so its cause is not confirmed. It did not recur in six isolated scenario 11 runs, a combined harness/lifecycle run, or subsequent complete lifecycle runs. The test now proves the worker delegation reply and grandchild working state before quit. It retains files and process diagnostics if this exit failure occurs again. No process-exit assertion was removed, skipped, or replaced with a pane-only check. This unreproduced timeout remains a diagnostic concern, not a claimed production fix.

Evidence logs include `/tmp/task3-fix1-child-red.log`, `/tmp/task3-fix1-grandchild-red.log`, `/tmp/task3-fix1-late-hook-red.log`, `/tmp/task3-fix1-retention-red.log`, `/tmp/task3-fix1-reporting-red.log`, `/tmp/task3-fix1-focused-green.log` (the early run with two failures), `/tmp/task3-fix1-focused-recheck.log`, `/tmp/task3-fix1-lifecycle-complete.log`, `/tmp/task3-fix1-harness-final.log`, and `/tmp/task3-fix1-npm-complete.log`. Relevant output is preserved above.
