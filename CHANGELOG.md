# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.0] - 2026-07-11

### Fixed
- **`coach(NaN)` silently returned GO.** `NaN >= threshold` is always `false` in JS, so invalid quota
  data (NaN usedPercent from malformed API responses) bypassed all STOP/THROTTLE thresholds and
  produced a GO decision. Added `Number.isNaN` guard → returns THROTTLE with 0 values.
- **`barFill(NaN)` / `barEmpty(NaN)` bypassed the `p <= 0` guard.** `NaN <= 0` is `false`, so NaN
  propagated through `Math.max/min` and `"█".repeat(NaN)` coerced to `""`, hiding the progress bar
  entirely. Added `!Number.isFinite(p)` check to both functions.
- **`providerToCodexbar("-openai")` returned `""`.** `"-openai".split("-")[0]` = `""`, silently losing
  the provider name. Now falls back to the full provider string when the first segment is empty.
- **`isHarnessVisible` treated `active=undefined` as visible.** Changed from `h.active === false` to
  `h.active !== true` — an incompletely initialized harness is now hidden.

### Added
- **`question` tool.** Two-phase interactive question gate: presents questions to the user, then stores
  answers. `checkScanGate` is now 3-stage: (1) scan not done → warning, (2) unresolved questions →
  prompt to ask them, (3) resolved → answers injected into generate prompt.
- **`parseQuotaResponse` exported as pure function.** Extracted from inline closure in
  `fetchQuotaWithRetry` — no longer depends on `spawnSync`. Enables direct unit testing.
- **`lastKnownQuota` cache.** Successful quota fetches are cached and used as fallback on transient
  failures, preventing the TUI from flickering to `-2` on a single network blip.
- **`fetchQuotaWithRetry`.** 3 attempts with 1s/2s exponential backoff before giving up.
- **Harness termination on missing generator.** `generate` / `generate_batch` now set `h.active=false`
  when no generator model is configured, instead of leaving the harness stuck in "generating" forever.
- **`taskQuotaPct` loading vs failed labels.** TUI shows `…` for loading (-1) and `retry` for failed
  (< -1), instead of always `0%`.
- **Wall-clock timeout for `runModel`.** `WALL_TIMEOUT_MS` (default 30 min, override via
  `UC_WALL_TIMEOUT_MIN`) aborts hung sub-sessions even if step counting fails.
- **`pollerDone` guard in `runModel`.** Prevents stale `setInterval` callbacks from writing to
  harness.json after the prompt has resolved or timed out. Fixes the "subElapsed 49000s" zombie poller
  bug where aborted generate calls left a poller running forever.

### Changed
- **`coach(null)` returns `weekly: -2`** (fetch failed), distinct from `-1` (still loading). This lets
  the TUI distinguish "retrying" from "first load" states.
- **254 tests** (up from 180). New test files:
  - `test/adversarial.test.ts` (74 tests): exception-path coverage — NaN, Infinity, null, undefined,
    empty strings, malformed JSON, corrupt state files, boundary conditions. Found 4 real bugs (fixed).
  - `test/tool-lifecycle.test.ts` (16 tests): integration — gate enforcement, state transitions,
    concurrency stress, stale detection.
  - `test/tui-render.test.ts` (76 tests): staleness thresholds, progress bars, task status rendering,
    visibility rules.
- **`src/tui-logic.ts`** extracted: pure rendering functions (computeStaleness, isHarnessVisible,
  computeTaskDisplay, barFill, barEmpty, taskQuotaPct, computeHarnessRender) separated from tui.tsx
  for testability.

## [0.8.5] - 2026-07-10

### Fixed
- **unknown_scan find output leaking to TUI.** `input.$` (BunShell) was used to run `find` for
  codebase profiling — its stdout leaked into the opencode TUI, flooding it with file listings
  (including `~/.zai/` log files). Switched to `spawnSync` (same pattern as the codexbar fix).
  Added `spawnSync` to imports.

## [0.8.4] - 2026-07-10

### Changed
- **README rewritten** (269 → 93 lines). Clean open-source style: badges (npm, license, coverage,
  Ko-fi, GitHub Sponsors), Features bullet list, Quick Start, links to docs/ for detail.
