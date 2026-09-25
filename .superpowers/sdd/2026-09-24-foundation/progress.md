# SDD ledger - plan: docs/superpowers/plans/2026-09-24-foundation.md

Pre-flight interface scan:
| Tasks | Producer / consumer | Finding |
|---|---|---|
| 1 -> 2-9 | package scripts and dependencies -> all test commands | Compatible. Task 2 can use isolated CLI fixtures. |
| 2 -> 3-8 | pinned Pi behavior -> implementation assumptions | Compatible. A failed pin stops consumer work. |
| 3 -> 4-6, 8 | schemas and strict JSON -> config, catalog, session, queue, launch | Compatible. |
| 4 -> 8 | catalog Launch -> launch argument and snapshot | Compatible. |
| 5 -> 8 | process identity and child session writer -> transaction | Compatible. |
| 6 -> 8 | queue directories -> transaction | Compatible. |
| 7 -> 8 | injectable Tmux -> transaction | Compatible. |
| 1-8 -> 9 | foundation behavior -> integration gate | Compatible. |

Pre-flight self-consistency scan:
| Task | Check | Finding |
|---|---|---|
| 1 | Script tests, install and typecheck | Compatible. |
| 2 | SDK pins before dependent code | Compatible. P7, P11, P12 need an isolated CLI process. |
| 3 | Schema walk, strict helpers and all schemas | Compatible. |
| 4 | Frontmatter, profile, nested launch resolution | Compatible. |
| 5 | Process identity and JSONL session tests | Compatible. |
| 6 | Queue file format and deletion | Compatible. |
| 7 | Tmux wrapper and injected command boundary | Compatible. |
| 8 | Script and transaction tests | Launch transaction needs injected runtime collaborators since parent runtime is Task 3 of the handoff. |
| 9 | npm test and review | The E2E command should fail when no E2E suite exists. |

