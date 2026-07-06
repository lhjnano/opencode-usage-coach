# opencode-usage-coach

A closed-loop usage coach and harness for [OpenCode](https://opencode.ai). Built for
flat-rate / quota-metered coding plans where USD cost is meaningless, so it tracks
**quota windows (5h / weekly / monthly)** and turns them into coaching + loop control.
Provider-agnostic — configure via `harness.config.json`.

Existing plugins only *display* usage. This one **senses quota → coaches → stops/advances
the loop** — and ships a harness agent mode.

## What it does

**Always-on guardian (plugin):**
- Senses provider quota windows via the `codexbar` CLI (config-driven — any provider codexbar knows).
- On STOP threshold: blocks tool calls (`tool.execute.before` throws) → the agent self-stops.
- Injects coaching (how to use right now) into the system prompt (double defense).
- Surfaces a sidebar panel: per-provider quota meters + harness task states + coaching.
- Defensive: any plugin error never breaks opencode.

**Harness (agent mode, 1 terminal):**
- The `usage-coach-harness` agent triages each request — trivial → do directly;
  unclear → clarify; substantive → generate→grade→revise→advance.
- Multi-model via plugin tools `generate`/`grade`: run the configured generator/grader model
  (from `harness.config.json`) in a new session on the same server — no second terminal.
- Reports progress via `task_update` → the sidebar panel shows live task states.
- **Triggering the harness:** the agent auto-triages — trivial work is done directly,
  substantive multi-step work enters the generate→grade loop. For reliable triggering,
  explicitly ask "run this through the harness" or "use the harness for this". The harness
  tools are only available when the harness agent mode is active (see Install).

## Requirements
- opencode (tested on 1.17.13) with a quota-metered provider configured.
- `codexbar` CLI with your provider key wired (e.g. `codexbar config set-api-key --provider zai --stdin`).

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
printf '%s' "$YOUR_PROVIDER_API_KEY" | codexbar config set-api-key --provider <id> --stdin
```

### 3. Harness config — `harness.config.json` (role → model) ★ the main one
Place in the **work directory**. Each role runs on its model, so per-model quota is tracked
(works for local LLMs — they show 0%).
```jsonc
{
  "generator":     "opencode/deepseek-v4-flash-free",  // model that produces the work
  "grader":        "opencode/mimo-v2.5-free",           // model that grades it
  "provider":      "",                                   // codexbar quota provider ("" = default)
  "lighterModel":  ""                                    // suggested when throttling
}
```
| Field | Default | Notes |
|---|---|---|
| `generator` | **required** | any `provider/model` opencode knows |
| `grader` | falls back to `generator` | can differ (multi-model) |
| `provider` | `""` (codexbar default) | which provider's quota the guardian watches |
| `lighterModel` | `""` | shown in throttle advice; env `UC_LIGHTER_MODEL` overrides |

`generator` is **required** — the tools return a clear error if missing. Copy
`harness.config.example.json` to get started (both example models are free → never gated).

### 4. Env vars (thresholds / tuning)
| Var | Default | Meaning |
|---|---|---|
| `UC_STOP_5H` | 92 | 5h window STOP % (blocks tools) |
| `UC_THROTTLE_5H` | 70 | 5h window throttle % |
| `UC_STOP_WEEKLY` | 95 | weekly STOP % |
| `UC_THROTTLE_WEEKLY` | 85 | weekly throttle % |
| `UC_STOP_MONTHLY` | 98 | monthly STOP % |
| `UC_LIGHTER_MODEL` | (config `lighterModel`) | suggested model when throttling |
| `UC_PROVIDER` | (config `provider`) | codexbar provider for the guardian |
| `UC_TTL_MS` | 60000 | quota cache TTL (ms) |
| `UC_DEBUG` | 0 | set to `1` for a diagnostic log at `~/.cache/opencode-usage-coach/coach.log` |

## Architecture
- **Server module** (`src/index.ts`) — SENSE/DECIDE/ACT + custom harness tools. Loaded via `opencode.json`.
- **TUI module** (`src/tui.tsx`) — SolidJS, reads a state file, renders into `sidebar_footer`/`home_footer`. Loaded via `tui.json`. Bundled with `tsup` + `esbuild-plugin-solid`, solid kept **external** (resolves to opencode's bundle — avoids the duplicate-instance crash). Exports `{ tui }` (a bare function is misread as a server plugin).
- server↔TUI communicate via a state file (`~/.cache/opencode-usage-coach/*.json`) — they are separate processes.

**Key lessons (hard-won):** never install `solid-js` in the config dir (conflicts with
opencode's bundled solid); TUI plugins must be compiled + loaded via `tui.json` file path;
`codexbar` must be called via `spawn` (the `$` BunShell leaks output to the TUI).

## Troubleshooting

Recurring issues and fixes — mostly learned the hard way during development.

### TUI panel missing or harness not shown
- **Check `tui.json` points at the `dist/tui.js` file path** — not the `plugins/` directory.
  ```jsonc
  // ~/.config/opencode/tui.json
  { "$schema": "https://opencode.ai/tui.json", "plugin": ["/abs/path/dist/tui.js"] }
  ```
- **Do NOT install `solid-js` in the config dir** — conflicts with opencode's bundled solid, causes a crash. Keep it peer + external only.
- **Export must be `{ tui }`** (an object) — a bare function is misread as a server plugin.
- **Color prop is `fg`** (not `foreground`): `style={{ fg: theme.current.success }}`.
- **Call `codexbar` via `spawn`** — the `$` BunShell leaks command output into the TUI.
- **Harness not visible?** The TUI scans session subdirectories for the most recent `active:true` harness. A finished harness (`active:false`) is hidden.

### LLM model selection (generate/grade)
- **`generator` is required in `harness.config.json`** — the tools return a clear error if missing (the old z.ai fallback was removed in v0.2.4).
- Format: `"provider/model"` (e.g. `"opencode/deepseek-v4-flash-free"`, `"opencode/mimo-v2.5-free"` — see `harness.config.example.json`).
- **Config precedence**: workdir `harness.config.json` > global `~/.config/opencode-usage-coach/harness.config.json`.
- Omitting `grader` falls back to `generator`. If neither is set, the grade tool returns FAIL + guidance.
- `provider` (quota source) and `lighterModel` (suggested on throttle) are also configurable in the same file.

### Parallel harness execution (generate_batch)
- **Only INDEPENDENT tasks should be batched** — dependent tasks (B needs A) require sequential `generate` calls.
- `generate_batch` runs each task in a separate sub-session on the same server (shared model config).
- runModel polls the sub-session until `idle`/`completed` (max 10 min). Trace with `UC_DEBUG=1`:
  ```
  runModel(<generator>): session xxx created, prompt 142 chars
  runModel(<generator>): poll 3s status="running"
  runModel(<generator>): done 48s, 1203 chars
  ```
- `(no output)` means the sub-session returned no text. Check `~/.cache/opencode-usage-coach/coach.log` for the runModel trace (requires `UC_DEBUG=1`).
- **Note**: runModel only terminates on explicit `idle`/`completed` status. An earlier bug broke on `!status` (undefined) immediately — fixed.

### Multi-session (per-session state isolation)
- Each opencode session has a unique sessionID; harness state is isolated per-session:
  ```
  ~/.cache/opencode-usage-coach/projects/<dir-hash>/<sessionID>/harness.json
  ```
- Different working directories get separate project state (keyed by path hash).
- The TUI auto-discovers the most recent `active:true` harness — switching sessions shows that session's harness.
- Harness completion sets `active:false` → hidden from the TUI.
- Override the state path with `UC_STATE_DIR` (forces global state).

## Status
- ✅ Quota guardian + TUI panel (per-provider coach view, colors, collapsible Alt+H)
- ✅ Harness: agent mode (triage) with generate/grade model-specific tools (1 terminal, multi-model)
- ✅ npm packaging (`opencode plugin install opencode-usage-coach`)

License: MIT.