- **docs/ restructured**: Unknowns Matrix design docs (3 files) removed. README detail sections
  moved to `docs/architecture.md`, `docs/configuration.md`, `docs/troubleshooting.md`.

### Added
- `.github/FUNDING.yml` (Ko-fi: lhjnano, GitHub Sponsors: lhjnano).
- README badges: npm version, license, coverage (planned), Ko-fi, GitHub Sponsors.

## [0.8.3] - 2026-07-09

### Added
- **TUI staleness detection.** Abandoned harnesses (interrupted without `harness_done`) are
  detected via `updatedAt` + `STALE_MS` (5 min). Non-terminal tasks show `STALE` label.
  After `HIDE_MS` (30 min), the entire harness section is hidden. Prevents stale "generating"
  tasks from showing forever when a session is abandoned.
- **Completed harness hiding.** `h.active !== false` check added — `harness_done()` sets
  `active=false`, and the TUI now hides completed harnesses instead of leaving them visible.

## [0.8.2] - 2026-07-09

### Added
- **Diagnosis gate (enforcement, not advisory).** `harness_start` sets `scanRequired=true` in
  harness.json. `unknown_scan` sets `scanDone=true` + `scanSummary`. `generate`/`generate_batch`
  call `checkScanGate()` — if scan was required but not done, a `⚠ DIAGNOSIS GATE` warning is
  injected into the sub-session prompt. If scan was done, findings (`scanSummary`) are injected
  so the sub-session knows about blind spots without manual copying. Does NOT block (revisions
  and trivial tasks can skip), but forces conscious choice over forgetfulness.
- `buildScanSummary()`: compact summary of unknown unknowns + implicit knowledge + questions.
- `checkScanGate()`: returns `{ warning, summary }` based on harness.json scan flags.
- **Rules**: "Diagnose before acting" + "unknown_scan is mandatory" written to rules.md.
- **Agent definition**: step 2 changed from "PRE-FLIGHT (advisory)" to "DIAGNOSIS GATE (REQUIRED)".
  Added "Diagnose before acting" as first rule.
- **Design doc** (`docs/unknown-scan-design.md` §4): updated from advisory to enforced design.

### Changed
- `harness_start` return message: `⚠ DIAGNOSIS GATE — unknown_scan is REQUIRED` (was advisory).
- `HarnessJson` type: added `scanRequired?`, `scanDone?`, `scanSummary?` fields.
- `writeUnknownScan()`: now also sets `scanDone=true` and `scanSummary`.

## [0.8.1] - 2026-07-09

### Changed
- **generate_batch resilience.** `Promise.all` → `Promise.allSettled` (one rejection no longer
  kills the entire batch). Failed tasks are automatically retried sequentially (once). If retry
  also fails, `[usage-coach NEXT]` directs the orchestrator to fall back to sequential `generate()`.

## [0.8.0] - 2026-07-09

### Added
- **Unknowns Matrix tools** (3 tools implemented in `src/index.ts`):
  - `unknown_scan`: pre-flight gap analysis — scans codebase, queries domain graph, runs model-assisted
    gap analysis, stores findings to domain DB, returns structured report. 5-phase pipeline.
  - `reverse_interview`: stateful Q&A — generates priority-ranked questions, records answers,
    completes with summary. Graph-enhanced question prioritization via `queryDomainGraph`.
  - `impl_notes`: `<impl-notes>` XML extraction from generate output → `impl-notes.md` + domain DB
    nodes (confidence 0.5) + edge promotion. `IMPL_NOTE_INSTRUCTION` injected into all generate calls.
- **Domain graph functions** (`src/domain.ts`):
  - `traverseNeighborhood()`: multi-hop BFS (bidirectional, maxDepth, maxNodes cap, cycle-safe).
  - `queryDomainGraph()`: keyword-match seeds → BFS-expand neighbors. Drop-in superset of `queryDomain`.
  - `writeEdges()`: batch edge append (single syscall).
  - New Relation types: `related-to`, `includes`, `references`.
  - `distance?` field on DomainNode (transient, not persisted).
