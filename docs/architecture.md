# Architecture

## Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    opencode (1 terminal)                      │
│                                                               │
│  ┌──────────────┐   ┌──────────────────┐   ┌──────────────┐ │
│  │  Server mod  │   │   TUI module     │   │  Agent mode  │ │
│  │ (index.ts)   │   │  (tui.tsx)       │   │ (harness.md) │ │
│  │              │   │                  │   │              │ │
│  │ SENSE quota  │   │ Reads state.json │   │ Triages req  │ │
│  │ DECIDE coach │←──│ Renders sidebar  │   │ generate     │ │
│  │ ACT gate     │   │ (SolidJS)        │   │ grade        │ │
│  │ Harness tools│   └──────────────────┘   │ revise       │ │
│  └──────┬───────┘                          └──────────────┘ │
│         │ state files                                        │
│         ▼                                                    │
│  ~/.cache/opencode-usage-coach/                              │
│  ├── state.json          (quota + coaching)                  │
│  ├── projects/<hash>/                                       │
│  │   ├── <sessionID>/harness.json  (task states)             │
│  │   ├── nodes.ndjson              (domain DB)               │
│  │   ├── edges.ndjson              (domain graph)            │
│  │   ├── rules.md                  (learning loop)           │
│  │   ├── impl-notes.md             (impl notes)              │
│  │   └── failures.ndjson           (failure records)         │
│  └── pipeline.log                                        │
└─────────────────────────────────────────────────────────────┘
```

## Server module (`src/index.ts`)

SENSE → DECIDE → ACT closed loop:

1. **SENSE**: Background fetch of quota windows via `codexbar` CLI (60s TTL cache, never blocks).
2. **DECIDE**: `coach(quota)` maps quota percentages to GO/THROTTLE/STOP + actionable advice.
3. **ACT**:
   - `tool.execute.before` hook: gates harness tools on quota + agent mode.
   - System prompt injection: coaching text for the harness agent.
   - Custom tools: `harness_start`, `unknown_scan`, `reverse_interview`, `generate`,
     `generate_batch`, `grade`, `task_update`, `harness_done`, learning loop tools.

### Key design principles

- **Defensive**: top-level try/catch, every hook wrapped, never breaks opencode.
- **Model-aware**: detects session model + provider, skips quota for free models.
- **Per-directory state**: each project dir gets isolated state/harness/domain files.

### Harness loop

```
harness_start → unknown_scan (diagnosis gate) → [reverse_interview] →
  for each task:
    task_update(generating) → generate → task_update(grading) → grade →
    PASS → completed | FAIL → revise (2x) → failed → learning loop
→ harness_done
```

### Diagnosis gate

`harness_start` sets `scanRequired=true`. `unknown_scan` sets `scanDone=true` + `scanSummary`.
`generate`/`generate_batch` check the gate: if scan was required but not done, a warning is
injected into the sub-session prompt. Scan findings are auto-injected when available.

### Learning loop

```
grade FAIL (revisions exhausted)
  → record_failure (→ failures.ndjson)
  → investigate (root-cause via generator)
  → verify_diagnosis (verify via grader)
  → generalize (→ rules.md)
  → next generate call includes the new rule
```

### Domain knowledge base

Local graph store (`nodes.ndjson` + `edges.ndjson`). Nodes are facts/patternns/limits;
edges connect them (returns, depends-on, related-to, etc.). Queried by `generate`,
`unknown_scan`, and `reverse_interview` to inject known facts into prompts. Graph traversal
via BFS (`traverseNeighborhood`, `queryDomainGraph`) up to maxDepth hops. Worm GC: nodes track
`lastAccessed`/`accessCount`, evicted by age (180 days) or size (100k nodes).

## TUI module (`src/tui.tsx`)

SolidJS panel in `sidebar_footer`. Reads `state.json` (quota) and `harness.json` (tasks) via
polling (3s interval). Renders:

- Quota header: `usage-coach [ok/free/STOP] {model}` + 5h/1w bars (paid models only).
- Harness section: task list with live status, step count, elapsed time. Hidden when
  `active=false` (completed) or stale (>30min abandoned).

**Key lessons**: never install `solid-js` in config dir; TUI plugins must be compiled + loaded
via `tui.json`; `codexbar` must be called via `spawn` (BunShell leaks to TUI).

## Server ↔ TUI communication

Separate processes communicating via state files. No IPC, no shared memory. The server writes
JSON; the TUI reads it on a polling interval.
