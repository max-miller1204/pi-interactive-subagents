# Subagent Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the tested foundation in HANDOFF.md section 10, step 2, without implementing the runtime.

**Architecture:** Keep strict schemas and atomic file operations separate from catalog resolution, session parsing, tmux, and launch preparation. Pin the Pi behaviors that the later runtime relies on before implementing a consumer of those behaviors. Use the approved spec as the authority when an older artifact differs.

**Tech Stack:** Node 24, TypeScript, Node test runner, TypeBox 1.3.27, Pi 0.87.1, Biome, tmux 3.3 or newer.

**Spec:** `/Users/maxmiller/pi-interactive-subagents-handoff/design/spec-v2.md`.

## Global Constraints

- Implement only the approved v2 design in `src/`. No old-code copy or compatibility layer.
- The package name is `pi-interactive-subagents` and its version is `4.0.0`.
- Pin Pi development packages to `0.87.1` and TypeBox to `1.3.27`.
- Use `realpathSync` for every stored or compared path.
- Reject unknown fields. Do not add a fallback.
- Keep module state on disk or in a runtime instance. Do not add module-level mutable state.
- Support Node 24, macOS and Linux. Require tmux 3.3 or newer.
- Use short, direct text. Never use the em dash character.
- Do not edit generated files or a changelog by hand.
- Do not change the user's global Pi files.
- All tests, lint, and type checks must pass. Do not skip failing tests.
- Do not commit with an AI attribution line.

## Review Focus

- A symlinked agent directory must not cause a path mismatch in a stored launch or session file. Test this in Task 5.
- A malformed queue file must cause an error rather than disappear from the read. Test this in Task 6.
- A duplicate real extension path reached through two spellings must fail. Test this in Task 4.
- A dead tmux pane without status or signal must fail classification. Test this in Task 7.
- A hostile environment word must round-trip without execution or expansion. Test this in Task 8.

## File map

- `package.json`, `tsconfig.json`, `biome.json`: strict package and tooling contracts.
- `scripts/check-pi-version.mjs`: installed versus invoked Pi version check.
- `scripts/run-tests.mjs`: private tmux test process and cleanup.
- `test/sdk/pinned.test.ts`, `test/sdk/harness.ts`: real Pi SDK characterization tests, with the faux provider.
- `src/schema.ts`: closed TypeBox schemas, strict JSON parsing, atomic JSON writes.
- `src/process.ts`: process identity and liveness.
- `src/config.ts`: agents, profiles, project trust and launch trust flag.
- `src/catalog.ts`: tool and skill provenance, nested resolution, launch snapshot.
- `src/session-file.ts`: child session writer, fork cut, strict branch reader, extraction, registry fold.
- `src/queue.ts`: producer-only atomic queue writes and consumer-only deletion.
- `src/tmux.ts`: strict tmux calls, pane parsing, version and socket checks.
- `src/launch.ts`: Pi argv, checked shell script, launch transaction and rollback.
- `test/unit/*.test.ts`: real behavior at each foundation boundary.

### Task 1: Package, scripts and strict tooling

**Files:** Create `package.json`, `tsconfig.json`, `biome.json`, `scripts/check-pi-version.mjs`, `scripts/run-tests.mjs`, `test/unit/tooling.test.ts`.

**Interfaces:** Produces the scripts and installed dependencies used by every later task. Consumes no project module.

