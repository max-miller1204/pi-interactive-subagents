# Final Foundation Fix Report

Status: DONE. All four Important findings are fixed.

Implementation commit: `be1edae` (`fix: close final foundation findings`).
Author and committer: Max Miller <maxmiller1204@outlook.com>.

## Scope and method

Read the approved spec, foundation plan, and current ledger before editing.
Checked the production paths and existing tests for each finding.
Checked the installed Pi message types before adding transcript validation.
Added each focused regression and observed RED before changing its production code.
Did not dispatch subagents.
Did not change generated files, package dependencies, global policy, or runtime scope.

These are end-to-end tests of foundation boundaries, not the deferred interactive E2E suite.
They use real files and the real Pi SessionManager.
Rollback tests use real child processes and process identities with an injected tmux adapter.
Agent tests run discovery through catalog display and launch resolution.

## 1. Fresh parent session paths

### Change

`src/session-file.ts` now exports `parentSessionPath`.
An absent parent file uses its real directory and basename.
An existing parent file uses its real file path.
A broken parent symlink still throws.
`src/launch.ts` and the child session writer use the same helper.
No dummy parent file is created.

The tests create fresh Pi sessions through a symlinked directory.
Standalone and fork launches commit successfully before the first assistant response.
The child header and run spec store the same canonical parent path.
The parent file remains absent.
The writer also rejects missing directories and broken parent symlinks.

### RED

Command:

```sh
node --test --test-name-pattern='fresh parent session' test/unit/launch.test.ts
```

Exit: 1. Output excerpt:

```text
FAIL fresh parent session launches standalone without creating a parent file
FAIL fresh parent session launches fork without creating a parent file
Error: ENOENT: no such file or directory, lstat '<temporary session path>.jsonl'
    at launchRun (.../src/launch.ts:268:25)
tests 2; pass 0; fail 2; skipped 0
```

### GREEN

Same command. Exit: 0.

```text
PASS fresh parent session launches standalone without creating a parent file
PASS fresh parent session launches fork without creating a parent file
tests 2; pass 2; fail 0; skipped 0
```

Also ran `node --test test/unit/launch.test.ts test/unit/session-file.test.ts` after this fix.
Result at that stage: 58 passed, 0 failed, 0 skipped.

## 2. Rollback exit confirmation

### Change

`src/launch.ts` retains the child process identity outside the launch body.
After a successful pane kill, it checks whether that process identity is gone.
A failed kill, live child, or unknown exit keeps the run files, new child session, and reserved name.
The error names the recovery directory and retains the primary failure.
When the normal PID read has not succeeded, rollback inspects the pane before killing it.
When the identity is known but cleanup is unsafe, rollback saves `pane.json` for recovery.
It does not invent an identity when inspection fails.

Real-process tests cover a failed kill, a successful kill with a live child, failure before the PID read, failed identity inspection, and confirmed process exit.
The tests check files, name reservations, recovery metadata, and process liveness.
The confirmed-exit case removes the new files and releases the name.

### RED

Command:

```sh
node --test --test-name-pattern='rollback exit confirmation' test/unit/launch.test.ts
```

Exit: 1. Output excerpt:

```text
FAIL rollback exit confirmation: kill
FAIL rollback exit confirmation: live
FAIL rollback exit confirmation: before-pid
FAIL rollback exit confirmation: unknown-pid
PASS rollback exit confirmation: exited
tests 5; pass 1; fail 4; skipped 0
```

The failed-kill case found that the recovery directory was absent while the child was alive.
The other failures received only `registry failed` or `display-message failed`, with no exit-confirmation error.

### GREEN

Same command. Exit: 0.

```text
PASS rollback exit confirmation: kill
PASS rollback exit confirmation: live
PASS rollback exit confirmation: before-pid
PASS rollback exit confirmation: unknown-pid
PASS rollback exit confirmation: exited
tests 5; pass 5; fail 0; skipped 0
```

Also ran `node --test test/unit/launch.test.ts`.
Result: 40 passed, 0 failed, 0 skipped.

## 3. Strict transcript extraction

### Change