- **Helper functions**: `parseFileList`, `buildGapPrompt`, `parseGapAnalysis`, `formatReport`,
  `writeUnknownScan`, `extractKeywords`, `extractImplNotes`, `readImplNotes`, `readImplNotesByGraph`,
  `appendImplNotes`, `linkImplNoteToDomain`, `readInterview`, `writeInterview`, `completeInterview`.
- **Design docs**: `unknown-scan-design.md`, `reverse-interview-design.md`, `impl-notes-design.md`.

## [0.7.1] - 2026-07-09

### Added
- **Step limit enforcement.** `runModel` monitors sub-session assistant turns via a watchdog
  poller (every `UC_WATCHDOG_POLL_MS` = 3s). If turns exceed `UC_MAX_STEPS` (default 30), the
  session is aborted and the caller is told to split the task. Prevents runaway tasks from
  burning quota.
- **Sub-session observability.** Watchdog poller writes live progress (step count, elapsed time)
  to `harness.json` → TUI displays `step:N` and `Ns` per task. Warning color when elapsed > 300s.
- `updateSubSession()` / `clearSubSession()`: harness.json task fields for live TUI progress.

## [0.7.0] - 2026-07-09

### Added
- **Model-aware quota tracking.** `resolveAgent()` detects the session's model + provider from
  `client.session.get`. `isFreeModel()` short-circuits quota fetch for free models (provider
  `opencode` or model name contains `free`). `providerToCodexbar()` maps opencode provider IDs
  (e.g. `zai-coding-plan`) to codexbar provider names (e.g. `zai`).
- **Model change detection.** `modelChanged` flag bypasses TTL cache for immediate quota refresh
  when the session switches models.
- `tool.execute.before` now calls `resolveAgent` on ALL tools (not just harness tools), so the
  quota panel always reflects the current model.

### Changed
- **TUI display**: free model → `usage-coach [free] {model}` (one line). Paid model →
  `usage-coach [ok] {model}` + quota bars. Model name in `textMuted` color.
- **Agent gating removed**: quota panel always visible (was hidden for non-harness agents).
- **`active` check removed** from harness section (completed harnesses stay visible). *(Note:
  partially reverted in 0.8.3 — completed harnesses now hidden.)*
- `state.json`: now includes `model`, `provider`, `isFree`, `agent` fields.

## [0.6.2] - 2026-07-09

### Fixed
- Revert of v0.6.1 (broken state). Restores v0.6.0 behavior.

## [0.6.1] - 2026-07-09

### Changed
- *(Reverted in v0.6.2 — broken state.)*

## [0.6.0] - 2026-07-08

### Changed
- ladybugDB migration groundwork, docs reorganization. Consolidated design docs under `docs/`.

## [0.5.0] - 2026-07-08

### Added
- **Domain-DB worm (GC).** Domain nodes now track `lastAccessed`/`accessCount` (touched on
  every `queryDomain`); `evictStale` drops stale + caps size, run on each `session.idle`.
  Keeps the domain knowledge base from growing unbounded with stale/forgotten facts.
  Configurable via env:
  - `UC_WORM_MAX_AGE_DAYS` (default **180** ≈ 6 months) — drop nodes not accessed in N days
  - `UC_WORM_MAX_NODES` (default **100000**) — cap node count, evict oldest-accessed beyond it
- New domain helpers: `touchNodes`, `evictStale`, `writeNodes`. Tests for access tracking
  and time/size eviction.

## [0.4.0] - 2026-07-08

### Added
- **Agent-mode scoping.** Harness tools (`generate`, `generate_batch`, `grade`, `investigate`,
  `verify_diagnosis`, `generalize`, `record_failure`, `harness_start`, `task_update`,
  `harness_done`) and quota system-prompt coaching are now restricted to the
  `usage-coach-harness` agent mode. Other modes (build, general, custom agents) get **no** harness
  tools and **no** quota injection — they stay completely clean. Controlled by `UC_HARNESS_AGENT`
  (default `Usage-Coach-Harness`, case-insensitive, comma-separated for multiple modes).
- **ESLint** (flat config) + `lint` / `lint:fix` scripts. TypeScript + Solid.js rules.

