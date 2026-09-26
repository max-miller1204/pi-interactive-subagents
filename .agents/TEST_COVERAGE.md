# End-to-end coverage map

Use the skill for the feature you change. Run its command from the repository root. Run `npm test && npm run test:e2e` for the full gate. The end-to-end runner starts real Pi sessions on a private tmux server. A scripted provider gives repeatable replies without a paid model or network API.

| Feature | Skill | Main end-to-end evidence |
| --- | --- | --- |
| Spawn, task order, result, status | `e2e-spawn-and-results` | `core.test.ts`, `provider.test.ts` |
| Steering, inbox order, questions, answers | `e2e-messages-and-questions` | `core.test.ts` |
| Columns, nested panes, sibling launches | `e2e-pane-layout-and-nesting` | `column.test.ts`, `layout.test.ts`, `pane-start.test.ts` |
| Reload, new session, fork, resume, quit | `e2e-session-recovery` | `core.test.ts`, `lifecycle.test.ts` |
| Tools, nested rights, project trust | `e2e-sandbox-and-trust` | `lifecycle.test.ts` |
| Crashes, fatal errors, orphan and pane cleanup | `e2e-failures-and-cleanup` | `child-timer.test.ts`, `harness.test.ts`, `lifecycle.test.ts` |

Each skill names the cases to inspect in the TAP output and the behavior those cases assert. If a feature changes, update its end-to-end case before using the skill as evidence. The full gate runs every file in `test/e2e/`, including cases that cross feature areas.

The optional `EVIDENCE_DIR=artifacts/recording npm run test:record` command creates an MP4, screenshot, checkpoints, and session files for a review that needs visual evidence. It needs VHS, FFmpeg, ttyd, and tmux. The recording makes assertions but covers one workflow. It does not replace the full gate.
