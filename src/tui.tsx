// tui.tsx — opencode-usage-coach TUI module (minimal / defensive)
// Reads the state file written by server(index.ts) and renders a quota meter.
// Build required (tsup + esbuild-plugin-solid, solid external). Load the compiled dist/tui.js.
// Diagnostic: on load, writes a marker file ~/.cache/opencode-usage-coach/tui-loaded.txt.

import type { TuiPlugin, TuiPluginApi, TuiSlotContext } from "@opencode-ai/plugin/tui";
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, statSync, appendFileSync } from "node:fs";
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

type State = { decision: "GO" | "THROTTLE" | "STOP"; advice: string; weekly: number; monthly: number; fiveHour: number; providers?: ProviderCoach[]; model?: string; provider?: string; isFree?: boolean; agent?: string };
type ProviderCoach = { id: string; name: string; fiveHour: number; weekly: number; fiveHourReset: string; weeklyReset: string; advice: string };
type TaskState = { id: number; title: string; status: string; model: string; revisions: number; score: string | null; startedAt?: string; subSessionId?: string; subStep?: number; lastActivity?: string; subElapsed?: number };
type ProviderQuota = { weekly: number; monthly: number; fiveHour: number };
type HarnessState = { name: string; total: number; current: number; tasks: TaskState[]; quotas?: Record<string, ProviderQuota>; active?: boolean; updatedAt?: string };

function readState(): State | null {
  try { if (!existsSync(STATE_FILE)) return null; return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State; }
  catch { return null; }
}
function readHarness(): HarnessState | null {
  try {
    // Session-scoped harness files live in STATE_DIR/<sessionID>/harness.json (per-session isolation).
    // Find the most recently updated active harness; fall back to the most recent; then legacy path.
    let best: { file: string; mtime: number; active: boolean } | null = null;
    let entries: string[] = [];
    try { entries = readdirSync(STATE_DIR); } catch { /* */ }
    for (const d of entries) {
      const sub = join(STATE_DIR, d);
      let isDir = false; try { isDir = statSync(sub).isDirectory(); } catch { /* */ }
      if (!isDir) continue;
      const f = join(sub, "harness.json");
      if (!existsSync(f)) continue;
      let st; try { st = statSync(f); } catch { continue; }
      let active = false; try { active = !!JSON.parse(readFileSync(f, "utf8")).active; } catch { /* */ }
      if (!best || (active && !best.active) || (active === best.active && st.mtimeMs > best.mtime)) {
        best = { file: f, mtime: st.mtimeMs, active };
      }
    }
    if (best) return JSON.parse(readFileSync(best.file, "utf8")) as HarnessState;
    // Legacy fallback: STATE_DIR/harness.json (pre-session-isolation)
    if (existsSync(HARNESS_FILE)) return JSON.parse(readFileSync(HARNESS_FILE, "utf8")) as HarnessState;
    return null;
  }
  catch { return null; }
}

// Plain ASCII indicators (no emoji — avoids static decorations that don't change live)
const TAG: Record<State["decision"], string> = { GO: "ok", THROTTLE: "slow", STOP: "STOP" };
const TLABEL: Record<string, string> = {
  generating: "gen", grading: "grade", revising: "revise", completed: "done",
  failed: "fail", timed_out: "timeout", halted_quota: "quota-halt", stale: "STALE",
};

// Staleness thresholds: a harness with no active sub-sessions that hasn't been
// updated in STALE_MS is "stale" (abandoned — session interrupted without
// harness_done). After HIDE_MS, hide it entirely to reduce noise.
const STALE_MS = 5 * 60_000;   // 5 min: mark non-terminal tasks as STALE
const HIDE_MS  = 30 * 60_000;  // 30 min: hide the whole harness section

function barFill(p: number): string {
  // 0% = empty; anything > 0% shows at least 1 block (otherwise low % looks like 0 / invisible row)
  const n = p <= 0 ? 0 : Math.max(1, Math.min(10, Math.round(p / 10)));
  return "█".repeat(n);
}
function barEmpty(p: number): string {
  const n = p <= 0 ? 0 : Math.max(1, Math.min(10, Math.round(p / 10)));
  return "░".repeat(10 - n);
}