- [ ] **Step 1: Write a failing tooling test.** Run the version-check script against a controlled fake `pi` on `PATH` and assert a mismatch exits nonzero with a clear error. Run the private tmux runner with a controlled failing test and assert it exits nonzero and leaves no private server. Name these tests `rejects a mismatched Pi executable` and `cleans the private tmux server after a failing test`.
- [ ] **Step 2: Verify RED.** Run `node --test test/unit/tooling.test.ts`. Expected: failures because both scripts are absent.
- [ ] **Step 3: Add package metadata from spec section 18.** Use exact scripts from that section. Pin the four Pi-related development packages at `0.87.1`, TypeBox at `1.3.27`, and concrete current versions of TypeScript, Node types and Biome. Install with `npm install` to create the lockfile. Do not install a global package.
- [ ] **Step 4: Implement the two scripts.** The version script compares `pi --version` to the installed package. The tmux runner uses `tmux -L pi-subagents-test-<pid> -f /dev/null`, traps normal exit and signals, and does not touch the default server. Apply the exact `tsconfig.json` flags in section 18. Set Biome to check source, tests and scripts.
- [ ] **Step 5: Verify GREEN.** Run `node --test test/unit/tooling.test.ts`, `npm run typecheck`, and `npm run lint`. Expected: all exit zero, and the private server is gone.
- [ ] **Step 6: Commit.** `git add package.json package-lock.json tsconfig.json biome.json scripts test/unit/tooling.test.ts && git commit -m "build: add strict package tooling"`.

### Task 2: Pin Pi 0.87 behavior before using it

**Files:** Create `test/sdk/harness.ts`, `test/sdk/pinned.test.ts`, `scripts/patch-pi-declarations.mjs`, and `test/unit/patch-pi-declarations.test.ts`. Modify `package.json` and `package-lock.json` for the approved strict NodeNext declaration patch.

**Interfaces:** Produces SDK characterization tests P1 through P15 from spec section 23. Uses Pi SDK, `fauxProvider()` from the root pi-ai export, `bindExtensions({ mode: "tui", ... })`, and temp sessions. Later tasks consume the verified Pi contracts.

- [ ] **Step 1: Write P1 through P5.** Assert committed boundary drafts and `continue`, idle `sendMessage` with both trigger values, and the distinction between a header-only session and a new session with no file. Use `getEntries()` and actual JSONL files, not mocks of session append.
- [ ] **Step 2: Write P6 through P10.** Assert input before an awaited preflight, `agent_start` after it, argv interactive input in an isolated CLI SDK/process fixture, shutdown order on session replacement, queue clearing and compaction preserving already appended entries, and prompt guideline refresh on re-registration. Record received events and inspect the actual next model request.
- [ ] **Step 3: Write P11 through P15.** Use an isolated Pi CLI for prompt-file and model fallback flags; use the bare SDK session for registered provider IDs; load `typebox` through an extension and check no defaults apply; assert `getSystemPrompt()` contains appended text. Give each P-number its own `test(...)` call.
- [ ] **Step 4: Fix Pi 0.87.1 declaration errors without hiding them.** Pin `@types/node@24.13.6` and `@modelcontextprotocol/sdk@1.30.1` as development dependencies. Write a failing test for a version-gated, idempotent install patch that checks and adds the JSON import attribute to exactly 41 Pi AI declaration files. Run the patch from `postinstall`. Test a different Pi AI version and an unexpected declaration line as failures. Never edit an installed declaration by hand.
- [ ] **Step 5: Run `npm run test:sdk`, `npm run typecheck`, `npm run lint`, and `npm run test:unit`.** Expected: 15 pinned SDK tests pass without skips, the strict NodeNext typecheck passes, and all unit and lint checks pass. If another pinned claim is false under 0.87.1, STOP. Correct `spec-v2.md` with the user before building a consumer of that claim.
- [ ] **Step 6: Commit.** `git add test/sdk test/unit/patch-pi-declarations.test.ts scripts/patch-pi-declarations.mjs package.json package-lock.json && git commit -m "test: pin Pi session contracts"`.

### Task 3: Closed schemas and strict atomic JSON

**Files:** Create `src/schema.ts`, `test/unit/schema.test.ts`.

**Interfaces:** Produces every schema and type in spec sections 5.3 and 8.2 to 8.3, `parseStrict<T extends TSchema>(schema: T, value: unknown, where: string): Static<T>`, `readJsonStrict`, `writeJsonAtomic`, `MAX_DEPTH`, `NAME_PATTERN`. Later tasks consume these exports.

