# Private Tmux E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify the v4 subagent extension across real Pi processes and private tmux panes without a paid model.

**Architecture:** The existing `scripts/run-tests.mjs` starts and stops one private tmux server for the E2E test process. Each test starts its own Pi parent in a new window on that server. A deterministic extension registers a scripted faux model inside each Pi process. The harness reads durable JSONL, queue files, pane state and captured TUI output. Tests wait for conditions with deadlines and preserve diagnostic files on failure until the failure is reported.

**Tech Stack:** Node 24, TypeScript NodeNext, Pi 0.87.1, pi-ai `createFauxCore`, Node test runner, tmux 3.3 or later.

**Spec:** `/Users/maxmiller/pi-interactive-subagents-handoff/design/spec-v2.md`, section 19.3, plus sections 6 through 14 and 23.

## Global Constraints

- Work only in `/Users/maxmiller/pi-interactive-subagents-new` on branch `rewrite`.
- Run E2E only through `npm run test:e2e`. It invokes `scripts/run-tests.mjs --isolated-tmux`.
- Never call the user's default tmux server. Every tmux command uses the socket from `process.env.TMUX` with `-S`.
- Never edit global `~/.pi` files. Set `PI_CODING_AGENT_DIR` to a new temporary directory per test.
- Use the pinned Pi CLI `node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`.
- Use a scripted faux provider. Never call a paid model.
- Start each parent with `--no-extensions` and explicit `-e` paths for this extension and the faux provider.
- Wait for observable conditions with a 20-second default deadline. Do not use fixed sleeps as test oracles.
- Verify session JSONL and queue files as well as captured UI. A UI-only observation does not prove durable delivery.
- Check widget and renderer width and alignment in every scenario that has UI. Do not accept clipped or cut text without a deliberate width test.
- Preserve strict v4 schemas, `PaneFile.server` identity checks, parent-message text details and the `delivery-ack.json` protocol.
- No fallbacks, compatibility paths, swallowed errors, module-level mutable state, em dash, AI attribution or manual changes to generated files.
- Do not claim E2E coverage for a scenario until that exact scenario runs on a real private tmux pane.
- Do not change global npm script policy or installed Pi files.
- Run the full E2E suite three times at the end. Fix a flake at its root with a RED/GREEN test.

## Review Focus

- A stale or unrelated pane with a reused id must survive recovery; the matching pane must still be cleaned. Task 3 tests both with real tmux.
- A question answer behind an earlier instruction must unblock the waiter and preserve instruction order. Task 2 tests this across processes.
- A parent that quits during a child's pending result must retain recovery files and show one notice after reopen. Task 2 tests this from disk and UI.
- A child process that fails before writing a complete transcript must produce a visible failed or crashed result without deleting recovery data early. Task 3 tests startup failure and crash.
- A private tmux server must stop even if an E2E test fails or receives SIGINT/SIGTERM. Task 1 exercises the existing runner and verifies absence afterward.

## File map

- `test/fixtures/faux-brain.ts`: register a deterministic `faux/brain` provider through the Pi extension API. No network request.
- `test/fixtures/throws-at-load.ts`: a deliberate extension load failure in a child.
- `test/e2e/harness.ts`: private-socket commands, per-test parent window, sandboxed agent directory, JSONL and UI helpers, deadlines and cleanup.
- `test/e2e/provider.test.ts`: pure script-selection and response-shape tests that run without tmux. If this file lives under `test/e2e`, invoke it through `npm run test:e2e` so the server is isolated.
- `test/e2e/core.test.ts`: real launch, delivery, questions, replacement and quit.
- `test/e2e/lifecycle.test.ts`: error, manual pane, resume, nested, fork and sandbox cases.
- `test/e2e/layout.test.ts`: private-server environment, orphan and layout cases.
- `scripts/run-tests.mjs`: modify only if a RED cleanup test proves an existing flaw.

### Task 1: Scripted provider and private-process harness

**Files:** Create `test/fixtures/faux-brain.ts`, `test/fixtures/throws-at-load.ts`, `test/e2e/harness.ts`, `test/e2e/provider.test.ts`. Modify `scripts/run-tests.mjs` only for a proved cleanup bug.

**Interfaces:** Export `scenario(t, options)` returning `{ root, cwd, agentDir, parentPane, parentFile, stderrFile, socket, tmux, readParent, capture, sendKeys, waitFor, childRuns }`. Export `waitFor(test, description, deadlineMs = 20_000)` and `readBranch(file)` using the production session reader. Export a pure `scriptStep(messages)` from the provider fixture for unit checks. E2E helpers must operate on the runner's private socket only.

