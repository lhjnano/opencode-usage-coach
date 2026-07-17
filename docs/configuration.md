# Configuration

This plugin has four config surfaces. Only the first two are required to run.

## 1. Install config (where opencode loads the plugin from)

```jsonc
// ~/.config/opencode/opencode.json — server plugin (guardian + harness tools)
{ "plugin": ["opencode-usage-coach"] }            // from npm, OR a local path:
// { "plugin": ["/abs/path/dist/index.js"] }
```

The TUI panel is **auto-configured by `usage-coach setup`**, which resolves the
absolute path to `dist/tui.js` and writes it into `~/.config/opencode/tui.json`.
You should not need to edit `tui.json` manually — just run:

```bash
npm install -g opencode-usage-coach   # provides the CLI + dist/tui.js
usage-coach setup                     # auto-writes tui.json + harness.config.json + agent file
```

If you need to configure `tui.json` manually (e.g. local dev without npm):

```jsonc
// ~/.config/opencode/tui.json — TUI panel (MUST be an absolute file path to dist/tui.js)
{ "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/abs/path/to/opencode-usage-coach/dist/tui.js"] }
```

> **Do NOT use** `opencode-usage-coach/tui` (subpath) in `tui.json` — opencode's
> plugin installer cannot resolve npm subpath exports for TUI plugins. Use the
> absolute file path instead. `usage-coach setup` handles this automatically.
>
> The TUI file MUST be the compiled `dist/tui.js` (raw `.tsx` / installing
> `solid-js` crashes opencode).

## 2. codexbar (quota data source)

```bash
printf '%s' "$YOUR_PROVIDER_API_KEY" | codexbar config set-api-key --provider <id> --stdin
```

## 3. Harness config — `harness.config.json` (role → model)

Place in the **work directory**. Each role runs on its model, so per-model quota is tracked.

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

Config precedence: workdir `harness.config.json` > global `~/.config/opencode-usage-coach/harness.config.json`.

## 4. Env vars (thresholds / tuning)

| Var | Default | Meaning |
|---|---|---|
| `UC_STOP_5H` | 92 | 5h window STOP % (blocks tools) |
| `UC_THROTTLE_5H` | 70 | 5h window throttle % |
| `UC_STOP_WEEKLY` | 95 | weekly STOP % |
| `UC_THROTTLE_WEEKLY` | 85 | weekly throttle % |
| `UC_STOP_MONTHLY` | 98 | monthly STOP % |
| `UC_MAX_STEPS` | 30 | max sub-session steps before abort |
| `UC_WATCHDOG_POLL_MS` | 3000 | sub-session watchdog poll interval |
| `UC_MAX_QUESTIONS` | 7 | reverse interview max questions |
| `UC_LIGHTER_MODEL` | (config `lighterModel`) | suggested model when throttling |
| `UC_PROVIDER` | (config `provider`) | codexbar provider for the guardian |
| `UC_TTL_MS` | 60000 | quota cache TTL (ms) |
| `UC_HARNESS_AGENT` | `Usage-Coach-Harness` | comma-separated agent modes allowed |
| `UC_WORM_MAX_AGE_DAYS` | 180 | domain DB worm (GC): max node age |
| `UC_WORM_MAX_NODES` | 100000 | domain DB worm (GC): max node count |

## Agent-mode scoping

Harness tools and quota coaching are scoped to the `usage-coach-harness` agent mode. Other modes
stay completely clean. To allow additional modes:

```bash
export UC_HARNESS_AGENT="usage-coach-harness,my-other-harness"
```
