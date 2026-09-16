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
- **Domain knowledge base** — a local graph store whose retrieval is a **tokenized BM25/IDF ranker** (Hangul bigrams), feeding the loop with a reward-updated confidence signal. See [Domain knowledge base](#domain-knowledge-base).
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

The plugin works in **GO-only mode** out of the box (no quota sensing). To enable real-time quota monitoring, install [CodexBar](https://github.com/steipete/CodexBar):

```bash
# macOS
brew install --cask codexbar

# Linux (Homebrew)
brew install steipete/tap/codexbar

# Linux (Arch AUR)
yay -S codexbar-cli

# Or download CLI tarballs from GitHub Releases
# https://github.com/steipete/CodexBar/releases
```

Then configure your provider API key:

```bash
printf '%s' "$YOUR_PROVIDER_API_KEY" | codexbar config set-api-key --provider <id> --stdin
```

CodexBar supports 65+ providers including z.ai, OpenAI, Claude, Cursor, Gemini, Copilot, and more. Check `codexbar config providers` for the full list.

Without CodexBar, the plugin simply doesn't sense quota — all other features (harness loop, learning, domain knowledge) work normally.

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

Independent tasks run in parallel (`generate_batch`); dependent tasks run sequentially. The loop is quota-aware: **GO** → full power, **THROTTLE** → lighter model + capped concurrency, **STOP** → halt. A watchdog performs **stall detection** on sub-sessions: if a batch task's message stream shows no progress for `UC_STALL_MIN` minutes (default 12), it is aborted early and retried instead of holding its slot until the wall clock.

## Domain knowledge base

Every generate/investigate call injects facts from a local NDJSON graph store (project + shared layers). Since v0.15 this pipeline is a small ranking system, not a keyword dump:

```
write:  session artifacts → salience gate (source rules) → nodes (typed TTL via access)
query:  tokenize (Hangul bigrams) → BM25/IDF over an inverted index → priors → top-12 injection
reward: injection provenance (injections.ndjson)
        → clear PASS/FAIL verdict → confidence ±δ on injected nodes (rewards.ndjson)
GC:     dead-edge sweep + "60 days without injection or reward" eviction
```

- **Ranking (v0.15)** — substring counting was replaced by BM25 (`k1=1.2, b=0.75`) over a stat-cached inverted index, with priors `α·confidence + β·recency + γ·accessCount` (defaults 0.3/0.2/0.1, env `UC_RANK_ALPHA/BETA/GAMMA`). Hangul runs become bigrams, so `다크모드` matches `다크 테마` text. Injection cap: 12 nodes (`domainMaxNodes`).
- **Graph hygiene (v0.16)** — dangling-edge sweep runs on idle; BFS expansion follows at most `UC_FANOUT_CAP` (12) neighbors per node; auto keyword-sharing edges are **off by default** (`UC_AUTOLINK=1` or `domainAutoLink: true` re-enables) — only learning-loop-verified edges are curated.
- **Reward closed loop (v0.16–0.17)** — every injection is logged with its node ids; when `grade`/`grade_batch` returns a clear PASS/FAIL, the injected nodes' confidence moves ±`UC_REWARD_DELTA` (0.05). Rewarded/injected nodes get their access stamped, so the shared-layer TTL (`UC_SHARED_WORM_MAX_AGE_DAYS`, 60d) reads *"unused and unrewarded for 60 days"* — salience emerges from the reward signal, without a static type schema.

Upgrading from ≤0.14? Run `node scripts/migrate-v016.mjs --purge-auto` once to drop legacy auto edges (backs up first; see CHANGELOG 0.16.0).

See **[docs/architecture.md](docs/architecture.md)** for the full design and **[docs/configuration.md](docs/configuration.md)** for every env var.

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
