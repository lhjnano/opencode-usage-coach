// quota.ts — the quota state machine, extracted verbatim from the V1 plugin
// closure (index.ts) so the V1 and V2 adapters share ONE implementation.
//
// SENSE → DECIDE pipeline: codexbar quota fetch → coach() decision
// (GO / THROTTLE / STOP) → state.json write for the TUI. The machine owns:
//   last / lastKnownQuota / lastFetchedAt / refreshing   (refresh cycle + TTL dedup)
//   currentModel / currentProvider / modelChanged        (model tracking; setModel
//                                                         flips modelChanged on swap)
// Everything state-shaped (writeState, log) stays in index.ts and is either
// injected (stateWriter) or imported — `log`/`writeState` are function
// declarations there, so the deferred index.ts ↔ quota.ts import cycle is safe
// (same pattern as tool-defs.ts: every cross-module reference sits inside a
// function body evaluated long after both modules finish loading).
//
// codexbar fetch layer (spawn/parse/retry/coach view) also lives here; tests
// inject `fetchQuota` to drive the machine deterministically.
import { spawn } from "node:child_process";
import { log, writeState } from "./index.js";

export type QuotaWindow = { resetDescription?: string; usedPercent?: number; resetsAt?: string; windowMinutes?: number };
export type Quota = { weekly: QuotaWindow | null; monthly: QuotaWindow | null; fiveHour: QuotaWindow | null };
export type Decision = "GO" | "THROTTLE" | "STOP";
export type Coaching = { decision: Decision; advice: string; weekly: number; monthly: number; fiveHour: number; model?: string; provider?: string; isFree?: boolean };

const TTL_MS = Number(process.env.UC_TTL_MS ?? 60000);

// Quota thresholds (override via env). Provider + lighter model come from config/env (see init).
const num = (e: string, d: number) => { try { const v = Number(process.env[e]); return Number.isFinite(v) && v >= 0 ? v : d; } catch { return d; } };
const STOP_5H = num("UC_STOP_5H", 92), THR_5H = num("UC_THROTTLE_5H", 70);
const STOP_WK = num("UC_STOP_WEEKLY", 95), THR_WK = num("UC_THROTTLE_WEEKLY", 85);
const STOP_MO = num("UC_STOP_MONTHLY", 98);

export function humanRemaining(iso?: string): string {
  try {
    if (!iso) return "";
    const ms = new Date(iso).getTime();
    if (Number.isNaN(ms)) return "";
    const mins = Math.floor((ms - Date.now()) / 60000);
    if (mins < 0) return "resets soon";
    if (mins < 60) return `resets in ${mins}m`;
    if (mins < 1440) return `resets in ${Math.floor(mins / 60)}h ${mins % 60}m`;
    return `${Math.floor(mins / 1440)}d left`;
  } catch { return ""; }
}

type ProviderCoach = { id: string; name: string; fiveHour: number; weekly: number; fiveHourReset: string; weeklyReset: string; advice: string };

let codexbarMissing = false; // set true on ENOENT — skip all future codexbar spawns

/** Test accessor for the codexbarMissing flag. */
export function isCodexbarMissing(): boolean { return codexbarMissing; }

/** Test-only: reset the codexbarMissing flag for test isolation. */
export function __resetCodexbarMissing(): void { codexbarMissing = false; }

/** spawn helper that captures stdout (never leaks to TUI). */
function captureStdout(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    let p;
    try { p = spawn("codexbar", args, { stdio: ["ignore", "pipe", "ignore"] }); }
    catch { return resolve(""); }
    p.stdout?.on("data", (d) => { out += d.toString(); });
    p.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") codexbarMissing = true;
      resolve("");
    });
    p.on("close", () => resolve(out));
  });
}

/** enabled provider ids from `codexbar config providers`. */
async function fetchEnabledProviders(): Promise<string[]> {
  if (codexbarMissing) return [];
  const out = await captureStdout(["config", "providers"]);
  const ids: string[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*([a-zA-Z0-9_-]+):\s*enabled/);
    if (m) ids.push(m[1]);
  }
  return ids;
}

/** per-provider coaching advice: big vs small task guidance based on 5h + weekly capacity. */
export function providerAdvice(h5: number | null, wk: number | null): string {
  const S5H = STOP_5H, SWK = STOP_WK, T5H = THR_5H, TWK = THR_WK;
  if ((h5 !== null && h5 >= S5H) || (wk !== null && wk >= SWK)) return "STOP — finish current only";
  if (h5 !== null && wk !== null && h5 >= T5H && wk >= TWK) return "small tasks only — big ones will hit both limits";
  if (h5 !== null && h5 >= T5H) return "small tasks only — 5h window nearly full, big tasks after reset";
  if (wk !== null && wk >= TWK) return "small tasks only — big ones will strain late-week";
  if ((h5 !== null && h5 >= 50) || (wk !== null && wk >= 50)) return "moderate tasks OK — save big ones for headroom";
  return "big tasks OK — short & long limits comfortable";
}

