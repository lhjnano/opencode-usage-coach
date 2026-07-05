// index.ts — opencode-usage-coach SERVER module (defensive design)
// Closed loop: SENSE (codexbar quota) -> DECIDE (coach) -> ACT (gate / system inject)
//
// Core principle: this plugin must never break opencode, regardless of errors.
//   - Top-level try/catch: on init failure, return no-op hooks.
//   - Every hook is wrapped in try/catch; no exception propagation.
//   - tool.execute.before: never blocks on our own bugs (only intentional STOP throws).
//   - codexbar call (~3s) runs in background, never blocks the critical path. 60s TTL cache.
//   - No console.log (TUI noise). Diagnostics only to file when UC_DEBUG=1.
//
// Local load: .opencode/plugins/ or ~/.config/opencode/plugins/. Single file required.

import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { tool } from "@opencode-ai/plugin";

const PLUGIN_NAME = "opencode-usage-coach";
const DEBUG = process.env.UC_DEBUG === "1";
const TTL_MS = Number(process.env.UC_TTL_MS ?? 60000);

// Per-directory state isolation: each project dir gets its own state/harness files,
// so multiple sessions/dirs don't share harness state. UC_STATE_DIR overrides (global).
let STATE_DIR = join(homedir(), ".cache", "opencode-usage-coach");
let STATE_FILE = join(STATE_DIR, "state.json");
let HARNESS_FILE = join(STATE_DIR, "harness.json");
let LOG_FILE = join(STATE_DIR, "coach.log");
function projectStateDir(dir: string): string {
  const abs = resolve(dir || ".");
  const h = createHash("sha1").update(abs).digest("hex").slice(0, 12);
  return join(homedir(), ".cache", "opencode-usage-coach", "projects", h);
}
function setStateDir(dir: string) {
  STATE_DIR = process.env.UC_STATE_DIR ?? projectStateDir(dir);
  STATE_FILE = join(STATE_DIR, "state.json");
  HARNESS_FILE = join(STATE_DIR, "harness.json");
  LOG_FILE = join(STATE_DIR, "coach.log");
}

type QuotaWindow = { resetDescription?: string; usedPercent: number; resetsAt?: string };
type Quota = { weekly: QuotaWindow; monthly: QuotaWindow; fiveHour: QuotaWindow };
type Decision = "GO" | "THROTTLE" | "STOP";
type Coaching = { decision: Decision; advice: string; weekly: number; monthly: number; fiveHour: number };

const NOOP_HOOKS = {}; // returned on init failure so opencode keeps working

