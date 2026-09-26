# Widget and Pane Subagents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users start and interact with subagents in tmux panes or a Pi conversation viewer, including when Pi runs outside tmux.

**Architecture:** Keep one run protocol and two saved backend identities. Pane runs keep the current tmux path. Widget runs use a separate Pi RPC process owned by a reconnectable local supervisor. Both children publish live view records and use the existing durable message, question, and result paths.

**Tech Stack:** TypeScript, Node.js, Pi 0.87, pi-tui, TypeBox, Node test runner, private-tmux end-to-end harness.

**Spec:** `docs/superpowers/specs/2026-09-26-widget-and-pane-subagents-design.md`

## Global Constraints

- The session mode is `auto`, `panes`, or `widget`. The default is `auto`.
- `auto` selects panes inside tmux and widget mode outside tmux. Explicit `panes` outside tmux fails.
- A mode change affects new runs only. Nested runs inherit their parent run's effective backend.
- Keep Pi's saved-session requirement. Parent print, JSON, and RPC modes remain disabled.
- Preserve ordered inbox delivery, question IDs, exact result delivery, and current pane geometry.
- A failed launch never switches to another backend. Uncertain ownership retains recovery files and blocks name reuse.
- Use short, direct text. Do not add AI attribution trailers or silent fallbacks.

## Review Focus

These five conditions require explicit tests in the tasks below:

1. A stale socket with a reused PID must fail identity checks and keep recovery files. Task 3 tests this.
2. An incomplete final view-stream line during a live write must wait for completion; a malformed complete line must report an error. Task 6 tests both.
3. A question withdrawn before the human submits an answer must not route that answer to another question. Task 7 tests this.
4. A session switch while the overlay is open must close the overlay without sending input to the old session. Task 7 tests this.
5. A narrow terminal must keep the run list and overlay usable without throwing. Task 7 tests this.

## File Map

- `src/display-mode.ts`: read, save, and resolve the session display setting.
- `src/run-backend.ts`: strict saved backend identity and explicit migration of legacy pane runs.
- `src/launch.ts`: existing pane launch, with a backend-neutral return type.
- `src/widget-launch.ts`: widget launch transaction and rollback.
- `src/widget-supervisor.ts`: local socket server, Pi RPC child ownership, and process status.
- `src/widget-client.ts`: authenticated supervisor requests and identity checks.
- `src/view-stream.ts`: durable child event records and parent projection.
- `src/conversation-viewer.ts`: run list and focused conversation overlay.
- `src/parent.ts`: common run lifecycle, recovery, stop, message, and result delivery.
- `src/child.ts`: RPC child support, human attribution, and view event hooks.
- `src/index.ts`, `src/tools.ts`, `src/ui.ts`: mode and UI wiring.
- `src/schema.ts`, `src/session-file.ts`: strict records and branch-scoped setting.
- `test/e2e/widget.test.ts`, `test/e2e/widget-harness.ts`: real non-tmux Pi scenario with the scripted provider.
- Existing `test/unit`, `test/sdk`, and `test/e2e` files: targeted regression assertions.
- `README.md`, `.agents/TEST_COVERAGE.md`: user instructions and test coverage map.

---

### Task 1: Session Mode and Legacy Schema

**Files:** Create `src/display-mode.ts`; modify `src/schema.ts`, `src/session-file.ts`, `src/child.ts`, `src/parent.ts`, `src/index.ts`, `test/unit/schema.test.ts`, `test/unit/session-file.test.ts`; create `test/unit/display-mode.test.ts`.

**Interfaces:** Produce `type DisplayMode = "auto" | "panes" | "widget"`, `type BackendKind = "pane" | "widget"`, `readDisplayMode(branch: SessionEntry[]): DisplayMode`, and `resolveDisplayMode(mode: DisplayMode, inTmux: boolean): BackendKind`. Define a strict `subagent_display_mode` custom entry. Add a `backend` field to new `RunSpec` records. Replace direct `spec.json` reads in parent and child with `readStoredRunSpec(path)`. Parse version 1 run specs only as legacy pane runs; do not treat a malformed new record as legacy.