function initializeTui(api: TuiPluginApi, disposeRoot: () => void) {
  // Per-directory state: scope to the session's working directory (matches harness/plugin).
  STATE_DIR = process.env.UC_STATE_DIR ?? projectStateDir(api.state.path.directory);
  STATE_FILE = join(STATE_DIR, "state.json");
  HARNESS_FILE = join(STATE_DIR, "harness.json");
  MARKER = join(STATE_DIR, "tui-loaded.txt");
  const TUI_LOG = join(STATE_DIR, "tui-debug.log");
  const tlog = (msg: string) => { try { appendFileSync(MARKER, `${new Date().toISOString()} ${msg}\n`); appendFileSync(TUI_LOG, `${new Date().toISOString()} ${msg}\n`); } catch (e) { try { appendFileSync(MARKER, `TLOG ERR: ${String(e)}\n`); } catch { /* */ } } };
  // Load marker (diagnostic)
  try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(MARKER, `loaded-v2 ${new Date().toISOString()} @ ${api.state.path.directory}`); } catch { /* */ }
  tlog(`init start | dir=${api.state.path.directory} | STATE_DIR=${STATE_DIR}`);
  // Probe where sessionID might live (ctx doesn't have it — check api.state).
  try {
    tlog(`api keys=${Object.keys(api).join(",")}`);
    tlog(`api.state=${JSON.stringify(api.state).slice(0, 400)}`);
    tlog(`api.state.path=${JSON.stringify(api.state?.path).slice(0, 300)}`);
    // route is the most likely place for the current session ID
    const r: any = (api as any).route;
    tlog(`api.route type=${typeof r} keys=${r && typeof r === "object" ? Object.keys(r).join(",") : "?"} val=${JSON.stringify(r).slice(0, 400)}`);
  } catch (e) { tlog(`api probe err: ${String(e)}`); }

  const [getState, setState] = createSignal<State | null>(readState());
  // harness is read per-render (per-session path) — no reactive signal needed; setState re-render re-reads it.
  const timer = setInterval(() => { try { setState(readState()); } catch { /* */ } }, 3000);
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
    let s: State | null;
    try { s = getState(); } catch { s = null; }
    // read harness from this SESSION's path (per-session isolation),
    // then fall back to the most recent active harness across all sessions
    // (so the panel shows a running harness even if ctx.session_id is empty/mismatched).
    let h: HarnessState | null = null;
    try {
      // opencode TUI ctx doesn't carry session_id — read it from api.route.current.params.sessionID
      const routeSid = (api.route as any)?.current?.params?.sessionID ?? "";
      const sid = routeSid || (ctx.session_id ?? "");
      if (sid) {
        // Current session ONLY — never fall back to other sessions' harnesses (session isolation).
        // This prevents a harness running in session B from showing in session A's panel.
        const hf = join(STATE_DIR, sid, "harness.json");
        if (existsSync(hf)) h = JSON.parse(readFileSync(hf, "utf8")) as HarnessState;
      } else {
        // No session_id available (legacy) — fall back to most recent active across sessions.
        h = readHarness();
      }
    } catch { h = null; }

    const nodes: any[] = [];
    if (s) {
      const dKey = s.decision === "GO" ? "success" : s.decision === "THROTTLE" ? "warning" : "error";
      const modelShort = s.model ? (s.model.split("/").pop() ?? s.model) : "";
      // Free model: one clean line — usage-coach [free] {model}
      if (s.isFree) {
        nodes.push(<box flexDirection="row"><text style={st(dKey)}>usage-coach [free]</text><text style={st("textMuted")}> {modelShort}</text></box>);
      } else {
        // Paid model: header + quota bars
        if (modelShort) {
          nodes.push(<box flexDirection="row"><text style={st(dKey)}>usage-coach [{TAG[s.decision]}]</text><text style={st("textMuted")}> {modelShort}</text></box>);
        } else {
          nodes.push(<text style={st(dKey)}>usage-coach [{TAG[s.decision]}]</text>);
        }
      if (s.providers && s.providers.length > 0) {
        for (const p of s.providers) {
          nodes.push(<box flexDirection="row"><text> 5h </text><text style={st("text")}>{barFill(p.fiveHour)}</text><text style={st("text")}>{barEmpty(p.fiveHour)}</text><text> {p.fiveHour}%  {p.fiveHourReset}</text></box>);
          nodes.push(<box flexDirection="row"><text> 1w </text><text style={st("text")}>{barFill(p.weekly)}</text><text style={st("text")}>{barEmpty(p.weekly)}</text><text> {p.weekly}%  {p.weeklyReset}</text></box>);
        }
      } else {
        nodes.push(<box flexDirection="row"><text> 5h </text><text style={st("text")}>{barFill(s.fiveHour)}</text><text style={st("text")}>{barEmpty(s.fiveHour)}</text><text> 0%</text></box>);
        nodes.push(<box flexDirection="row"><text> 1w </text><text style={st("text")}>{barFill(s.weekly)}</text><text style={st("text")}>{barEmpty(s.weekly)}</text><text> 0%</text></box>);
      }
      }
    } else {
      nodes.push(<text>usage-coach: ...</text>);
    }

    // Harness section: show only for ACTIVE or STALE (abandoned) harnesses.
    // Completed harnesses (active=false, recently updated) are hidden — the TUI
    // is for live status, not history. Abandoned harnesses show as STALE until
    // HIDE_MS, then disappear.
    if (h && h.tasks.length > 0 && h.active !== false) {
      const hAge = h.updatedAt ? Date.now() - new Date(h.updatedAt).getTime() : 0;
      const hasActiveSub = h.tasks.some((t: any) => !!t.subSessionId);
      const isStale = !hasActiveSub && hAge > STALE_MS;
      const shouldHide = hAge > HIDE_MS && !hasActiveSub;
      if (shouldHide) {
        // Very stale — skip rendering the harness section entirely.
      } else {
      nodes.push(<text>{" "}</text>);
      nodes.push(<text style={st("textMuted")}>harness: {h.name} {h.current}/{h.total}{isStale ? " (stale)" : ""}</text>);
      for (const t of h.tasks) {
        const TERMINAL = new Set(["completed", "failed", "timed_out", "halted_quota"]);
        const displayStatus = isStale && !TERMINAL.has(t.status) ? "stale" : t.status;
        const sKey = statusKey[displayStatus] ?? "text";
        const lbl = TLABEL[displayStatus] ?? displayStatus;
        const rev = t.revisions > 0 && t.status === "revising" ? `(${t.revisions})` : "";
        const mdl = t.model ? ` ${(t.model.split("/").pop() ?? t.model)}` : "";
        // Sub-session live progress (when runModel is actively executing for this task).
        // subSessionId present = sub-session is alive (poller running); cleared on completion.
        const hasSub = !!t.subSessionId;
        const subStepStr = hasSub && t.subStep !== undefined && t.subStep > 0 ? ` step:${t.subStep}` : "";
        const subEl = hasSub && t.subElapsed !== undefined ? ` ${t.subElapsed}s` : "";
        const subWarn = hasSub && (t.subElapsed ?? 0) > 300;
        // Task-level elapsed (fallback when no active sub-session; hidden on terminal states)
        const elapsed = t.startedAt ? Math.max(0, Math.round((Date.now() - new Date(t.startedAt).getTime()) / 1000)) : 0;
        const taskEl = (t.status === "completed" || t.status === "failed") ? "" : (elapsed > 0 ? ` ${elapsed}s` : "");
        const displayEl = hasSub ? subEl : taskEl;
        // Warning color when sub-session elapsed > 300s
        const lineKey = subWarn ? "warning" : sKey;
        nodes.push(<text style={st(lineKey)}> ● {t.id}{mdl} {lbl}{rev}{subStepStr}{displayEl} {t.title}</text>);
        // quota: read from coaching state (h.quotas is not populated — use the live state)
        const pv = t.model ? (t.model.split("/")[0] ?? "").split("-")[0] : "";
        // match by provider id; fall back to first provider if task has no model
        const provCoach = pv
          ? s?.providers?.find((p: any) => p.id === pv || (pv && p.id.startsWith(pv)) || (pv && pv.startsWith(p.id)))
          : s?.providers?.[0];
        const rawPct = provCoach?.fiveHour ?? s?.fiveHour ?? -1;
        const pct = rawPct < 0 ? 0 : rawPct;  // -1 means no quota data — show empty bar
        const pctLabel = rawPct < 0 ? "n/a" : `${rawPct}%`;
        nodes.push(<box flexDirection="row"><text>   5h </text><text style={st("text")}>{barFill(pct)}</text><text style={st("text")}>{barEmpty(pct)}</text><text> {pctLabel}</text></box>);
      }
      }
    }

    return (<box flexDirection="column">{nodes}</box>);
  };

  tlog("registering slots");
  api.slots.register({
    order: 80,
    slots: {
      sidebar_footer(ctx: TuiSlotContext & { session_id?: string }) {
        tlog("sidebar_footer slot called");
        // slot callback (not a Solid component) — single return avoids reactivity false-positive
        let result: any;
        try { result = panel(ctx); }
        catch (e) { tlog(`sidebar_footer err: ${String(e)}`); result = <text>usage-coach</text>; }
        return result;
      },
    },
  });
  tlog("slots registered, init complete");
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
