// src/index.ts
import { mkdirSync as mkdirSync2, writeFileSync, appendFileSync as appendFileSync2, readFileSync as readFileSync2, existsSync as existsSync2 } from "fs";
import { spawn } from "child_process";
import { createHash } from "crypto";
import { homedir } from "os";
import { join as join2, resolve, dirname } from "path";
import { tool } from "@opencode-ai/plugin";

// src/domain.ts
import { mkdirSync, appendFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
var BASE_DIR = "";
function initDomain(stateDir) {
  BASE_DIR = stateDir;
}
var nodesFile = () => join(BASE_DIR, "nodes.ndjson");
var edgesFile = () => join(BASE_DIR, "edges.ndjson");
function readNdjson(path) {
  try {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
function readNodes() {
  return readNdjson(nodesFile());
}
function readEdges() {
  return readNdjson(edgesFile());
}
function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function addDomainNode(node) {
  const full = { ...node, id: uid("node"), ts: (/* @__PURE__ */ new Date()).toISOString() };
  try {
    mkdirSync(BASE_DIR, { recursive: true });
    appendFileSync(nodesFile(), JSON.stringify(full) + "\n");
  } catch {
  }
  return full.id;
}
function queryDomain(keywords) {
  const lc = keywords.map((k) => k.toLowerCase());
  const nodes = readNodes();
  const matched = nodes.filter((n) => {
    const hay = (n.name + " " + JSON.stringify(n.props)).toLowerCase();
    return lc.some((k) => k && hay.includes(k));
  });
  const ids = new Set(matched.map((n) => n.id));
  const edges = readEdges().filter((e) => ids.has(e.from) || ids.has(e.to));
  return { nodes: matched, edges };
}
function saveInvestigationResult(keywords, result, source) {
  try {
    return addDomainNode({
      type: "fact",
      name: keywords.join(" "),
      props: { result },
      source: source || "investigation",
      confidence: 0.7
    });
  } catch {
    return "";
  }
}

// src/index.ts
var PLUGIN_NAME = "opencode-usage-coach";
var DEBUG = process.env.UC_DEBUG === "1";
var TTL_MS = Number(process.env.UC_TTL_MS ?? 6e4);
var STATE_DIR = join2(homedir(), ".cache", "opencode-usage-coach");
var STATE_FILE = join2(STATE_DIR, "state.json");
var HARNESS_FILE = join2(STATE_DIR, "harness.json");
var LOG_FILE = join2(STATE_DIR, "coach.log");
function projectStateDir(dir) {
  const abs = resolve(dir || ".");
  const h = createHash("sha1").update(abs).digest("hex").slice(0, 12);
  return join2(homedir(), ".cache", "opencode-usage-coach", "projects", h);
}
function setStateDir(dir) {
  STATE_DIR = process.env.UC_STATE_DIR ?? projectStateDir(dir);
  STATE_FILE = join2(STATE_DIR, "state.json");
  HARNESS_FILE = join2(STATE_DIR, "harness.json");
  LOG_FILE = join2(STATE_DIR, "coach.log");
}
var NOOP_HOOKS = {};
function log(msg) {
  try {
    appendFileSync2(LOG_FILE, `${(/* @__PURE__ */ new Date()).toISOString()} ${msg}
`);
  } catch {
  }
}
function writeState(c) {
  try {
    mkdirSync2(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ ...c, updatedAt: (/* @__PURE__ */ new Date()).toISOString() }));
  } catch {
  }
}
function rulesFile() {
  return join2(STATE_DIR, "rules.md");
}
function failuresFile() {
  return join2(STATE_DIR, "failures.ndjson");
}
function readRules() {
  try {
    const f = rulesFile();
    if (!existsSync2(f)) return "";
    return readFileSync2(f, "utf8").trim();
  } catch {
    return "";
  }
}
function extractKeywords(text) {
  try {
    const STOP = /* @__PURE__ */ new Set(["the", "and", "for", "with", "that", "this", "from", "into", "your", "you", "are", "was", "but", "not", "all", "any", "use", "task", "prompt"]);
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const raw of (text ?? "").toLowerCase().split(/[^a-z0-9_]+/)) {
      const t = raw.trim();
      if (t.length < 3 || STOP.has(t) || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= 16) break;
    }
    return out;
  } catch {
    return [];
  }
}
function harnessFile(sessionID) {
  return join2(STATE_DIR, sessionID || "_default", "harness.json");
}
function readHarness(sessionID) {
  try {
    const f = harnessFile(sessionID);
    if (!existsSync2(f)) return null;
    return JSON.parse(readFileSync2(f, "utf8"));
  } catch {
    return null;
  }
}
function writeHarness(sessionID, h) {
  try {
    const f = harnessFile(sessionID);
    mkdirSync2(dirname(f), { recursive: true });
    h.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    writeFileSync(f, JSON.stringify(h, null, 2));
  } catch {
  }
}
function readHarnessCfg(dir) {
  const tryRead = (p) => {
    try {
      if (existsSync2(p)) return JSON.parse(readFileSync2(p, "utf8"));
    } catch {
    }
    return {};
  };
  return {
    ...tryRead(join2(homedir(), ".config", "opencode-usage-coach", "harness.config.json")),
    ...tryRead(join2(dir, "harness.config.json"))
  };
}
async function runModel(client, model, prompt, directory) {
  const t0 = Date.now();
  try {
    const slash = model.indexOf("/");
    const providerID = slash >= 0 ? model.slice(0, slash) : model;
    const modelID = slash >= 0 ? model.slice(slash + 1) : "";
    const s = await client.session.create({ body: { title: "uc-harness-sub" }, query: { directory } });
    const id = s?.data?.info?.id ?? s?.data?.id ?? s?.id;
    if (!id) return `ERROR: session.create returned no id (response: ${JSON.stringify(s?.data ?? s).slice(0, 200)})`;
    log(`runModel(${model}): session ${id} created, sending prompt (${prompt.length} chars)`);
    const resp = await client.session.prompt({
      path: { id },
      body: { model: { providerID, modelID }, parts: [{ type: "text", text: prompt }] }
    });
    const elapsed = Math.round((Date.now() - t0) / 1e3);
    const parts = resp?.data?.parts ?? resp?.parts ?? [];
    const text = parts.filter((p) => p?.type === "text").map((p) => p?.text ?? "").join("");
    try {
      const summary = await client.session.summarize?.({ path: { id } });
      log(`runModel(${model}): sub-session summary: ${JSON.stringify(summary?.data ?? summary).slice(0, 300)}`);
    } catch {
    }
    try {
      await client.session.delete?.({ path: { id } });
    } catch {
    }
    log(`runModel(${model}): done ${elapsed}s, ${text.length} chars`);
    return text.trim() || `ERROR: no assistant text in prompt response after ${elapsed}s (parts: ${parts.length}, types: ${parts.map((p) => p?.type).join(",")})`;
  } catch (e) {
    const elapsed = Math.round((Date.now() - t0) / 1e3);
    log(`runModel err (${model}, ${elapsed}s): ${String(e)}`);
    return `ERROR: runModel exception after ${elapsed}s: ${String(e)}`;
  }
}
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
function fetchQuota(provider) {
  return new Promise((resolve2) => {
    let out = "";
    let p;
    try {
      const args = provider ? ["usage", "--provider", provider, "--json"] : ["usage", "--json"];
      p = spawn("codexbar", args, {
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
function coach(q, lighter) {
  if (!q) return { decision: "GO", advice: "quota unavailable \u2014 proceeding cautiously.", weekly: -1, monthly: -1, fiveHour: -1 };
  const wk = Math.round(q.weekly?.usedPercent ?? 0), mo = Math.round(q.monthly?.usedPercent ?? 0), h5 = Math.round(q.fiveHour?.usedPercent ?? 0);
  const wkR = humanRemaining(q.weekly?.resetsAt), h5R = humanRemaining(q.fiveHour?.resetsAt);
  const stop = (r) => ({ decision: "STOP", advice: `STOP recommend \u2014 ${r}. window nearly exhausted. stop now or it will be force-blocked.`, weekly: wk, monthly: mo, fiveHour: h5 });
  const thr = (r) => ({ decision: "THROTTLE", advice: `Throttle recommend \u2014 ${r}. switch to lighter model (${lighter}) or wait for window reset.`, weekly: wk, monthly: mo, fiveHour: h5 });
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
    initDomain(STATE_DIR);
    const cfg0 = readHarnessCfg(input.directory);
    const PROVIDER = process.env.UC_PROVIDER ?? cfg0.provider ?? "";
    const LIGHTER = process.env.UC_LIGHTER_MODEL ?? cfg0.lighterModel ?? "a lighter model";
    let last = null;
    let lastFetchedAt = 0;
    let refreshing = false;
    const refreshBackground = () => {
      try {
        if (refreshing) return;
        if (last && Date.now() - lastFetchedAt < TTL_MS) return;
        refreshing = true;
        fetchQuota(PROVIDER).then(async (q) => {
          try {
            last = coach(q, LIGHTER);
            lastFetchedAt = Date.now();
            let providers = [];
            try {
              providers = await fetchProvidersCoach();
            } catch {
            }
            if (providers.length > 0 && last.weekly < 0) {
              const p0 = providers[0];
              last = { ...last, weekly: p0.weekly, fiveHour: p0.fiveHour, monthly: p0.weekly >= 0 ? 0 : -1, advice: p0.advice, decision: p0.weekly >= STOP_WK ? "STOP" : p0.weekly >= THR_WK ? "THROTTLE" : "GO" };
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
      // ACT(1) hard gate — ONLY for harness tools (generate/grade/etc.) that consume quota.
      // General tools (read/edit/bash/grep/task) are NEVER blocked — they don't consume model quota.
      // This ensures Agent-Factory-Coordinator and other modes work freely even at STOP.
      "tool.execute.before": async (_input) => {
        let decision = "GO";
        try {
          decision = current().decision;
        } catch {
          decision = "GO";
        }
        if (decision === "STOP") {
          const harnessTools = ["generate", "generate_batch", "grade", "investigate", "verify_diagnosis", "generalize"];
          if (harnessTools.includes(_input.tool)) {
            throw new Error(`[${PLUGIN_NAME}] blocked: quota limit exceeded. ${current().advice}`);
          }
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
            return `Harness '${args.name}' started (${args.total} tasks).

DETERMINISTIC LOOP \u2014 first classify the tasks:
  INDEPENDENT = task B does NOT need task A's output  ->  use PATH A (parallel, faster)
  DEPENDENT   = task B needs task A's output          ->  use PATH B (sequential)

PATH A \u2014 INDEPENDENT (parallel via generate_batch):
  1. task_update(1..${args.total}, title, "generating")
  2. generate_batch({tasks: [{id:1, prompt:"Task: <title1>. Perform it."}, ...]})  -> all results + NEXT
  3. for each i: task_update(i, title, "grading") + grade({prompt:"Evaluate... PASS/FAIL first line. Task: <title>"})  -> verdict + NEXT
  4. for each i: PASS -> task_update(i, title, "completed", "PASS"); FAIL -> revise (up to 2x) or task_update(i, title, "failed", "FAIL")

PATH B \u2014 DEPENDENT (sequential):
  for i in 1..${args.total}:
    1. task_update(i, title, "generating")
    2. generate({prompt:"Task: <title>. Perform it."})  -> work + NEXT
    3. task_update(i, title, "grading")
    4. grade(...)  -> verdict + NEXT
    5. PASS -> task_update(i, title, "completed", "PASS"); FAIL -> revise (up to 2x) or failed

Then: harness_done(). Follow the [usage-coach NEXT] directive each tool returns. Do NOT improvise the sequence.`;
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
            const cfg = readHarnessCfg(ctx.directory);
            const h = readHarness(ctx.sessionID) ?? { name: "batch", total: 0, current: 0, tasks: [], usage: {}, active: true };
            h.tasks = h.tasks.filter((x) => x.id !== args.id);
            const model = args.model || cfg.generator || "";
            if (!model) return `ERROR: task ${args.id} has no model and no generator configured. Set "generator" in harness.config.json.`;
            h.tasks.push({ id: args.id, title: args.title, status: args.status, model, revisions: args.revisions ?? 0, score: args.score ?? null, startedAt: (/* @__PURE__ */ new Date()).toISOString() });
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
        record_failure: tool({
          description: "Stage 1 (RECORD) of the learning loop. Append a failure record to failures.ndjson for later root-cause analysis.",
          args: {
            task: tool.schema.string(),
            prompt: tool.schema.string(),
            gradeResult: tool.schema.string(),
            model: tool.schema.string().optional(),
            revisions: tool.schema.number().optional()
          },
          async execute(args, _ctx) {
            const rec = { ts: (/* @__PURE__ */ new Date()).toISOString(), task: args.task, prompt: args.prompt, gradeResult: args.gradeResult, model: args.model, revisions: args.revisions };
            try {
              mkdirSync2(STATE_DIR, { recursive: true });
              appendFileSync2(failuresFile(), JSON.stringify(rec) + "\n");
            } catch (e) {
              log(`record_failure err: ${String(e)}`);
            }
            return `Failure recorded. [usage-coach NEXT] call investigate({failure: ${JSON.stringify(rec)}}) to find the root cause.`;
          }
        }),
        investigate: tool({
          description: "Stage 2 (INVESTIGATE) of the learning loop. Run the generator to analyze the ROOT CAUSE of a failure (not just the symptom).",
          args: {
            task: tool.schema.string(),
            prompt: tool.schema.string(),
            gradeResult: tool.schema.string(),
            model: tool.schema.string().optional()
          },
          async execute(args, ctx) {
            const cfg = readHarnessCfg(ctx.directory);
            if (!cfg.generator) return 'ERROR: no generator model configured. Set "generator" in harness.config.json (see harness.config.example.json).';
            let domainPrefix = "";
            let keywords = [];
            let domainEmpty = true;
            try {
              keywords = extractKeywords(`${args.task} ${args.gradeResult}`);
              if (keywords.length) {
                const { nodes, edges } = queryDomain(keywords);
                if (nodes && nodes.length || edges && edges.length) {
                  domainEmpty = false;
                  domainPrefix = `Known facts from domain DB: ${JSON.stringify({ nodes, edges })}. Use these if relevant.

---

`;
                }
              }
            } catch (e) {
              log(`investigate domain query err: ${String(e)}`);
            }
            const rcaPrompt = `A task failed. Analyze the ROOT CAUSE (not just the symptom).
Task: ${args.task}
What was expected (from grade): ${args.gradeResult}
Read relevant files in the directory if needed.
Output a structured root cause:
category: (one of: constraint-violation, missing-context, tool-misuse, model-limitation, other)
explanation: <why it failed>
evidence: <file/line or specific quote>`;
            const out = await runModel(input.client, cfg.generator, domainPrefix + rcaPrompt, ctx.directory);
            if (domainEmpty && keywords.length) {
              try {
                saveInvestigationResult(keywords, out, "investigate");
              } catch (e) {
                log(`investigate save err: ${String(e)}`);
              }
            }
            return out + "\n[usage-coach NEXT] call verify_diagnosis with this diagnosis.";
          }
        }),
        verify_diagnosis: tool({
          description: "Stage 3 (VERIFY) of the learning loop. Run the grader to check whether a diagnosis is CORRECT and ACTIONABLE (leads to a useful rule). Returns PASS/FAIL + a [usage-coach NEXT] directive.",
          args: {
            diagnosis: tool.schema.string(),
            task: tool.schema.string(),
            gradeResult: tool.schema.string()
          },
          async execute(args, ctx) {
            const cfg = readHarnessCfg(ctx.directory);
            const model = cfg.grader ?? cfg.generator;
            if (!model) return "FAIL\n(ERROR: no grader/generator model configured.)\n[usage-coach NEXT] configure grader in harness.config.json, then retry verify_diagnosis.";
            const verifyPrompt = `Verify this root-cause analysis for a failure.
Task: ${args.task}
Grade feedback: ${args.gradeResult}
Diagnosis: ${args.diagnosis}
Is the diagnosis CORRECT and ACTIONABLE (leads to a useful rule)?
Output PASS (the diagnosis is right) or FAIL (re-investigate needed), then reason.`;
            const out = await runModel(input.client, model, verifyPrompt, ctx.directory);
            let verdict = "FAIL";
            if (!out.startsWith("ERROR:")) {
              const f = (out.split("\n").find((l) => l.trim()) ?? "").trim();
              if (/^pass\b/i.test(f)) verdict = "PASS";
              else verdict = "FAIL";
            }
            const next = verdict === "PASS" ? `
[usage-coach NEXT] call generalize with this verified diagnosis.` : `
[usage-coach NEXT] FAIL \u2014 re-investigate the root cause.`;
            return out + "\n" + next;
          }
        }),
        generalize: tool({
          description: "Stage 4 (GENERALIZE) of the learning loop. Run the generator to turn a verified root cause into a reusable rule and append it to rules.md, so the next generate call includes it. Returns the rule text and a [usage-coach NEXT] directive.",
          args: {
            diagnosis: tool.schema.string(),
            task: tool.schema.string()
          },
          async execute(args, ctx) {
            const cfg = readHarnessCfg(ctx.directory);
            if (!cfg.generator) return 'ERROR: no generator model configured. Set "generator" in harness.config.json (see harness.config.example.json).';
            const genPrompt = `Turn this verified root cause into a GENERAL, REUSABLE rule for future tasks of this kind.
Diagnosis: ${args.diagnosis}
Failed task: ${args.task}
Output a single rule in the form: 'For <task-type> tasks, always <check/do X> because <reason>.'
Keep it concrete and actionable.`;
            const out = await runModel(input.client, cfg.generator, genPrompt, ctx.directory);
            const rule = out;
            try {
              const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
              mkdirSync2(STATE_DIR, { recursive: true });
              appendFileSync2(rulesFile(), `## Rule (${date})
${rule}
Origin: ${args.task}

`);
            } catch (e) {
              log(`generalize err: ${String(e)}`);
            }
            return `${rule}
[usage-coach NEXT] rule saved to rules.md. The next generate call will include it. Call task_update for the original failed task -> failed, then proceed.`;
          }
        }),
        // Per-role model execution (config-driven, quota-aware, same server, no deadlock).
        // P1: quota decision drives model selection + concurrency.
        generate: tool({
          description: "Run the GENERATOR model on a prompt. Quota-aware: on THROTTLE, auto-switches to lighterModel if configured. Returns the model's text response.",
          args: { prompt: tool.schema.string() },
          async execute(args, ctx) {
            const cfg = readHarnessCfg(ctx.directory);
            if (!cfg.generator) return 'ERROR: no generator model configured. Set "generator" in harness.config.json (see harness.config.example.json).';
            let decision = "GO";
            try {
              decision = current().decision;
            } catch {
            }
            const throttle = decision === "THROTTLE" && cfg.lighterModel;
            const model = throttle ? cfg.lighterModel : cfg.generator;
            const rules = readRules();
            let prefix = rules ? `Lessons learned from previous failures (apply where relevant):
${rules}

---

` : "";
            let keywords = [];
            let domainEmpty = true;
            try {
              keywords = extractKeywords(args.prompt);
              if (keywords.length) {
                const { nodes, edges } = queryDomain(keywords);
                if (nodes && nodes.length || edges && edges.length) {
                  domainEmpty = false;
                  prefix = `Known facts from domain DB: ${JSON.stringify({ nodes, edges })}. Use these if relevant.

---

` + prefix;
                }
              }
            } catch (e) {
              log(`generate domain query err: ${String(e)}`);
            }
            const out = await runModel(input.client, model, prefix + args.prompt, ctx.directory);
            if (domainEmpty && keywords.length) {
              try {
                saveInvestigationResult(keywords, out, "generate");
              } catch (e) {
                log(`generate save err: ${String(e)}`);
              }
            }
            return out + (throttle ? `
[usage-coach] quota THROTTLE \u2014 used lighter model ${cfg.lighterModel}` : "") + `
[usage-coach NEXT] call task_update(i, title, "grading"), then grade to evaluate this work.`;
          }
        }),
        generate_batch: tool({
          description: "Run the GENERATOR model on MULTIPLE tasks. Quota-aware: GO = full parallel; THROTTLE = lighter model + concurrency capped at 2; STOP = refused. Use for INDEPENDENT tasks.",
          args: { tasks: tool.schema.array(tool.schema.object({ id: tool.schema.number(), prompt: tool.schema.string() })) },
          async execute(args, ctx) {
            const cfg = readHarnessCfg(ctx.directory);
            if (!cfg.generator) return 'ERROR: no generator model configured. Set "generator" in harness.config.json (see harness.config.example.json).';
            let decision = "GO";
            try {
              decision = current().decision;
            } catch {
            }
            if (decision === "STOP") return 'ERROR: quota STOP \u2014 halt the harness loop now. Call task_update(current, "halted_quota") and stop.';
            const throttle = decision === "THROTTLE" && cfg.lighterModel;
            const model = throttle ? cfg.lighterModel : cfg.generator;
            const limit = decision === "THROTTLE" ? 2 : args.tasks.length;
            const results = [];
            for (let i = 0; i < args.tasks.length; i += limit) {
              const batch = args.tasks.slice(i, i + limit);
              const out = await Promise.all(batch.map(async (t) => {
                const r = await runModel(input.client, model, t.prompt, ctx.directory);
                return `[task ${t.id}] ${r}`;
              }));
              results.push(...out);
            }
            const note = throttle ? `
[usage-coach] quota THROTTLE \u2014 lighter model ${cfg.lighterModel}, concurrency capped at ${limit}` : "";
            return results.join("\n\n") + note;
          }
        }),
        grade: tool({
          description: "Run the GRADER model on a prompt. Returns PASS/FAIL on the first line + a [usage-coach NEXT] directive. Falls back to generator if grader quota is out.",
          args: { prompt: tool.schema.string() },
          async execute(args, ctx) {
            const cfg = readHarnessCfg(ctx.directory);
            const model = cfg.grader ?? cfg.generator;
            if (!model) return "FAIL\n(ERROR: no grader/generator model configured.)\n[usage-coach NEXT] configure grader in harness.config.json, then retry grade.";
            const out = await runModel(input.client, model, args.prompt, ctx.directory);
            let verdict = "FAIL";
            if (!out.startsWith("ERROR:")) {
              const f = (out.split("\n").find((l) => l.trim()) ?? "").trim();
              if (/^pass\b/i.test(f)) verdict = "PASS";
              else if (/^fail\b/i.test(f)) verdict = "FAIL";
              else verdict = "FAIL";
            }
            const next = verdict === "PASS" ? `
[usage-coach NEXT] PASS -> call task_update(i, title, "completed", "PASS"), then proceed to next task (or harness_done if last).` : `
[usage-coach NEXT] FAIL -> if revisions < 2: task_update(i, title, "revising", revisions+1) + generate({prompt: "Apply feedback:\\n{grade result}\\nTask: {title}"}); else: run the learning loop before failing \u2014
  1. record_failure({task, prompt, gradeResult, model, revisions})
  2. investigate({task, prompt, gradeResult}) -> diagnosis
  3. verify_diagnosis({diagnosis, task, gradeResult}) -> if PASS: generalize({diagnosis, task}) (saves rule to rules.md)
  4. task_update(i, title, "failed", "FAIL") -> next task.
The next generate call will automatically include the new rule.`;
            return out + "\n" + next;
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