- [ ] **Step 1: Write tests that reject an unknown property in `RunSpec`, a nonmatching key and invalid value in a `Rec`, and a bad JSON file that identifies its path.** Traverse all exported schema nodes and assert each object and record closes extra keys. Check a `Value.Errors` item exposes `instancePath` and `message`. Test atomic overwrite and ignored `.tmp-*` files.
- [ ] **Step 2: Run `node --test test/unit/schema.test.ts`.** Expected: RED because `src/schema.ts` does not exist.
- [ ] **Step 3: Define `Obj`, `Rec`, every schema in section 5.3, `AgentFrontmatter`, `ProfilesFile`, strict helpers and atomic tmp-plus-rename.** Use only `typebox` and `typebox/value`; use `as const` literal unions. Test `Value.Check`, then display up to three `Value.Errors` diagnostics. Do not apply defaults during parsing.
- [ ] **Step 4: Run `node --test test/unit/schema.test.ts` and `npm run typecheck`.** Expected: all pass, including the schema walk.
- [ ] **Step 5: Commit.** `git add src/schema.ts test/unit/schema.test.ts && git commit -m "feat: add strict subagent schemas"`.

### Task 4: Agent config, profiles and catalog

**Files:** Create `src/config.ts`, `src/catalog.ts`, `test/unit/config.test.ts`, `test/unit/catalog.test.ts`.

**Interfaces:** Produces `discoverAgents`, `loadProfiles`, `projectConfigAllowed`, `trustFlag`, `buildLiveCatalog`, `resolveLaunch`, and `catalogSummary`. Consumes Task 3 schemas. `resolveLaunch` accepts the catalog, agent, profile, spawner depth and allowlist, cwd and child session file, and returns a `Launch`.

- [ ] **Step 1: Write failing config tests.** Cover every frontmatter rejection in spec section 19.1, including YAML, BOM, CRLF, 33-character stem, invalid higher-precedence file, unknown and hidden names in `spawns`. Use the installed `parseFrontmatter` and real temp files. Cover all four project trust decisions and profile provider/extension validation, including `llama.cpp`.
- [ ] **Step 2: Run `node --test test/unit/config.test.ts`.** Expected: RED because config exports are absent.
- [ ] **Step 3: Implement `config.ts` with the exact precedence and error records of section 8.** Normalize optional fields after strict validation. Resolve project files only through the trust gate. Resolve profile extension paths to real paths and require the correct provider source. Do not replace an invalid higher file with a lower one.
- [ ] **Step 4: Run `node --test test/unit/config.test.ts`.** Expected: all pass.
- [ ] **Step 5: Write failing catalog tests.** Cover built-in, own extension through a symlink, external extension, inline and missing tools, skill modes and unknown names, tool extension order, two spellings of one real extension path, allowlist intersection, depth 3, nested snapshot, and fork cwd equality.
- [ ] **Step 6: Run `node --test test/unit/catalog.test.ts`.** Expected: RED because catalog exports are absent.
- [ ] **Step 7: Implement `catalog.ts` per sections 8.5 and 8.6.** Build tool provenance from `pi.getAllTools()`, skill provenance from `pi.getCommands()`, and a closed nested snapshot. Validate every reachable nested agent before launch. Reject duplicate real extension files before adding argv.
- [ ] **Step 8: Run `node --test test/unit/{config,catalog}.test.ts` and `npm run typecheck`.** Expected: all pass.
- [ ] **Step 9: Commit.** `git add src/config.ts src/catalog.ts test/unit/config.test.ts test/unit/catalog.test.ts && git commit -m "feat: resolve strict agent catalogs"`.

### Task 5: Process identity and session files

**Files:** Create `src/process.ts`, `src/session-file.ts`, `test/unit/process.test.ts`, `test/unit/session-file.test.ts`.

