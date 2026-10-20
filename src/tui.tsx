// tui.tsx — opencode-usage-coach CLI plugin for the OpenCode V2 terminal.
// Reads the state files written by the server plugin (index.ts) and renders the
// quota meter + harness panel in the sidebar footer.
//
// Ported from the V1 TUI plugin ({ tui } object + api.slots.register) to the
// V2 CLI plugin API: Plugin.define({ id, setup(ctx) }) from "@opencode/plugin/tui",
// context.ui.slot({ append: "sidebar.footer" }), context.keymap.layer for the
// Alt+H toggle, and context.ui.router.current() for per-session harness lookup.
// Rendering is Solid/OpenTUI JSX exactly as before; tui-logic.ts is reused as-is.
// Build required (tsup + esbuild-plugin-solid, solid external). Load dist/tui.js.
// Diagnostic: on load, writes a marker file ~/.cache/opencode-usage-coach/tui-loaded.txt.

import { Plugin } from "@opencode/plugin/tui";
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createSignal } from "solid-js";
import {
  TAG,
  barFill, barEmpty,
  computeStaleness, isHarnessVisible,
  computeTaskDisplay, taskQuotaPct, decisionThemeKey,
} from "./tui-logic.js";

// Per-directory state (matches the server plugin & harness script). UC_STATE_DIR overrides.
function projectStateDir(dir: string): string {
  const abs = resolve(dir || ".");
  const h = createHash("sha1").update(abs).digest("hex").slice(0, 12);
  return join(homedir(), ".cache", "opencode-usage-coach", "projects", h);
}

let STATE_DIR = join(homedir(), ".cache", "opencode-usage-coach");
let STATE_FILE = join(STATE_DIR, "state.json");
let MARKER = join(STATE_DIR, "tui-loaded.txt");

type State = { decision: "GO" | "THROTTLE" | "STOP"; advice: string; weekly: number; monthly: number; fiveHour: number; providers?: ProviderCoach[]; model?: string; provider?: string; isFree?: boolean; agent?: string };
type ProviderCoach = { id: string; name: string; fiveHour: number; weekly: number; fiveHourReset: string; weeklyReset: string; advice: string };
type TaskState = { id: number; title: string; status: string; model: string; revisions: number; score: string | null; startedAt?: string; subSessionId?: string; subStep?: number; lastActivity?: string; subElapsed?: number; lastPollTs?: number };
type ProviderQuota = { weekly: number; monthly: number; fiveHour: number };
type HarnessState = { name: string; total: number; current: number; tasks: TaskState[]; quotas?: Record<string, ProviderQuota>; active?: boolean; updatedAt?: string };

function tlog(msg: string): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(MARKER, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* */ }
}

function readState(): State | null {
  try { if (!existsSync(STATE_FILE)) return null; return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State; }
  catch { return null; }
}

function readHarness(sid?: string): HarnessState | null {
  try {
    // Session-scoped harness files live in STATE_DIR/<sessionID>/harness.json.
    // With a session id: CURRENT session only (never leak another session's
    // harness). Without: fall back to the most recently updated active harness.
    if (sid) {
      const hf = join(STATE_DIR, sid, "harness.json");
      if (existsSync(hf)) return JSON.parse(readFileSync(hf, "utf8")) as HarnessState;
      return null;
    }
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
    return null;
  } catch { return null; }
}

// Theme probe — V1 gave a flat record (text, textMuted, ok, error…); V2 gives
// semantic token trees (text.base, status.success…). Resolve either, else
// render unstyled (still readable in the default terminal color).
function makeStyleGetter(theme: any): (k: string) => { fg?: string } | undefined {
  const t = theme ?? {};
  const pick = (...names: string[]): { fg?: string } | undefined => {
    for (const n of names) {
      const v = t[n];
      if (typeof v === "string") return { fg: v };
    }
    return undefined;
  };
  return (k: string): { fg?: string } | undefined => {
    switch (k) {
      case "textMuted": {
        const nested = t?.text?.muted ?? t?.text?.dim;
        if (typeof nested === "string") return { fg: nested };
        return pick("textMuted", "muted", "textDim", "text");
      }
      case "text": {
        const nested = t?.text?.base;
        if (typeof nested === "string") return { fg: nested };
        return pick("text", "foreground", "fg");
      }
      case "ok":
      case "success": {
        const nested = t?.status?.success ?? t?.color?.green;
        if (typeof nested === "string") return { fg: nested };
        return pick("ok", "success", "green");
      }
      case "warning": {
        const nested = t?.status?.warning ?? t?.color?.yellow;
        if (typeof nested === "string") return { fg: nested };
        return pick("warning", "yellow");
      }
      case "error": {
        const nested = t?.status?.error ?? t?.color?.red;
        if (typeof nested === "string") return { fg: nested };
        return pick("error", "red");
      }
      case "info":
      case "accent": {
        const nested = t?.status?.info ?? t?.color?.blue;
        if (typeof nested === "string") return { fg: nested };
        return pick("info", "accent", "blue");
      }
      default: {
        const flat = t[k];
        return typeof flat === "string" ? { fg: flat } : undefined;
      }
    }
  };
}

