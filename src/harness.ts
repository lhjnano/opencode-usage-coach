// harness.ts — generic harness orchestrator (deterministic script variant)
// Reads tasks.txt + rubric.md and runs a generate -> grade -> pass-branch loop.
// Updates harness.json state on every step (TUI panel reads it) + quota gate.
//
// Usage: bun run src/harness.ts <workdir> [tasks.txt] [rubric.md]
// Env:
//   UC_TASK_TIMEOUT_MS (default 1800000 = 30min) — per-task timeout (on exceed: split)
//   UC_MAX_REVISIONS   (default 2)
//   UC_MODEL           (default zai-coding-plan/glm-5.1)
//   UC_STOP_5H/UC_STOP_WEEKLY — quota gate thresholds
//
// Note: this is the deterministic alternative to the agent mode (agents/usage-coach-harness.md).
//       The agent mode is adaptive (conversation-driven); this script is rigid but guaranteed.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Per-directory state (matches the plugin & TUI). UC_STATE_DIR overrides (global).
function projectStateDir(dir: string): string {
  const abs = resolve(dir || ".");
  const h = createHash("sha1").update(abs).digest("hex").slice(0, 12);
  return join(homedir(), ".cache", "opencode-usage-coach", "projects", h);
}

let STATE_DIR = join(homedir(), ".cache", "opencode-usage-coach");
let HARNESS_FILE = join(STATE_DIR, "harness.json");
const TIMEOUT_MS = Number(process.env.UC_TASK_TIMEOUT_MS ?? 1800000);
const GRADE_TIMEOUT_MS = Number(process.env.UC_GRADE_TIMEOUT_MS ?? 180000);
const MAX_REVISIONS = Number(process.env.UC_MAX_REVISIONS ?? 2);

type TaskState = {
  id: number; title: string; status: string;
  model: string; revisions: number; score: string | null; note: string;
};
type Usage = { input: number; output: number; calls: number };
type ProviderQuota = { weekly: number; monthly: number; fiveHour: number };
type HarnessState = {
  name: string; total: number; current: number;
  tasks: TaskState[]; usage: Record<string, Usage>;
  quotas?: Record<string, ProviderQuota>;
  active?: boolean;
  startedAt: string; updatedAt?: string;
};

type OcResult = { text: string | null; tokens: { input: number; output: number } };

/** opencode run (json) — extracts response text + tokens together. On timeout text=null. */
function runOc(prompt: string, dir: string, model: string, timeoutMs: number): Promise<OcResult> {
  return new Promise((resolve) => {
    let buf = "";
    const acc = { input: 0, output: 0 };
    const textParts: string[] = [];
    const p = spawn("opencode", ["run", "-m", model, "--dir", dir, "--format", "json", prompt], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* */ } resolve({ text: null, tokens: acc }); }, timeoutMs);
    p.stdout.on("data", (d) => {
      buf += d.toString();
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const e = JSON.parse(line);
          if (e.type === "text" && e.part?.text) textParts.push(e.part.text);
          if (e.type === "step_finish" && e.part?.tokens) {
            acc.input += e.part.tokens.input ?? 0;
            acc.output += e.part.tokens.output ?? 0;
          }
        } catch { /* */ }
      }
    });
    p.on("error", () => { clearTimeout(t); resolve({ text: null, tokens: acc }); });
    p.on("close", () => { clearTimeout(t); resolve({ text: textParts.join("").trim() || null, tokens: acc }); });
  });
}

/** quota gate: returns true (halt) if codexbar zai is at STOP threshold. */
/** quota gate: true (halt) if the given provider's 5h/weekly is at STOP. Free/local providers with no quota -> never halts. */
function quotaStop(provider: string): Promise<boolean> {
  return new Promise((resolve) => {
    let out = "";
    const p = spawn("codexbar", ["usage", "--provider", provider, "--json"], { stdio: ["ignore", "pipe", "ignore"] });
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.on("error", () => resolve(false));
    p.on("close", () => {
      try {
        const u = JSON.parse(out)[0]?.usage;
        if (!u) return resolve(false); // no quota for this provider (e.g. free/local) -> never halt
        const s5h = Number(process.env.UC_STOP_5H ?? 92), swk = Number(process.env.UC_STOP_WEEKLY ?? 95);
        if ((u?.tertiary?.usedPercent ?? 0) >= s5h) return resolve(true);
        if ((u?.primary?.usedPercent ?? 0) >= swk) return resolve(true);
        resolve(false);
      } catch { resolve(false); }
    });
  });
}

/** opencode "provider/model" -> codexbar provider name (e.g. zai-coding-plan -> zai, ollama -> ollama). */
function codexbarProvider(model: string): string {
  const pid = (model.split("/")[0] ?? model).trim();
  if (!pid) return "zai";
  if (pid.startsWith("zai")) return "zai";
  return pid.split("-")[0];
}