- [ ] **Step 1: Write failing tests.** Assert `auto` resolves from tmux presence, explicit `widget` works in tmux, explicit `panes` outside tmux throws, the latest mode entry on a branch wins, a new branch reads `auto`, and a valid version 1 run spec migrates to `backend: "pane"`.
- [ ] **Step 2: Run tests and confirm failure.** Run `node --test test/unit/display-mode.test.ts test/unit/schema.test.ts test/unit/session-file.test.ts`. Expect missing mode and migration interfaces.
- [ ] **Step 3: Implement mode parsing and persistence.** Use `pi.appendEntry("subagent_display_mode", { v: 1, mode })` when the user changes mode. Keep branch folding in `src/display-mode.ts`.
- [ ] **Step 4: Run the same tests and `npm run typecheck`.** Expect both to pass.
- [ ] **Step 5: Commit.** Commit the mode and schema files with `feat: record subagent display mode`.

### Task 2: Backend Identity Without Pane Regressions

**Files:** Create `src/run-backend.ts`; modify `src/launch.ts`, `src/parent.ts`, `src/schema.ts`, `test/unit/launch.test.ts`, `test/unit/parent.test.ts`, `test/sdk/runtime.test.ts`.

**Interfaces:** Produce `type RunBackend = { kind: "pane"; pane: PaneFile } | { kind: "widget"; supervisor: ProcessIdentity; child: ProcessIdentity; socket: string }`, `readRunBackend(runDir: string): RunBackend`, and `writeRunBackend(runDir: string, backend: RunBackend): void`. New launches commit `backend.json` last. `readRunBackend` accepts a strict legacy `pane.json` only when `backend.json` is absent. Change `StartedRun` and `ParentRun` to hold `backend`.

- [ ] **Step 1: Write failing tests.** Assert a new pane run writes `backend.json`, an old valid `pane.json` reattaches, a corrupt `backend.json` never falls through to `pane.json`, and existing pane rollback still retains uncertain ownership.
- [ ] **Step 2: Run tests and confirm failure.** Run `node --test test/unit/launch.test.ts test/unit/parent.test.ts test/sdk/runtime.test.ts`.
- [ ] **Step 3: Add the backend identity union and adapt pane code.** Keep tmux verification and layout calls behind the `kind: "pane"` branch. Do not change pane geometry rules.
- [ ] **Step 4: Run the same tests and `npm run typecheck`.** Expect all assertions to pass.
- [ ] **Step 5: Commit.** Commit with `refactor: save subagent backend identity`.

### Task 3: Reconnectable Widget Supervisor

**Files:** Create `src/widget-supervisor.ts`, `src/widget-client.ts`, `test/unit/widget-supervisor.test.ts`; modify `src/schema.ts`.

**Interfaces:** `startSupervisor(spec: RunSpec, runDir: string, argv: string[], env: NodeJS.ProcessEnv): Promise<RunBackend & { kind: "widget" }>`, `connectSupervisor(backend: RunBackend & { kind: "widget" }, runId: string, ownerKey: string): Promise<WidgetClient>`, and `WidgetClient.status(): Promise<{ childAlive: boolean; exitCode: number | null; signal: string | null }>`, `WidgetClient.stop(): Promise<void>`. The supervisor owns Pi RPC stdin and stdout, sends the initial prompt once, and serves a mode `0600` Unix socket in the private run directory. Every request checks run ID, owner key, and current process identity. It writes an exit record before it exits. The existing package `src` include ships this entry.

- [ ] **Step 1: Write failing tests.** Use a fixture RPC child. Assert one initial prompt, valid reconnection, rejected wrong run or owner, stale socket with reused PID retained, a child crash exit record, and a stop that signals only the verified child.
- [ ] **Step 2: Run tests and confirm failure.** Run `node --test test/unit/widget-supervisor.test.ts`.
- [ ] **Step 3: Implement the local protocol and Pi RPC process owner.** Bound request size and response time. Report malformed RPC output as a run failure. Keep the supervisor alive while the child runs, even when the parent disconnects.
- [ ] **Step 4: Run the same tests and `npm run typecheck`.** Expect both to pass.
- [ ] **Step 5: Commit.** Commit with `feat: supervise widget subagent processes`.