```ts
interface ScenarioOptions {
  prompt: string;
  agents?: Record<string, string>;
  extensionPaths?: string[];
  approval?: "approve" | "no-approve";
}
interface Scenario {
  root: string;
  cwd: string;
  agentDir: string;
  parentPane: string;
  parentFile: string;
  stderrFile: string;
  socket: string;
  tmux(args: string[]): Promise<string>;
  readParent(): SessionEntry[];
  capture(pane?: string): Promise<string>;
  sendKeys(pane: string, text: string): Promise<void>;
  waitFor<T>(test: () => T | Promise<T>, description: string, deadlineMs?: number): Promise<NonNullable<T>>;
  childRuns(): string[];
}
```

Use the production JSONL entry type for `SessionEntry`. Normalize typed `custom_message` entries through a strict test helper before inspecting `details`. Keep helpers small and let malformed JSONL fail the test.

**Provider contract:** Build a `createFauxCore({ api: "faux", provider: "faux", models: [{ id: "brain", reasoning: false }] })` inside the extension factory. Register `pi.registerProvider("faux", { api: "faux", baseUrl: "http://localhost:0", apiKey: "faux", models: [{ id: "brain", name: "Scripted brain", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 }], streamSimple(model, context, options) { const step = scriptStep(context.messages); core.setResponses([toFauxMessage(step)]); return core.streamSimple(model, context, options); } })`. Call `options.onPayload` and `options.onResponse` as the Pi provider contract requires. The model must not read or write script state outside its own process; select steps from the current transcript.

**Script input:** The newest user or delivered custom message with a line `#script <JSON array>` supplies the steps. Count assistant messages after that message to select the next step. Strictly parse the array and validate exactly one of `{ say: string }`, `{ call: string, args: object }`, `{ calls: { call: string, args: object }[] }`, `{ error: string }`, `{ exit: integer }`, `{ hang: true }`. No script returns `ack: <first line of the last message>`. Invalid scripts throw with the session and step index.

- [ ] **Step 1: Write provider RED tests.** Test `#script [{"say":"hello"},{"call":"subagent","args":{"agent":"scout"}}]`, a later assistant selecting step 2, two tool calls in one assistant message, an invalid step key, a missing step, the no-script acknowledgement, and `hang` abort. The tests assert exact `stopReason`, text or tool call, and no network request. Run `npm run test:e2e`; expect module import or assertion failure before the fixture exists.
- [ ] **Step 2: Implement the provider and failure fixture.** Use `fauxAssistantMessage`, `fauxToolCall` and `createFauxCore` from the root `@earendil-works/pi-ai` export. A `call` or `calls` step has `stopReason: "toolUse"`; `calls` produces distinct ids and two tool-call blocks in one assistant message. An `error` step has `stopReason: "error"` and `errorMessage`. An `exit` step calls `process.exit(code)` inside the child. `hang` waits for the abort signal and returns an aborted message. Do not leave a Promise pending after abort.
- [ ] **Step 3: Run the provider tests.** Expect all provider cases to pass. Write a separate RED test for the harness that starts a parent, waits for a session file and `ack: probe`, then closes its window and verifies process exit. For example, use `scenario(t, { prompt: "probe" })`, wait for an assistant `text` block equal to `ack: probe` in `readParent()`, and assert `capture()` also contains it. Implement only enough harness for that test.
- [ ] **Step 4: Implement private harness.** Resolve `process.env.TMUX` to the socket and verify it is the runner's private server. Use `execFile` with `tmux -S <socket>` and a five-second command timeout. Start a new detached window with `remain-on-exit on` and a wrapper script. Write `subagent-profiles.json` into the per-test `PI_CODING_AGENT_DIR` with `{"profiles":{"test":{"model":"faux/brain","thinking":"off","guidance":"Test profile.","extensions":["<absolute test/fixtures/faux-brain.ts>"]}}}`. Write agent Markdown into its `agents/` directory. The wrapper uses `/usr/bin/env -i` with explicit `HOME`, `PATH`, `PI_CODING_AGENT_DIR`, `TMUX`, `TMUX_PANE` and test variables. Use absolute `process.execPath`, pinned CLI, `--no-extensions`, both explicit `-e` paths, `--model faux/brain`, `--thinking off`, `--session <parentFile>`, an explicit approval flag and one argv script prompt. Use `--approve` for trusted cases. Use `--no-approve` for the trust test and drive `/trust` in that test. Register `t.after` cleanup for the window and temp files. On failure, capture pane text, stderr, session tail and run directory names before cleanup.
- [ ] **Step 5: Run `npm run test:e2e` and check no private server remains.** Assert the runner stops the server on success, failed test and signal using its existing SDK cleanup tests plus one E2E failure fixture. Run `npm test` once, then commit `feat: add scripted private tmux E2E harness`.

