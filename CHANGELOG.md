# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
