# Widget and Pane Subagents Design

## Goal

Let a Pi user run and interact with subagents with or without tmux. Inside tmux, panes remain the default. Outside tmux, a widget and conversation viewer provide the interaction. Both modes keep the existing agent profiles, nested spawn rules, saved sessions, messages, questions, and result delivery.

The user can choose widget mode inside tmux. A mode change affects new runs. A running subagent keeps the mode it started with.

## User experience

The session setting has three values: `auto`, `panes`, and `widget`. The default is `auto`. It selects panes when Pi runs inside tmux and widget mode when Pi runs outside tmux. An explicit `panes` selection outside tmux fails with a clear error. The setting belongs to the current Pi session and survives reload and resume. A new session starts at `auto`. Nested subagents inherit the effective mode of their parent run.

The existing status widget remains above the editor. It shows the same run states in both modes. `/subagents` opens a run list and displays the current mode. The user can change the mode there. Selecting a run opens a live conversation overlay. The overlay shows messages and tool activity, follows new content until the user scrolls up, and lets the user return to the latest content. It shows open questions. A composer sends a human message or answers a selected question. A confirmed stop action stops a live run. Finished runs remain available from the current session branch so the user can read the conversation and resume by sending a new message.

Pane users can still work in the child Pi terminal. The overlay is an additional way to inspect and message a pane run. Widget mode does not embed the child's terminal or expose its terminal commands and keybindings.

The design follows the status widget, run list, and conversation viewer pattern in [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents#ui). This project retains its own run lifecycle and message protocol.

## Runtime architecture

Each run has one saved launch definition and one backend identity. The backend is either a verified tmux pane or a supervised Pi process. The backend kind is saved with the run. Launch, recovery, monitoring, stop, result creation, and cleanup dispatch on that saved kind. The parent does not infer a run's backend from its current environment.

Pane launches keep their existing terminal and layout behavior. Widget launches start Pi in a separate process through its RPC interface. A local supervisor owns the RPC connection and records the child's process identity. The parent connects to the supervisor for process control. The supervisor remains reachable across a Pi extension reload. Its local socket permits only the current user, and each request must match the saved run and owner identity. The child process keeps its saved Pi session and the existing subagent extension, including its inbox, question, and result rules.

The child extension writes a durable view stream for both backends from Pi message and tool events. Each record has a run ID and sequence number. The parent uses the stream to update the status widget and conversation overlay. On reconnect, it rebuilds the overlay from the saved session and then consumes newer view records. The parent removes view records after it has saved and acknowledged the final result. The view stream is display data. The Pi session and run records remain the source of truth for completion and result delivery. The viewer shows a clear error if a live run's stream is invalid or missing. It does not report a successful result from display data.

Human messages and question answers from the overlay use the existing ordered inbox and acknowledgment path. They retain human attribution in the child conversation. Model tool messages retain parent-agent attribution. A stop request verifies the saved backend identity before it signals a child. Closing the overlay does not stop the child.

## Lifecycle and recovery

The parent records the selected backend before starting a child. A launch that fails before ownership is known cleans up its own files. A launch with uncertain process or pane ownership keeps its recovery files and reports the exact problem. It never starts a second child for the same run name to hide that uncertainty.

On reload, the parent reattaches to pane runs through verified pane identity and to widget runs through the supervisor and saved process identity. The parent reconciles inbox, outbox, status, and result records before it resumes UI updates. A temporary loss of the viewer does not end a live child. If the supervisor dies while the child lives, the parent stops the verified child and reports the failure. If it cannot prove the child's identity, it keeps the recovery files and blocks another run with the same name. A lost child produces a visible failure result after identity checks. A result is delivered once to the correct parent session branch.

On normal quit, the parent stops both backend types, waits for the child to finish, records undelivered messages and open questions, and reports any process it could not stop. Session switch, fork, and resume use the same branch and run ownership rules as pane mode. A finished child can resume with its saved agent, profile, tools, model, and session. The new run uses the current session mode setting.

Widget mode supports `auto-exit: false`. The child remains available for human messages after a model turn. A confirmed stop ends that run and delivers its final result. For `auto-exit: true`, the existing completion rule remains in force.

The runtime stays limited to Pi's interactive TUI with a saved session. Print, JSON, and parent RPC modes do not gain the `/subagents` UI. A widget child may use Pi RPC internally without changing this parent-mode rule. No mode silently changes to another backend after a launch failure.

## Acceptance checks

- Outside tmux, `auto` starts a widget run. Inside tmux, `auto` starts a pane run. An explicit mode uses only that backend.
- The run list and conversation overlay display live and finished runs in both modes. The overlay shows messages and tool activity in order.
- A human can send messages, answer the intended question, stop a run, and resume a finished run in widget mode. Existing pane interaction still works.
- Nested runs use their parent's effective mode and keep current depth and allowlist limits.
- Reload reconnects to a live widget run. Quit, fork, session switch, and resume preserve the current delivery and ownership rules.
- A child crash, supervisor crash, failed launch, invalid view record, and failed cleanup each produce a clear status. None silently starts a replacement child.
- Each run result is durable and delivered once. Unread messages and open questions are reported accurately.

## Test strategy

Add a non-tmux end-to-end runner that uses the repository's scripted provider. Check widget launch, message order, question ID routing, stop, resume, reload, crash, and exact result delivery. Assert both visible UI state and saved run records. Keep the private-tmux tests for pane layout, nested launches, recovery, and cleanup. Add unit tests for mode resolution, backend identity validation, view record framing, and overlay input. Run the repository's version check, typecheck, lint, unit tests, SDK tests, and end-to-end suites before release.
