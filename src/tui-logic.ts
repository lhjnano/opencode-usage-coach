// tui-logic.ts — Pure rendering-logic functions extracted from tui.tsx.
// These are the computations that drive every rendering decision in the TUI:
// staleness thresholds, progress bars, status-to-label mapping, visibility rules,
// quota display. Extracted so they can be unit-tested without a terminal runtime.

// ── Types ────────────────────────────────────────────────────────────────────

export type TaskState = {
  id: number;
  title: string;
  status: string;
  model?: string;
  revisions?: number;
  score?: string | null;
  startedAt?: string;
  subSessionId?: string;
  subStep?: number;
  lastActivity?: string;
  subElapsed?: number;
};

export type ProviderCoach = {
  id: string;
  name: string;
  fiveHour: number;
  weekly: number;
  fiveHourReset: string;
  weeklyReset: string;
  advice: string;
};

export type HarnessState = {
  name: string;
  total: number;
  current: number;
  tasks: TaskState[];
  quotas?: Record<string, { weekly: number; monthly: number; fiveHour: number }>;
  active?: boolean;
  updatedAt?: string;
};

export type QuotaState = {
  decision: "GO" | "THROTTLE" | "STOP";
  advice: string;
  weekly: number;
  monthly: number;
  fiveHour: number;
  providers?: ProviderCoach[];
  model?: string;
  provider?: string;
  isFree?: boolean;
  agent?: string;
};

// ── Constants ────────────────────────────────────────────────────────────────

export const STALE_MS = 5 * 60_000;   // 5 min: mark non-terminal tasks as STALE
export const HIDE_MS  = 30 * 60_000;  // 30 min: hide the whole harness section

export const TAG: Record<string, string> = {
  GO: "ok",
  THROTTLE: "slow",
  STOP: "STOP",
};

export const TLABEL: Record<string, string> = {
  generating: "gen",
  grading: "grade",
  revising: "revise",
  completed: "done",
  failed: "fail",
  timed_out: "timeout",
  halted_quota: "quota-halt",
  stale: "STALE",
};

export const STATUS_KEY: Record<string, string> = {
  generating: "info",
  grading: "accent",
  revising: "warning",
  completed: "success",
  failed: "error",
  timed_out: "error",
  halted_quota: "error",
};

export const TERMINAL_STATUSES = new Set([
  "completed", "failed", "timed_out", "halted_quota",
]);

// ── Progress bar ─────────────────────────────────────────────────────────────

export function barFill(p: number): string {
  const n = (!Number.isFinite(p) || p <= 0) ? 0 : Math.max(1, Math.min(10, Math.round(p / 10)));
  return "\u2588".repeat(n);
}

export function barEmpty(p: number): string {
  const n = (!Number.isFinite(p) || p <= 0) ? 0 : Math.max(1, Math.min(10, Math.round(p / 10)));
  return "\u2591".repeat(10 - n);
}

// ── Staleness computation ────────────────────────────────────────────────────

export type StalenessResult = {
  hAge: number;
  hasActiveSub: boolean;
  isStale: boolean;
  shouldHide: boolean;
};

export function computeStaleness(
  h: HarnessState,
  now: number = Date.now(),
): StalenessResult {
  const hAge = h.updatedAt ? now - new Date(h.updatedAt).getTime() : 0;
  const hasActiveSub = h.tasks.some((t) => !!t.subSessionId);
  const isStale = !hasActiveSub && hAge > STALE_MS;
  const shouldHide = hAge > HIDE_MS && !hasActiveSub;
  return { hAge, hasActiveSub, isStale, shouldHide };
}

// ── Harness visibility ───────────────────────────────────────────────────────

export function isHarnessVisible(h: HarnessState | null, staleness: StalenessResult): boolean {
  if (!h) return false;
  if (h.tasks.length === 0) return false;
  if (h.active !== true) return false;
  if (staleness.shouldHide) return false;
  return true;
}

// ── Task display computation ─────────────────────────────────────────────────

export type TaskDisplay = {
  displayStatus: string;
  themeKey: string;
  label: string;
  revSuffix: string;
  modelStr: string;
  stepStr: string;
  elapsedStr: string;
  hasSub: boolean;
  subWarn: boolean;
};

