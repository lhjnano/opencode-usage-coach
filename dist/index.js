// src/index.ts
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "fs";
import { spawn } from "child_process";
import { createHash } from "crypto";
import { homedir } from "os";
import { join, resolve, dirname } from "path";
import { tool } from "@opencode-ai/plugin";
var PLUGIN_NAME = "opencode-usage-coach";
var DEBUG = process.env.UC_DEBUG === "1";
var TTL_MS = Number(process.env.UC_TTL_MS ?? 6e4);
var STATE_DIR = join(homedir(), ".cache", "opencode-usage-coach");
var STATE_FILE = join(STATE_DIR, "state.json");
var HARNESS_FILE = join(STATE_DIR, "harness.json");
var LOG_FILE = join(STATE_DIR, "coach.log");
function projectStateDir(dir) {
  const abs = resolve(dir || ".");
  const h = createHash("sha1").update(abs).digest("hex").slice(0, 12);
  return join(homedir(), ".cache", "opencode-usage-coach", "projects", h);
}
function setStateDir(dir) {
  STATE_DIR = process.env.UC_STATE_DIR ?? projectStateDir(dir);
  STATE_FILE = join(STATE_DIR, "state.json");
  HARNESS_FILE = join(STATE_DIR, "harness.json");
  LOG_FILE = join(STATE_DIR, "coach.log");
}
var NOOP_HOOKS = {};
function log(msg) {
  if (DEBUG) try {
    appendFileSync(LOG_FILE, `${(/* @__PURE__ */ new Date()).toISOString()} ${msg}
`);
  } catch {
  }
}
function writeState(c) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ ...c, updatedAt: (/* @__PURE__ */ new Date()).toISOString() }));
  } catch {
  }
}
function harnessFile(sessionID) {
  return join(STATE_DIR, sessionID || "_default", "harness.json");
}
function readHarness(sessionID) {
  try {
    const f = harnessFile(sessionID);
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}
function writeHarness(sessionID, h) {
  try {
    const f = harnessFile(sessionID);
    mkdirSync(dirname(f), { recursive: true });
    h.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    writeFileSync(f, JSON.stringify(h, null, 2));
  } catch {
  }
}
function readHarnessCfg(dir) {
  const tryRead = (p) => {
    try {
      if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
    } catch {
    }
    return {};
  };
  return {
    ...tryRead(join(homedir(), ".config", "opencode-usage-coach", "harness.config.json")),
    ...tryRead(join(dir, "harness.config.json"))
  };
}
async function runModel(client, model, prompt, directory) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const slash = model.indexOf("/");
    const providerID = slash >= 0 ? model.slice(0, slash) : model;
    const modelID = slash >= 0 ? model.slice(slash + 1) : "";
    const s = await client.session.create({ body: { title: "uc-harness-sub" }, query: { directory } });
    const id = s?.data?.info?.id;
    if (!id) return null;
    await client.session.prompt({
      path: { id },
      body: { model: { providerID, modelID }, parts: [{ type: "text", text: prompt }] }
    });
    for (let i = 0; i < 600; i++) {
      await sleep(1e3);
      const st = await client.session.status({ path: { id } });
      const status = st?.data?.[id]?.status ?? st?.data?.status;
      if (status === "idle" || status === "completed" || !status) break;
    }
    const msgs = await client.session.messages({ path: { id } });
    const all = msgs?.data ?? [];
    const lastAssistant = all.filter((m) => m?.info?.role === "assistant").pop();
    const parts = lastAssistant?.parts ?? [];
    const text = parts.filter((p) => p?.type === "text").map((p) => p?.text ?? "").join("");
    try {
      await client.session.remove?.({ path: { id } });
    } catch {
    }
    return text.trim() || null;
  } catch (e) {
    log(`runModel err (${model}): ${String(e)}`);
    return null;
  }
}
var PROVIDER = process.env.UC_PROVIDER ?? "zai";
var num = (e, d) => {
  try {
    const v = Number(process.env[e]);
    return Number.isFinite(v) && v >= 0 ? v : d;
  } catch {
    return d;
  }
};
var STOP_5H = num("UC_STOP_5H", 92);
var THR_5H = num("UC_THROTTLE_5H", 70);
var STOP_WK = num("UC_STOP_WEEKLY", 95);
var THR_WK = num("UC_THROTTLE_WEEKLY", 85);
var STOP_MO = num("UC_STOP_MONTHLY", 98);
var LIGHTER = process.env.UC_LIGHTER_MODEL ?? "glm-4.5-air";
function humanRemaining(iso) {
  try {
    if (!iso) return "";
    const mins = Math.floor((new Date(iso).getTime() - Date.now()) / 6e4);
    if (mins < 0) return "resets soon";
    if (mins < 60) return `resets in ${mins}m`;
    if (mins < 1440) return `resets in ${Math.floor(mins / 60)}h ${mins % 60}m`;
    return `${Math.floor(mins / 1440)}d left`;
  } catch {
    return "";
  }
}
function captureStdout(args) {
  return new Promise((resolve2) => {
    let out = "";
    let p;
    try {
      p = spawn("codexbar", args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return resolve2("");
    }
    p.stdout?.on("data", (d) => {
      out += d.toString();
    });
    p.on("error", () => resolve2(""));
    p.on("close", () => resolve2(out));
  });
}
async function fetchEnabledProviders() {
  const out = await captureStdout(["config", "providers"]);
  const ids = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*([a-zA-Z0-9_-]+):\s*enabled/);
    if (m) ids.push(m[1]);
  }
  return ids;
}
function providerAdvice(h5, wk) {
  const S5H = STOP_5H, SWK = STOP_WK, T5H = THR_5H, TWK = THR_WK;
  if (h5 >= S5H || wk >= SWK) return "STOP \u2014 finish current only";
  if (h5 >= T5H && wk >= TWK) return "small tasks only \u2014 big ones will hit both limits";
  if (h5 >= T5H) return "small tasks only \u2014 5h window nearly full, big tasks after reset";
  if (wk >= TWK) return "small tasks only \u2014 big ones will strain late-week";
  if (h5 >= 50 || wk >= 50) return "moderate tasks OK \u2014 save big ones for headroom";
  return "big tasks OK \u2014 short & long limits comfortable";
}
async function fetchProvidersCoach() {
  const ids = await fetchEnabledProviders();
  const results = await Promise.all(ids.map(async (id) => {
    try {
      const out = await captureStdout(["usage", "--provider", id, "--json"]);
      const u = JSON.parse(out)[0]?.usage;
      if (!u) return null;
      const h5 = Math.round(u.tertiary?.usedPercent ?? 0);
      const wk = Math.round(u.primary?.usedPercent ?? 0);
      return {
        id,
        name: id,
        fiveHour: h5,
        weekly: wk,
        fiveHourReset: humanRemaining(u.tertiary?.resetsAt),
        weeklyReset: humanRemaining(u.primary?.resetsAt),
        advice: providerAdvice(h5, wk)
      };
    } catch {
      return null;
    }
  }));
  return results.filter(Boolean);
}
function fetchQuota() {
  return new Promise((resolve2) => {
    let out = "";
    let p;
    try {
      p = spawn("codexbar", ["usage", "--provider", PROVIDER, "--json"], {
        stdio: ["ignore", "pipe", "ignore"]
      });
    } catch {
      return resolve2(null);
    }
    p.stdout?.on("data", (d) => {
      out += d.toString();
    });
    p.on("error", () => resolve2(null));
    p.on("close", () => {
      try {
        const text = out.trim();
        if (!text || text === "[]") return resolve2(null);
        const u = JSON.parse(text)[0]?.usage;
        if (!u) return resolve2(null);
        resolve2({ weekly: u.primary ?? { usedPercent: 0 }, monthly: u.secondary ?? { usedPercent: 0 }, fiveHour: u.tertiary ?? { usedPercent: 0 } });
      } catch {
        resolve2(null);
      }
    });
  });
}
function coach(q) {
  if (!q) return { decision: "GO", advice: "quota unavailable \u2014 proceeding cautiously.", weekly: -1, monthly: -1, fiveHour: -1 };
  const wk = Math.round(q.weekly?.usedPercent ?? 0), mo = Math.round(q.monthly?.usedPercent ?? 0), h5 = Math.round(q.fiveHour?.usedPercent ?? 0);
  const wkR = humanRemaining(q.weekly?.resetsAt), h5R = humanRemaining(q.fiveHour?.resetsAt);
  const stop = (r) => ({ decision: "STOP", advice: `STOP recommend \u2014 ${r}. window nearly exhausted. stop now or it will be force-blocked.`, weekly: wk, monthly: mo, fiveHour: h5 });
  const thr = (r) => ({ decision: "THROTTLE", advice: `Throttle recommend \u2014 ${r}. switch to lighter model (${LIGHTER}) or wait for window reset.`, weekly: wk, monthly: mo, fiveHour: h5 });
  if (h5 >= STOP_5H) return stop(`5h window ${h5}% (${h5R})`);
  if (wk >= STOP_WK) return stop(`weekly ${wk}% (${wkR})`);
  if (mo >= STOP_MO) return stop(`monthly ${mo}%`);
  if (h5 >= THR_5H) return thr(`5h window ${h5}% (${h5R})`);
  if (wk >= THR_WK) return thr(`weekly ${wk}% (${wkR})`);
  return { decision: "GO", advice: `Comfortable \u2014 weekly ${wk}% \xB7 5h ${h5}% \xB7 monthly ${mo}%. proceed. 5h window ${h5R}.`, weekly: wk, monthly: mo, fiveHour: h5 };
}
var LOADING = { decision: "GO", advice: "quota loading\u2026", weekly: -1, monthly: -1, fiveHour: -1 };
async function UsageCoachPlugin(input) {
  try {
    setStateDir(input.directory);
    let last = null;
    let lastFetchedAt = 0;
    let refreshing = false;
    const refreshBackground = () => {
      try {
        if (refreshing) return;
        if (last && Date.now() - lastFetchedAt < TTL_MS) return;
        refreshing = true;
        fetchQuota().then(async (q) => {
          try {
            last = coach(q);
            lastFetchedAt = Date.now();
            let providers = [];
            try {
              providers = await fetchProvidersCoach();
            } catch {
            }
            writeState({ ...last, providers, updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
            log(`${last.decision} | weekly=${last.weekly}% 5h=${last.fiveHour}% | providers=${providers.length}`);
          } catch (e) {
            log(`refresh-in-then err: ${String(e)}`);
          }
        }).catch((e) => {
          log(`fetchQuota err: ${String(e)}`);
        }).finally(() => {
          refreshing = false;
        });
      } catch (e) {
        log(`refreshBackground err: ${String(e)}`);
      }
    };
    const current = () => {
      try {
        if (!last) refreshBackground();
        return last ?? LOADING;
      } catch {
        return LOADING;
      }
    };
    return {
      event: async ({ event }) => {
        try {
          if (event.type === "session.created" || event.type === "session.idle") refreshBackground();
        } catch (e) {
          log(`event err: ${String(e)}`);
        }
      },
      // ACT(1) hard gate: only intentional STOP throws. Our own bugs never block.
      "tool.execute.before": async (_input) => {
        let decision = "GO";
        try {
          decision = current().decision;
        } catch {
          decision = "GO";
        }
        if (decision === "STOP") {
          throw new Error(`[${PLUGIN_NAME}] blocked: quota limit exceeded. ${current().advice}`);
        }
      },
      // ACT(2) inject coaching into system prompt (double defense). Silent on error.
      "experimental.chat.system.transform": async (_input, output) => {
        try {
          const c = current();
          let instruction = "";
          if (c.decision === "STOP") instruction = `[${PLUGIN_NAME}] QUOTA limit exceeded. ${c.advice} Stop making further tool calls, finish the in-progress work, then report the quota status to the user.`;
          else if (c.decision === "THROTTLE") instruction = `[${PLUGIN_NAME}] ${c.advice} Hold off on long/heavy tasks.`;
          else if (c.weekly >= 0) instruction = `[${PLUGIN_NAME}] quota ok \u2014 weekly ${c.weekly}% \xB7 5h ${c.fiveHour}% \xB7 monthly ${c.monthly}%.`;
          if (instruction) output.system.push(instruction);
        } catch (e) {
          log(`system.transform err: ${String(e)}`);
        }
      },
      // Custom tools for the harness agent mode — report status to the panel.
      tool: {
        harness_start: tool({
          description: "Start the harness: register the total task count on the panel. Call once when the harness loop begins.",
          args: { name: tool.schema.string(), total: tool.schema.number() },
          async execute(args, ctx) {
            writeHarness(ctx.sessionID, { name: args.name, total: args.total, current: 0, tasks: [], usage: {}, active: true, startedAt: (/* @__PURE__ */ new Date()).toISOString() });
            return `Harness '${args.name}' started (${args.total} tasks). Now report each task's status via task_update and run the loop.`;
          }
        }),
        task_update: tool({
          description: "Update a harness task's status on the panel. Call whenever a task transitions to generating/grading/revising/completed/failed.",
          args: {
            id: tool.schema.number(),
            title: tool.schema.string(),
            status: tool.schema.string().describe("generating | grading | revising | completed | failed | timed_out"),
            revisions: tool.schema.number().optional(),
            score: tool.schema.string().optional().describe("PASS | FAIL"),
            model: tool.schema.string().optional()
          },
          async execute(args, ctx) {
            const h = readHarness(ctx.sessionID) ?? { name: "batch", total: 0, current: 0, tasks: [], usage: {}, active: true };
            h.tasks = h.tasks.filter((x) => x.id !== args.id);
            h.tasks.push({ id: args.id, title: args.title, status: args.status, model: args.model ?? "", revisions: args.revisions ?? 0, score: args.score ?? null });
            if (args.id > h.current) h.current = args.id;
            writeHarness(ctx.sessionID, h);
            return `task ${args.id} -> ${args.status}${args.score ? ` (${args.score})` : ""}`;
          }
        }),
        harness_done: tool({
          description: "Mark the harness as complete \u2014 call when the loop ends.",
          args: {},
          async execute(_args, ctx) {
            const h = readHarness(ctx.sessionID);
            if (h) {
              h.current = h.total;
              h.active = false;
              writeHarness(ctx.sessionID, h);
            }
            return "Harness complete.";
          }
        }),
        // Per-role model execution (config-driven, same server, no deadlock).
        generate: tool({
          description: "Run the GENERATOR model on a prompt. The generator can use tools (write/edit files). Returns the model's text response.",
          args: { prompt: tool.schema.string() },
          async execute(args, ctx) {
            const cfg = readHarnessCfg(ctx.directory);
            const model = cfg.generator ?? "zai-coding-plan/glm-5.1";
            const out = await runModel(input.client, model, args.prompt, ctx.directory);
            return out ?? `(generator ${model} produced no text)`;
          }
        }),
        generate_batch: tool({
          description: "Run the GENERATOR model on MULTIPLE tasks in PARALLEL. Pass an array of {id, prompt}. Returns all results at once. Use for INDEPENDENT tasks (much faster than sequential generate calls).",
          args: { tasks: tool.schema.array(tool.schema.object({ id: tool.schema.number(), prompt: tool.schema.string() })) },
          async execute(args, ctx) {
            const cfg = readHarnessCfg(ctx.directory);
            const model = cfg.generator ?? "zai-coding-plan/glm-5.1";
            const results = await Promise.all(args.tasks.map(async (t) => {
              const out = await runModel(input.client, model, t.prompt, ctx.directory);
              return `[task ${t.id}] ${out ?? "(no output)"}`;
            }));
            return results.join("\n\n");
          }
        }),
        grade: tool({
          description: "Run the GRADER model on a prompt. Returns PASS/FAIL on the first line. Falls back to generator if grader quota is out.",
          args: { prompt: tool.schema.string() },
          async execute(args, ctx) {
            const cfg = readHarnessCfg(ctx.directory);
            const model = cfg.grader ?? cfg.generator ?? "opencode/mimo-v2.5-free";
            const out = await runModel(input.client, model, args.prompt, ctx.directory);
            return out ?? `(grader ${model} produced no text)`;
          }
        })
      }
    };
  } catch (e) {
    log(`PLUGIN INIT FAILED (no-op): ${String(e)}`);
    return NOOP_HOOKS;
  }
}
export {
  UsageCoachPlugin as default
};