### Fixed
- **`agents/usage-coach-harness.md` missing 5 tool permissions.** `generate_batch`,
  `investigate`, `verify_diagnosis`, `generalize`, `record_failure` were absent from the agent's
  `permission` allowlist — so even the harness mode couldn't use them. All 10 harness tools are
  now explicitly allowed in that mode (and only that mode).
- Lint cleanup: removed unused `DEBUG`/`HARNESS_FILE`/`TICON`/`short`, fixed
  `no-useless-assignment` initializers, simplified a Solid slot callback to a single return.

### Changed
- **`tool.execute.before`** now (1) resolves the session's agent via `client.session.get` and
  rejects non-harness modes, then (2) applies the STOP quota gate. General tools (read/edit/bash/
  grep/task) are never gated in any mode. Result: the `[opencode-usage-coach] QUOTA…` system-prompt
  line and harness tool availability no longer leak into other agent modes.

## [0.3.5] - 2026-07-07

### Fixed
- **Hard gate scoped to harness tools only.** STOP quota previously blocked ALL tools (read/edit/bash/grep) in ALL agent modes — now only blocks harness tools (generate/grade/investigate/etc.) that consume model quota. General tools work freely even at STOP.
- **Sub-session cleanup**: `session.remove` → `session.delete` (correct SDK method). Sub-sessions (uc-harness-sub) no longer pile up in `/session`.

### Added
- `session.summarize` called before sub-session delete — logs activity summary to coach.log for visibility.

### Changed
- TUI: monthly (mo) gauge removed — rarely hits limits, reduces clutter.

## [0.3.4] - 2026-07-07

### Added
- **Learning loop tools (Stages 1-4)**: `record_failure` (→ failures.ndjson), `investigate` (root-cause via generator), `verify_diagnosis` (verify via grader), `generalize` (→ rules.md). Stage 5 (reference: generate reads rules.md) landed in 0.3.3.
- **grade FAIL NEXT** now points to the learning loop when revisions are exhausted (record_failure → investigate → verify_diagnosis → generalize → failed).

### Fixed
- **TUI session isolation**: opencode TUI `ctx` does NOT carry `session_id` (only `theme`). The panel now reads the current session from `api.route.current.params.sessionID` and shows only that session's harness. Previously fell back to a broad scan → other sessions' harnesses leaked in.
- **TUI task title**: full title shown (was truncated to 12 chars with `…`).
- **TUI quota display**: shows `n/a` when quota data is unavailable (was showing -1%).
- **TUI task elapsed time**: shows seconds in current status (e.g. `gen 30s`).
- TUI: `appendFileSync` was missing from imports → all debug logging silently failed. Fixed.

## [0.3.3] - 2026-07-07

### Changed
- **runModel rewritten — polling removed.** Per SDK docs, `session.prompt()` blocks until the sub-session completes and returns the `AssistantMessage` directly. Previous versions polled `session.messages()` (because we wrongly assumed prompt returned immediately), which caused duplicate waiting and frequent `Tool execution aborted`. Now runModel just reads the response parts — simpler, faster, abort-resistant.
- `generate` now prepends accumulated rules (`rules.md`) to the prompt — Stage 5 of the learning loop. Empty at first; grows as failures are analyzed.

### Added
- Learning loop design (`learning-loop-design.md`) — 5 stages: Record → Investigate → Verify → Generalize → Reference. Plus a domain knowledge base extension (declarative learning, connected/graph storage, structure TBD).
- `readRules()` / `rulesFile()` / `failuresFile()` helpers (Stage 5 reference + Stage 1 record plumbing).
- `task_update` records `startedAt`; TUI shows elapsed time per task (e.g. `gen 30s`).
- TUI session isolation: panel shows the **current session's** harness only (no cross-session leakage).
- TUI task quota now reads from coaching `state` (was always 0% — `h.quotas` was never populated).
- README: "generate aborted" troubleshooting (platform tool timeout), updated multi-session section.
- ROADMAP P3 expanded to "Accumulated judgment" — procedural (rules.md) + declarative (domain DB).

## [0.3.2] - 2026-07-06

