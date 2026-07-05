// tui.tsx — opencode-usage-coach TUI module (minimal / defensive)
// Reads the state file written by server(index.ts) and renders a quota meter.
// Build required (tsup + esbuild-plugin-solid, solid external). Load the compiled dist/tui.js.
// Diagnostic: on load, writes a marker file ~/.cache/opencode-usage-coach/tui-loaded.txt.

import type { TuiPlugin, TuiPluginApi, TuiSlotContext } from "@opencode-ai/plugin/tui";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createRoot, createSignal, onCleanup } from "solid-js";

// Per-directory state (matches the server plugin & harness script). UC_STATE_DIR overrides.
function projectStateDir(dir: string): string {
  const abs = resolve(dir || ".");
  const h = createHash("sha1").update(abs).digest("hex").slice(0, 12);
  return join(homedir(), ".cache", "opencode-usage-coach", "projects", h);
}

let STATE_DIR = join(homedir(), ".cache", "opencode-usage-coach");
let STATE_FILE = join(STATE_DIR, "state.json");
let HARNESS_FILE = join(STATE_DIR, "harness.json");
let MARKER = join(STATE_DIR, "tui-loaded.txt");

type State = { decision: "GO" | "THROTTLE" | "STOP"; advice: string; weekly: number; monthly: number; fiveHour: number; providers?: ProviderCoach[] };
type ProviderCoach = { id: string; name: string; fiveHour: number; weekly: number; fiveHourReset: string; weeklyReset: string; advice: string };
type TaskState = { id: number; title: string; status: string; model: string; revisions: number; score: string | null };
type ProviderQuota = { weekly: number; monthly: number; fiveHour: number };
type HarnessState = { name: string; total: number; current: number; tasks: TaskState[]; quotas?: Record<string, ProviderQuota>; active?: boolean };

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