/** fetch quota + advice for all enabled providers (coach view). */
async function fetchProvidersCoach(): Promise<ProviderCoach[]> {
  const ids = await fetchEnabledProviders();
  const results = await Promise.all(ids.map(async (id) => {
    try {
      const out = await captureStdout(["usage", "--provider", id, "--json"]);
      const q = parseQuotaResponse(out);
      if (!q) return null;
      const h5 = q.fiveHour ? Math.round(q.fiveHour.usedPercent ?? 0) : null;
      const wk = q.weekly ? Math.round(q.weekly.usedPercent ?? 0) : null;
      return {
        id, name: id,
        fiveHour: h5 ?? -1, weekly: wk ?? -1,
        fiveHourReset: q.fiveHour ? humanRemaining(q.fiveHour.resetsAt) : "",
        weeklyReset: q.weekly ? humanRemaining(q.weekly.resetsAt) : "",
        advice: providerAdvice(h5, wk),
      } as ProviderCoach;
    } catch { return null; }
  }));
  return results.filter(Boolean) as ProviderCoach[];
}

/** Parse raw codexbar --json output into a Quota object. Pure function — no I/O.
 *  Classifies windows by windowMinutes/resetDescription, falling back to slot
 *  position (primary/secondary/tertiary) for legacy data without those fields. */
export function parseQuotaResponse(rawText: string): Quota | null {
  try {
    const text = (rawText || "").trim();
    if (!text || text === "[]") return null;
    const u = (JSON.parse(text)[0]?.usage) as { primary?: QuotaWindow; secondary?: QuotaWindow; tertiary?: QuotaWindow } | undefined;
    if (!u) return null;

    const result: Quota = { weekly: null, monthly: null, fiveHour: null };
    const entries = [
      { key: "primary", slot: u.primary },
      { key: "secondary", slot: u.secondary },
      { key: "tertiary", slot: u.tertiary },
    ].filter((e) => e.slot != null);

    for (const { key, slot } of entries) {
      const mins = slot!.windowMinutes ?? 0;
      const desc = String(slot!.resetDescription ?? "").toLowerCase();

      if (mins === 300 || desc.includes("5 hour") || desc.includes("5h")) {
        result.fiveHour = slot!;
      } else if (mins === 10080 || desc.includes("week")) {
        result.weekly = slot!;
      } else if (desc.includes("month")) {
        result.monthly = slot!;
      } else if (mins > 0 && mins <= 360) {
        result.fiveHour = slot!;
      } else if (mins > 360 && mins <= 14400) {
        result.weekly = slot!;
      } else if (mins > 14400) {
        result.monthly = slot!;
      } else if (key === "primary") {
        result.weekly = slot!;
      } else if (key === "secondary") {
        result.monthly = slot!;
      } else if (key === "tertiary") {
        result.fiveHour = slot!;
      }
    }

    return result;
  } catch { return null; }
}