### Added
- **Deterministic harness loop via NEXT directives.** `harness_start`, `generate`, and `grade` each append a `[usage-coach NEXT]` line telling the agent exactly what to call next. The agent follows NEXT instead of improvising the sequence — closer to a deterministic state machine (Agent-Factory-Coordinator style).
- **harness_start distinguishes INDEPENDENT (parallel via `generate_batch`) vs DEPENDENT (sequential) tasks** — parallel was accidentally dropped when the deterministic sequence was introduced; now restored as PATH A.
- README: "Prompting the harness" section (triggering, independent vs dependent, NEXT directives, quota-aware).

### Changed
- `generate` return value appends `[usage-coach NEXT] call task_update(grading) + grade`.
- `grade` return value appends NEXT based on verdict (PASS→completed, FAIL→revise/failed).

## [0.3.1] - 2026-07-06

### Added
- **P1: quota-aware harness tools.** `generate` and `generate_batch` now read the live quota decision and adjust automatically — no agent judgment needed for model selection:
  - **GO** → strong generator, `generate_batch` runs all tasks in parallel.
  - **THROTTLE** → auto-switch to `lighterModel` (if configured), `generate_batch` caps concurrency at 2.
  - **STOP** → `generate_batch` refuses and directs the agent to halt the loop.
- `agents/usage-coach-harness.md`: quota-aware loop strategy guidance (agent picks task size/parallelism, tools pick the model).

### Changed
- `.gitignore`: also exclude `roadmap-audit.md` and `competitor-analysis.md` (strategy docs, like ROADMAP.md).

## [0.3.0] - 2026-07-06

### Fixed
- **Harness loop now works end-to-end.** Root cause: `session.status` does not track sub-sessions (returns the main session's state), so `runModel` never detected completion → infinite poll → timeout. Switched to **messages-based polling** — watch for the assistant reply text directly.
- `runModel` session id extraction: `data.info.id` → `data.id` fallback (the response has no `info` wrapper).
- TUI harness panel: added fallback to most-recent active harness when `ctx.session_id` is empty/mismatched (was showing nothing in multi-session).

### Added
- `runModel` returns diagnostic strings (`ERROR: ...`) on failure instead of `null` — no longer need `UC_DEBUG` to see why a sub-session failed.
- Always-on file logging (`coach.log`) — no longer gated on `UC_DEBUG=1`.
- `grade` tool normalizes the verdict: enforces `PASS`/`FAIL` on the first line even if the grader model doesn't follow the format.
- README: Troubleshooting section (TUI / model selection / parallel execution / multi-session), harness trigger docs, provider-agnostic examples.
- `agents/usage-coach-harness.md`: clarified `generate_batch`, file verification after generate, error handling for TIMEOUT/ERROR.

### Removed
- Stale `taskTimeoutMs` / `maxRevisions` / `parallel` config fields and `UC_TASK_TIMEOUT_MS` / `UC_MAX_REVISIONS` env vars (were documented but never read by code).

## [0.2.5] - 2026-07-06

### Fixed
- `runModel` early exit on undefined status — loop now breaks only on explicit idle/completed/error.
- TUI harness path mismatch (session-scoped harness discovery).
- Normalize grader verdict to strict `PASS`/`FAIL`.

### Added
- `runModel` observability logging (`UC_DEBUG=1`).
- README Troubleshooting section, harness trigger docs, provider-agnostic examples.
- Agent guidance for `generate_batch`, file verification, and error handling.

## [0.2.4] - 2026-07-05

### Changed
- Provider-agnostic config: `provider`/`lighter`/`generator`/`grader` are config-driven (removed z.ai model hardcoding).

### Removed
- Dead config (`taskTimeoutMs`, `maxRevisions`, `UC_TASK_TIMEOUT_MS`, `UC_MAX_REVISIONS`).
- Killed prototypes (`reference/`) and stale tarball.
- `PLAN.md` (absorbed into README + ROADMAP).

## [0.2.3] - 2026-07-05

### Fixed
- `runModel` now waits for the agent loop — polls `session.status` until idle before reading the final assistant message. (`session.prompt` returns only the first response; tool-use loops continue server-side, so file writes now complete.)
