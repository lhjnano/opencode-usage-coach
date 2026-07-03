# opencode-usage-coach

A closed-loop usage coach and harness for [OpenCode](https://opencode.ai). Built for
flat-rate coding plans (e.g. z.ai / GLM) where USD cost is meaningless, so it tracks
**quota windows (5h / weekly / monthly)** and turns them into coaching + loop control.

Existing plugins only *display* usage. This one **senses quota → coaches → stops/advances
the loop** — and ships a harness agent mode + a deterministic orchestrator.

## What it does

**Always-on guardian (plugin):**
- Senses z.ai quota windows via the `codexbar` CLI.
- On STOP threshold: blocks tool calls (`tool.execute.before` throws) → the agent self-stops.
- Injects coaching (how to use right now) into the system prompt (double defense).
- Surfaces a sidebar panel: quota meters + harness task states + per-model token usage.
- Defensive: any plugin error never breaks opencode.

**Harness (two ways):**
- **Agent mode** (`usage-coach-harness`): triages each request — trivial → do directly;
  unclear → clarify; substantive → generate(delegate)→grade(delegate)→revise→advance.
  Conversation-driven, no file required. Adaptive (best-effort).
- **Deterministic script** (`harness.ts`): `tasks.txt` + `rubric.md` → guaranteed loop.
  Reliable for batch jobs. Tracks per-model tokens, auto-splits on timeout.

## Requirements
- opencode (tested on 1.17.13) with a z.ai coding-plan provider configured.
- `codexbar` CLI with the z.ai key wired (`codexbar config set-api-key --provider zai --stdin`).

## Install (from npm)
```jsonc
// ~/.config/opencode/opencode.json  (server plugin)
{ "plugin": ["opencode-usage-coach"] }

// ~/.config/opencode/tui.json        (TUI panel)
{ "$schema": "https://opencode.ai/tui.json", "plugin": ["opencode-usage-coach/tui"] }
```
Drop `agents/usage-coach-harness.md` into `~/.config/opencode/agents/` for the agent mode.

## Local dev / install (without npm)
```bash
bun install
bun run build          # -> dist/index.js, dist/tui.js (solid external)
# server plugin
cp dist/index.js ~/.config/opencode/plugins/opencode-usage-coach.js
# TUI plugin — point tui.json at the built file (NOT the plugins/ dir)
#   ~/.config/opencode/tui.json: { "plugin": ["/abs/path/dist/tui.js"] }
```

## Config

This plugin has **four config surfaces**. Only the first two are required to run.

### 1. Install config (where opencode loads the plugin from)
```jsonc
// ~/.config/opencode/opencode.json — server plugin (guardian + harness tools)
{ "plugin": ["opencode-usage-coach"] }            // from npm, OR a local path:
// { "plugin": ["/abs/path/dist/index.js"] }

// ~/.config/opencode/tui.json — TUI panel (MUST point at the built dist/tui.js)
{ "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/abs/path/dist/tui.js"] }

// ~/.config/opencode/agents/usage-coach-harness.md — agent mode (copy from agents/)
```
> The TUI file MUST be loaded via `tui.json` file path (not the `plugins/` dir), and MUST be
> the compiled `dist/tui.js` (raw `.tsx` / installing `solid-js` crashes opencode).

### 2. codexbar (quota data source)
```bash
printf '%s' "$Z_AI_API_KEY" | codexbar config set-api-key --provider zai --stdin
```

### 3. Harness config — `harness.config.json` (role → model) ★ the main one
Place in the **work directory** beside `tasks.txt`/`rubric.md`. Each role runs on its model,
so per-model quota is tracked (works for local LLMs — they show 0%).
```jsonc
{
  "generator":     "zai-coding-plan/glm-5.1",   // model that produces the work
  "grader":        "ollama/llama3",              // model that grades it
  "taskTimeoutMs": 1800000,                       // per-task timeout (on exceed: auto-split)
  "maxRevisions":  2                              // revise attempts before giving up
}
```
| Field | Default | Notes |
|---|---|---|
| `generator` | `UC_MODEL` | any `provider/model` opencode knows |
| `grader` | `UC_MODEL` | can differ from generator (multi-model) |
| `taskTimeoutMs` | `1800000` (30m) | exceed → task split into subtasks |
| `maxRevisions` | `2` | FAIL → revise → re-grade, up to N times |

Missing roles fall back to `UC_MODEL`. Provider for quota is derived from the model id
(`zai-coding-plan/...` → `zai`, `ollama/...` → `ollama`).

### 4. Env vars (thresholds / tuning)
| Var | Default | Meaning |
|---|---|---|
| `UC_STOP_5H` | 92 | 5h window STOP % (blocks tools) |
| `UC_THROTTLE_5H` | 70 | 5h window throttle % |
| `UC_STOP_WEEKLY` | 95 | weekly STOP % |
| `UC_THROTTLE_WEEKLY` | 85 | weekly throttle % |
| `UC_STOP_MONTHLY` | 98 | monthly STOP % |
| `UC_LIGHTER_MODEL` | glm-4.5-air | suggested model when throttling |
| `UC_PROVIDER` | zai | codexbar provider for the guardian |
| `UC_TTL_MS` | 60000 | quota cache TTL (ms) |
| `UC_MODEL` | zai-coding-plan/glm-5.1 | harness fallback model |
| `UC_TASK_TIMEOUT_MS` | 1800000 | harness per-task timeout (overridden by config) |
| `UC_MAX_REVISIONS` | 2 | harness revise attempts (overridden by config) |
| `UC_DEBUG` | 0 | set to `1` for a diagnostic log at `~/.cache/opencode-usage-coach/coach.log` |

## Architecture
- **Server module** (`src/index.ts`) — SENSE/DECIDE/ACT + custom harness tools. Loaded via `opencode.json`.
- **TUI module** (`src/tui.tsx`) — SolidJS, reads a state file, renders into `sidebar_footer`/`home_footer`. Loaded via `tui.json`. Bundled with `tsup` + `esbuild-plugin-solid`, solid kept **external** (resolves to opencode's bundle — avoids the duplicate-instance crash). Exports `{ tui }` (a bare function is misread as a server plugin).
- server↔TUI communicate via a state file (`~/.cache/opencode-usage-coach/*.json`) — they are separate processes.

Key lessons (see `PLAN.md`): never install `solid-js` in the config dir (conflicts with
opencode's bundled solid); TUI plugins must be compiled + loaded via `tui.json` file path;
`codexbar` must be called via `spawn` (the `$` BunShell leaks output to the TUI).

## Status
- ✅ M0–M2 quota guardian + TUI panel
- ✅ M3 harness: agent mode (triage) + deterministic script (per-model tokens, auto-split)
- ⏳ M4 npm packaging

License: MIT.