function barFill(p: number): string {
  return "█".repeat(Math.max(0, Math.min(10, Math.round(p / 10))));
}
function barEmpty(p: number): string {
  return "░".repeat(10 - Math.max(0, Math.min(10, Math.round(p / 10))));
}
// Truncate title to fit sidebar width
function short(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function initializeTui(api: TuiPluginApi, disposeRoot: () => void) {
  // Per-directory state: scope to the session's working directory (matches harness/plugin).
  STATE_DIR = process.env.UC_STATE_DIR ?? projectStateDir(api.state.path.directory);
  STATE_FILE = join(STATE_DIR, "state.json");
  HARNESS_FILE = join(STATE_DIR, "harness.json");
  MARKER = join(STATE_DIR, "tui-loaded.txt");
  // Load marker (diagnostic)
  try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(MARKER, `loaded ${new Date().toISOString()} @ ${api.state.path.directory}`); } catch { /* */ }

  const [getState, setState] = createSignal<State | null>(readState());
  const [getHarness, setHarness] = createSignal<HarnessState | null>(readHarness());
  const timer = setInterval(() => { try { setState(readState()); setHarness(readHarness()); } catch { /* */ } }, 3000);
  onCleanup(() => clearInterval(timer));
  onCleanup(() => disposeRoot());

  // Toggle (collapsible) via command + keybind (Alt+H). MCP-style collapsible section.
  const [collapsed, setCollapsed] = createSignal(false);
  let cmdDispose: (() => void) | undefined;
  try {
    cmdDispose = api.command?.register?.(() => [{
      title: "Toggle usage-coach panel",
      value: "usage-coach-toggle",
      category: "usage-coach",
      keybind: "alt+h",
      onSelect: () => { setCollapsed((c) => !c); },
    }]) as (() => void) | undefined;
  } catch { /* command API unavailable — toggle disabled */ }
  onCleanup(() => { try { cmdDispose?.(); } catch { /* */ } });

  // status -> theme color key (MCP-style colored dot ●)
  const statusKey: Record<string, string> = {
    generating: "info", grading: "accent", revising: "warning",
    completed: "success", failed: "error", timed_out: "error", halted_quota: "error",
  };

  // panel(ctx) — one line per item. Color via style.fg using theme (opentui convention).
  // Harness is read per-SESSION (ctx.session_id), so each session sees only its own harness.
  const panel = (ctx: TuiSlotContext & { session_id?: string }) => {
    const th = (ctx.theme?.current ?? {}) as Record<string, any>;
    const st = (k: string) => ({ fg: th[k] });
    if (collapsed()) {
      return (<box><text style={st("textMuted")}>usage-coach (hidden — Alt+H)</text></box>);
    }
    let s: State | null = null;
    try { s = getState(); } catch { s = null; }
    // read harness from this SESSION's path (per-session isolation)
    let h: HarnessState | null = null;
    try {
      const sid = ctx.session_id ?? "";
      if (sid) {
        const hf = join(STATE_DIR, sid, "harness.json");
        if (existsSync(hf)) h = JSON.parse(readFileSync(hf, "utf8")) as HarnessState;
      }
    } catch { h = null; }

    const nodes: any[] = [];
    if (s) {
      const dKey = s.decision === "GO" ? "success" : s.decision === "THROTTLE" ? "warning" : "error";
      nodes.push(<text style={st(dKey)}>usage-coach [{TAG[s.decision]}]</text>);
      // Coach view: per-provider breakdown (5h + wk + time remaining + big/small advice)
      if (s.providers && s.providers.length > 0) {
        for (const p of s.providers) {
          nodes.push(<text style={st("textMuted")}> {p.name}</text>);
          nodes.push(<box flexDirection="row"><text>  5h </text><text style={st("text")}>{barFill(p.fiveHour)}</text><text style={st("textMuted")}>{barEmpty(p.fiveHour)}</text><text> {p.fiveHour}%  {p.fiveHourReset}</text></box>);
          nodes.push(<box flexDirection="row"><text>  wk </text><text style={st("text")}>{barFill(p.weekly)}</text><text style={st("textMuted")}>{barEmpty(p.weekly)}</text><text> {p.weekly}%  {p.weeklyReset}</text></box>);
          nodes.push(<text style={st(dKey)}>  {"->"} {p.advice}</text>);
        }
      } else {
        nodes.push(<box flexDirection="row"><text> 5h </text><text style={st("text")}>{barFill(s.fiveHour)}</text><text style={st("textMuted")}>{barEmpty(s.fiveHour)}</text><text> {s.fiveHour}%</text></box>);
        nodes.push(<box flexDirection="row"><text> wk </text><text style={st("text")}>{barFill(s.weekly)}</text><text style={st("textMuted")}>{barEmpty(s.weekly)}</text><text> {s.weekly}%</text></box>);
        nodes.push(<box flexDirection="row"><text> mo </text><text style={st("text")}>{barFill(s.monthly)}</text><text style={st("textMuted")}>{barEmpty(s.monthly)}</text><text> {s.monthly}%</text></box>);
      }
    } else {
      nodes.push(<text>usage-coach: ...</text>);
    }

    // Harness section: ONLY when a harness is active (running). Hidden when done (active===false).
    if (h && h.active !== false && h.tasks.length > 0) {
      nodes.push(<text>{" "}</text>);
      nodes.push(<text style={st("textMuted")}>harness: {h.name} {h.current}/{h.total}</text>);
      for (const t of h.tasks) {
        const sKey = statusKey[t.status] ?? "text";
        const lbl = TLABEL[t.status] ?? t.status;
        const rev = t.revisions > 0 && t.status === "revising" ? `(${t.revisions})` : "";
        const mdl = t.model ? ` ${(t.model.split("/").pop() ?? t.model)}` : "";
        nodes.push(<text style={st(sKey)}> ● {t.id}{mdl} {lbl}{rev} {short(t.title, 12)}</text>);
        const pv = t.model ? (t.model.startsWith("zai") ? "zai" : (t.model.split("/")[0] ?? "").split("-")[0]) : "";
        const q = pv && h.quotas?.[pv] ? h.quotas[pv] : null;
        const pct = q ? q.fiveHour : 0;
        nodes.push(<box flexDirection="row"><text>   5h </text><text style={st("text")}>{barFill(pct)}</text><text style={st("textMuted")}>{barEmpty(pct)}</text><text> {pct}%</text></box>);
      }
    }

    return (<box flexDirection="column">{nodes}</box>);
  };

  api.slots.register({
    order: 80,
    slots: {
      sidebar_footer(ctx: TuiSlotContext & { session_id?: string }) { try { return panel(ctx); } catch { return <text>usage-coach</text>; } },
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
