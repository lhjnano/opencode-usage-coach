// src/index.ts
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "fs";
import { spawn } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { tool } from "@opencode-ai/plugin";
var PLUGIN_NAME = "opencode-usage-coach";
var STATE_DIR = process.env.UC_STATE_DIR ?? join(homedir(), ".cache", "opencode-usage-coach");
var STATE_FILE = join(STATE_DIR, "state.json");
var HARNESS_FILE = join(STATE_DIR, "harness.json");
var LOG_FILE = join(STATE_DIR, "coach.log");
var DEBUG = process.env.UC_DEBUG === "1";
var TTL_MS = Number(process.env.UC_TTL_MS ?? 6e4);
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
function readHarness() {
  try {
    if (!existsSync(HARNESS_FILE)) return null;
    return JSON.parse(readFileSync(HARNESS_FILE, "utf8"));
  } catch {
    return null;
  }
}
function writeHarness(h) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    h.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    writeFileSync(HARNESS_FILE, JSON.stringify(h, null, 2));
  } catch {
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
    if (mins < 1440) return `resets in ${Math.floor(mins / 60)}h`;
    return `resets in ${Math.floor(mins / 1440)}d`;
  } catch {
    return "";
  }
}
function fetchQuota() {
  return new Promise((resolve) => {
    let out = "";
    let p;
    try {
      p = spawn("codexbar", ["usage", "--provider", PROVIDER, "--json"], {
        stdio: ["ignore", "pipe", "ignore"]
      });
    } catch {
      return resolve(null);
    }
    p.stdout?.on("data", (d) => {
      out += d.toString();
    });
    p.on("error", () => resolve(null));
    p.on("close", () => {
      try {
        const text = out.trim();
        if (!text || text === "[]") return resolve(null);
        const u = JSON.parse(text)[0]?.usage;
        if (!u) return resolve(null);
        resolve({ weekly: u.primary ?? { usedPercent: 0 }, monthly: u.secondary ?? { usedPercent: 0 }, fiveHour: u.tertiary ?? { usedPercent: 0 } });
      } catch {
        resolve(null);
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
    let last = null;
    let lastFetchedAt = 0;
    let refreshing = false;
    const refreshBackground = () => {
      try {
        if (refreshing) return;
        if (last && Date.now() - lastFetchedAt < TTL_MS) return;
        refreshing = true;
        fetchQuota().then((q) => {
          try {
            last = coach(q);
            lastFetchedAt = Date.now();
            writeState(last);
            log(`${last.decision} | weekly=${last.weekly}% 5h=${last.fiveHour}%`);
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
          async execute(args) {
            writeHarness({ name: args.name, total: args.total, current: 0, tasks: [], usage: {}, startedAt: (/* @__PURE__ */ new Date()).toISOString() });
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
          async execute(args) {
            const h = readHarness() ?? { name: "batch", total: 0, current: 0, tasks: [], usage: {} };
            h.tasks = h.tasks.filter((x) => x.id !== args.id);
            h.tasks.push({ id: args.id, title: args.title, status: args.status, model: args.model ?? "", revisions: args.revisions ?? 0, score: args.score ?? null });
            if (args.id > h.current) h.current = args.id;
            writeHarness(h);
            return `task ${args.id} -> ${args.status}${args.score ? ` (${args.score})` : ""}`;
          }
        }),
        harness_done: tool({
          description: "Mark the harness as complete \u2014 call when the loop ends.",
          args: {},
          async execute() {
            const h = readHarness();
            if (h) {
              h.current = h.total;
              writeHarness(h);
            }
            return "Harness complete.";
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
