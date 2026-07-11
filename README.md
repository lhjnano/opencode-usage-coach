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

```jsonc
// ~/.config/opencode/opencode.json  — server plugin
{ "plugin": ["opencode-usage-coach"] }

// ~/.config/opencode/tui.json        — sidebar panel (point at built dist/tui.js)
{ "$schema": "https://opencode.ai/tui.json", "plugin": ["opencode-usage-coach/tui"] }
```

Then wire `codexbar` and drop `agents/usage-coach-harness.md` into `~/.config/opencode/agents/` for agent mode:

```bash
# provider quota data source
printf '%s' "$YOUR_PROVIDER_API_KEY" | codexbar config set-api-key --provider <id> --stdin

# harness role → model mapping (place in your work directory)
cp harness.config.example.json harness.config.json   # edit generator/grader
```

For local dev without npm: `bun install && bun run build`, then point both configs at the `dist/` files.

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

Common issues: TUI panel missing (check `tui.json` points at `dist/tui.js`, never install `solid-js` in the config dir), model selection errors (`generator` is required), and tool-abort timeouts (platform limit — split large tasks).

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