/** Fetch a provider's quota windows (5h/weekly/monthly usedPercent). null if unavailable. */
function fetchProviderQuota(provider: string): Promise<ProviderQuota | null> {
  return new Promise((resolve) => {
    let out = "";
    const p = spawn("codexbar", ["usage", "--provider", provider, "--json"], { stdio: ["ignore", "pipe", "ignore"] });
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.on("error", () => resolve(null));
    p.on("close", () => {
      try {
        const u = JSON.parse(out)[0]?.usage;
        if (!u) return resolve(null);
        resolve({
          weekly: Math.round(u.primary?.usedPercent ?? 0),
          monthly: Math.round(u.secondary?.usedPercent ?? 0),
          fiveHour: Math.round(u.tertiary?.usedPercent ?? 0),
        });
      } catch { resolve(null); }
    });
  });
}

function writeState(h: HarnessState) {
  h.updatedAt = new Date().toISOString();
  try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(HARNESS_FILE, JSON.stringify(h, null, 2)); } catch { /* */ }
}

function parseTasks(file: string): { id: number; title: string }[] {
  return readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).map((l, i) => {
    const m = l.match(/^\*?\s*\d+\.\s*(.*)/);
    return { id: i + 1, title: m ? m[1] : l };
  });
}

/** Role -> model config. Lookup order: workdir harness.config.json > global ~/.config/opencode-usage-coach/harness.config.json > defaults. */
type HarnessConfig = { generator?: string; grader?: string; taskTimeoutMs?: number; maxRevisions?: number; parallel?: number };
// Models come ONLY from config (workdir harness.config.json > global ~/.config/opencode-usage-coach/harness.config.json).
// No hardcoded model defaults — see harness.config.example.json for the reference defaults.
function loadConfig(dir: string): HarnessConfig {
  const tryRead = (p: string): HarnessConfig => {
    try { if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")) as HarnessConfig; } catch { /* */ }
    return {};
  };
  const globalCfg = tryRead(join(homedir(), ".config", "opencode-usage-coach", "harness.config.json"));
  const dirCfg = tryRead(join(dir, "harness.config.json"));
  return { ...globalCfg, ...dirCfg }; // workdir overrides global
}

/** P3: split a timed-out task into smaller subtasks. */
async function decompose(title: string, dir: string, model: string): Promise<string[]> {
  const r = await runOc(
    `Task "${title}" is too large and timed out. Inspect the current directory progress, then split this task into 2-4 smaller, independent subtasks. Output one subtask per line (no numbers, no bullets).`,
    dir, model, GRADE_TIMEOUT_MS,
  );
  if (!r.text) return [];
  return r.text.split("\n")
    .map((l) => l.replace(/^\s*\d+\.\s*/, "").replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 4);
}

async function main() {
  const dir = process.argv[2] ?? ".";
  // per-directory state isolation (matches the TUI panel for this dir)
  STATE_DIR = process.env.UC_STATE_DIR ?? projectStateDir(dir);
  HARNESS_FILE = join(STATE_DIR, "harness.json");
  const resolve = (p: string | undefined, def: string) => {
    const base = p ?? def;
    return base.startsWith("/") ? base : join(dir, base);
  };
  const tasksFile = resolve(process.argv[3], "tasks.txt");
  const rubricFile = resolve(process.argv[4], "rubric.md");
  const rubric = readFileSync(rubricFile, "utf8");
  const tasks = parseTasks(tasksFile);

  // Role-based models — from config ONLY (workdir > global). No code defaults.
  const cfg = loadConfig(dir);
  if (!cfg.generator || !cfg.grader) {
    console.error("harness: generator/grader missing. Set them in ./harness.config.json or ~/.config/opencode-usage-coach/harness.config.json (see harness.config.example.json).");
    process.exit(1);
  }
  const GENERATOR = cfg.generator;
  const GRADER = cfg.grader;
  const taskTimeout = cfg.taskTimeoutMs ?? TIMEOUT_MS;
  const maxRev = cfg.maxRevisions ?? MAX_REVISIONS;
  console.log(`models: generator=${GENERATOR} grader=${GRADER}`);

  // providers involved -> fetch each one's quota (5h/weekly/monthly) for the panel.
  const providers = Array.from(new Set([codexbarProvider(GENERATOR), codexbarProvider(GRADER)]));
  const refreshQuotas = async () => {
    const q: Record<string, ProviderQuota> = {};
    for (const pv of providers) { const r = await fetchProviderQuota(pv); if (r) q[pv] = r; }
    state.quotas = q;
  };

  const state: HarnessState = { name: "batch", total: tasks.length, current: 0, tasks: [], usage: {}, active: true, startedAt: new Date().toISOString() };
  // per-model token accumulation
  const trackUsage = (model: string, tok: { input: number; output: number }) => {
    const u = state.usage[model] ?? { input: 0, output: 0, calls: 0 };
    u.input += tok.input; u.output += tok.output; u.calls += 1;
    state.usage[model] = u;
  };
  const parallel = Math.max(1, cfg.parallel ?? 1);
  let finished = 0;
  writeState(state);
  console.log(`harness start: ${tasks.length} tasks, parallel=${parallel}, timeout ${taskTimeout}ms, max revisions ${maxRev}`);

  // Process one task: generate (GENERATOR) -> grade/revise (GRADER/GENERATOR).
  // Returns { split: subtasks (sequential-only auto-split on timeout), halt: quota STOP }.
  const processTask = async (t: { id: number; title: string }): Promise<{ split: string[]; halt: boolean }> => {
    const task: TaskState = { id: t.id, title: t.title, status: "generating", model: GENERATOR, revisions: 0, score: null, note: "" };
    state.tasks = state.tasks.filter((x) => x.id !== t.id);
    state.tasks.push(task);
    state.current = finished;
    writeState(state);

    if (await quotaStop(codexbarProvider(GENERATOR))) {
      task.status = "halted_quota"; task.note = "quota STOP"; writeState(state);
      console.log(`quota STOP @ task ${t.id}`); return { split: [], halt: true };
    }
    await refreshQuotas();
    writeState(state);

    console.log(`> task ${t.id} generating [${GENERATOR}]`);
    task.model = GENERATOR; writeState(state);
    const gen = await runOc(`Task: ${t.title}\nPerform it for real in the current directory (write/edit files).`, dir, GENERATOR, taskTimeout);
    trackUsage(GENERATOR, gen.tokens);
    writeState(state);
    if (gen.text === null) {
      task.status = "timed_out"; task.note = `${taskTimeout}ms exceeded -> split`;
      writeState(state); console.log(`! task ${t.id} timeout`);
      const subs = await decompose(t.title, dir, GENERATOR);
      if (subs.length) task.note = `-> split into ${subs.length} subtasks`;
      writeState(state);
      return { split: subs, halt: false };
    }

    // pick grader: GRADER if its quota is fine, else fall back to GENERATOR; null if both out.
    const pickGrader = async (): Promise<string | null> => {
      if (!(await quotaStop(codexbarProvider(GRADER)))) return GRADER;
      if (!(await quotaStop(codexbarProvider(GENERATOR)))) { console.log(`! grader quota out -> grading with generator [${GENERATOR}]`); return GENERATOR; }
      return null;
    };

    for (let rev = 0; rev <= maxRev; rev++) {
      task.status = rev === 0 ? "grading" : "revising"; task.revisions = rev;
      const gm = await pickGrader();
      if (!gm) { task.status = "halted_grade"; task.note = "generator & grader quota both out"; writeState(state); console.log(`!! task ${t.id} cannot grade (both quotas out)`); return { split: [], halt: true }; }
      task.model = gm; writeState(state);
      console.log(`> task ${t.id} ${rev === 0 ? "grading" : `revise(${rev}) re-grade`} [${gm}]`);
      const grade = await runOc(
        `Grade the directory's result against the rubric below.\n${rubric}\nTask to evaluate: ${t.title}\nOutput PASS or FAIL on the first line, and the reason on the second line.`,
        dir, gm, GRADE_TIMEOUT_MS,
      );
      trackUsage(gm, grade.tokens);
      const pass = /^\s*PASS\b/im.test(grade.text ?? "");
      task.score = pass ? "PASS" : "FAIL";
      writeState(state);
      if (pass) { task.status = "completed"; writeState(state); console.log(`+ task ${t.id} passed`); return { split: [], halt: false }; }
      if (rev < maxRev) {
        task.status = "revising"; task.model = GENERATOR; writeState(state);
        console.log(`> task ${t.id} revising (${rev + 1}) [${GENERATOR}]`);
        const fix = await runOc(`Grade: FAIL.\n${grade.text ?? ""}\n\nImprove the work to meet the rubric.\n${rubric}\nTask: ${t.title}`, dir, GENERATOR, taskTimeout);
        trackUsage(GENERATOR, fix.tokens);
      } else {
        task.status = "failed"; task.note = "max revisions exceeded";
        writeState(state); console.log(`x task ${t.id} failed (giving up)`);
      }
    }
    return { split: [], halt: false };
  };

  if (parallel <= 1) {
    // sequential (with auto-split on timeout)
    for (let i = 0; i < tasks.length; i++) {
      const r = await processTask(tasks[i]);
      finished++; state.current = finished;
      await refreshQuotas(); writeState(state); // update quota after each task
      if (r.halt) break;
      if (r.split.length) {
        const base = tasks[i].id;
        tasks.splice(i + 1, 0, ...r.split.map((s, k) => ({ id: Number(`${base}.${k + 1}`), title: s })));
        state.total = tasks.length;
      }
      writeState(state);
    }
  } else {
    // parallel pool (concurrency = parallel). No auto-split in parallel — use sequential for that.
    let next = 0; let halted = false;
    const worker = async () => {
      while (!halted) {
        const my = next++;
        if (my >= tasks.length) return;
        const r = await processTask(tasks[my]);
        finished++; state.current = finished;
        await refreshQuotas(); writeState(state); // update quota after each task
        if (r.halt) { halted = true; return; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(parallel, tasks.length) }, () => worker()));
  }
  state.current = state.tasks.length;
  state.active = false; // done -> panel hides the harness section
  writeState(state);
  console.log("harness complete");
}

main().catch((e) => { console.error("harness fatal error:", e); process.exit(1); });