// spawn codexbar — capture stdout in a pipe only, never leak to parent stdio (TUI).
// (opencode $ BunShell displays command output in the TUI, so $ must not be used here.)
// provider="" omits --provider so codexbar uses its default.
function fetchQuota(provider: string): Promise<Quota | null> {
  return new Promise((resolve) => {
    let out = "";
    let p;
    try {
      const args = provider ? ["usage", "--provider", provider, "--json"] : ["usage", "--json"];
      p = spawn("codexbar", args, {
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch { return resolve(null); }
    p.stdout?.on("data", (d) => { out += d.toString(); });
    p.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") codexbarMissing = true;
      resolve(null);
    });
    p.on("close", () => {
      resolve(parseQuotaResponse(out));
    });
  });
}

/** fetchQuota with retry: max 3 attempts with 1s, 2s delays between failures. */
export async function fetchQuotaWithRetry(provider: string, maxRetries = 3): Promise<Quota | null> {
  if (codexbarMissing) return null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const q = await fetchQuota(provider);
    if (q) return q;
    if (attempt < maxRetries - 1) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return null;
}

export function coach(q: Quota | null, lighter: string): Coaching {
  if (!q) return { decision: "GO", advice: "quota unavailable — retrying. proceeding cautiously.", weekly: -2, monthly: -2, fiveHour: -2 };
  const wk = q.weekly ? Math.round(q.weekly.usedPercent ?? 0) : null;
  const mo = q.monthly ? Math.round(q.monthly.usedPercent ?? 0) : null;
  const h5 = q.fiveHour ? Math.round(q.fiveHour.usedPercent ?? 0) : null;
  if ((wk !== null && Number.isNaN(wk)) || (mo !== null && Number.isNaN(mo)) || (h5 !== null && Number.isNaN(h5))) {
    const sWk = wk !== null && !Number.isNaN(wk) ? wk : 0;
    const sMo = mo !== null && !Number.isNaN(mo) ? mo : 0;
    const sH5 = h5 !== null && !Number.isNaN(h5) ? h5 : 0;
    return { decision: "THROTTLE", advice: "invalid quota data — proceeding with caution. switch to lighter model if available.", weekly: sWk, monthly: sMo, fiveHour: sH5 };
  }
  const wkR = q.weekly ? humanRemaining(q.weekly.resetsAt) : "";
  const h5R = q.fiveHour ? humanRemaining(q.fiveHour.resetsAt) : "";
  const stop = (r: string): Coaching => ({ decision: "STOP", advice: `STOP recommend — ${r}. window nearly exhausted. stop now or it will be force-blocked.`, weekly: wk ?? -1, monthly: mo ?? -1, fiveHour: h5 ?? -1 });
  const thr = (r: string): Coaching => ({ decision: "THROTTLE", advice: `Throttle recommend — ${r}. switch to lighter model (${lighter}) or wait for window reset.`, weekly: wk ?? -1, monthly: mo ?? -1, fiveHour: h5 ?? -1 });
  if (h5 !== null && h5 >= STOP_5H) return stop(`5h window ${h5}% (${h5R})`);
  if (wk !== null && wk >= STOP_WK) return stop(`weekly ${wk}% (${wkR})`);
  if (mo !== null && mo >= STOP_MO) return stop(`monthly ${mo}%`);
  if (h5 !== null && h5 >= THR_5H) return thr(`5h window ${h5}% (${h5R})`);
  if (wk !== null && wk >= THR_WK) return thr(`weekly ${wk}% (${wkR})`);
  const parts: string[] = [];
  if (wk !== null) parts.push(`weekly ${wk}%`);
  if (h5 !== null) parts.push(`5h ${h5}%`);
  if (mo !== null) parts.push(`monthly ${mo}%`);
  const summary = parts.length > 0 ? parts.join(" · ") : "no quota limits detected";
  const resetInfo = h5R ? ` 5h window ${h5R}.` : wkR ? ` weekly ${wkR}.` : "";
  return { decision: "GO", advice: `Comfortable — ${summary}. proceed.${resetInfo}`, weekly: wk ?? -1, monthly: mo ?? -1, fiveHour: h5 ?? -1 };
}

export function isFreeModel(model: string, provider: string): boolean {
  if (!model && !provider) return false;
  if (provider === "opencode") return true;
  if (model.toLowerCase().includes("free")) return true;
  return false;
}

// Map opencode providerID (e.g. "zai-coding-plan") to codexbar provider name (e.g. "zai").
export function providerToCodexbar(provider: string): string {
  if (!provider) return "";
  const first = provider.split("-")[0];
  return first || provider; // fallback to full provider if first segment is empty (e.g. "-openai")
}

const LOADING: Coaching = { decision: "GO", advice: "quota loading…", weekly: -1, monthly: -1, fiveHour: -1 };

// ── The quota machine ────────────────────────────────────────────────────────
// Factory-extracted V1 closure state. Behavior is byte-identical to the code
// that lived inside UsageCoachPlugin: same TTL dedup, same model-change forced
// refresh, same free-model short-circuit, same providers-restore fallback.
export type QuotaMachine = {
  current(): Coaching;
  refresh(): void;
  /** resolveAgent feeds this; a model swap flips modelChanged (forces a refresh). */
  setModel(model: string, provider: string): void;
  /** Force the next refresh to bypass the TTL dedup. */
  markModelChanged(): void;
};

export function createQuotaMachine(opts: {
  directory: string;
  /** injectable for tests; default = the codexbar fetchQuotaWithRetry above */
  fetchQuota?: (provider: string) => Promise<Quota | null>;
  /** default = index.ts writeState (state.json for the TUI) */
  stateWriter?: (state: any) => void;
  /** env > harness.config provider fallback ("" = codexbar default) */
  provider?: string;
  /** lighter-model name for THROTTLE advice */
  lighter?: string;
  /** current agent name for the state.json payload */
  getAgent?: () => string;
}): QuotaMachine {
  const PROVIDER = opts.provider ?? "";
  const LIGHTER = opts.lighter ?? "a lighter model";
  const agentOf = opts.getAgent ?? (() => "");
  const doFetch = opts.fetchQuota ?? ((provider: string) => fetchQuotaWithRetry(provider));
  const persist = opts.stateWriter ?? ((c: any) => writeState(c));
  // Provider + lighter model defaults live per-machine (computed by the adapter
  // at init from env > config, mirroring the V1 closure's PROVIDER/LIGHTER).

  let last: Coaching | null = null;
  let lastKnownQuota: Quota | null = null; // persists across refresh cycles for retry fallback
  let lastFetchedAt = 0;
  let refreshing = false;
  let currentModel = "";
  let currentProvider = "";
  let modelChanged = false; // set by setModel on model change, cleared by refreshBackground

  // Background refresh: never awaited. Skips re-call within TTL.
  // Also triggered on model change (lastFetchedAt reset by caller).
  const refreshBackground = () => {
    try {
      if (refreshing) return;
      if (codexbarMissing) {
        last = { decision: "GO", advice: "codexbar not installed — running in GO-only mode (no quota sensing).", weekly: -3, monthly: -3, fiveHour: -3 };
        lastFetchedAt = Date.now();
        refreshing = false;
        return;
      }
      if (last && !modelChanged && Date.now() - lastFetchedAt < TTL_MS) return;
      refreshing = true;
      modelChanged = false; // consumed

      // Free model short-circuit: no quota to track.
      if (isFreeModel(currentModel, currentProvider)) {
        last = { decision: "GO", advice: `${currentModel || currentProvider || "free model"} — no quota limit.`, weekly: -1, monthly: -1, fiveHour: -1, model: currentModel, provider: currentProvider, isFree: true };
        lastFetchedAt = Date.now();
        persist({ ...last, providers: [], model: currentModel, provider: currentProvider, isFree: true, agent: agentOf(), updatedAt: new Date().toISOString() } as any);
        log(`FREE | model=${currentModel} provider=${currentProvider}`);
        refreshing = false;
        return;
      }

      // Paid model: fetch quota for the ACTIVE provider (detected from session), mapped to codexbar name.
      const activeProvider = providerToCodexbar(currentProvider) || PROVIDER;
      doFetch(activeProvider).then(async (q) => {
        try {
          if (q) lastKnownQuota = q; // cache for retry fallback
          const effectiveQ = q ?? lastKnownQuota; // fall back to last known good
          last = coach(effectiveQ, LIGHTER); lastFetchedAt = Date.now();
          // also fetch per-provider coach view (best-effort, non-blocking on failure)
          let providers: ProviderCoach[] = [];
          try { providers = await fetchProvidersCoach(); } catch { /* */ }
          // If primary fetch failed (all windows < 0) but providers have real data,
          // restore the top-level from providers[0] so the TUI/advice show real numbers.
          if (providers.length > 0 && last.weekly < 0 && last.fiveHour < 0) {
            const p0 = providers[0];
            const newWeekly = p0.weekly >= 0 ? p0.weekly : last.weekly;
            const newFiveHour = p0.fiveHour >= 0 ? p0.fiveHour : last.fiveHour;
            const newDecision = (newWeekly >= STOP_WK || newFiveHour >= STOP_5H) ? "STOP" : (newWeekly >= THR_WK || newFiveHour >= THR_5H) ? "THROTTLE" : "GO";
            last = { ...last, weekly: newWeekly, fiveHour: newFiveHour, advice: p0.advice, decision: newDecision as Decision };
          }
          persist({ ...last, providers, model: currentModel, provider: currentProvider, isFree: false, agent: agentOf(), updatedAt: new Date().toISOString() } as any);
          log(`${last.decision} | weekly=${last.weekly}% 5h=${last.fiveHour}% | providers=${providers.length}`);
        }
        catch (e) { log(`refresh-in-then err: ${String(e)}`); }
      }).catch((e) => { log(`fetchQuotaWithRetry err: ${String(e)}`); }).finally(() => { refreshing = false; });
    } catch (e) { log(`refreshBackground err: ${String(e)}`); }
  };

  // Sync current value: never throws. On error returns LOADING (GO).
  const current = (): Coaching => {
    try { if (!last) refreshBackground(); return last ?? LOADING; }
    catch { return LOADING; }
  };

  const setModel = (model: string, provider: string) => {
    // Detect model change (same check resolveAgent used to inline).
    if (currentModel && model && currentModel !== model) {
      log(`MODEL CHANGED: ${currentModel} → ${model} (provider: ${currentProvider} → ${provider})`);
      modelChanged = true;
    }
    currentModel = model;
    currentProvider = provider;
  };

  return {
    current,
    refresh: refreshBackground,
    setModel,
    markModelChanged() { modelChanged = true; },
  };
}
