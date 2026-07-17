# opencode-usage-coach

A closed-loop usage coach and harness for [OpenCode](https://opencode.ai). Built for flat-rate / quota-metered coding plans — it **senses quota → coaches → stops/advances the loop**. Provider-agnostic, configurable via `harness.config.json`.

[![npm version](https://img.shields.io/npm/v/opencode-usage-coach)](https://www.npmjs.com/package/opencode-usage-coach) [![license](https://img.shields.io/npm/l/opencode-usage-coach)](./LICENSE) [![coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/lhjnano/opencode-usage-coach/main/coverage-badge.json)](./coverage-badge.json) [![Ko-fi](https://img.shields.io/badge/Ko--fi-sponsor-FF5E5B)](https://ko-fi.com/lhjnano) [![GitHub Sponsors](https://img.shields.io/badge/GitHub-Sponsors-ea4aaa)](https://github.com/sponsors/lhjnano)

## Features

- **Quota guardian** — senses provider quota windows (5h / weekly / monthly) via the `codexbar` CLI.
- **Automatic loop control** — STOP threshold blocks tool calls so the agent self-stops; throttle advice downshifts models.
- **Coaching injection** — real-time guidance on how to use remaining quota, injected into the system prompt.
- **Sidebar panel** — per-provider quota meters + live harness task states (SolidJS, `Alt+H` to toggle).
- **Harness agent mode** — triages requests and runs a generate → grade → revise loop, multi-model in one terminal.
- **Learning loop** — failures are investigated, verified, and generalized into reusable rules (`rules.md`).
- **Domain knowledge base** — a local graph store that injects known facts into prompts, reducing speculation.
- **Pre-flight gap analysis** — inspired by Anthropic's Unknowns Matrix; surfaces blind spots before generation starts.
- **Provider-agnostic** — any provider `codexbar` knows; configure once in `harness.config.json`.
- **Session isolation** — per-session harness state; no cross-session leakage.

## How it works

The plugin runs in two parts inside a single opencode terminal. The **server module** senses quota, decides GO/THROTTLE/STOP, and exposes custom harness tools (`generate`, `grade`, `record_failure`, …). The **TUI module** renders quota meters and live task states into the sidebar. The **harness agent** triages each request — trivial work is done directly; substantive work enters the generate→grade→revise loop.

See **[docs/architecture.md](docs/architecture.md)** for the full design.

## Quick Start

### 3 steps to get running

**Step 1 — Install globally (provides the `usage-coach` CLI):**

```bash
npm install -g opencode-usage-coach
```

**Step 2 — Add the server plugin to opencode:**

```jsonc
// ~/.config/opencode/opencode.json
{ "plugin": ["opencode-usage-coach"] }
```

**Step 3 — Run setup (auto-configures everything else):**

```bash
usage-coach setup
```

This single command:
- Creates `~/.config/opencode-usage-coach/harness.config.json` (model config)
- Copies the harness agent file to `~/.config/opencode/agents/`
- **Auto-configures `~/.config/opencode/tui.json`** with the correct TUI plugin path
- Detects whether `codexbar` is installed

Restart opencode — you're done. The sidebar panel appears (toggle with `Alt+H`).

> **Without `npm install -g`:** The server plugin still works (opencode auto-installs it from npm), but `usage-coach setup` and the `usage-coach` CLI won't be available. You'd need to manually create `harness.config.json` and configure `tui.json` yourself.

### Quota sensing (optional but recommended)

The plugin works in **GO-only mode** out of the box (no quota sensing). To enable real-time quota monitoring, install [codexbar](https://github.com/nicepkg/codexbar):

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/nicepkg/codexbar/main/install.sh | bash

# Then configure your provider API key:
printf '%s' "$YOUR_PROVIDER_API_KEY" | codexbar config set-api-key --provider <id> --stdin
```

codexbar supports any provider with a usage API (OpenAI, Anthropic, Google, z.ai, etc.). Check `codexbar providers` for the full list.

Without codexbar, the plugin simply doesn't sense quota — all other features (harness loop, learning, domain knowledge) work normally.

## Configuration

Four config surfaces; only the first two (install config + codexbar) are required to run. The **harness config** (`harness.config.json`) maps roles to models so per-model quota is tracked — set `generator` (required) and optionally `grader`, `lighterModel`, and `provider`. Thresholds and tuning live in env vars (`UC_STOP_5H`, `UC_THROTTLE_5H`, …).

### Changing models at runtime

Type `/coach-config` in the TUI to view or update harness models interactively. The AI calls the `coach_config` tool, which reads/writes `harness.config.json` with merge semantics — no manual JSON editing required:

```
/coach-config                              # view current config
"change generator to anthropic/claude-sonnet-4-20250514"
"set grader and lighterModel to opencode/mimo-v2.5-free"
```

Changes take effect immediately for new `generate` / `grade` calls.

See **[docs/configuration.md](docs/configuration.md)** for the full reference (env var table, harness config fields, agent-mode scoping, local dev setup).

## Harness Loop

```
  request → triage → trivial? → done directly
                      substantive? → generate → grade ─┬─ PASS → completed
                                                     │
                          ┌── (FAIL, up to 2×) ──────┘
                          ▼
                     record_failure → investigate → verify → generalize → rules.md
                                                                        │
                                     next generate call includes rules ◄─┘
```

Independent tasks run in parallel (`generate_batch`); dependent tasks run sequentially. The loop is quota-aware: **GO** → full power, **THROTTLE** → lighter model + capped concurrency, **STOP** → halt.

See **[docs/architecture.md](docs/architecture.md)** for details on the loop, NEXT directives, and quota-aware switching.

## Troubleshooting

**opencode crashes on startup after adding the plugin** — Make sure you're on v0.13.1 or later. Earlier versions had a bug where opencode would crash due to named exports. Run `npm install -g opencode-usage-coach@latest`.

**TUI sidebar not showing** — Run `usage-coach setup` again. It auto-detects the TUI path and writes `tui.json`. If you installed via `npm install -g`, the path is `$(npm root -g)/opencode-usage-coach/dist/tui.js`. Never install `solid-js` in the opencode config directory.

**`usage-coach: command not found`** — You need `npm install -g opencode-usage-coach` for the CLI. The server plugin works without it, but setup and status commands require the global install.

**Model selection errors** — `generator` is required in `harness.config.json`. Run `usage-coach setup` to create it, then edit the model or use `/coach-config` at runtime.

See **[docs/troubleshooting.md](docs/troubleshooting.md)** for full diagnoses and fixes.

## Contributing

Bug reports and pull requests are welcome. Run `bun run build` before submitting, and keep `lint` + `typecheck` clean:

```bash
bun run lint && bun run typecheck
```

## License

[MIT](./LICENSE) © opencode-usage-coach contributors

## Sponsor

If this saves your quota budget, consider supporting development:

[![Ko-fi](https://img.shields.io/badge/Ko--fi-sponsor-FF5E5B)](https://ko-fi.com/lhjnano) [![GitHub Sponsors](https://img.shields.io/badge/GitHub-Sponsors-ea4aaa)](https://github.com/sponsors/lhjnano)