**Interfaces:** Produces `processIdentity`, `processAlive`, `writeChildSession`, `forkEntries`, `readBranch`, `afterMarker`, `lastAssistant`, `finalText`, `persistedIds`, `foldRegistry`. Consumes Task 3 schemas and Pi's exported `CURRENT_SESSION_VERSION`, `SessionHeader`, `SessionEntry` and pi-ai `uuidv7`.

- [ ] **Step 1: Write tests for own process identity, a dead pid, reused pid identity, and a non-ENOENT `ps` failure.** Run `node --test test/unit/process.test.ts`. Expected: RED from the absent module.
- [ ] **Step 2: Implement `process.ts`.** Run `ps -o lstart= -p <pid>` with `LC_ALL=C`. Return null only for exit code 1 with empty output. Throw on malformed output or another failure. Compare both pid and start time.
- [ ] **Step 3: Run `node --test test/unit/process.test.ts`.** Expected: all pass.
- [ ] **Step 4: Write session tests.** A symlinked directory returns a real child file path; `SessionManager.open(file)` reads its id, cwd and parent; append persists at once. Fork at a tool call excludes that assistant entry and all sibling calls. Read a branched file, reject bad middle and torn last lines, reject non-session header and missing parent, then test marker, text/token extraction and nested registry fold by own session id.
- [ ] **Step 5: Run `node --test test/unit/session-file.test.ts`.** Expected: RED from the absent module.
- [ ] **Step 6: Implement `session-file.ts` per spec section 9.** Use `writeFileSync` with `wx` and a header built from the exported type. Parse JSONL line by line, require its final newline and valid parent links, and fold only the active branch. Never call `parseSessionEntries`.
- [ ] **Step 7: Run `node --test test/unit/{process,session-file}.test.ts` and `npm run typecheck`.** Expected: all pass.
- [ ] **Step 8: Commit.** `git add src/process.ts src/session-file.ts test/unit/process.test.ts test/unit/session-file.test.ts && git commit -m "feat: track processes and child sessions"`.

### Task 6: Atomic ordered queues

**Files:** Create `src/queue.ts`, `test/unit/queue.test.ts`.

**Interfaces:** Produces `put`, `list`, `count`, `itemId`, and consumer deletion for typed inbox and outbox items. Consumes `readJsonStrict`, `writeJsonAtomic`, `InboxItem`, `OutboxItem`.

- [ ] **Step 1: Write tests for 1,000 ordered writes, invalid item JSON, a hidden temporary file, an unexpected visible filename, a bad sequence, and deletion after confirmed consumption.** Run `node --test test/unit/queue.test.ts`. Expected: RED from missing exports.
- [ ] **Step 2: Implement the spec section 5.2 queue.** Generate a padded monotonic sequence and random suffix. Write to the same directory with tmp-plus-rename. Sort lexical names. Ignore only names starting with `.`. Reject every other invalid name. The queue reader never deletes an item.
- [ ] **Step 3: Run `node --test test/unit/queue.test.ts` and `npm run typecheck`.** Expected: all pass.
- [ ] **Step 4: Commit.** `git add src/queue.ts test/unit/queue.test.ts && git commit -m "feat: add ordered disk queues"`.

### Task 7: Strict tmux adapter

**Files:** Create `src/tmux.ts`, `test/unit/tmux.test.ts`.

**Interfaces:** Produces `Tmux`, `PaneState`, `createTmux`, `tmuxSocket`, and tmux version check. A `Tmux` instance exposes `run`, `listPanes` and `capture`; launch uses its `run` calls. Consumes no other project module.

- [ ] **Step 1: Write tests for a tmux socket from `$TMUX`, six-field pane lines, status and signal parsing, malformed lines, dead pane with neither status nor signal, 3.2 rejection, 3.3 acceptance, signal termination and both no-room texts.** Use an injected exec adapter or an isolated fake binary, not the user's tmux server. Run `node --test test/unit/tmux.test.ts`. Expected: RED from missing exports.
- [ ] **Step 2: Implement `tmux.ts` per spec sections 7.1 and 7.5.** Pass `-S <socket>` on every call. Use `execFile` so nonzero exits and signals throw. Parse `list-panes -a` once per tick. Capture text only for diagnostics. Convert no-room errors into the specified message.
- [ ] **Step 3: Run `node --test test/unit/tmux.test.ts` and `npm run typecheck`.** Expected: all pass.
- [ ] **Step 4: Commit.** `git add src/tmux.ts test/unit/tmux.test.ts && git commit -m "feat: add strict tmux adapter"`.