### Task 2: Delivery, questions, replacement and quit across processes

**Files:** Create `test/e2e/core.test.ts`. Modify `test/e2e/harness.ts` only to add a shared helper proved necessary by a RED E2E case.

**Interfaces:** Use Task 1 `scenario`, `waitFor`, `readParent`, `sendKeys`, `capture`, `childRuns` and the strict queue/session readers. Tests launch only with `scenario(t, options)`. Each expected item has a stable `deliveryId` and is counted in the receiving JSONL, not only in TUI text. For a result, find a `custom_message` with `customType === "subagent_result"`, validate `details` with the production `ResultDetails` schema, assert its `deliveryId`, and assert exactly one matching entry. For a question, save both qids before sending answers, then assert matching `toolResult.details.deliveryId` values in the child session. For `/new` and `/fork`, compare the old and new session IDs before asserting which branch got the result. For quit, check stderr and `undelivered/<sessionId>/` on disk before reopening.

- [ ] **Step 1: Add RED launch and messaging E2E tests.** Cover section 19.3 scenarios 1, 2 and 3. For scenario 1 assert one spawn record, one result, child pane gone, run directory removed, done widget row then expired row. For 2 assert the task user entry precedes the steer in the child branch. For 3 use an `auto-exit: false` agent and assert three distinct messages appear in order in its persisted session. Run `npm run test:e2e` with each new assertion. Previously implemented runtime behavior can pass immediately. If an assertion fails, distinguish a real runtime defect from a fixture error before changing code. First make a failing test for a demonstrated defect, then fix it.
- [ ] **Step 2: Add RED question E2E tests.** Cover scenarios 4 and the Review Focus answer-behind-instruction case. Spawn a child with one `calls` step that contains two `ask_question` tool calls. Assert two qids, route answers in reverse qid order, then assert both matching tool results and one final child result. In a separate case queue an ordinary instruction before the question and its answer after; assert the waiter resolves and the instruction arrives once. Check question and parent-message renderers in pane capture for readable text.
- [ ] **Step 3: Add RED replacement E2E tests.** Cover scenarios 5, 6, 7 and 17. While the child is active, send parent `/reload`, `/new` or `/fork`, then settle its result. Assert exactly one durable delivery to the active branch, the correct trigger behavior, and `adopt` after `/new`. Under Esc with a ready result, assert the result appends without starting another model run. Test each mode in its own window so session state cannot leak.
- [ ] **Step 4: Add RED quit and notice E2E tests.** Cover scenarios 8, 9 and 10. Send `/quit` while a child runs or a result waits behind a hanging parent. Assert child process exit, stderr advice, on-disk `stopped` or `result` record, one notice after reopening the saved session and ability to resume by name. For `/new` then quit, assert the notice targets the new session. Do not delete files based only on UI text.
- [ ] **Step 5: Make only fixes exposed by RED cases.** Keep runtime behavior and test harness changes separate. Run the focused core file and `npm test`; commit `test: cover subagent delivery and recovery in tmux`.

### Task 3: Failure, resume, nesting, sandbox and pane safety

**Files:** Create `test/e2e/lifecycle.test.ts`. Modify `test/e2e/harness.ts` only for focused, reusable helpers with RED evidence.

**Interfaces:** Use Task 1's strict scenario and session helpers. For each destructive pane assertion, compare the saved `PaneFile.server` and pane PID/session with the current private server. Do not issue a kill for a mismatched identity in test cleanup. For a crash, find the saved `subagent_result`, validate `ResultDetails`, and assert `status === "crashed"`, `exitCode === 3`, and visible `crashed` text in `capture()`. For a reused pane ID, compare the live PID and session after recovery, and assert that `pane.json` and the child session still exist. For a matching pane, assert removal after verified cleanup. Inspect actual child tools and extension effects for sandbox tests. Do not infer isolation only from absent calls.

