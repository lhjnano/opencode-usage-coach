# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-07-08

### Added
- **Domain knowledge base migrated to ladybugDB** (graph DB). NDJSON flat-file storage
  replaced with embedded property-graph (`@ladybugdb/core`, Kuzu successor). Cypher
  `MATCH` queries replace full-file `CONTAINS` scans — relationship traversal 13–60×
  faster. All public helpers wrapped in timeout guard (`UC_DOMAIN_TIMEOUT_MS`, default 5s).
- **`domain-db-optimization.md`**: performance rationale, schema docs, LadybugDB benchmarks,
  optimization headroom (full-text index, n-hop, vector search).

### Changed
- Docs reorganized: `ROADMAP.md`, `roadmap-audit.md`, `competitor-analysis.md`,
  `domain-db-design.md`, `domain-db-optimization.md`, `learning-loop-design.md` moved to
  `docs/` directory. Root level keeps only `README.md` and `CHANGELOG.md`.
- `.gitignore` cleaned up: removed stale individual entries, added
  `docs/ROADMAP.md` + `docs/roadmap-audit.md`.
- `package.json`: removed duplicate `dependencies` block, added `trustedDependencies`
  for `@ladybugdb/core`.

### Fixed
- LadybugDB `Connection.query()` return type handled as `any` (upstream typings incomplete).
- Automatic NDJSON → ladybugDB migration on first open (best-effort, never double-imports).

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