### Task 4: Widget Launch and RPC Child Role

**Files:** Create `src/widget-launch.ts`, `test/unit/widget-launch.test.ts`; modify `src/child.ts`, `src/index.ts`, `src/launch.ts`, `src/parent.ts`, `test/sdk/runtime.test.ts`.

**Interfaces:** Define `WidgetLaunchContext = Omit<LaunchContext, "tmux" | "liveColumnPanes"> & { startSupervisor: typeof startSupervisor }`. Produce `launchWidgetRun(plan: LaunchPlan, context: WidgetLaunchContext): Promise<StartedRun & { backend: { kind: "widget" } }>` with the same session and prompt preparation as `launchRun`. A widget child runs in Pi RPC mode, but only a child with a valid `--subagent-run` may enable its subagent role in RPC. A parent in RPC mode stays disabled. The child uses the existing inbox, question, nested spawn, and auto-exit code.

- [ ] **Step 1: Write failing tests.** Assert no tmux calls for widget launch, exact model/tools/skills/session arguments, child role activation in RPC with a valid run spec, rejection of parent RPC mode, nested widget inheritance, and rollback after a failed supervisor start.
- [ ] **Step 2: Run tests and confirm failure.** Run `node --test test/unit/widget-launch.test.ts test/sdk/runtime.test.ts`.
- [ ] **Step 3: Extract shared launch preparation from `src/launch.ts` and implement widget launch.** Save backend choice before process start. Keep the current launch reservation and recovery-file rules.
- [ ] **Step 4: Run the same tests and `npm run typecheck`.** Expect both to pass.
- [ ] **Step 5: Commit.** Commit with `feat: launch widget subagents without tmux`.

### Task 5: Parent Monitoring, Recovery, and Result Delivery

**Files:** Modify `src/parent.ts`, `src/tools.ts`, `src/ui.ts`, `test/unit/parent.test.ts`, `test/sdk/cleanup.test.ts`; create `test/unit/widget-recovery.test.ts`.

**Interfaces:** `Runtime.spawn()` resolves the current mode and calls the matching launch. `Runtime.stop(name: string): Promise<void>` verifies the saved backend before stopping it. `Runtime.tick()` checks pane state for pane runs and supervisor plus child identity for widget runs. `Runtime.message()` resumes a finished run with the current session mode. Result classification accepts either backend exit evidence and preserves the existing statuses and delivery IDs.

- [ ] **Step 1: Write failing tests.** Assert widget reload reconnects without a second process, a lost supervisor stops a verified live child, uncertain identity retains files and reserves the name, quit reports a child that will not stop, resume uses the current mode, and one final result reaches the correct branch once.
- [ ] **Step 2: Run tests and confirm failure.** Run `node --test test/unit/parent.test.ts test/unit/widget-recovery.test.ts test/sdk/cleanup.test.ts`.
- [ ] **Step 3: Implement backend dispatch in the parent.** Keep branch ownership, result acknowledgment, unread inbox, question reporting, and pane cleanup behavior in shared paths. Show backend-specific error text.
- [ ] **Step 4: Run the same tests and `npm run typecheck`.** Expect both to pass.
- [ ] **Step 5: Commit.** Commit with `feat: recover and finish widget runs`.

### Task 6: Durable Live View Stream

**Files:** Create `src/view-stream.ts`, `test/unit/view-stream.test.ts`; modify `src/child.ts`, `src/index.ts`, `src/parent.ts`, `test/sdk/runtime.test.ts`.

**Interfaces:** Define `ViewRecord` as strict JSONL with `v`, `runId`, increasing `seq`, `messageOrdinal`, and a message or tool event. Export `appendViewRecord(runDir: string, record: ViewRecord): void` and `readViewRecords(runDir: string, afterSeq: number): ViewRecord[]`. A child writes start, update, and end records. `messageOrdinal` counts child messages after the run marker. On reconnect, the parent counts persisted messages after that marker and applies only records with a greater ordinal. Remove the stream after the final result is saved and acknowledged.