export default Plugin.define({
  id: "opencode-usage-coach.tui",
  setup(context: any) {
    // Location-scoped state dir (matches the server plugin). UC_STATE_DIR overrides.
    const dir: string = process.env.UC_STATE_DIR
      ?? projectStateDir(context?.location?.directory ?? context?.location?.project?.directory ?? "");
    STATE_DIR = dir;
    STATE_FILE = join(STATE_DIR, "state.json");
    MARKER = join(STATE_DIR, "tui-loaded.txt");
    tlog(`loaded (v2 cli plugin, dir=${dir})`);

    const st = makeStyleGetter(context?.theme);

    // Quota state: polled every 3s into a signal; harness is read per render
    // (per-session lookup), same freshness model as the V1 panel.
    const [getState, setState] = createSignal<State | null>(readState());
    const timer = setInterval(() => { try { setState(readState()); } catch { /* */ } }, 3000);

    const [collapsed, setCollapsed] = createSignal(false);

    // Alt+H toggle via the V2 keymap layer.
    try {
      context.keymap?.layer?.(() => ({
        mode: "global",
        commands: [{
          id: "usage-coach.toggle-panel",
          title: "Toggle usage-coach panel",
          bind: "alt+h",
          run: () => { setCollapsed((c) => !c); },
        }],
        bindings: ["usage-coach.toggle-panel"],
      }));
    } catch (e) { tlog(`keymap layer err: ${String(e)}`); }

    // Current session id for per-session harness lookup. The router route
    // object shape is probed defensively (params.sessionID / sessionID).
    const currentSessionId = (): string => {
      try {
        const r = context?.ui?.router?.current?.() ?? null;
        return String(r?.params?.sessionID ?? r?.sessionID ?? r?.data?.sessionID ?? "") || "";
      } catch { return ""; }
    };

    // panel — one line per item, Solid JSX exactly like the V1 renderer.
    const panel = (slotProps: any) => {
      if (collapsed()) {
        return <box><text style={st("textMuted")}>usage-coach (hidden — Alt+H)</text></box>;
      }
      const s = getState();
      const sid = String(slotProps?.sessionID ?? currentSessionId() ?? "");
      const h = sid ? readHarness(sid) : readHarness();

      const nodes: any[] = [];
      if (s) {
        const dKey = decisionThemeKey(s.decision);
        const modelShort = s.model ? (s.model.split("/").pop() ?? s.model) : "";
        if (s.isFree) {
          nodes.push(<box flexDirection="row"><text style={st(dKey)}>usage-coach [free]</text><text style={st("textMuted")}> {modelShort}</text></box>);
        } else {
          if (modelShort) {
            nodes.push(<box flexDirection="row"><text style={st(dKey)}>usage-coach [{TAG[s.decision]}]</text><text style={st("textMuted")}> {modelShort}</text></box>);
          } else {
            nodes.push(<text style={st(dKey)}>usage-coach [{TAG[s.decision]}]</text>);
          }
          if (s.providers && s.providers.length > 0) {
            for (const p of s.providers) {
              if (p.fiveHour >= 0) nodes.push(<box flexDirection="row"><text> 5h </text><text style={st("text")}>{barFill(p.fiveHour)}</text><text style={st("text")}>{barEmpty(p.fiveHour)}</text><text> {p.fiveHour}%  {p.fiveHourReset}</text></box>);
              if (p.weekly >= 0) nodes.push(<box flexDirection="row"><text> 1w </text><text style={st("text")}>{barFill(p.weekly)}</text><text style={st("text")}>{barEmpty(p.weekly)}</text><text> {p.weekly}%  {p.weeklyReset}</text></box>);
            }
          } else {
            if (s.fiveHour >= 0) nodes.push(<box flexDirection="row"><text> 5h </text><text style={st("text")}>{barFill(s.fiveHour)}</text><text style={st("text")}>{barEmpty(s.fiveHour)}</text><text> {s.fiveHour}%</text></box>);
            if (s.weekly >= 0) nodes.push(<box flexDirection="row"><text> 1w </text><text style={st("text")}>{barFill(s.weekly)}</text><text style={st("text")}>{barEmpty(s.weekly)}</text><text> {s.weekly}%</text></box>);
          }
        }
      } else {
        nodes.push(<text>usage-coach: ...</text>);
      }

      // Harness section: show only for ACTIVE or STALE (abandoned) harnesses.
      if (h) {
        const staleness = computeStaleness(h);
        if (isHarnessVisible(h, staleness)) {
          const isStale = staleness.isStale;
          nodes.push(<text>{" "}</text>);
          nodes.push(<text style={st("textMuted")}>harness: {h.name} {h.current}/{h.total}{isStale ? " (stale)" : ""}</text>);
          for (const t of h.tasks) {
            const td = computeTaskDisplay(t, isStale);
            nodes.push(<text style={st(td.themeKey)}> ● {t.id}{td.modelStr} {td.label}{td.revSuffix}{td.stepStr}{td.elapsedStr}{td.heartbeat} {t.title}</text>);
            const { pct, label: pctLabel } = taskQuotaPct(t, s);
            nodes.push(<box flexDirection="row"><text>   5h </text><text style={st("text")}>{barFill(pct)}</text><text style={st("text")}>{barEmpty(pct)}</text><text> {pctLabel}</text></box>);
          }
        }
      }

      return (<box flexDirection="column">{nodes}</box>);
    };

    // Sidebar footer — the V2 name for the V1 sidebar_footer slot.
    const disposers: Array<() => void> = [];
    try {
      const reg = context.ui.slot({ append: "sidebar.footer", render: (slotProps: any) => {
        try { return panel(slotProps); }
        catch (e) { tlog(`slot render err: ${String(e)}`); return <text>usage-coach</text>; }
      } });
      if (typeof reg === "function") disposers.push(reg);
      else if (reg && typeof reg.dispose === "function") disposers.push(() => reg.dispose());
      tlog("sidebar.footer slot registered");
    } catch (e) { tlog(`slot register err: ${String(e)}`); }

    return () => {
      clearInterval(timer);
      for (const d of disposers) { try { d(); } catch { /* */ } }
      tlog("unloaded");
    };
  },
});