`src/session-file.ts` validates message envelopes and assistant fields before it returns a branch.
Checks cover content blocks, text, thinking, tool calls, total tokens, stop reasons, and optional error text.
A supplied delivery ID must be a string.
Package-owned `subagent` and `subagent_child` custom records use their existing closed schemas.
Errors include the file and line.
Validation includes inactive branches, so corruption cannot disappear when the reader selects a different leaf.
All seven stop reasons in the installed Pi 0.87.1 type remain valid.
Provider metadata and foreign custom data are not given new closed schemas.

### RED

Command:

```sh
node --test --test-name-pattern='transcript extraction|transcript validation' test/unit/session-file.test.ts
```

Exit: 1. Output excerpt:

```text
FAIL transcript extraction rejects missing content with file and line
FAIL transcript extraction rejects missing text with file and line
FAIL transcript extraction rejects unknown block with file and line
FAIL transcript extraction rejects malformed message envelopes and owned records
FAIL transcript validation covers inactive branches and accepts Pi assistant shapes
tests 16; pass 0; fail 16; skipped 0
```

Malformed content either reached extraction without an error or caused a JavaScript error without file and line context.
For example, missing content produced `Cannot read properties of undefined (reading 'filter')`.

### GREEN

Same command. Exit: 0.

```text
tests 16; pass 16; fail 0; skipped 0
```

Also ran `node --test test/unit/session-file.test.ts`.
Result: 39 passed, 0 failed, 0 skipped.

## 4. Broken agent symlinks

### Change

`src/config.ts` enumerates agent file candidates without following each symlink.
It checks each file and resolves its real path inside that file's error boundary.
A broken link produces an AgentError with its canonical directory and filename.
It still replaces a lower-scope definition with the same name.
Unrelated valid agents remain available.

Tests cover user and trusted project scopes, a symlinked user directory, catalog error display, rejection of the broken agent, and successful resolution of another agent.

### RED

Command:

```sh
node --test --test-name-pattern='broken .* agent symlink' test/unit/config.test.ts
```

Exit: 1. Output excerpt:

```text
FAIL broken user agent symlink stays isolated through catalog resolution
FAIL broken project agent symlink stays isolated through catalog resolution
Error: ENOENT: no such file or directory, stat '<agent directory>/scout.md'
    at agentFiles (.../src/config.ts:84:4)
tests 2; pass 0; fail 2; skipped 0
```

### GREEN

Same command. Exit: 0.

```text
PASS broken user agent symlink stays isolated through catalog resolution
PASS broken project agent symlink stays isolated through catalog resolution
tests 2; pass 2; fail 0; skipped 0
```

Also ran `node --test test/unit/config.test.ts test/unit/catalog.test.ts`.
Result: 93 passed, 0 failed, 0 skipped.

## Final verification

Ran all four focused GREEN commands again after the final test changes.
All passed with no skips.

| Command | Exit | Output |
| --- | --- | --- |
| `npm run typecheck` | 0 | `tsc`, no diagnostics |
| `npm run lint` | 0 | `Checked 25 files in 64ms. No fixes applied.` |
| `npm test` | 0 | Pi version check, typecheck, lint, 214 unit tests, and 20 SDK tests passed |
| `git diff --check` | 0 | No output |

The full suite passed twice during this pass.
The final full run had 234 passing tests, no failures, no skips, and no cancellations.
All P1 through P15 pins passed.

Kept every prior test case.
Updated three old expectations to match the approved rulings: an absent parent filename is now valid, a failed pane kill keeps recovery files, and inactive registry records must be valid before branch selection.
The inactive-branch fold test still verifies that valid inactive records do not enter the fold.
Added 26 tests in total.

## Concerns and limits

Rollback checks exit immediately after the kill returns.
It does not guess that a process still in shutdown will exit later.
That case fails loudly and keeps recovery state rather than waiting or deleting files.
An unknown process identity leaves no fabricated `pane.json` and requires manual recovery from the reported directory.
Runtime recovery and supervision remain in HANDOFF step 3.

No interactive tmux E2E suite exists in this foundation.
Did not run or claim the deferred E2E suite.
The existing ledger minors and package-manager policy concerns remain unchanged.
No new Important finding remains open in the four assigned paths.