- [ ] **Step 1: Add RED exit and manual-pane tests.** Cover scenarios 12, 13, 14, 15 and 16. Load `throws-at-load.ts` only for the intended child. Assert `crashed`, exit code 1 and pane tail for load failure, exit code 3 for an explicit process exit, `error` for provider error, `closed` for manual kill and retained text for a human takeover. Capture UI and check the status color and full text.
- [ ] **Step 2: Add RED resume tests.** Cover scenarios 18 and 19. Finish a run, send `subagent_message({ name, message })`, inspect the new child process argv with `ps -o args= -p <pid>` and compare stored tools, extension paths, skills, model and thinking. Assert result text is only from the resumed segment. Try resume while its old pane remains open and assert an explicit error without a second pane.
- [ ] **Step 3: Add RED nested and fork tests.** Cover scenarios 11, 20, 21 and 22. A worker can spawn scout, cannot spawn a name outside its allowlist, and depth 3 has no nested spawn tools. A nested fork cannot resume an ancestor's sibling child. A fork child copies the active parent branch before the delegation call. Parent quit stops the child and grandchild and leaves the child's stopped record.
- [ ] **Step 4: Add RED sandbox and trust tests.** Cover scenarios 23 and 24. Spawn with one permitted extension tool and one omitted tool; assert only the permitted one is active and its `-e` file runs. An untrusted project agent must be ignored with a notice. After `/trust`, the same agent becomes available. Do not alter the user's real trust store.
- [ ] **Step 5: Add real pane identity tests.** Use a second unique private socket in a dedicated subtest for server reuse. Keep the runner's private server alive; never restart it. Stop the second server in `t.after`, including on assertion failure. Create a reused pane id and saved run files with an old server identity. Assert the live unrelated pane survives, files remain, and a visible error names the mismatch. Then test a matching pane is cleaned. This pins the Review Focus identity risk without touching the user's server.
- [ ] **Step 6: Run the focused lifecycle file, then `npm test`.** Correct defects with RED/GREEN tests. Commit `test: cover child failures and sandbox in tmux`.

### Task 4: Environment, orphan, layout and full E2E gate

**Files:** Create `test/e2e/layout.test.ts`. Modify `test/e2e/harness.ts` or production code only for a demonstrated RED case.

**Interfaces:** Uses Task 1's private socket and per-test window. Captured layout uses `tmux list-panes -F "#{pane_id}\t#{pane_width}\t#{pane_height}\t#{window_width}"` on the private socket. Compare dimensions before and after each split. Parse numeric fields strictly. Before a three-child spawn, capture the user's pane width. After each split, assert the user's width stays the same and all child panes have one column of even heights. On Linux read `/proc/<pid>/environ`; on macOS use `ps eww -p <pid>`. Assert `STALE=` is absent and `TMUX=` and `TMUX_PANE=` are present.

- [ ] **Step 1: Add RED late-message and environment cases.** Cover scenarios 25 and 26. Queue a steer after the child's exit decision and assert it appears in the result's unread messages rather than disappearing. Set `STALE=x` in the private server, then assert it is absent from the child process environment while the required pane identity variables are present.
- [ ] **Step 2: Add RED orphan and layout cases.** Cover scenarios 27 and 28. Kill the test parent process only, not the test runner. Assert the child shows an orphan notice and stays open. After that child exits, start a new parent and assert one stopped recovery record. For layout, start with a user pane, spawn three children, and assert they occupy one column with even heights while the user pane retains its original width. Capture both UI states and reject misaligned or cut text.
- [ ] **Step 3: Check real-path behavior.** Cover scenario 29 on macOS by asserting resolved session, agent, extension and run paths under `/var/folders`. On Linux make a symlinked temp agent directory and assert the same canonical paths. On macOS verify the test temp dir is a symlink before using it as symlink evidence; create an explicit symlink if it is not. Do not treat a non-symlinked path as proof of symlink behavior.
- [ ] **Step 4: Run the full E2E suite three separate times.** Use `npm run test:e2e` for each run. Keep full logs and inspect every failure, timeout, skipped test and UI capture. Fix timing defects at their source with focused RED/GREEN tests. Run `npm test` and `git diff --check`. Commit `test: verify tmux layout and full E2E suite`.

### Task 5: Review gate

**Files:** Modify only tests or code for a reproducible review finding.

- [ ] **Step 1: Run `npm test` and `npm run test:e2e` after the final change.** Read all results and inspect UI captures. Do not claim E2E if any scenario is skipped.
- [ ] **Step 2: Request a whole-branch review against section 19.3 and Review Focus.** Address every Critical and Important issue with a RED test and a scoped re-review.
- [ ] **Step 3: Record deferred minor findings and the exact scenarios proved.** Leave README, CI, migration, real-model smoke, push and PR for later handoff steps.

## Self-review checklist

- Every scenario 1 through 29 in section 19.3 appears in Task 2, 3 or 4.
- The provider never makes a network call, and its stream obeys abort and instrumentation requirements.
- All test tmux commands use the runner's private socket. Each window and directory has cleanup.
- Review Focus maps to Task 1, 2 or 3 tests.
- `npm test` remains the unit and SDK gate. `npm run test:e2e` runs only under `--isolated-tmux`.
- No task changes global Pi state or claims a paid-model smoke test.
