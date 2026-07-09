# Troubleshooting

Recurring issues and fixes — mostly learned the hard way during development.

## TUI panel missing or harness not shown

- **Check `tui.json` points at the `dist/tui.js` file path** — not the `plugins/` directory.
  ```jsonc
  // ~/.config/opencode/tui.json
  { "$schema": "https://opencode.ai/tui.json", "plugin": ["/abs/path/dist/tui.js"] }
  ```
- **Do NOT install `solid-js` in the config dir** — conflicts with opencode's bundled solid, causes a crash. Keep it peer + external only.
- **Export must be `{ tui }`** (an object) — a bare function is misread as a server plugin.
- **Color prop is `fg`** (not `foreground`): `style={{ fg: theme.current.success }}`.
- **Call `codexbar` via `spawn`** — the `$` BunShell leaks command output into the TUI.
- **Harness not visible?** The TUI shows active harnesses only. Completed (`active:false`) and stale (>30min abandoned) harnesses are hidden.

## LLM model selection (generate/grade)

- **`generator` is required in `harness.config.json`** — the tools return a clear error if missing.
- Format: `"provider/model"` (e.g. `"opencode/deepseek-v4-flash-free"`).
- **Config precedence**: workdir `harness.config.json` > global `~/.config/opencode-usage-coach/harness.config.json`.
- Omitting `grader` falls back to `generator`.

## Parallel harness execution (generate_batch)

- **Only INDEPENDENT tasks should be batched** — dependent tasks require sequential `generate` calls.
- `generate_batch` runs each task in a separate sub-session. Failed tasks are automatically retried sequentially; if retry also fails, fall back to individual `generate()` calls.
- **Step limit**: each sub-session is aborted after `UC_MAX_STEPS` (default 30) assistant turns. Trace with `UC_DEBUG=1`.

## generate / generate_batch returns "Tool execution aborted"

- **Cause:** opencode imposes a tool execution timeout (~60–120s). `runModel` blocks until the sub-session completes; if it takes longer, opencode aborts the call.
- **Mitigation:** split large tasks into smaller ones. The step limit + revise loop help.
- The sub-session keeps running in the background after abort; file writes are preserved.

## Multi-session (per-session state isolation)

- Each opencode session has a unique sessionID; harness state is isolated per-session:
  ```
  ~/.cache/opencode-usage-coach/projects/<dir-hash>/<sessionID>/harness.json
  ```
- The TUI shows the **current session's** harness only.
- Harness completion sets `active:false` → hidden from the TUI.
- Abandoned harnesses (no `harness_done()`) are marked STALE after 5 min, hidden after 30 min.

## MCP server log noise (zai-mcp etc.)

- opencode restarts MCP servers on session lifecycle events (create/switch/destroy).
- Each restart generates ~10 INFO log lines from the MCP server (tool registration).
- This is opencode's MCP lifecycle behavior, not caused by this plugin.
- Logs are at `~/.zai/zai-mcp-YYYY-MM-DD.log` (or equivalent for your MCP server).