- [ ] **Step 1: Write failing tests.** Assert ordered message and tool updates, a reconnect with no duplicate completed message, an incomplete trailing JSONL line waits while the child lives and reports an error after exit, a malformed complete line reports an error, and invalid run ID or sequence reports an error.
- [ ] **Step 2: Run tests and confirm failure.** Run `node --test test/unit/view-stream.test.ts test/sdk/runtime.test.ts`.
- [ ] **Step 3: Implement child event hooks and strict view projection.** Use Pi `message_start`, `message_update`, `message_end`, and tool execution events. Keep the session and result records authoritative.
- [ ] **Step 4: Run the same tests and `npm run typecheck`.** Expect both to pass.
- [ ] **Step 5: Commit.** Commit with `feat: stream subagent conversations`.

### Task 7: Run List and Conversation Overlay

**Files:** Create `src/conversation-viewer.ts`, `test/unit/conversation-viewer.test.ts`; modify `src/ui.ts`, `src/tools.ts`, `src/index.ts`, `src/child.ts`, `src/schema.ts`, `test/unit/ui.test.ts`, `test/unit/tools.test.ts`.

**Interfaces:** Register `/subagents` to show current mode, change it, and select live or finished runs. The viewer uses `ctx.ui.custom(..., { overlay: true })`. It reads `ViewRecord` projection and child session history. It calls `Runtime.message(name, text, questionId?, origin?)` with `origin: "human"` for composer input and `Runtime.stop(name)` for confirmed stop. Add a strict human inbox item so child text identifies its sender. Model tool messages keep their current attribution.

- [ ] **Step 1: Write failing tests.** Assert run order, mode selection, scrolling and follow behavior, human message attribution, explicit question ID, withdrawn question rejection, confirmed stop, finished-run resume, overlay closure on session switch, and narrow terminal rendering.
- [ ] **Step 2: Run tests and confirm failure.** Run `node --test test/unit/conversation-viewer.test.ts test/unit/ui.test.ts test/unit/tools.test.ts`.
- [ ] **Step 3: Implement the menu, viewer, composer, and child human message type.** The widget remains display only. Closing the overlay leaves the child running. Display errors from view or control failures in the overlay.
- [ ] **Step 4: Run the same tests and `npm run typecheck`.** Expect both to pass.
- [ ] **Step 5: Commit.** Commit with `feat: interact with subagents in a viewer`.

### Task 8: End-to-End Coverage and User Instructions

**Files:** Create `test/e2e/widget-harness.ts`, `test/e2e/widget.test.ts`; modify `test/e2e/core.test.ts`, `test/e2e/lifecycle.test.ts`, `package.json`, `README.md`, `.agents/TEST_COVERAGE.md`.

**Interfaces:** The new harness starts a real parent Pi TUI in a `node-pty` terminal without `TMUX` or `TMUX_PANE` and uses the existing scripted provider. Add `node-pty` as a pinned development dependency. The harness captures parent UI and saved child files. The private-tmux harness remains the pane coverage path.

- [ ] **Step 1: Write end-to-end tests.** Assert outside-tmux `auto` launch, inside-tmux `auto` pane launch, explicit widget launch inside tmux, ordered human messages and question answers, `auto-exit: false`, stop with a `closed` result, resume, nested widget spawn, reload reconnection, new-session adoption, fork delivery, crash reporting, and one durable result. Count result IDs and inspect saved run files.
- [ ] **Step 2: Run the new tests and confirm failure.** Run `node --test test/e2e/widget.test.ts` before completing the harness, then use the scripted provider to make them pass.
- [ ] **Step 3: Update instructions.** Document `/subagents`, mode behavior, overlay keys, saved sessions, and clear failure messages. Update the test coverage map.
- [ ] **Step 4: Run verification.** Run `npm test`, `node --test test/e2e/widget.test.ts`, and `npm run test:e2e`. Expect all to pass. Check the pane layout, message, recovery, and cleanup cases named in the repo's end-to-end skills.
- [ ] **Step 5: Commit.** Commit with `test: cover widget and pane subagents`.

## Final Review

- [ ] Inspect the complete branch diff against the spec. Check strict identity, saved-session migration, mode scope, human message origin, and no silent backend switch.
- [ ] Run `git diff --check` and confirm a clean test run before making a completion claim.
- [ ] Request one whole-branch code review before integration.
