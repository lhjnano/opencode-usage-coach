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

**Learning from failures (learning loop):**
- When `grade` returns FAIL, the harness enters a learning cycle: `record_failure` → `investigate` (root-cause analysis) → `verify_diagnosis` → `generalize` (extract a reusable rule).
- Rules accumulate in `rules.md` → the next `generate` call automatically includes them → the harness avoids repeating the same mistake.
- Tools: `record_failure`, `investigate`, `verify_diagnosis`, `generalize`.

**Domain knowledge base:**
- `investigate` and `generate` query a local domain DB before running — known facts are injected into the prompt ("Known facts from domain DB: ...").
- Unknown domains are investigated (webfetch/docs) and stored as graph nodes/edges → accumulates over time → evidence-based judgments instead of speculation.
- Storage: `nodes.ndjson` + `edges.ndjson` under the project state dir.

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

## Prompting the harness

How to trigger and use the harness loop for substantive work.

### Triggering
With the harness agent mode active (`agents/usage-coach-harness.md` installed), ask for substantive work — explicitly or just describe a multi-step task:
- `"run this through the harness: write CONTRIBUTING.md from git log"`
- `"harness: add TypeScript strict mode across the repo"`
- Or just describe the work; the agent triages and enters the loop.

Trivial requests (a one-line fix, a direct answer) are done directly — the loop only runs when generate→grade adds value.

### Independent vs dependent tasks
The harness picks the loop path based on task dependency:
- **Independent** (task B doesn't need A's output) → `generate_batch` runs all tasks in **parallel** (faster). Example: `"CONTRIBUTING.md, PR template, issue template"` — three separate docs.
- **Dependent** (B needs A) → **sequential** `generate` calls. Example: `"1) schema, 2) migration, 3) API"` — each needs the prior.

### Deterministic NEXT directives
Each tool appends a `[usage-coach NEXT]` line to its return value, telling the agent exactly what to call next:
- `generate` → NEXT: grade the work
- `grade` PASS → NEXT: mark completed, proceed
- `grade` FAIL → NEXT: revise (up to 2x) or mark failed

The agent follows NEXT — you just describe the work, the loop runs itself.

### Quota-aware (automatic)
You don't manage quota — the tools adapt:
- **GO** + headroom → strong generator, full parallel
- **THROTTLE** → auto-switch to `lighterModel`, concurrency capped at 2
- **STOP** → loop halts

Set `lighterModel` in `harness.config.json` to enable THROTTLE switching.

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
| `UC_HARNESS_AGENT` | `Usage-Coach-Harness` | comma-separated agent modes allowed to use harness tools + receive quota coaching (case-insensitive; must match the agent id, e.g. `usage-coach-harness` from `agents/usage-coach-harness.md`) |
| `UC_WORM_MAX_AGE_DAYS` | 180 | domain DB worm (GC): drop nodes not accessed in N days (~6 months) |
| `UC_WORM_MAX_NODES` | 100000 | domain DB worm (GC): cap node count, evict oldest-accessed beyond this |
| `UC_DOMAIN_TIMEOUT_MS` | 5000 | domain DB query timeout (ms) — a slow/hung query resolves to a safe fallback instead of blocking the plugin |

## Agent-mode scoping

Harness tools (`generate`, `grade`, `harness_start`, …) and quota coaching are **scoped to
the `usage-coach-harness` agent mode**. Other modes (build, general, your custom agents) stay
completely clean — no harness tools in their tool list, no quota coaching injected into their
system prompt.

This is enforced on two independent layers (defense in depth):

1. **Agent definition** (`agents/usage-coach-harness.md`) — its `permission` allowlist names the
   harness tools, so they only appear in this mode. Other agents' permission lists don't name
   them, so they're hidden from those modes automatically (this is the standard opencode
   mechanism — tool visibility is the agent definition's responsibility).