function log(msg: string) { if (DEBUG) try { appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`); } catch { /* */ } }
function writeState(c: Coaching) { try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify({ ...c, updatedAt: new Date().toISOString() })); } catch { /* */ } }

// Harness state — per-SESSION (each opencode session sees only its own harness)
type HarnessJson = { name: string; total: number; current: number; tasks: any[]; usage?: Record<string, any>; startedAt?: string; updatedAt?: string; active?: boolean };
function harnessFile(sessionID: string): string { return join(STATE_DIR, sessionID || "_default", "harness.json"); }
function readHarness(sessionID: string): HarnessJson | null {
  try { const f = harnessFile(sessionID); if (!existsSync(f)) return null; return JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
}
function writeHarness(sessionID: string, h: HarnessJson) {
  try { const f = harnessFile(sessionID); mkdirSync(dirname(f), { recursive: true }); h.updatedAt = new Date().toISOString(); writeFileSync(f, JSON.stringify(h, null, 2)); } catch { /* */ }
}

// Read harness config (workdir > global). Used by generate/grade tools + quota provider.
type HarnessCfg = { generator?: string; grader?: string; provider?: string; lighterModel?: string };
function readHarnessCfg(dir: string): HarnessCfg {
  const tryRead = (p: string): HarnessCfg => {
    try { if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")); } catch { /* */ }
    return {};
  };
  return { ...tryRead(join(homedir(), ".config", "opencode-usage-coach", "harness.config.json")),
           ...tryRead(join(dir, "harness.config.json")) };
}

// Run a specific model in a NEW session on the SAME server (no deadlock), return its text response.
// Polls session.status until the agent loop (including tool use / file writes) completes.
async function runModel(client: any, model: string, prompt: string, directory: string): Promise<string | null> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    const slash = model.indexOf("/");
    const providerID = slash >= 0 ? model.slice(0, slash) : model;
    const modelID = slash >= 0 ? model.slice(slash + 1) : "";
    const s: any = await client.session.create({ body: { title: "uc-harness-sub" }, query: { directory } });
    const id = s?.data?.info?.id;
    if (!id) return null;
    // send the prompt (starts the agent loop)
    await client.session.prompt({
      path: { id },
      body: { model: { providerID, modelID }, parts: [{ type: "text", text: prompt }] },
    });
    // poll until the session is idle (agent loop done — including file writes)
    for (let i = 0; i < 600; i++) { // 600 * 1s = 10min max
      await sleep(1000);
      const st: any = await client.session.status({ path: { id } });
      const status = st?.data?.[id]?.status ?? st?.data?.status;
      if (status === "idle" || status === "completed" || !status) break;
    }
    // read the final assistant message text
    const msgs: any = await client.session.messages({ path: { id } });
    const all = msgs?.data ?? [];
    const lastAssistant = all.filter((m: any) => m?.info?.role === "assistant").pop();
    const parts: any[] = lastAssistant?.parts ?? [];
    const text = parts.filter((p: any) => p?.type === "text").map((p: any) => p?.text ?? "").join("");
    try { await client.session.remove?.({ path: { id } }); } catch { /* */ }
    return text.trim() || null;
  } catch (e) { log(`runModel err (${model}): ${String(e)}`); return null; }
}

// Quota thresholds (override via env). Provider + lighter model come from config/env (see init).
const num = (e: string, d: number) => { try { const v = Number(process.env[e]); return Number.isFinite(v) && v >= 0 ? v : d; } catch { return d; } };
const STOP_5H = num("UC_STOP_5H", 92), THR_5H = num("UC_THROTTLE_5H", 70);
const STOP_WK = num("UC_STOP_WEEKLY", 95), THR_WK = num("UC_THROTTLE_WEEKLY", 85);
const STOP_MO = num("UC_STOP_MONTHLY", 98);

function humanRemaining(iso?: string): string {
  try {
    if (!iso) return "";
    const mins = Math.floor((new Date(iso).getTime() - Date.now()) / 60000);
    if (mins < 0) return "resets soon";
    if (mins < 60) return `resets in ${mins}m`;
    if (mins < 1440) return `resets in ${Math.floor(mins / 60)}h ${mins % 60}m`;
    return `${Math.floor(mins / 1440)}d left`;
  } catch { return ""; }
}

type ProviderCoach = { id: string; name: string; fiveHour: number; weekly: number; fiveHourReset: string; weeklyReset: string; advice: string };

/** spawn helper that captures stdout (never leaks to TUI). */
function captureStdout(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    let p;
    try { p = spawn("codexbar", args, { stdio: ["ignore", "pipe", "ignore"] }); }
    catch { return resolve(""); }
    p.stdout?.on("data", (d) => { out += d.toString(); });
    p.on("error", () => resolve(""));
    p.on("close", () => resolve(out));
  });
}

/** enabled provider ids from `codexbar config providers`. */
async function fetchEnabledProviders(): Promise<string[]> {
  const out = await captureStdout(["config", "providers"]);
  const ids: string[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*([a-zA-Z0-9_-]+):\s*enabled/);
    if (m) ids.push(m[1]);
  }
  return ids;
}

/** per-provider coaching advice: big vs small task guidance based on 5h + weekly capacity. */
function providerAdvice(h5: number, wk: number): string {
  const S5H = STOP_5H, SWK = STOP_WK, T5H = THR_5H, TWK = THR_WK;
  if (h5 >= S5H || wk >= SWK) return "STOP — finish current only";
  if (h5 >= T5H && wk >= TWK) return "small tasks only — big ones will hit both limits";
  if (h5 >= T5H) return "small tasks only — 5h window nearly full, big tasks after reset";
  if (wk >= TWK) return "small tasks only — big ones will strain late-week";
  if (h5 >= 50 || wk >= 50) return "moderate tasks OK — save big ones for headroom";
  return "big tasks OK — short & long limits comfortable";
}

/** fetch quota + advice for all enabled providers (coach view). */
async function fetchProvidersCoach(): Promise<ProviderCoach[]> {
  const ids = await fetchEnabledProviders();
  const results = await Promise.all(ids.map(async (id) => {
    try {
      const out = await captureStdout(["usage", "--provider", id, "--json"]);
      const u = (JSON.parse(out)[0]?.usage) as any;
      if (!u) return null;
      const h5 = Math.round(u.tertiary?.usedPercent ?? 0);
      const wk = Math.round(u.primary?.usedPercent ?? 0);
      return {
        id, name: id,
        fiveHour: h5, weekly: wk,
        fiveHourReset: humanRemaining(u.tertiary?.resetsAt),
        weeklyReset: humanRemaining(u.primary?.resetsAt),
        advice: providerAdvice(h5, wk),
      } as ProviderCoach;
    } catch { return null; }
  }));
  return results.filter(Boolean) as ProviderCoach[];
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
    p.on("error", () => resolve(null));
    p.on("close", () => {
      try {
        const text = out.trim();
        if (!text || text === "[]") return resolve(null);
        const u = (JSON.parse(text)[0]?.usage) as { primary?: QuotaWindow; secondary?: QuotaWindow; tertiary?: QuotaWindow } | undefined;
        if (!u) return resolve(null);
        resolve({ weekly: u.primary ?? { usedPercent: 0 }, monthly: u.secondary ?? { usedPercent: 0 }, fiveHour: u.tertiary ?? { usedPercent: 0 } });
      } catch { resolve(null); }
    });
  });
}

function coach(q: Quota | null, lighter: string): Coaching {
  if (!q) return { decision: "GO", advice: "quota unavailable — proceeding cautiously.", weekly: -1, monthly: -1, fiveHour: -1 };
  const wk = Math.round(q.weekly?.usedPercent ?? 0), mo = Math.round(q.monthly?.usedPercent ?? 0), h5 = Math.round(q.fiveHour?.usedPercent ?? 0);
  const wkR = humanRemaining(q.weekly?.resetsAt), h5R = humanRemaining(q.fiveHour?.resetsAt);
  const stop = (r: string): Coaching => ({ decision: "STOP", advice: `STOP recommend — ${r}. window nearly exhausted. stop now or it will be force-blocked.`, weekly: wk, monthly: mo, fiveHour: h5 });
  const thr = (r: string): Coaching => ({ decision: "THROTTLE", advice: `Throttle recommend — ${r}. switch to lighter model (${lighter}) or wait for window reset.`, weekly: wk, monthly: mo, fiveHour: h5 });
  if (h5 >= STOP_5H) return stop(`5h window ${h5}% (${h5R})`);
  if (wk >= STOP_WK) return stop(`weekly ${wk}% (${wkR})`);
  if (mo >= STOP_MO) return stop(`monthly ${mo}%`);
  if (h5 >= THR_5H) return thr(`5h window ${h5}% (${h5R})`);
  if (wk >= THR_WK) return thr(`weekly ${wk}% (${wkR})`);
  return { decision: "GO", advice: `Comfortable — weekly ${wk}% · 5h ${h5}% · monthly ${mo}%. proceed. 5h window ${h5R}.`, weekly: wk, monthly: mo, fiveHour: h5 };
}

const LOADING: Coaching = { decision: "GO", advice: "quota loading…", weekly: -1, monthly: -1, fiveHour: -1 };

export default async function UsageCoachPlugin(input: {
  project: unknown; client: unknown;
  $: (s: TemplateStringsArray, ...v: unknown[]) => Promise<{ stdout?: { toString(): string } | string }>;
  directory: string; worktree: string;
}) {
  // Top-level guard: even if init fails, opencode keeps working.
  try {
    setStateDir(input.directory); // per-directory state isolation
    // Provider + lighter model: env > config > empty (codexbar picks its default).
    // No hardcoded provider — this plugin is provider-agnostic.
    const cfg0 = readHarnessCfg(input.directory);
    const PROVIDER = process.env.UC_PROVIDER ?? cfg0.provider ?? "";
    const LIGHTER = process.env.UC_LIGHTER_MODEL ?? cfg0.lighterModel ?? "a lighter model";
    let last: Coaching | null = null;
    let lastFetchedAt = 0;
    let refreshing = false;

    // Background refresh: never awaited. Skips re-call within TTL.
    const refreshBackground = () => {
      try {
        if (refreshing) return;
        if (last && Date.now() - lastFetchedAt < TTL_MS) return;
        refreshing = true;
        fetchQuota(PROVIDER).then(async (q) => {
          try {
            last = coach(q, LIGHTER); lastFetchedAt = Date.now();
            // also fetch per-provider coach view (best-effort, non-blocking on failure)
            let providers: ProviderCoach[] = [];
            try { providers = await fetchProvidersCoach(); } catch { /* */ }
            writeState({ ...last, providers, updatedAt: new Date().toISOString() } as any);
            log(`${last.decision} | weekly=${last.weekly}% 5h=${last.fiveHour}% | providers=${providers.length}`);
          }
          catch (e) { log(`refresh-in-then err: ${String(e)}`); }
        }).catch((e) => { log(`fetchQuota err: ${String(e)}`); }).finally(() => { refreshing = false; });
      } catch (e) { log(`refreshBackground err: ${String(e)}`); }
    };

    // Sync current value: never throws. On error returns LOADING (GO).
    const current = (): Coaching => {
      try { if (!last) refreshBackground(); return last ?? LOADING; }
      catch { return LOADING; }
    };

    return {
      event: async ({ event }: { event: { type: string } }) => {
        try { if (event.type === "session.created" || event.type === "session.idle") refreshBackground(); }
        catch (e) { log(`event err: ${String(e)}`); }
      },

      // ACT(1) hard gate: only intentional STOP throws. Our own bugs never block.
      "tool.execute.before": async (_input: { tool: string; sessionID: string; callID: string }) => {
        let decision: Decision = "GO";
        try { decision = current().decision; } catch { decision = "GO"; } // safe default
        if (decision === "STOP") {
          throw new Error(`[${PLUGIN_NAME}] blocked: quota limit exceeded. ${current().advice}`);
        }
      },

      // ACT(2) inject coaching into system prompt (double defense). Silent on error.
      "experimental.chat.system.transform": async (_input: { sessionID?: string }, output: { system: string[] }) => {
        try {
          const c = current();
          let instruction = "";
          if (c.decision === "STOP") instruction = `[${PLUGIN_NAME}] QUOTA limit exceeded. ${c.advice} Stop making further tool calls, finish the in-progress work, then report the quota status to the user.`;
          else if (c.decision === "THROTTLE") instruction = `[${PLUGIN_NAME}] ${c.advice} Hold off on long/heavy tasks.`;
          else if (c.weekly >= 0) instruction = `[${PLUGIN_NAME}] quota ok — weekly ${c.weekly}% · 5h ${c.fiveHour}% · monthly ${c.monthly}%.`;
          if (instruction) output.system.push(instruction);
        } catch (e) { log(`system.transform err: ${String(e)}`); }
      },

      // Custom tools for the harness agent mode — report status to the panel.
      tool: {
        harness_start: tool({
          description: "Start the harness: register the total task count on the panel. Call once when the harness loop begins.",
          args: { name: tool.schema.string(), total: tool.schema.number() },
          async execute(args: { name: string; total: number }, ctx: any) {
            writeHarness(ctx.sessionID, { name: args.name, total: args.total, current: 0, tasks: [], usage: {}, active: true, startedAt: new Date().toISOString() });
            return `Harness '${args.name}' started (${args.total} tasks). Now report each task's status via task_update and run the loop.`;
          },
        }),
        task_update: tool({
          description: "Update a harness task's status on the panel. Call whenever a task transitions to generating/grading/revising/completed/failed.",
          args: {
            id: tool.schema.number(),
            title: tool.schema.string(),
            status: tool.schema.string().describe("generating | grading | revising | completed | failed | timed_out"),
            revisions: tool.schema.number().optional(),
            score: tool.schema.string().optional().describe("PASS | FAIL"),
            model: tool.schema.string().optional(),
          },
          async execute(args: { id: number; title: string; status: string; revisions?: number; score?: string; model?: string }, ctx: any) {
            const h = readHarness(ctx.sessionID) ?? { name: "batch", total: 0, current: 0, tasks: [], usage: {}, active: true };
            h.tasks = h.tasks.filter((x: any) => x.id !== args.id);
            h.tasks.push({ id: args.id, title: args.title, status: args.status, model: args.model ?? "", revisions: args.revisions ?? 0, score: args.score ?? null });
            if (args.id > h.current) h.current = args.id;
            writeHarness(ctx.sessionID, h);
            return `task ${args.id} -> ${args.status}${args.score ? ` (${args.score})` : ""}`;
          },
        }),
        harness_done: tool({
          description: "Mark the harness as complete — call when the loop ends.",
          args: {},
          async execute(_args: any, ctx: any) {
            const h = readHarness(ctx.sessionID);
            if (h) { h.current = h.total; h.active = false; writeHarness(ctx.sessionID, h); }
            return "Harness complete.";
          },
        }),
        // Per-role model execution (config-driven, same server, no deadlock).
        generate: tool({
          description: "Run the GENERATOR model on a prompt. The generator can use tools (write/edit files). Returns the model's text response.",
          args: { prompt: tool.schema.string() },
          async execute(args: { prompt: string }, ctx: any) {
            const cfg = readHarnessCfg(ctx.directory);
            if (!cfg.generator) return "ERROR: no generator model configured. Set \"generator\" in harness.config.json (see harness.config.example.json).";
            const out = await runModel(input.client, cfg.generator, args.prompt, ctx.directory);
            return out ?? `(generator ${cfg.generator} produced no text)`;
          },
        }),
        generate_batch: tool({
          description: "Run the GENERATOR model on MULTIPLE tasks in PARALLEL. Pass an array of {id, prompt}. Returns all results at once. Use for INDEPENDENT tasks (much faster than sequential generate calls).",
          args: { tasks: tool.schema.array(tool.schema.object({ id: tool.schema.number(), prompt: tool.schema.string() })) },
          async execute(args: { tasks: Array<{ id: number; prompt: string }> }, ctx: any) {
            const cfg = readHarnessCfg(ctx.directory);
            if (!cfg.generator) return "ERROR: no generator model configured. Set \"generator\" in harness.config.json (see harness.config.example.json).";
            const results = await Promise.all(args.tasks.map(async (t) => {
              const out = await runModel(input.client, cfg.generator, t.prompt, ctx.directory);
              return `[task ${t.id}] ${out ?? "(no output)"}`;
            }));
            return results.join("\n\n");
          },
        }),
        grade: tool({
          description: "Run the GRADER model on a prompt. Returns PASS/FAIL on the first line. Falls back to generator if grader quota is out.",
          args: { prompt: tool.schema.string() },
          async execute(args: { prompt: string }, ctx: any) {
            const cfg = readHarnessCfg(ctx.directory);
            const model = cfg.grader ?? cfg.generator;
            if (!model) return "ERROR: no grader/generator model configured. Set \"grader\" (and \"generator\") in harness.config.json (see harness.config.example.json).";
            const out = await runModel(input.client, model, args.prompt, ctx.directory);
            return out ?? `(grader ${model} produced no text)`;
          },
        }),
      },
    };
  } catch (e) {
    // Init failure: return no-op so opencode keeps working.
    log(`PLUGIN INIT FAILED (no-op): ${String(e)}`);
    return NOOP_HOOKS;
  }
}
