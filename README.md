# pi-interactive-subagents

Interactive subagents for [Pi](https://pi.dev).
Each subagent runs in a tmux pane or a Pi conversation viewer.
The parent starts it and keeps working.
The result comes back later as a message.
A status line above the editor shows each live subagent.

```text
● scout-1  scout  working  0:12  18.2k
✓ worker-1  worker  done  1:04  22.0k
```

This package is version 4.0.0.
It needs Pi 0.87.

## Requirements

Install Pi 0.87.
Install tmux 3.3 or newer if you want pane mode.
Use a saved Pi session.
Do not pass `--no-session`.
A different Pi version stops Pi at startup with this error:

```text
pi-interactive-subagents 4 needs Pi 0.87. This Pi is <version>. Install Pi 0.87, or update pi-interactive-subagents.
```

Print mode and JSON mode turn subagent tools off.
RPC mode turns them off for the parent. A widget child uses RPC mode to run its task.
Pi shows one notice that names the reason.

## Install

Run this command:

```sh
pi install git:github.com/max-miller1204/pi-interactive-subagents
```

Restart Pi after the install.
Load this package only once.
Do not also load an older copy of the same package.

## Quick start

Create `~/.pi/agent/subagent-profiles.json`.
Put at least one profile in it.

```json
{
  "profiles": {
    "quick": {
      "model": "provider/model-id",
      "thinking": "low",
      "guidance": "Prefer a short, direct result."
    }
  }
}
```

Replace `provider/model-id` with a model that this Pi can use.
`thinking` must be a level that model supports.
The allowed levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

Start Pi in a terminal.
Ask Pi to spawn the bundled `scout` agent with the `quick` profile.
Pi opens a tmux pane when tmux is active. Otherwise, Pi starts a widget child.
Pi returns the result in the parent session.

Run `/subagents` to view a child conversation or change the display mode.
The mode applies to new subagents in the current Pi session.
`auto` is the default. It uses panes inside tmux and the widget outside tmux.
Choose `widget` to use the conversation viewer inside tmux.
Choose `panes` to require tmux. A launch outside tmux then fails with an error.
Changing the mode does not move a running subagent.

In the `/subagents` menu, select a run to open its conversation.
Type a message and press Enter to send it to the child.
Press Tab to choose an open question before you send an answer.
Press Ctrl-X, then `y`, to stop the child.
Press Esc to close the viewer. The child keeps running.
Use PgUp, PgDn, and End to move through the conversation.

## Tools

`subagent` starts a subagent and returns at once.
`subagent_message` steers a running subagent, answers its question, or resumes a finished subagent.
`subagents_list` prints the agents, profiles, and runs you can use.
`ask_question` is available only inside a subagent.
A subagent uses it to wait for a decision from the parent.

### subagent

Required fields are `agent`, `task`, and `profile`.
Optional fields are `name` and `cwd`.

```text
subagent({
  agent: "scout",
  task: "Find the files that parse the session header.",
  profile: "quick",
  name: "header-scout"
})
```

`agent` is the agent file name without `.md`.
`task` is the full task.
A standalone subagent sees only that text.
`profile` selects the model and the thinking level.
`name` must match `^[a-z0-9][a-z0-9-]{0,39}$`.
When you omit `name`, Pi uses `<agent>-1`, then `<agent>-2`, and so on.
`cwd` must be an existing directory.
The default is the current directory.
Unknown fields are rejected.

The tool returns as soon as the subagent starts.
Do not poll, sleep, or call `subagents_list` to wait.
End the turn.
The result starts a new turn.

### subagent_message

Required fields are `name` and `message`.
The optional field is `question_id`.

```text
subagent_message({
  name: "header-scout",
  message: "Also check the fork path."
})
```

A message to a live subagent waits until that subagent can read it.
A message to a finished subagent resumes it in the current display mode.
Resume keeps the original tools, extensions, skills, model, thinking level, and prompt.
Pass `question_id` to answer one open question.
The id looks like `q-1a2b3c4d`.
When several questions are open, pass `question_id`.
When one question is open, a message without `question_id` answers that question.

### subagents_list

Call it with `{}`.
It lists agents you may spawn, invalid agent files, ignored project agents, profiles, live subagents, and finished subagents on this branch.

### ask_question

A subagent calls `ask_question({ question })` and waits.
The parent receives a `subagent_question` message.
Answer with `subagent_message` and the question id.
Use `ask_question` only when the subagent cannot continue without a parent decision.
An open question keeps the subagent from exiting.

## The /subagent command

Type `/subagent <agent>` in the Pi editor.
You can add the task on the same line.
Pi asks you to pick a profile.
When the task is missing, Pi asks you to type it.
Cancel either prompt to make no change.
The command starts the same launch as the `subagent` tool.
It does not start a model turn.
At the root session, `/subagent` can start an agent that has `disable-model-invocation: true`.
The model cannot start that agent with the `subagent` tool.

## Agent files

Pi reads agent files from three places.
A higher place replaces a lower place with the same name.
An invalid higher file still replaces the lower file.
Pi does not fall back to the lower file.

1. Package agents in this package. This is the lowest place.
2. User agents in `~/.pi/agent/agents/`.
3. Project agents in `.pi/agents/`. Pi reads these only when the project trust gate is open.

The file name is the agent name.
Use 1 to 32 characters.
Use only lowercase letters, digits, and dashes.
The name must end in `.md`.
Any other `.md` name in an agents directory is an error.

This package ships `scout` and `worker`.
`scout` can read files.
`worker` can edit files and can spawn `scout`.

```markdown
---
description: Read files and report focused findings.
tools: [read, grep, find, ls]
skills: none
spawns: []
session: standalone
auto-exit: true
system-prompt: append
---
Read the files needed for the task. Do not change files. Report relevant paths and findings to the parent agent.
```

| Field | Required | Meaning |
| --- | --- | --- |
| `description` | yes | One line, from 1 to 300 characters. |
| `tools` | yes | Tool names the subagent may use. Names match `^[A-Za-z0-9_-]+$`. |
| `skills` | no | `none`, `all`, or a list of skill names. The default is `none`. |
| `spawns` | no | Agent names this agent may spawn. The default is none. |
| `session` | no | `standalone` or `fork`. The default is `standalone`. |
| `auto-exit` | no | `true` or `false`. The default is `true`. |
| `system-prompt` | no | `append` or `replace`. The default is `append`. |
| `disable-model-invocation` | no | `true` hides the agent from the model. The default is `false`. |

The body is the system prompt.
An empty body is an error.
Do not list `subagent`, `subagent_message`, `subagents_list`, or `ask_question` in `tools`.
The extension adds those tools when the subagent may use them.
An agent cannot list itself in `spawns`.
Every name in `spawns` must be a known agent that the model may start.
Unknown fields are errors.
Pi shows each error once at session start.
`subagents_list` shows the same errors.
A spawn of that agent name throws the error.

Agent file changes apply at the next session start.
That includes a new session, a resume, and `/reload`.

## Profiles

A profile is required for every spawn.
Put profiles in `~/.pi/agent/subagent-profiles.json`.
A trusted project file `.pi/subagent-profiles.json` replaces the user file.
When neither file exists, spawn fails and names both paths.

```json
{
  "profiles": {
    "quick": {
      "model": "provider/model-id",
      "thinking": "low",
      "guidance": "Prefer a short, direct result."
    },
    "local": {
      "model": "extension-provider/model-id",
      "thinking": "off",
      "guidance": "Use the local model.",
      "extensions": ["./extensions/local-provider.ts"]
    }
  }
}
```

`model` is `provider/id`.
Pi must already have that model.
`thinking` must be one of the levels that model supports.
`guidance` is required text.
Pi shows it in the tool guidelines.
`extensions` holds paths to provider extensions.
Resolve each path from the profile file directory.
Store and load the real path.
Add `extensions` only when an extension registers that provider.
`llama.cpp` is a built-in Pi provider.
A `llama.cpp` profile must not set `extensions`.
The parent Pi must load every provider extension that a profile uses.
Unknown fields are errors.

Profile changes apply at the next session start.

## Sandbox

A child starts with `--no-extensions`.
Pi then adds one `-e` path for each extension the child needs.
`--tools` lists only the tools in the agent file, plus the subagent tools the child may use.
A tool that is not in that list is not active.
Each listed tool must already be loaded in the parent.
A built-in tool needs no extension path.
A tool from another extension adds that extension's real path.
An inline tool cannot be given to a child.
Pi throws and names the tool.

`skills: none` loads no skills.
`skills: all` loads every skill the parent can see.
A list loads those skill names only.
An unknown skill name throws.

The trust flag is `--approve` or `--no-approve`.
The child gets `--approve` when its working directory is the parent directory and the parent project is trusted.
Otherwise the child gets `--approve` only when that directory is already trusted in Pi's project trust store.

A loaded extension still runs all of its hooks.
`--tools` hides the extension's other tools.
This sandbox is not a boundary against a hostile extension.

## Session modes

`standalone` starts a new child session.
The child sees the task text.
It does not see the parent conversation.

`fork` copies the parent branch into the child session.
The copy stops before the delegation call.
A fork must use the parent directory.
The parent must be idle when you fork.

## Nested subagents

A child can spawn only the agents in its `spawns` list.
That list is also limited by the parent's allowlist.
The maximum depth is 3.
Depth 1 is a child of the root session.
A subagent at depth 3 has no spawn tools.
A spawn past depth 3 throws.

## Lifecycle

`auto-exit: true` closes the subagent when it finishes a normal turn.
It stays open while a question is unanswered, a nested subagent is still running, a message is still unread, or a delivery is still in progress.
An abort or a tool call does not close it.
A fatal startup error closes it with a failed result.

Set `auto-exit: false` when a human should keep the subagent open.
The parent receives the result when the human stops the subagent.
If a human types into an `auto-exit: true` pane, auto-exit turns off for that run.
A message sent from the widget viewer also turns auto-exit off for that run.

A question blocks inside `ask_question`.
The subagent cannot exit with that question still open.
Escape in the subagent withdraws the question.
A late answer to a withdrawn question arrives as a normal parent message.

The result message includes the final text, the status, the duration, and the context size.
A cut result names the child session file.
Unread parent messages are listed in the result.
Open questions at the end are listed in the result.
A message that arrives after the exit decision stays in that unread list.
It is not delivered to the child.

Statuses:

| Status | Meaning |
| --- | --- |
| `completed` | The subagent finished a normal reply. |
| `error` | The model returned an error. |
| `aborted` | The turn was interrupted. |
| `crashed` | The process exited with a code or a signal. |
| `closed` | The subagent was stopped. |
| `no_output` | The process ended with no assistant reply. |
| `failed` | The subagent could not start. |

A `closed` result for `auto-exit: false` is the normal human ending when the subagent has final text.

## Reload, new, resume, fork, and quit

`/reload`, `/new`, `/resume`, and `/fork` do not stop children.
The new runtime reads the run files and reconnects to the live subagents.
Results still arrive.
A result for a run that this session does not know yet is adopted.
The name stays usable with `subagent_message`.

`/tree` to a point before a spawn hides that name on the branch.
The live subagent stays up and can still deliver.

Only a real quit stops children.
Quit stops each verified child.
Each child then stops its own children.
Pi writes a line to stderr that names the stopped subagents.
Open the same session again.
You see one notice.
Resume a stopped subagent by name with `subagent_message`.
A result that was ready but not delivered is in that notice.

If quit happens before the session has any assistant reply, Pi says the session was not saved.
The stderr line then lists the child session files.

A parent crash does not quit the children.
Each child stays open. A pane child shows an error.
You can continue work in the pane or reopen the widget viewer after recovery.
Parent messaging and auto-exit stop.
Session switching and forking remain blocked.
The next Pi startup records the stopped runs.
Open the parent session to see the notice.

## Project trust

Pi ignores `.pi/agents` and `.pi/subagent-profiles.json` until this folder has a trust decision.
Run `/trust` in that project.
Until you do, session start warns that project subagent files are ignored.
A spawn of a project-only agent name throws and tells you to run `/trust` first.
User agents and package agents stay available.

## Files on disk

Run state is under `~/.pi/agent/subagent-runs/`.
The directory mode is `0700`.
Each owner process has a directory under `owners/`.
Each run has a directory under that owner.

| File | Role |
| --- | --- |
| `spec.json` | The launch record. The child reads it at startup. |
| `backend.json` | The selected pane or widget backend and its process identity. |
| `launch-state.json` | The launch phase used to clean incomplete runs after restart. |
| `system-prompt.md` | The child system prompt. |
| `launch.sh` | The pane command. It deletes itself after it starts. |
| `pane.json` | A legacy pane record. New runs use `backend.json`. |
| `widget-start-*.json` | The private widget supervisor start request. |
| `widget-ready.json` | The supervisor and child identities and socket path. |
| `widget-exit.json` | The child exit code or signal. |
| `view.jsonl` | A bounded stream of child conversation updates for the viewer. |
| `inbox/` | Messages from the parent to the child. |
| `outbox/` | Questions from the child to the parent. |
| `questions/` | Open questions. |
| `status.json` | `starting`, `working`, or `waiting`, plus question and human flags. |
| `fatal.json` | The startup or child timer error. |
| `result.json` | The result waiting for delivery. |
| `delivery-ack.json` | Proof that the result was saved while backend cleanup is still pending. |

Quit and crash recovery files are in `subagent-runs/undelivered/<sessionId>/`.
Pi deletes a queue file only after the receiving session has saved that delivery.
The child session file stays after the run directory is removed.

To debug a run, read `spec.json`, `status.json`, `fatal.json`, and `result.json`.
Then read the child session file named in the result.
A bad JSON file throws and names its path.
Do not delete a run directory while its pane or process is still alive.
An incomplete run with a verified `preparing` or `cleanup-confirmed` phase is removed at startup.
An attempted launch without `backend.json` needs manual recovery.
Pi reports its run directory and reserves its name until the pane and process are checked.
An older run without `launch-state.json` also needs manual recovery.
After manual cleanup, reload Pi to clear the reservation.

## Limits

The sandbox stops at extension granularity.
A parent crash leaves children open in their current sessions.
The parent cannot receive messages from those subagents until it restarts.
A message sent after the child decides to exit is listed, not delivered.
A prompt that starts with `/` can race one delivery.
A prompt preflight longer than 30 seconds can race one delivery.
A result that is ready during a session switch can land in the session you leave.
It stays in that session.
A new parent session keeps records in memory until its first assistant reply.
Quit reports that case.
A task plus its environment cannot exceed 768 KiB.
One command word cannot exceed 128 KiB.
Children of one pane share one column.
A full column fails with an error.
Scrollbar layout is not supported.
Agent and profile edits apply at the next session start.
Windows is not supported.

## Development

Use Node 24.
Install dependencies with `npm ci`.
The pinned Pi packages are 0.87.1.

| Command | Action |
| --- | --- |
| `npm run check:pi-version` | Compare `pi --version` with the installed Pi package. |
| `npm run typecheck` | Run strict TypeScript. |
| `npm run lint` | Run Biome. |
| `npm run test:unit` | Run unit tests. |
| `npm run test:sdk` | Run in-process Pi tests with the faux provider. |
| `npm test` | Run the version check, typecheck, lint, unit tests, and SDK tests. |
| `npm run test:e2e` | Run end-to-end tests on a private tmux server. |
| `npm run test:docker` | Build a Linux image and run both suites with networking disabled. |
| `EVIDENCE_DIR=artifacts/recording npm run test:record` | Record an asserted Pi and tmux workflow. |

Project-local [end-to-end test skills](.agents/TEST_COVERAGE.md) map each feature to its private-tmux checks. Pi discovers the skills in `.agents/skills/`.

`npm run test:e2e` starts `tmux -L pi-subagents-test-<pid>`.
It does not use your default tmux server.
It stops that private server when the run ends.
The end-to-end tests use a scripted faux model.
They do not call a paid model.

The Docker command requires a running Docker engine.
The image uses a pinned Node 24 base and `npm ci`.
The build needs network access to install packages.
The tests run without network access.
The build context excludes local settings, credentials, and generated artifacts.

The recording command requires VHS, FFmpeg, ttyd, and tmux on `PATH`.
Create the output parent directory first, for example with `mkdir -p artifacts`.
Set `EVIDENCE_DIR` to a directory that does not exist.
The test saves an MP4, a screenshot, terminal captures, checkpoints, and session files.
It checks questions, reload recovery, result delivery, nested panes, steering, crash reporting, and descendant shutdown.
It records real Pi processes with scripted model responses.
It does not test a live model service or prove every possible app behavior.

GitHub Actions runs `npm ci`, installs the pinned Pi command, then runs `npm test` and `npm run test:e2e`.
The jobs use Ubuntu 24.04 and macOS.
Ubuntu uses apt tmux.
macOS uses Homebrew tmux.

## Migration from 3.x

Version 4 rejects unknown agent fields.
An old field makes that agent file invalid.
There is no compatibility reader.
Update each agent file before you rely on it.
The profile file `subagent-profiles.json` keeps the same `profiles` object.

| 3.x field | 4.0 replacement |
| --- | --- |
| `name` | Remove it. The file name stem is the agent name. |
| `description` | Keep it. |
| `tools` | Keep the names as a YAML list. Remove `safe_bash`. Do not list subagent tool names. |
| `model` | Remove it. Set `model` in a profile. |
| `thinking` | Remove it. Set `thinking` in a profile. |
| `cwd` | Remove it. Pass `cwd` to `subagent` when the directory differs. |
| `session-mode` | Replace it with `session`. Use `standalone` or `fork`. |
| `subagent_agents` | Replace it with `spawns` as a YAML list. |
| `skill-policy` | Remove it. |
| `available-skills` | Remove it. Put the names in `skills`. |
| `skills` | Use `none`, `all`, or a YAML list of names. |
| `system-prompt` | Keep `append` or `replace`. |
| `auto-exit` | Keep it. |
| `interactive` | Remove it. Stall notices are gone. Use `auto-exit: false` when a human works in the pane. |
| `disable-model-invocation` | Keep it. |
| `cli` | Remove it. Only Pi runs. |

`lineage-only` is removed.
Use `standalone` or `fork`.
`safe_bash` is removed.
The activity recorder and stall recovery are removed.
`researcher` is not bundled.
`config.json` subagent settings are removed.
Global compatibility registries are removed.

`skills: all` is explicit.
The old default skill policy was `all`.
The new default is `none`.
Set `skills: all` on an agent that should keep the old open skill behavior.

A profile whose provider comes from an extension must list that extension in `extensions`.
Built-in providers must not set `extensions`.

## Acknowledgements

The original idea comes from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents).