2. **Plugin runtime gate** (`tool.execute.before`) — even if a harness tool were somehow
   invoked, the plugin resolves the current session's agent (`client.session.get` → `info.agent`,
   60s-cached) and throws unless it matches `UC_HARNESS_AGENT` (default `Usage-Coach-Harness`,
   case-insensitive). The quota system-prompt injection is gated the same way.

**To use the harness tools**, switch to the `usage-coach-harness` agent mode.

**To allow additional modes**, set `UC_HARNESS_AGENT` to a comma-separated list:
```bash
export UC_HARNESS_AGENT="usage-coach-harness,my-other-harness"
```

> Why not the v2 plugin API? v2 has no `tool` registration domain, so a plugin that provides
> custom tools (like this one) cannot be fully rewritten in v2. Agent `permission` allowlists +
> the v1 runtime gate is the structurally correct way to scope tool visibility.

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
- **Harness not visible?** The TUI shows the **current session's** harness only. A finished harness (`active:false`) is hidden. A harness started in another session won't appear here — switch to that session to see it.

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

### generate / generate_batch returns "Tool execution aborted"
- **Cause:** opencode imposes a tool execution timeout (~60–120s, not configurable). `runModel` polls the sub-session for up to 10 min; if the generator model takes longer than the tool timeout, opencode aborts the call.
- **This is a platform limit, not a plugin bug** — there is no config key to extend it.
- **Mitigation:** split large tasks into smaller ones that finish within the timeout. The NEXT directives + revise loop help — a FAIL triggers a focused revise rather than a monolithic retry.
- The sub-session keeps running in the background after abort; its file writes are preserved. Only the tool's return value is lost.

### Multi-session (per-session state isolation)
- Each opencode session has a unique sessionID; harness state is isolated per-session:
  ```
  ~/.cache/opencode-usage-coach/projects/<dir-hash>/<sessionID>/harness.json
  ```
- Different working directories get separate project state (keyed by path hash).
- The TUI shows the **current session's** harness only (per-session isolation) — no cross-session leakage. A harness running in session B does not appear in session A's panel.
- Harness completion sets `active:false` → hidden from the TUI.
- Override the state path with `UC_STATE_DIR` (forces global state).

**Key gotcha — opencode TUI `ctx` does NOT carry `session_id`.**
The slot context passed to `panel(ctx)` contains only `{ theme }`. There is no `session_id`/`sessionID` field. The current session ID lives in **`api.route.current.params.sessionID`** instead — the panel reads it from there. If you ever see harnesses from other sessions leaking in, the cause is almost certainly that `sid` resolved to empty (→ fallback broad scan).

**Debugging session isolation** (if it breaks again):
1. Check `~/.cache/opencode-usage-coach/projects/<hash>/tui-debug.log` — is `panel` being called? What `routeSid` value?
2. `api.route.current.params.sessionID` — populated? (Empty → panel falls back to scanning all sessions.)
3. New TUI code loaded? `tui-loaded.txt` (MARKER) should show `loaded-v2 ...`. If it still says `loaded`, the new dist isn't being picked up.
4. `appendFileSync` imported in `src/tui.tsx`? If missing, **all TUI debug logging silently fails** (ReferenceError swallowed by try/catch) — this wasted a lot of debugging time once.

**Past issue (fixed v0.3.4):** panel read `ctx.session_id` which was always `undefined` → fallback scanned every session → another session's active harness leaked in. Fixed by reading `api.route.current.params.sessionID`.

## Status
- ✅ Quota guardian + TUI panel (per-provider coach view, 5h/1w gauges, collapsible Alt+H)
- ✅ Harness: agent mode with generate/grade tools (multi-model, 1 terminal)
- ✅ Deterministic loop via NEXT directives (parallel PATH A / sequential PATH B)
- ✅ Quota-aware tools (GO/THROTTLE/STOP drive model selection + concurrency)
- ✅ Learning loop (record_failure → investigate → verify_diagnosis → generalize → rules.md)
- ✅ Domain knowledge base (graph store, investigate/generate injection)
- ✅ Session isolation (api.route, per-session harness state)
- ✅ npm packaging (`opencode plugin install opencode-usage-coach`)

License: MIT.
