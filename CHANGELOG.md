# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
