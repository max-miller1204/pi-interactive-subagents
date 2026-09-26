---
name: e2e-widget-and-display-mode
description: Use when changing subagent display mode, the /subagents menu, the conversation viewer, or widget launch, interaction, recovery, and result delivery.
---

# Test widget and display mode

Run from the repository root. The tests start real Pi processes with a scripted provider. The widget tests use a private terminal without tmux. The core test uses a private tmux server.

```sh
npm run check:pi-version
node --test test/e2e/widget.test.ts
node scripts/run-tests.mjs --isolated-tmux --test --test-concurrency=1 test/e2e/core.test.ts
```

Check the TAP output for these cases:

| Case | Evidence |
| --- | --- |
| `outside tmux auto starts an interactive widget and delivers one result` | `backend.json` says `widget`, no pane file exists, and the result arrives once. |
| `explicit widget mode starts a widget inside tmux` | `/subagents` shows `Mode: auto`, then `Mode: widget`. Launch adds no tmux pane. |
| `widget viewer sends a human message to an interactive child` | The child session records the human source and reply. Stop produces a `closed` result. |
| `widget viewer answers a child question` | The viewer shows the question ID. The saved `ask_question` tool result contains the selected answer and question ID. |
| `reload reconnects the viewer to the same widget child` | The saved backend identity stays the same. |
| `finished widget resumes in widget mode with one new result` | Resume keeps the selected backend and produces one result. |
| `nested subagent inherits widget mode` | The nested run uses the widget backend. |
| `widget child crash reports one crashed result` | The parent records one crashed result. |

For a changed mode or viewer behavior, extend the relevant end-to-end case. Check the saved backend, child session, and result ID as well as the rendered text. If a mode change affects active runs, add an assertion that the active run keeps its backend. If persistence changes, check the mode after `/reload`.

If a change affects `auto` inside tmux or pane selection, also use `e2e-pane-layout-and-nesting` and check that a pane run keeps its geometry.

For Linux verification, build the Docker image and run the focused widget file without network access:

```sh
docker build -f test/evidence/Dockerfile -t pi-subagents-widget-demo .
docker run --rm --init --network none pi-subagents-widget-demo node --test test/e2e/widget.test.ts
```

Run `npm test && npm run test:e2e` before claiming full local coverage. Run `npm run test:docker` before claiming full Docker coverage. The Docker image build needs network access for `npm ci`; the test run uses no network API.