### Task 8: Launch script and transaction

**Files:** Create `src/launch.ts`, `test/unit/launch.test.ts`.

**Interfaces:** Produces `piInvocation`, `renderLaunchScript`, `piArgs`, and `launchRun`. Consumes `Launch`, `RunSpec`, `Tmux`, `processIdentity`, session writer and strict JSON helpers.

- [ ] **Step 1: Write script tests.** Execute generated `launch.sh` in a private temp directory against a stub Node executable that prints argv and env. Assert exact round trips for apostrophes, newlines, `$()`, backticks and `BASH_FUNC_f%%`, no shell execution, self-delete, and the calling pane's `TMUX` and `TMUX_PANE`. Assert NUL, a 200 KiB word and over 786432 total bytes fail before a file write.
- [ ] **Step 2: Run `node --test test/unit/launch.test.ts`.** Expected: RED from the absent module.
- [ ] **Step 3: Implement `piInvocation`, `piArgs`, validation and `renderLaunchScript` per section 7.** Launch the parent's Node and CLI script only. Validate every word by byte size. Build `env -i` and shell-quote every word. Use `wx` and mode `0o700`.
- [ ] **Step 4: Run `node --test test/unit/launch.test.ts`.** Expected: script tests pass.
- [ ] **Step 5: Add transaction tests for exact tmux call order, pane focus, identity check, `pane.json` written last, and rollback after a failed or disposed await.** Run the focused tests. Expected: RED because `launchRun` is absent.
- [ ] **Step 6: Implement `launchRun` per section 7.6.** Reserve the name first, write files before the pane, create the empty pane before enabling remain-on-exit and respawning, check `disposed` after each await, then commit pane and registry. On failure kill the pane, remove new files and reservation, and preserve both the primary and kill errors.
- [ ] **Step 7: Run `node --test test/unit/launch.test.ts`, `npm run typecheck` and `npm run lint`.** Expected: all pass.
- [ ] **Step 8: Commit.** `git add src/launch.ts test/unit/launch.test.ts && git commit -m "feat: prepare and start child launches"`.

### Task 9: Foundation integration gate

**Files:** Modify only the foundation files if a test exposes a real defect. No runtime files in this plan.

**Interfaces:** Consumes every prior task. Produces a green foundation for the runtime plan.

- [ ] **Step 1: Run `npm test`.** Expected: Pi version, typecheck, lint, all unit tests and all 15 pinned SDK tests pass. Fix a failing behavior with a new RED test before code.
- [ ] **Step 2: Run `npm run test:e2e` only after an E2E suite exists.** At this stage the script must fail loudly if no E2E tests exist. Do not claim E2E coverage in the foundation.
- [ ] **Step 3: Request a fresh review of the branch against `spec-v2.md`, especially the five Review Focus cases and every ledger ruling.** Fix Critical and Important findings with a failing test first and rerun `npm test`.
- [ ] **Step 4: Commit verified fixes.** `git add src test scripts package.json package-lock.json && git commit -m "fix: close foundation review findings"` only when there are changes. Report deferred minor findings.

## Self-review notes

The old `module_plan.json` and `test_plan.json` describe v1 queue state and delivery. They are not the authority. This plan uses `spec-v2.md`, includes `process.ts` even though HANDOFF step 2 omits it, and defers `delivery.ts` and all runtime behavior to HANDOFF step 3. The P7, P11 and P12 CLI observations need an isolated Pi process even though the other pinned tests use the in-process SDK. If a pinned observation fails, implementation pauses for a spec correction rather than adding a fallback.