export function computeTaskDisplay(
  t: TaskState,
  isStale: boolean,
  now: number = Date.now(),
): TaskDisplay {
  const displayStatus = isStale && !TERMINAL_STATUSES.has(t.status) ? "stale" : t.status;
  const sKey = STATUS_KEY[displayStatus] ?? "text";
  const lbl = TLABEL[displayStatus] ?? displayStatus;
  const rev = (t.revisions ?? 0) > 0 && t.status === "revising" ? `(${t.revisions})` : "";
  const mdl = t.model ? ` ${(t.model.split("/").pop() ?? t.model)}` : "";

  const hasSub = !!t.subSessionId;
  const subStepStr = hasSub && t.subStep !== undefined && t.subStep > 0 ? ` step:${t.subStep}` : "";
  const subEl = hasSub && t.subElapsed !== undefined ? ` ${t.subElapsed}s` : "";
  const subWarn = hasSub && (t.subElapsed ?? 0) > 300;

  const elapsed = t.startedAt ? Math.max(0, Math.round((now - new Date(t.startedAt).getTime()) / 1000)) : 0;
  const taskEl = (t.status === "completed" || t.status === "failed") ? "" : (elapsed > 0 ? ` ${elapsed}s` : "");
  const displayEl = hasSub ? subEl : taskEl;

  const lineKey = subWarn ? "warning" : sKey;

  return {
    displayStatus,
    themeKey: lineKey,
    label: lbl,
    revSuffix: rev,
    modelStr: mdl,
    stepStr: subStepStr,
    elapsedStr: displayEl,
    hasSub,
    subWarn,
  };
}

// ── Quota display ────────────────────────────────────────────────────────────

export function decisionThemeKey(decision: QuotaState["decision"]): string {
  return decision === "GO" ? "success" : decision === "THROTTLE" ? "warning" : "error";
}

export function taskQuotaPct(
  t: TaskState,
  s: QuotaState | null,
): { pct: number; label: string } {
  const pv = t.model ? (t.model.split("/")[0] ?? "").split("-")[0] : "";
  const provCoach = pv
    ? s?.providers?.find((p) => p.id === pv || (pv && p.id.startsWith(pv)) || (pv && pv.startsWith(p.id)))
    : s?.providers?.[0];
  const rawPct = provCoach?.fiveHour ?? s?.fiveHour ?? -1;
  const pct = rawPct < 0 ? 0 : rawPct;
  const label = rawPct === -1 ? "…" : rawPct < 0 ? "retry" : `${rawPct}%`;
  return { pct, label };
}

// ── Full harness render data ─────────────────────────────────────────────────

export type HarnessRenderData = {
  visible: boolean;
  isStale: boolean;
  header: string | null;
  progress: { current: number; total: number } | null;
  tasks: Array<{
    id: number;
    title: string;
    display: TaskDisplay;
    quota: { pct: number; label: string; fill: string; empty: string };
  }>;
};

export function computeHarnessRender(
  h: HarnessState | null,
  s: QuotaState | null,
  now: number = Date.now(),
): HarnessRenderData {
  if (!h) {
    return { visible: false, isStale: false, header: null, progress: null, tasks: [] };
  }
  const staleness = computeStaleness(h, now);
  const visible = isHarnessVisible(h, staleness);
  if (!visible) {
    return { visible: false, isStale: staleness.isStale, header: null, progress: null, tasks: [] };
  }
  const staleSuffix = staleness.isStale ? " (stale)" : "";
  const header = `harness: ${h.name} ${h.current}/${h.total}${staleSuffix}`;
  const tasks = h.tasks.map((t) => {
    const display = computeTaskDisplay(t, staleness.isStale, now);
    const { pct, label } = taskQuotaPct(t, s);
    return {
      id: t.id,
      title: t.title,
      display,
      quota: { pct, label, fill: barFill(pct), empty: barEmpty(pct) },
    };
  });
  return {
    visible: true,
    isStale: staleness.isStale,
    header,
    progress: { current: h.current, total: h.total },
    tasks,
  };
}
