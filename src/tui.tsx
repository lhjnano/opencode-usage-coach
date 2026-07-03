// tui.tsx — opencode-usage-coach TUI module (minimal / defensive)
// Reads the state file written by server(index.ts) and renders a quota meter.
// Build required (tsup + esbuild-plugin-solid, solid external). Load the compiled dist/tui.js.
// Diagnostic: on load, writes a marker file ~/.cache/opencode-usage-coach/tui-loaded.txt.

import type { TuiPlugin, TuiPluginApi, TuiSlotContext } from "@opencode-ai/plugin/tui";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRoot, createSignal, onCleanup } from "solid-js";

const STATE_DIR = process.env.UC_STATE_DIR ?? join(homedir(), ".cache", "opencode-usage-coach");
const STATE_FILE = join(STATE_DIR, "state.json");
const HARNESS_FILE = join(STATE_DIR, "harness.json");
const MARKER = join(STATE_DIR, "tui-loaded.txt");

type State = { decision: "GO" | "THROTTLE" | "STOP"; advice: string; weekly: number; monthly: number; fiveHour: number };
type TaskState = { id: number; title: string; status: string; model: string; revisions: number; score: string | null };
type ProviderQuota = { weekly: number; monthly: number; fiveHour: number };
type HarnessState = { name: string; total: number; current: number; tasks: TaskState[]; quotas?: Record<string, ProviderQuota> };

function readState(): State | null {
  try { if (!existsSync(STATE_FILE)) return null; return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State; }
  catch { return null; }
}
function readHarness(): HarnessState | null {
  try { if (!existsSync(HARNESS_FILE)) return null; return JSON.parse(readFileSync(HARNESS_FILE, "utf8")) as HarnessState; }
  catch { return null; }
}

// Plain ASCII indicators (no emoji — avoids static decorations that don't change live)
const TAG: Record<State["decision"], string> = { GO: "ok", THROTTLE: "slow", STOP: "STOP" };
// Task status ASCII icons
const TICON: Record<string, string> = {
  generating: ">", grading: "?", revising: "~", completed: "+",
  failed: "x", timed_out: "!", halted_quota: "#",
};
const TLABEL: Record<string, string> = {
  generating: "gen", grading: "grade", revising: "revise", completed: "done",
  failed: "fail", timed_out: "timeout", halted_quota: "quota-halt",
};

function bar(p: number): string {
  const n = Math.max(0, Math.min(10, Math.round(p / 10)));
  return "█".repeat(n) + "░".repeat(10 - n);
}
// Truncate title to fit sidebar width
function short(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function initializeTui(api: TuiPluginApi, disposeRoot: () => void) {
  // Load marker (diagnostic)
  try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(MARKER, `loaded ${new Date().toISOString()}`); } catch { /* */ }

  const [getState, setState] = createSignal<State | null>(readState());
  const [getHarness, setHarness] = createSignal<HarnessState | null>(readHarness());
  const timer = setInterval(() => { try { setState(readState()); setHarness(readHarness()); } catch { /* */ } }, 3000);
  onCleanup(() => clearInterval(timer));
  onCleanup(() => disposeRoot());

  // status -> label (MCP-style dot ● prefix; color TBD via style prop in a follow-up)
  const statusDot: Record<string, string> = {
    generating: "●", grading: "●", revising: "●",
    completed: "●", failed: "●", timed_out: "●", halted_quota: "●",
  };

  // panel(ctx) — one line per item. ctx reserved for theme colors (follow-up).
  const panel = (ctx: TuiSlotContext & { session_id?: string }) => {
    let s: State | null = null;
    try { s = getState(); } catch { s = null; }
    let h: HarnessState | null = null;
    try { h = getHarness(); } catch { h = null; }

    const nodes: any[] = [];
    if (s) {
      nodes.push(<text>usage-coach [{TAG[s.decision]}]</text>);
      nodes.push(<text> 5h {bar(s.fiveHour)} {s.fiveHour}%</text>);
      nodes.push(<text> wk {bar(s.weekly)} {s.weekly}%</text>);
      nodes.push(<text> mo {bar(s.monthly)} {s.monthly}%</text>);
    } else {
      nodes.push(<text>usage-coach: ...</text>);
    }

    // Harness section: ALWAYS show a status line, then one line per task + inline 5h quota bar.
    const hStatus = h && h.tasks.length > 0 ? `${h.name} ${h.current}/${h.total}` : "idle";
    nodes.push(<text>{" "}</text>);
    nodes.push(<text>harness: {hStatus}</text>);
    if (h && h.tasks.length > 0) {
      for (const t of h.tasks) {
        const dot = statusDot[t.status] ?? "·";
        const lbl = TLABEL[t.status] ?? t.status;
        const rev = t.revisions > 0 && t.status === "revising" ? `(${t.revisions})` : "";
        const mdl = t.model ? ` ${(t.model.split("/").pop() ?? t.model)}` : "";
        nodes.push(<text> {dot} {t.id}{mdl} {lbl}{rev} {short(t.title, 12)}</text>);
        // inline quota meter: 5h window of this task's model provider (0% for local LLMs)
        const pv = t.model ? (t.model.startsWith("zai") ? "zai" : (t.model.split("/")[0] ?? "").split("-")[0]) : "";
        const q = pv && h.quotas?.[pv] ? h.quotas[pv] : null;
        const pct = q ? q.fiveHour : 0;
        nodes.push(<text>   5h {bar(pct)} {pct}%</text>);
      }
    }

    return (<box flexDirection="column">{nodes}</box>);
  };

  api.slots.register({
    order: 80,
    slots: {
      sidebar_footer(ctx: TuiSlotContext & { session_id?: string }) { try { return panel(ctx); } catch { return <text>usage-coach</text>; } },
      home_footer(ctx: TuiSlotContext & { session_id?: string }) { try { return panel(ctx); } catch { return <text>usage-coach</text>; } },
    },
  });
}

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  createRoot((disposeRoot) => initializeTui(api, disposeRoot));
};

// A TUI plugin must export a { tui } object so opencode recognizes it as TUI.
// (a bare function export is misread as a server plugin -> never renders)
const plugin: { id: string; tui: TuiPlugin } = {
  id: "opencode-usage-coach-tui",
  tui,
};

export default plugin;