Task 8: Ruling: Use explicit injected launch collaborators for reservations, registry records and disposal - the parent runtime is outside foundation scope - cost if wrong: adjust the launch interface when the runtime lands.
Workspace: the user specified the dedicated new checkout on branch rewrite; work in place rather than create another branch or worktree.
Task 1: fix round 1/5 (2 addressed, 1 new Important open: signal path can leave child running; commits ea5b8c1..9f85514)
Task 1: fix round 2/5 (1 addressed, 0 open; commits 9f85514..5e05a2d)
Task 1: complete (commits af82a5d..5e05a2d, review clean; focused 6/6 pass, npm test pass; SDK test file planned in Task 2)
Task 2: Ruling: P1 must distinguish persistent custom state from model-visible custom_message content - real SDK behavior and Pi docs disagree with the old wording; user approved this correction in spec-v2.md - cost if wrong: revise the P1 pin and any registry use of custom entries.
Task 2: blocked typecheck in third-party declaration files under NodeNext; resolve without suppressing the errors before calling the task complete.
Task 2: Ruling: P13 checks bare SDK [] and CLI built-in llama.cpp separately - the SDK does not load the CLI's built-in factory; user approved the spec correction - cost if wrong: a profile could incorrectly require an extension path for llama.cpp.
Task 2: Ruling: apply an exact version-gated, idempotent install patch to 41 Pi AI declaration imports, pin Node 24 types and the optional MCP type dependency - user approved a strict NodeNext solution without hiding errors - cost if wrong: npm install stops on an upstream package change until the patch is revised.
Task 2: Ruling: P12 separately pins silent fuzzy model selection and warned custom missing ID - real Pi CLI behavior contradicts the combined wording; user approved spec correction - cost if wrong: the child self-check could miss a different silent model selection.
Task 2: Ruling: a failed tmux cleanup can leak a private server, so grade the reviewer's cleanup finding Important rather than Minor - test and fix it - cost if wrong: testing leaves orphan tmux servers.
Task 2: minor (deferred): npm reports a deprecated upstream dependency and blocked third-party lifecycle scripts under this machine's policy; record the warnings without changing global npm policy.
Task 2: Ruling: an installed consumer dependency cannot run the package postinstall under this machine's npm script policy - leave global policy unchanged and report that its 41 declarations remain unpatched, while root npm ci and full checks pass - cost if wrong: a strict TypeScript consumer will see upstream declaration errors until its package manager permits scripts.
Task 2: minor (deferred): P12 tests the fuzzy model ID but does not assert absence of a warning, though the observed run was silent.
Task 2: fix round 1/5 (P12 resolved by approved spec correction, tmux cleanup fixed, 0 open; commits 4a4ef85..e99cccd)
Task 2: complete (commits 5e05a2d..e99cccd, review clean; npm test pass: 14 unit and 20 SDK tests)
Task 3: complete (commits e99cccd..517df57, review clean; focused 6/6 pass, npm test 40/40 pass)
Task 3: review note: canonical path resolution is a consumer duty in Tasks 4, 5 and 8; AbsPath checks syntax only.
Task 4: fix round 1/5 (1 addressed, 0 open: dangling project profile link; commits 9d2fbf7..abf9277)
Task 4: complete (commits 517df57..abf9277, review clean; focused 91/91 pass, npm test 131/131 pass)
Task 5: minor (deferred): existing P12 SDK diagnostic prints observed model-selection behavior in the full test output.
Task 5: complete (commits abf9277..6da3afe, review clean; focused 26/26 pass, npm test 157/157 pass)
Task 6: complete (commits 6da3afe..2960bd6, review clean; focused 6/6 pass, npm test 163/163 pass)
Task 6: review note: confirm consumer-only deletion after durable delivery when the runtime is built in HANDOFF step 3.
Task 7: minor (deferred): a fake-binary test could exercise production execFile callback for nonzero exit and signal, beyond the injected adapter tests.
Task 7: complete (commits 2960bd6..646ef36, review clean; focused 6/6 pass, npm test 169/169 pass)
Task 7: review note: the runtime must invoke checkTmuxVersion once and enforce other section 7.1 preconditions.
Task 8: Ruling: split spawn resolution into a path-free launch draft and complete it only after the transaction writes the child session; keep preflight byte checks with a same-byte-length candidate path - pure catalog resolution cannot realpath a file the writer has not created, and no dummy existing session may stand in - cost if wrong: adjust the runtime's planned launch API and its preflight sequence.
Task 8: Ruling: repair the shared ThinkingLevel type inference and partial-write cleanup in their producer modules during this fix round - both are load-bearing for the launch contract - cost if wrong: broader diff and review scope for Task 8.
Task 8: fix round 1/5 (3 addressed, 0 open: session partial file, path-free launch draft, typed thinking levels; commits 5a1132e..7e03a3a)
Task 8: complete (commits 646ef36..7e03a3a, review clean; affected 92/92 pass, npm test 208/208 pass)
Task 8: review note: runtime must use the new LaunchDraft for spawn, stored Launch for resume, and check tmux version once.
Task 9: minor (deferred): filtering rename:parent.jsonl can miss an out-and-back rename that preserves its final file identity; no evidence that launch performs this operation.
Task 9: minor (deferred): the preflight test restores fixed file modes rather than the fixture's original modes.
Task 9: fix round 1/5 (watcher assertion replaced by deterministic read-only preflight check; 0 Important open; commits 9c82b89..f310a8a)
Task 9: branch-wide review found four Important defects; final fix pass complete in be1edae. See final-fix-report.md.
Final: Ruling: an unflushed parent session has no file to realpath - store its canonical intended path from a real parent directory and basename, then use the real file path once it exists - cost if wrong: a later symlink at that path could require identity reconciliation.
Final: Ruling: rollback must not remove a run directory or new child session before child exit is confirmed - preserve recovery files and report a failed kill or unknown exit loudly - cost if wrong: interrupted launches may leave files that require manual recovery.
Final: Ruling: validate transcript fields consumed by result extraction and package-owned records with file and line context - avoid silently empty results from malformed messages - cost if wrong: stricter readers can reject a legitimate Pi entry shape and need refinement.
Final: Ruling: a broken agent symlink is an error for that agent, not a reason to hide other valid agents - keep scope precedence and display the error - cost if wrong: catalog discovery may expose a stale link while preserving unrelated agents.
Final: Ruling: runtime delivery, supervision, resume guards and shutdown are outside the foundation and remain unjudged until HANDOFF step 3 - cost if wrong: an interface issue may surface later.
Final: Ruling: runtime version-gate calls and spawn preconditions are outside the foundation - the adapter and launch guard exist, but caller wiring is deferred to step 3 - cost if wrong: unsupported tmux could start a run.
Final: Ruling: extension entry point and bundled agents are assigned to step 3, not this foundation - cost if wrong: package cannot run yet.
Final: Ruling: queue producer and consumer race needs runtime call-site review - no consumer exists in this phase - cost if wrong: a queue file might be deleted before confirmation.
Final: Ruling: E2E and UI layout are assigned to step 4 - cost if wrong: an interactive defect may escape unit and SDK checks.
Final: Ruling: README, CI and migration are assigned to step 5 - cost if wrong: the package remains undocumented until then.
Final: Ruling: do not change npm script policy or remove the approved declaration patch during this review - cost if wrong: installed strict TypeScript consumers can see unpatched upstream declarations.
Final: Ruling: retain the recorded P12, diagnostic, tmux callback, watcher and fixture-mode minors for later triage - cost if wrong: a pin or test may miss a narrow regression.
Final: Ruling: hostile extensions and deliberate same-user filesystem replacement are outside the chosen security boundary - cost if wrong: an attacker with those capabilities could bypass sandbox intent.
Final: complete (commit be1edae): four focused RED runs reproduced the assigned defects before production changes. All focused GREEN tests pass. Final npm test: 214 unit tests and 20 SDK tests pass, with no skips. Separate typecheck and lint pass. The report records recovery limits and the deferred runtime and E2E scope.
