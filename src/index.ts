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
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { tool } from "@opencode-ai/plugin";
import { initDomain, queryDomain, queryDomainGraph, saveInvestigationResult, evictStale, addDomainEdge, readNodes, readEdges } from "./domain.js";
import type { DomainNode } from "./domain.js";

const PLUGIN_NAME = "opencode-usage-coach";
const TTL_MS = Number(process.env.UC_TTL_MS ?? 60000);

// Step-limit enforcement for sub-sessions: prevents runaway tasks from burning quota.
// Each generate/generate_batch call creates a sub-session whose agent loop is monitored;
// if the assistant-turn count exceeds maxSteps, the session is aborted.
const DEFAULT_MAX_STEPS = Number(process.env.UC_MAX_STEPS ?? 30) || 30;
const WATCHDOG_POLL_MS = Math.max(1000, Number(process.env.UC_WATCHDOG_POLL_MS ?? 3000) || 3000);
// Wall-clock timeout: if the prompt hasn't completed within this many minutes,
// abort the sub-session regardless of step count. Prevents zombie pollers from
// aborted/interrupted generate calls running forever. Override via UC_WALL_TIMEOUT_MIN.
const WALL_TIMEOUT_MS = (Math.max(1, Number(process.env.UC_WALL_TIMEOUT_MIN ?? 30) || 30)) * 60 * 1000;
// Reverse interview: hard cap on questions per interview (override via UC_MAX_QUESTIONS).
const DEFAULT_MAX_QUESTIONS = Math.max(1, Math.round(Number(process.env.UC_MAX_QUESTIONS ?? 7)) || 7);

// Unified pipeline log — survives even if setStateDir fails. Traces the FULL flow:
// module load → plugin init → hooks → refresh → state.json write.
const PIPE_LOG = join(homedir(), ".cache", "opencode-usage-coach", "pipeline.log");
function pipeLog(msg: string) { try { mkdirSync(dirname(PIPE_LOG), { recursive: true }); appendFileSync(PIPE_LOG, `[SERVER] ${new Date().toISOString()} ${msg}\n`); } catch { /* */ } }

// Module load marker — fires when this file is imported, before UsageCoachPlugin is called.
pipeLog(`MODULE LOADED | node=${process.version} | pid=${process.pid}`);

// Per-directory state isolation: each project dir gets its own state/harness files,
// so multiple sessions/dirs don't share harness state. UC_STATE_DIR overrides (global).
let STATE_DIR = join(homedir(), ".cache", "opencode-usage-coach");
let STATE_FILE = join(STATE_DIR, "state.json");
let LOG_FILE = join(STATE_DIR, "coach.log");
function projectStateDir(dir: string): string {
  const abs = resolve(dir || ".");
  const h = createHash("sha1").update(abs).digest("hex").slice(0, 12);
  return join(homedir(), ".cache", "opencode-usage-coach", "projects", h);
}
function setStateDir(dir: string) {
  STATE_DIR = process.env.UC_STATE_DIR ?? projectStateDir(dir);
  STATE_FILE = join(STATE_DIR, "state.json");
  LOG_FILE = join(STATE_DIR, "coach.log");
}

type QuotaWindow = { resetDescription?: string; usedPercent: number; resetsAt?: string };
type Quota = { weekly: QuotaWindow; monthly: QuotaWindow; fiveHour: QuotaWindow };
type Decision = "GO" | "THROTTLE" | "STOP";
type Coaching = { decision: Decision; advice: string; weekly: number; monthly: number; fiveHour: number; model?: string; provider?: string; isFree?: boolean };

const NOOP_HOOKS = {}; // returned on init failure so opencode keeps working

// Always log to file (not gated on UC_DEBUG) — essential for runtime diagnosis.
function log(msg: string) { try { appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`); } catch { /* */ } }
function writeState(c: Coaching) { try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify({ ...c, updatedAt: new Date().toISOString() })); } catch { /* */ } }

// Learning loop — accumulated rules from past failures (Stage 5: reference / Stage 1: record).
// rules.md is per-project (under STATE_DIR). generate prepends rules to its prompt so the
// next run avoids known pitfalls. The file grows over time = irreducible craft.
function rulesFile(): string { return join(STATE_DIR, "rules.md"); }
function failuresFile(): string { return join(STATE_DIR, "failures.ndjson"); }
function readRules(): string {
  try { const f = rulesFile(); if (!existsSync(f)) return ""; return readFileSync(f, "utf8").trim(); }
  catch { return ""; }
}

// ── Implementation Notes (impl-notes) ──────────────────────────────────────
// The third knowledge store: captures decisions/constraints/surprises discovered
// DURING generate execution — the gap between the prompt (map) and the codebase
// (territory). impl-notes.md is the human-readable record; promoted notes become
// low-confidence domain nodes linked into the knowledge graph via relates-to edges.
// See docs/impl-notes-design.md for the full design.
function implNotesFile(): string { return join(STATE_DIR, "impl-notes.md"); }

// Instruction appended to the generate prefix so the sub-session emits a
// structured <impl-notes> block at the end of its output (optional — no
// fabrication when nothing notable happened).
const IMPL_NOTE_INSTRUCTION = `
## Implementation Notes (important!)
During this task, if you:
  - Made a decision that differed from the obvious/expected approach
  - Discovered a constraint, limitation, or surprising behavior in the codebase/API
  - Found something that was different from what the prompt implied
Then append a block at the END of your response in this exact format:

<impl-notes>
- **Decision**: <what you chose and why it wasn't obvious>
- **Constraint**: <limitation/surprise you discovered>
- **Unexpected**: <how reality differed from the prompt's assumption>
</impl-notes>

If nothing notable happened, omit the block entirely. Do not fabricate notes.
`;

// Read the last N impl-notes entries from impl-notes.md for injection into
// the next generate prompt. Returns "" when the file doesn't exist or is empty.
function readImplNotes(limit = 5): string {
  try {
    const f = implNotesFile();
    if (!existsSync(f)) return "";
    const content = readFileSync(f, "utf8").trim();
    if (!content) return "";
    // Split on "## Note" headers, keep the last `limit` entries.
    const notes = content.split(/^## Note /m).filter(Boolean);
    const recent = notes.slice(-limit);
    return recent.map((n) => `## Note ${n.trim()}`).join("\n\n");
  } catch { return ""; }
}

// Extract the <impl-notes>...</impl-notes> block from sub-session output.
// Returns { notes: bullet content (or ""), cleanText: output without block }.
function extractImplNotes(output: string): { notes: string; cleanText: string } {
  const match = output.match(/<impl-notes>([\s\S]*?)<\/impl-notes>/i);
  if (!match) return { notes: "", cleanText: output };
  const notes = match[1].trim();
  const cleanText = output.replace(/<impl-notes>[\s\S]*?<\/impl-notes>\s*/i, "").trim();
  return { notes, cleanText };
}

// Append extracted notes to impl-notes.md with a structured header.
// taskSummary is the original generate prompt (truncated) for traceability.
function appendImplNotes(notes: string, taskSummary: string): void {
  try {
    const date = new Date().toISOString().slice(0, 10);
    const shortTask = taskSummary.slice(0, 80).replace(/\n/g, " ");
    const entry = `## Note (${date}, task: "${shortTask}")\n${notes}\nSource: generate task "${shortTask}"\n\n`;
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(implNotesFile(), entry);
  } catch (e) { log(`appendImplNotes err: ${String(e)}`); }
}

// Link a newly-promoted impl-note domain node to existing nodes via keyword
// overlap. Creates generic `relates-to` edges (deduped, max maxEdges). This
// turns isolated facts into a queryable knowledge web — traverseNeighborhood
// and readImplNotesByGraph can then find connected notes. Pure heuristic: no
// model call, just keyword matching against node name + props.
function linkImplNoteToDomain(noteNodeId: string, noteText: string, maxEdges = 3): number {
  try {
    const words = new Set(
      noteText.toLowerCase()
        .replace(/[^a-z0-9가-힣\s-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3),
    );
    if (words.size === 0) return 0;
    const existing = readNodes().filter((n) => n.id !== noteNodeId);
    const scored = existing
      .map((n) => {
        const hay = (n.name + " " + JSON.stringify(n.props)).toLowerCase();
        let hits = 0;
        for (const w of words) if (hay.includes(w)) hits++;
        return { node: n, hits };
      })
      .filter((s) => s.hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .slice(0, maxEdges);
    // Dedup: don't re-add an edge that already exists (either direction).
    const edgeKey = new Set(readEdges().map((e) => `${e.from}|${e.to}|${e.rel}`));
    let added = 0;
    for (const { node } of scored) {
      const k1 = `${noteNodeId}|${node.id}|related-to`;
      const k2 = `${node.id}|${noteNodeId}|related-to`;
      if (edgeKey.has(k1) || edgeKey.has(k2)) continue;
      addDomainEdge({ from: noteNodeId, to: node.id, rel: "related-to", note: "impl-note auto-link" });
      edgeKey.add(k1);
      added++;
    }
    return added;
  } catch { return 0; }
}

// Select impl-notes whose promoted domain nodes are in the task's graph
// neighborhood (keyword seeds → BFS-expand via queryDomainGraph). Falls back
// to readImplNotes(limit) when the graph is empty or no notes match (first
// runs, unrelated tasks). This is the graph read path: §7.1 creates edges on
// promotion, and this function follows them to find relevant notes.
function readImplNotesByGraph(keywords: string[], limit = 5): string {
  try {
    if (!keywords.length) return readImplNotes(limit);
    const { nodes: neighborhood } = queryDomainGraph(keywords, 2);
    if (neighborhood.length === 0) return readImplNotes(limit);

    // Collect note texts from neighborhood nodes that originated as impl-notes.
    const noteTexts = neighborhood
      .filter((n) => n.source === "impl-note" || n.source === "generate")
      .map((n) => String(n.props?.result ?? ""));
    if (noteTexts.length === 0) return readImplNotes(limit);

    // Match note texts against impl-notes.md entries.
    const f = implNotesFile();
    const fileContent = existsSync(f) ? readFileSync(f, "utf8") : "";
    if (!fileContent.trim()) return readImplNotes(limit);

    const entries = fileContent.split(/^## Note /m).filter(Boolean);
    const matched = entries
      .filter((e) => noteTexts.some((t) => t && e.includes(t.slice(0, 60))))
      .slice(0, limit);
    if (matched.length === 0) return readImplNotes(limit); // fallback
    return matched.map((e) => `## Note ${e.trim()}`).join("\n\n");
  } catch { return readImplNotes(limit); }
}

// Lightweight keyword extraction for domain DB queries: lowercase, split on
// non-alphanumeric, drop short/common tokens. Defensive — never throws.
function extractKeywords(text: string): string[] {
  try {
    const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "your", "you", "are", "was", "but", "not", "all", "any", "use", "task", "prompt"]);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of (text ?? "").toLowerCase().split(/[^a-z0-9_]+/)) {
      const t = raw.trim();
      if (t.length < 3 || STOP.has(t) || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= 16) break;
    }
    return out;
  } catch { return []; }
}

// Harness state — per-SESSION (each opencode session sees only its own harness)
type HarnessJson = { name: string; total: number; current: number; tasks: any[]; unknownScan?: UnknownScanResult; scanRequired?: boolean; scanDone?: boolean; scanSummary?: string; questionsResolved?: boolean; questionAnswers?: Record<string, string>; usage?: Record<string, any>; startedAt?: string; updatedAt?: string; active?: boolean };
function harnessFile(sessionID: string): string { return join(STATE_DIR, sessionID || "_default", "harness.json"); }
function readHarness(sessionID: string): HarnessJson | null {
  try { const f = harnessFile(sessionID); if (!existsSync(f)) return null; return JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
}
function writeHarness(sessionID: string, h: HarnessJson) {
  try { const f = harnessFile(sessionID); mkdirSync(dirname(f), { recursive: true }); h.updatedAt = new Date().toISOString(); writeFileSync(f, JSON.stringify(h, null, 2)); } catch { /* */ }
}

// ── Reverse interview state ──────────────────────────────────────────────────
// Stateful across multiple tool calls (each call = one question round). Persists
// in STATE_DIR/<sessionID>/interview.json, mirroring harness.json's pattern.
// See docs/reverse-interview-design.md §3.
type InterviewQuestion = {
  id: string;
  text: string;
  why: string;
  priority: "critical" | "high" | "medium" | "low";
  category: string;
  optional: boolean;
  concept?: string;
};
type InterviewAnswer = {
  questionId: string;
  questionText: string;
  answer: string;
  ts: string;
};
type InterviewState = {
  id: string;
  task: string;
  userRequest: string;
  startedAt: string;
  updatedAt: string;
  questions: InterviewQuestion[];
  answers: InterviewAnswer[];
  currentIndex: number;
  phase: "planning" | "asking" | "complete";
  maxQuestions: number;
  summary?: string;
  constraints?: Record<string, string>;
};
function interviewFile(sessionID: string): string { return join(STATE_DIR, sessionID || "_default", "interview.json"); }
function readInterview(sessionID: string): InterviewState | null {
  try { const f = interviewFile(sessionID); if (!existsSync(f)) return null; return JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
}
function writeInterview(sessionID: string, s: InterviewState) {
  try { const f = interviewFile(sessionID); mkdirSync(dirname(f), { recursive: true }); s.updatedAt = new Date().toISOString(); writeFileSync(f, JSON.stringify(s, null, 2)); } catch { /* */ }
}
// Sort weights for question ranking (design §4.4). Lower sort key = asked first.
const PRIORITY_WEIGHT: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const CATEGORY_WEIGHT: Record<string, number> = { architecture: 0, scope: 1, constraint: 2, tradeoff: 3, preference: 4, "constraint-env": 5 };
// Resolve a question's `concept` to its graph distance in the neighborhood (design §4.4.1).
// Closer (smaller distance) = more urgent. Defaults to 9 (effectively "not in graph").
function resolveGraphDistance(concept: string | undefined, graphNodes: DomainNode[]): number {
  if (!concept) return 9;
  const lc = concept.toLowerCase().trim();
  if (!lc) return 9;
  for (const n of graphNodes) {
    if ((n.name ?? "").toLowerCase() === lc) return n.distance ?? 9;
  }
  for (const n of graphNodes) {
    const nm = (n.name ?? "").toLowerCase();
    if (nm.includes(lc) || lc.includes(nm)) return n.distance ?? 9;
  }
  return 9;
}
// Parse the model's question-list JSON into sorted InterviewQuestion[] (design §4.1/§4.4).
// Defensive: never throws; on parse failure returns [].
function parseInterviewQuestions(raw: string, maxQ: number, graphNodes: DomainNode[]): InterviewQuestion[] {
  try {
    let s = raw.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first >= 0 && last > first) s = s.slice(first, last + 1);
    const p = JSON.parse(s);
    const arr: any[] = Array.isArray(p.questions) ? p.questions : [];
    const qs: InterviewQuestion[] = arr.map((q: any) => ({
      id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      text: String(q.text || ""),
      why: String(q.why || ""),
      priority: (["critical", "high", "medium", "low"].includes(String(q.priority)) ? String(q.priority) : "medium") as InterviewQuestion["priority"],
      category: String(q.category || "scope"),
      optional: Boolean(q.optional),
      concept: q.concept ? String(q.concept) : undefined,
    })).filter((q) => q.text);
    qs.sort((a, b) => {
      const ka = (PRIORITY_WEIGHT[a.priority] ?? 3) * 100 + resolveGraphDistance(a.concept, graphNodes) * 10 + (CATEGORY_WEIGHT[a.category] ?? 5);
      const kb = (PRIORITY_WEIGHT[b.priority] ?? 3) * 100 + resolveGraphDistance(b.concept, graphNodes) * 10 + (CATEGORY_WEIGHT[b.category] ?? 5);
      return ka - kb;
    });
    return qs.slice(0, maxQ);
  } catch { return []; }
}
// Format a single question for the return-and-delegate pattern (design §5.3).
function formatQuestionOutput(qNum: number, total: number, q: InterviewQuestion): string {
  return `Interview Q${qNum}/${total} [${q.priority}]: ${q.text}\n` +
    (q.why ? `  Why it matters: ${q.why}\n` : "") +
    `\n[usage-coach NEXT] Present Q${qNum}/${total} to the user VERBATIM (copy the question text above). ` +
    `Do NOT answer it yourself — you are interviewing the USER, not guessing. ` +
    `End your turn after presenting the question. When the user responds, call ` +
    `reverse_interview({task: "...", answer: "<their response>"}) to record the answer and get the next question.`;
}
// Format the interview completion summary (design §9.1).
function formatCompleteOutput(state: InterviewState): string {
  const n = state.answers.length;
  const lines = [`Interview complete (${n} question${n === 1 ? "" : "s"} answered).`, "", "Resolved constraints:"];
  if (state.answers.length) {
    state.answers.forEach((a, i) => lines.push(`${i + 1}. ${a.questionText}: ${a.answer}`));
  } else {
    lines.push("(no questions were asked)");
  }
  lines.push("");
  lines.push("[usage-coach NEXT] Interview complete. The resolved constraints above MUST be injected into every generate prompt. Call harness_start(name, N) now, then for each task call generate with the constraints prepended to the prompt.");
  return lines.join("\n");
}
// Generate a structured summary from the Q&A pairs via runModel, persist to
// interview.json + domain DB (design §9.1/§9.2). model may be null on quota
// STOP / misconfiguration — falls back to a deterministic Q&A listing.
async function completeInterview(state: InterviewState, sessionID: string, client: any, model: string | null, directory: string): Promise<string> {
  if (state.phase === "complete") return formatCompleteOutput(state);
  const pairs = state.answers.map((a, i) => `Q${i + 1}: ${a.questionText}\nA: ${a.answer}`).join("\n\n");
  let summary = "";
  const constraints: Record<string, string> = {};
  if (model) {
    const sumPrompt = `Summarize this reverse interview as actionable constraints for implementation.\n\nQ&A pairs:\n${pairs || "(none)"}\n\nOutput JSON ONLY (no markdown fences, no prose):\n{"summary":"human-readable bullet list of resolved decisions","constraints":{"key":"value"}}`;
    const out = await runModel(client, model, sumPrompt, directory);
    if (!out.startsWith("ERROR:") && !out.startsWith("Task appears too large")) {
      try {
        let s = out.trim();
        const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fence) s = fence[1].trim();
        const fi = s.indexOf("{"); const la = s.lastIndexOf("}");
        if (fi >= 0 && la > fi) s = s.slice(fi, la + 1);
        const p = JSON.parse(s);
        summary = String(p.summary ?? "");
        if (p.constraints && typeof p.constraints === "object") {
          for (const [k, v] of Object.entries(p.constraints as Record<string, unknown>)) constraints[String(k)] = String(v);
        }
      } catch { /* parse fail — deterministic fallback below */ }
    }
  }
  if (!summary) {
    summary = state.answers.length
      ? state.answers.map((a, i) => `${i + 1}. ${a.questionText}: ${a.answer}`).join("\n")
      : "No significant ambiguities found. The task appears well-specified.";
  }
  state.summary = summary;
  state.constraints = constraints;
  state.phase = "complete";
  writeInterview(sessionID, state);
  // Store in domain DB so the next interview on a similar task needs fewer questions.
  try {
    const kw = extractKeywords(state.task);
    if (kw.length) saveInvestigationResult(kw, summary, "reverse_interview", 0.9);
  } catch (e) { log(`reverse_interview save err: ${String(e)}`); }
  return formatCompleteOutput(state);
}

// Sub-session progress tracking — updates/clears sub-session fields on a harness task.
// runModel's poller calls updateSubSession every 5s; clearSubSession runs on completion.
function updateSubSession(sessionID: string, taskId: number, fields: Record<string, any>) {
  try {
    const h = readHarness(sessionID);
    if (!h) return;
    const t = h.tasks.find((x: any) => x.id === taskId);
    if (!t) return;
    Object.assign(t, fields);
    writeHarness(sessionID, h);
  } catch { /* */ }
}
function clearSubSession(sessionID: string, taskId: number) {
  try {
    const h = readHarness(sessionID);
    if (!h) return;
    const t = h.tasks.find((x: any) => x.id === taskId);
    if (!t) return;
    t.subSessionId = undefined;
    t.subStep = undefined;
    t.lastActivity = undefined;
    t.subElapsed = undefined;
    writeHarness(sessionID, h);
  } catch { /* */ }
}
// Find the harness task currently in a given status (for correlating runModel with a task).
function findActiveTaskId(sessionID: string, status: string): number | undefined {
  try {
    const h = readHarness(sessionID);
    if (!h) return undefined;
    return h.tasks.find((x: any) => x.status === status)?.id;
  } catch { return undefined; }
}

// ── Unknown Scan types + helpers ──────────────────────────────────────────
// Pre-flight gap analysis (unknown-scan-design.md): scans the codebase against
// the user's tasks BEFORE generate, finding blind spots that would waste
// 30+ steps if discovered late. Deterministic profile + domain-DB query +
// model-assisted gap classification.
type CodebaseProfile = {
  skipped: boolean;
  reason?: string;
  language: string;
  frameworks: string[];
  testPattern?: string;
  testFramework?: string;
  structure: Array<{ dir: string; fileCount: number }>;
  manifestFiles: string[];
  keyDeps: string[];
  configFiles: string[];
  totalFiles: number;
};

type UnknownScanResult = {
  scannedAt: string;
  codebaseProfile: CodebaseProfile;
  knownKnowns: Array<{ taskId: number; title: string; note: string }>;
  knownUnknowns: Array<{ taskId: number; gap: string; suggestion?: string }>;
  unknownKnowns: Array<{ finding: string; source: string }>;
  unknownUnknowns: Array<{ finding: string; impact: string; mitigation?: string }>;
  questions: Array<{ id: string; question: string }>;
  taskRefinements: Array<{ taskId: number; action: string; detail: string }>;
  domainHits: number;
  domainMisses: number;
  rawAnalysis?: string;
};

const MANIFEST_FILES_SET = new Set([
  "package.json", "go.mod", "requirements.txt", "pyproject.toml", "Cargo.toml",
  "deno.json", "pom.xml", "build.gradle", "mix.exs", "Gemfile",
]);
const FRAMEWORK_SIG: Record<string, string[]> = {
  "react": ["react", "react-dom", "next"],
  "solid-js": ["solid-js", "@opentui/solid"],
  "vue": ["vue", "nuxt"],
  "svelte": ["svelte", "@sveltejs/kit"],
  "express": ["express"],
  "fastify": ["fastify"],
  "hono": ["hono"],
  "vitest": ["vitest"],
  "jest": ["jest"],
  "tsup": ["tsup"],
  "eslint": ["eslint"],
};

// Parse a raw file listing (from `input.$` find command) into a CodebaseProfile.
// Pure function — no I/O except reading manifest files for dependency detection.
// Defensive: never throws, always returns a valid CodebaseProfile.
function parseFileList(rawList: string, baseDir: string): CodebaseProfile {
  const empty: CodebaseProfile = {
    skipped: false, language: "unknown", frameworks: [], structure: [],
    manifestFiles: [], keyDeps: [], configFiles: [], totalFiles: 0,
  };
  try {
    const lines = (rawList || "").split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return { ...empty, skipped: true, reason: "no files found" };

    // Normalize paths relative to baseDir, cap at 200 files (design §11).
    const relFiles = lines
      .map((l) => (l.startsWith(baseDir) ? l.slice(baseDir.length).replace(/^\//, "") : l))
      .slice(0, 200);

    // Extension frequency → language detection.
    const extCounts: Record<string, number> = {};
    for (const f of relFiles) {
      const dot = f.lastIndexOf(".");
      if (dot >= 0) { const ext = f.slice(dot + 1).toLowerCase(); extCounts[ext] = (extCounts[ext] || 0) + 1; }
    }
    const language = detectLanguage(extCounts);

    // Manifest files.
    const manifestFiles = relFiles.filter((f) => {
      const base = f.split("/").pop() || f;
      return MANIFEST_FILES_SET.has(base);
    });

    // Parse manifests for deps + framework/test detection.
    let keyDeps: string[] = [];
    let frameworks: string[] = [];
    let testPattern: string | undefined;
    let testFramework: string | undefined;
    for (const mf of manifestFiles) {
      const full = join(baseDir, mf);
      if (existsSync(full)) {
        try {
          const content = JSON.parse(readFileSync(full, "utf8"));
          const depNames = Object.keys({ ...(content.dependencies || {}), ...(content.devDependencies || {}) });
          keyDeps = [...new Set([...keyDeps, ...depNames])].slice(0, 50);
          for (const [fw, sigs] of Object.entries(FRAMEWORK_SIG)) {
            if (sigs.some((s) => depNames.includes(s))) frameworks = [...new Set([...frameworks, fw])];
          }
          if (depNames.includes("vitest")) testFramework = "vitest";
          else if (depNames.includes("jest")) testFramework = "jest";
          else if (depNames.includes("pytest")) testFramework = "pytest";
        } catch { /* not JSON or unreadable */ }
      }
    }

    // Test file pattern detection.
    const testFiles = relFiles.filter((f) =>
      /\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/.test(f) ||
      /(^|\/)(test_[^.]+|.+_test)\.(py|go)$/.test(f),
    );
    if (testFiles.length) {
      const m = testFiles[0].match(/(\.(test|spec)\.[a-z]+|test_[a-z]+\.(py|go)|_[a-z]+_test\.(py|go))$/i);
      if (m) testPattern = "*" + m[0];
    }

    // Config files.
    const configFiles = relFiles.filter((f) =>
      /\.(eslintrc|prettierrc|tsconfig|jsconfig|babelrc|stylelintrc)/.test(f) ||
      f.endsWith("tsconfig.json") || f.endsWith(".eslintrc") || f.endsWith(".prettierrc"),
    );

    // Directory structure summary (top-level dirs by file count).
    const dirCounts: Record<string, number> = {};
    for (const f of relFiles) {
      const parts = f.split("/");
      const dir = parts.length > 1 ? parts[0] : ".";
      dirCounts[dir] = (dirCounts[dir] || 0) + 1;
    }
    const structure = Object.entries(dirCounts)
      .map(([dir, fileCount]) => ({ dir, fileCount }))
      .sort((a, b) => b.fileCount - a.fileCount)
      .slice(0, 8);

    return {
      skipped: false, language, frameworks, testPattern, testFramework,
      structure, manifestFiles, keyDeps, configFiles, totalFiles: lines.length,
    };
  } catch {
    return { ...empty, skipped: true, reason: "scan error" };
  }
}

function detectLanguage(extCounts: Record<string, number>): string {
  const sum = (exts: string[]) => exts.reduce((s, e) => s + (extCounts[e] || 0), 0);
  const ts = sum(["ts", "tsx", "mts", "cts"]);
  const js = sum(["js", "jsx", "mjs", "cjs"]);
  if (ts > 0 && ts >= js) return "TypeScript";
  if (js > 0) return "JavaScript";
  if ((extCounts["py"] || 0) > 0) return "Python";
  if ((extCounts["go"] || 0) > 0) return "Go";
  if ((extCounts["rs"] || 0) > 0) return "Rust";
  if ((extCounts["java"] || 0) > 0) return "Java";
  return "unknown";
}

// Build the gap-analysis prompt sent to the generator model (Phase 3).
function buildGapPrompt(
  userRequest: string,
  tasks: Array<{ id: number; title: string }>,
  profile: CodebaseProfile,
  domainNodes: any[],
): string {
  const taskList = tasks.map((t) => `${t.id}: ${t.title}`).join("\n");
  const profileStr = profile.skipped
    ? `(skipped — ${profile.reason || "unknown reason"})`
    : [
        `- Language: ${profile.language}`,
        `- Frameworks: ${profile.frameworks.join(", ") || "none detected"}`,
        `- Test pattern: ${profile.testPattern || "not detected"} (${profile.testFramework || "?"})`,
        `- Structure: ${profile.structure.map((s) => `${s.dir}/(${s.fileCount})`).join(", ")}`,
        `- Manifest: ${profile.manifestFiles.join(", ") || "none"}`,
        `- Key deps: ${profile.keyDeps.slice(0, 20).join(", ") || "none"}`,
        `- Config: ${profile.configFiles.join(", ") || "none"}`,
        `- Total files: ${profile.totalFiles}`,
      ].join("\n");
  const domainStr = domainNodes.length
    ? domainNodes.slice(0, 15).map((n) => `- ${n.name}: ${JSON.stringify(n.props).slice(0, 200)}`).join("\n")
    : "(empty — no prior knowledge stored)";
  return `You are a pre-flight gap analyst. Compare the user's request (the MAP) with the actual codebase (the TERRITORY) and classify every gap.

USER REQUEST:
${userRequest}

PROPOSED TASKS:
${taskList}

CODEBASE PROFILE:
${profileStr}

EXISTING DOMAIN KNOWLEDGE (from local DB):
${domainStr}

Classify into EXACTLY these 4 categories:

1. KNOWN KNOWNS — requirements explicitly stated in the user request.
   For each: which task it maps to, and the specific requirement.
2. KNOWN UNKNOWNS — the user left ambiguous / didn't specify.
   For each: what is ambiguous, which task it affects, and a suggestion.
3. UNKNOWN KNOWNS — implicit knowledge in the codebase not mentioned in the prompt
   (conventions, patterns, dependencies, tool registration style, test framework).
   For each: the finding and where in the codebase it comes from.
4. UNKNOWN UNKNOWNS — blind spots: things neither the prompt nor the codebase surface,
   but that WILL affect the work (platform quirks, hidden coupling, ordering deps).
   For each: the finding, its impact (high/medium/low), and a mitigation.

Also output:
- QUESTIONS: questions the agent should ask the user before proceeding.
  Only include questions where the answer materially changes the approach.
- TASK REFINEMENTS: suggestions to split, merge, reorder, add, or remove tasks.

Output as JSON ONLY (no markdown fences, no prose before or after):
{"knownKnowns":[{"taskId":1,"title":"","note":"requirement from prompt"}],"knownUnknowns":[{"taskId":1,"gap":"what is ambiguous","suggestion":"how to resolve"}],"unknownKnowns":[{"finding":"implicit knowledge","source":"file or pattern"}],"unknownUnknowns":[{"finding":"blind spot","impact":"high","mitigation":"how to handle"}],"questions":[{"id":"Q1","question":"..."}],"taskRefinements":[{"taskId":1,"action":"split","detail":"..."}]}`;
}

// Parse the model's gap-analysis output into a structured result. Defensive:
// if JSON parsing fails, the raw text is preserved as an unstructured finding.
function parseGapAnalysis(raw: string, profile: CodebaseProfile, domainHits: number): UnknownScanResult {
  const scannedAt = new Date().toISOString();
  const base: UnknownScanResult = {
    scannedAt, codebaseProfile: profile,
    knownKnowns: [], knownUnknowns: [], unknownKnowns: [], unknownUnknowns: [],
    questions: [], taskRefinements: [],
    domainHits, domainMisses: 0,
  };
  if (!raw || raw.startsWith("ERROR:") || raw.startsWith("Task appears too large")) {
    base.rawAnalysis = raw;
    return base;
  }
  try {
    let jsonStr = raw.trim();
    // Strip markdown fences if present.
    const fence = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) jsonStr = fence[1].trim();
    // Extract the outermost JSON object.
    const first = jsonStr.indexOf("{");
    const last = jsonStr.lastIndexOf("}");
    if (first >= 0 && last > first) jsonStr = jsonStr.slice(first, last + 1);
    const p = JSON.parse(jsonStr);
    const arr = <T,>(v: unknown, map: (item: any, i: number) => T): T[] =>
      Array.isArray(v) ? v.map(map) : [];
    base.knownKnowns = arr(p.knownKnowns, (k: any) => ({
      taskId: Number(k.taskId) || 0, title: String(k.title || ""), note: String(k.note || ""),
    }));
    base.knownUnknowns = arr(p.knownUnknowns, (k: any) => ({
      taskId: Number(k.taskId) || 0, gap: String(k.gap || ""),
      suggestion: k.suggestion ? String(k.suggestion) : undefined,
    }));
    base.unknownKnowns = arr(p.unknownKnowns, (k: any) => ({
      finding: String(k.finding || ""), source: String(k.source || "codebase"),
    }));
    base.unknownUnknowns = arr(p.unknownUnknowns, (k: any) => ({
      finding: String(k.finding || ""), impact: String(k.impact || "medium"),
      mitigation: k.mitigation ? String(k.mitigation) : undefined,
    }));
    base.questions = arr(p.questions, (q: any, i: number) => ({
      id: String(q.id || `Q${i + 1}`), question: String(q.question || ""),
    })).filter((q: any) => q.question);
    base.taskRefinements = arr(p.taskRefinements, (t: any) => ({
      taskId: Number(t.taskId) || 0, action: String(t.action || "split"),
      detail: String(t.detail || ""),
    }));
    base.domainMisses = base.unknownKnowns.length + base.unknownUnknowns.length;
  } catch {
    // Parse failed — preserve raw text as a single unstructured finding.
    base.unknownUnknowns = [{ finding: raw.slice(0, 500), impact: "medium", mitigation: "review the raw analysis" }];
    base.rawAnalysis = raw;
    base.domainMisses = 1;
  }
  return base;
}

// Format the structured result as a human-readable report for the agent.
function formatReport(r: UnknownScanResult): string {
  const L: string[] = [];
  L.push(`Unknown Scan Report — ${new Date(r.scannedAt).toLocaleString()}`);
  L.push("=".repeat(50));
  const p = r.codebaseProfile;
  if (p.skipped) {
    L.push(`\nCodebase Profile: SKIPPED (${p.reason || "unknown"})`);
  } else {
    L.push("\nCodebase Profile:");
    L.push(`  language: ${p.language}`);
    if (p.frameworks.length) L.push(`  frameworks: ${p.frameworks.join(", ")}`);
    if (p.testPattern) L.push(`  test: ${p.testPattern} (${p.testFramework || "?"})`);
    if (p.structure.length) L.push(`  structure: ${p.structure.map((s) => `${s.dir}/(${s.fileCount})`).join(", ")}`);
    L.push(`  total files: ${p.totalFiles}`);
  }
  L.push(`\nDomain DB: ${r.domainHits} hits, ${r.domainMisses} new findings`);
  if (r.knownKnowns.length) {
    L.push(`\nKnown Knowns (${r.knownKnowns.length}):`);
    for (const k of r.knownKnowns) L.push(`  + task ${k.taskId}: ${k.note}`);
  }
  if (r.knownUnknowns.length) {
    L.push(`\nKnown Unknowns (${r.knownUnknowns.length}):`);
    for (const k of r.knownUnknowns) {
      L.push(`  ! task ${k.taskId}: ${k.gap}`);
      if (k.suggestion) L.push(`    -> ${k.suggestion}`);
    }
  }
  if (r.unknownKnowns.length) {
    L.push(`\nUnknown Knowns (${r.unknownKnowns.length}) — implicit, from codebase:`);
    for (const k of r.unknownKnowns) L.push(`  i  ${k.finding}`);
  }
  if (r.unknownUnknowns.length) {
    L.push(`\nUnknown Unknowns (${r.unknownUnknowns.length}) — blind spots:`);
    for (const k of r.unknownUnknowns) {
      L.push(`  *  ${k.finding}`);
      L.push(`    impact: ${k.impact}`);
      if (k.mitigation) L.push(`    mitigation: ${k.mitigation}`);
    }
  }
  if (r.questions.length) {
    L.push(`\nQuestions for the user (${r.questions.length}):`);
    for (const q of r.questions) L.push(`  [${q.id}] ${q.question}`);
  }
  if (r.taskRefinements.length) {
    L.push("\nTask Refinement Suggestions:");
    for (const t of r.taskRefinements) L.push(`  -> task ${t.taskId}: ${t.action} - ${t.detail}`);
  }
  if (r.rawAnalysis) L.push(`\nRaw analysis: ${r.rawAnalysis.slice(0, 200)}`);
  L.push("\n[usage-coach NEXT] unknowns reviewed:");
  L.push("  - If questions are flagged, call question() to present them to the user.");
  L.push("  - If task splits are suggested, adjust via task_update.");
  L.push("  - Then proceed to generate/generate_batch.");
  return L.join("\n");
}

// Write the unknown-scan result into harness.json for TUI consumption.
function writeUnknownScan(sessionID: string, result: UnknownScanResult): void {
  try {
    const h = readHarness(sessionID);
    if (h) {
      h.unknownScan = result;
      h.scanDone = true;
      h.scanSummary = buildScanSummary(result);
      writeHarness(sessionID, h);
    }
  } catch { /* */ }
}

// Compact summary of unknown_scan findings for injection into generate prompts.
// Only includes ACTIONABLE items: unknown unknowns + questions. Known knowns are
// already in the prompt; known unknowns are resolved by user Q&A before generate.
function buildScanSummary(r: UnknownScanResult): string {
  const lines: string[] = [];
  if (r.unknownUnknowns?.length) {
    lines.push(`Unknown Unknowns (${r.unknownUnknowns.length}):`);
    for (const uu of r.unknownUnknowns.slice(0, 5)) {
      lines.push(`  [${uu.impact?.toUpperCase() ?? "?"}] ${uu.finding}${uu.mitigation ? ` → ${uu.mitigation}` : ""}`);
    }
  }
  if (r.unknownKnowns?.length) {
    lines.push(`Implicit knowledge (${r.unknownKnowns.length}):`);
    for (const uk of r.unknownKnowns.slice(0, 5)) {
      lines.push(`  ℹ ${uk.finding}`);
    }
  }
  if (r.questions?.length) {
    lines.push(`Pending questions (${r.questions.length}):`);
    for (const q of r.questions.slice(0, 5)) {
      lines.push(`  [Q] ${q.question}`);
    }
  }
  return lines.join("\n");
}

// Diagnosis gate check: returns null if gate passed, or a warning string if
// unknown_scan was required but not done yet. Used by generate/generate_batch.
function checkScanGate(sessionID: string): { warning: string | null; summary: string | null } {
  try {
    const h = readHarness(sessionID);
    if (!h || !h.scanRequired) return { warning: null, summary: null };
    if (!h.scanDone) {
      // scanRequired but not done → warn.
      return {
        warning: `⚠ DIAGNOSIS GATE: unknown_scan was NOT called before this generate. ` +
          `You are generating without pre-flight gap analysis. Blind spots (unknown unknowns) ` +
          `may cause wrong assumptions and waste steps. Call unknown_scan first, OR proceed ` +
          `consciously accepting the risk.`,
        summary: null,
      };
    }
    // Scan is done — check for unresolved questions from unknown_scan.
    if (h.unknownScan?.questions?.length && !h.questionsResolved) {
      return {
        warning: `⚠ UNRESOLVED QUESTIONS: unknown_scan found ${h.unknownScan.questions.length} question(s) for the user, but the ` +
          `question tool was not called. You MUST call question() to present these to the user before generating. ` +
          `The answers materially affect the approach. Do NOT proceed without asking.`,
        summary: h.scanSummary ?? null,
      };
    }
    // Scan done and questions resolved (or none) — include user answers in summary if available.
    let summary = h.scanSummary ?? null;
    if (h.questionsResolved && h.questionAnswers) {
      const answers = Object.entries(h.questionAnswers)
        .map(([id, ans]) => `  ${id}: ${ans}`).join("\n");
      summary = summary
        ? `${summary}\nUser answers to scan questions:\n${answers}`
        : `User answers to scan questions:\n${answers}`;
    }
    return { warning: null, summary };
  } catch { return { warning: null, summary: null }; }
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

// Write harness config to the GLOBAL config path (~/.config/opencode-usage-coach/harness.config.json).
// Merges with existing values so partial updates don't erase other fields.
function writeHarnessCfg(updates: HarnessCfg): string {
  const configDir = join(homedir(), ".config", "opencode-usage-coach");
  const configPath = join(configDir, "harness.config.json");
  try {
    mkdirSync(configDir, { recursive: true });
    const existing = (() => { try { return JSON.parse(readFileSync(configPath, "utf8")); } catch { return {}; } })();
    const merged = { ...existing, ...updates };
    writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n");
    return configPath;
  } catch (e) {
    throw new Error(`Failed to write harness config: ${String(e)}`, { cause: e });
  }
}

// Run a specific model in a NEW session. session.prompt() blocks until the sub-session's
// agent loop completes. A poller runs every WATCHDOG_POLL_MS during the blocking call:
//   1. Estimates step count from session.messages (assistant turns) for TUI display.
//   2. Enforces maxSteps: if exceeded, aborts the session (step-limit timeout).
// When `track` is provided, the poller also writes live progress to harness.json.
async function runModel(client: any, model: string, prompt: string, directory: string, track?: { sessionID: string; taskId: number }, maxSteps: number = DEFAULT_MAX_STEPS): Promise<string> {
  const t0 = Date.now();
  const subStart = Date.now();
  let poller: ReturnType<typeof setInterval> | null = null;
  let wallTimer: ReturnType<typeof setTimeout> | null = null;
  let subId: string | null = null;
  let timedOut = false;
  let pollerDone = false; // set in finally — stops pending async poller callbacks from writing stale data
  // Deferred promise: resolves when the step limit is exceeded (races against prompt).
  let signalTimeout!: () => void;
  const timeoutSignal = new Promise<void>((resolve) => { signalTimeout = resolve; });
  try {
    const slash = model.indexOf("/");
    const providerID = slash >= 0 ? model.slice(0, slash) : model;
    const modelID = slash >= 0 ? model.slice(slash + 1) : "";
    const s: any = await client.session.create({ body: { title: "uc-harness-sub" }, query: { directory } });
    const id = s?.data?.info?.id ?? s?.data?.id ?? s?.id;
    if (!id) return `ERROR: session.create returned no id (response: ${JSON.stringify(s?.data ?? s).slice(0, 200)})`;
    subId = id;
    log(`runModel(${model}): session ${id} created, sending prompt (${prompt.length} chars), max_steps=${maxSteps}`);
    // Poller: every WATCHDOG_POLL_MS, count steps from messages, enforce step limit,
    // and (when track is provided) write live progress to harness.json for the TUI.
    poller = setInterval(async () => {
      if (timedOut || pollerDone) return; // already timed out or cleaned up — skip
      try {
        let step = 0;
        let lastTs = new Date().toISOString();
        try {
          const msgs: any = await client.session.messages?.({ path: { id } });
          // After await: re-check pollerDone — the finally block may have run
          // while we were waiting for the messages API response.
          if (pollerDone) return;
          const msgList: any[] = Array.isArray(msgs?.data) ? msgs.data : Array.isArray(msgs) ? msgs : [];
          if (msgList.length) {
            // Count assistant turns as steps (each assistant message = one loop iteration).
            step = msgList.filter((m: any) => {
              const role = m?.role ?? m?.info?.role;
              return role === "assistant";
            }).length;
            const last = msgList[msgList.length - 1];
            const ts = last?.ts ?? last?.info?.updatedAt ?? last?.info?.completedAt ?? last?.updatedAt;
            if (ts) lastTs = String(ts);
          }
        } catch { /* messages endpoint unavailable — step stays 0 */ }
        // Step-limit enforcement: abort the sub-session if it exceeds maxSteps.
        if (step > maxSteps) {
          log(`runModel(${model}): STEP LIMIT exceeded (${step} > ${maxSteps}), aborting session ${id}`);
          timedOut = true;
          try { await client.session.abort?.({ path: { id } }); } catch { /* */ }
          signalTimeout();
          return;
        }
        // Update TUI progress (only when tracking is enabled and not cleaned up).
        if (track && !pollerDone) {
          const elapsed = Math.round((Date.now() - subStart) / 1000);
          updateSubSession(track.sessionID, track.taskId, {
            subSessionId: id, subStep: step, lastActivity: lastTs, subElapsed: elapsed,
          });
        }
      } catch (e) { log(`runModel poller err: ${String(e)}`); }
    }, WATCHDOG_POLL_MS);
    // Wall-clock timeout: if the prompt hasn't resolved within WALL_TIMEOUT_MS
    // (regardless of step count), abort the session. This catches cases where
    // the messages endpoint is unavailable (step stays 0) or the prompt hangs.
    wallTimer = setTimeout(() => {
      if (!timedOut) {
        timedOut = true;
        log(`runModel(${model}): WALL-CLOCK timeout after ${WALL_TIMEOUT_MS / 1000}s, aborting session ${id}`);
        try { client.session.abort?.({ path: { id } }); } catch { /* */ }
        signalTimeout();
      }
    }, WALL_TIMEOUT_MS);
    // Race: prompt completes normally vs step-limit/wall-clock timeout.
    // Wrap prompt with .then(onFulfilled, onRejected) so that aborting the session
    // (which causes prompt to reject) never produces an unhandled promise rejection.
    const promptP: Promise<any> = client.session.prompt({
      path: { id },
      body: { model: { providerID, modelID }, parts: [{ type: "text", text: prompt }] },
    }).then(
      (r: any) => r,
      () => null, // abort causes rejection -> return null (handled via timedOut flag)
    );
    const resp: any = await Promise.race([promptP, timeoutSignal.then(() => null)]);
    const elapsed = Math.round((Date.now() - t0) / 1000);

    // Step-limit timeout: the task is too large — tell the caller to split it.
    if (timedOut) {
      try {
        const summary: any = await client.session.summarize?.({ path: { id } });
        log(`runModel(${model}): TIMED OUT summary: ${JSON.stringify(summary?.data ?? summary).slice(0, 300)}`);
      } catch { /* */ }
      try { await client.session.delete?.({ path: { id } }); } catch { /* */ }
      subId = null;
      log(`runModel(${model}): TIMED OUT after ${elapsed}s (${maxSteps} steps exceeded)`);
      return `Task appears too large (exceeded ${maxSteps} steps). Consider splitting into smaller subtasks.\n[usage-coach NEXT] split the original task into smaller subtasks (each should complete within ${maxSteps} steps), then re-run generate for each subtask.`;
    }

    // Normal completion: extract assistant text from the response parts.
    const parts: any[] = resp?.data?.parts ?? resp?.parts ?? [];
    const text = parts.filter((p: any) => p?.type === "text").map((p: any) => p?.text ?? "").join("");
    // Before cleanup, summarize the sub-session for visibility (what did it do?).
    try {
      const summary: any = await client.session.summarize?.({ path: { id } });
      log(`runModel(${model}): sub-session summary: ${JSON.stringify(summary?.data ?? summary).slice(0, 300)}`);
    } catch { /* summarize not available — skip */ }
    try { await client.session.delete?.({ path: { id } }); } catch { /* */ }
    subId = null;
    log(`runModel(${model}): done ${elapsed}s, ${text.length} chars`);
    return text.trim() || `ERROR: no assistant text in prompt response after ${elapsed}s (parts: ${parts.length}, types: ${parts.map((p: any) => p?.type).join(",")})`;
  } catch (e) {
    const elapsed = Math.round((Date.now() - t0) / 1000);
    log(`runModel err (${model}, ${elapsed}s): ${String(e)}`);
    return `ERROR: runModel exception after ${elapsed}s: ${String(e)}`;
  } finally {
    // Set pollerDone FIRST — stops pending async poller callbacks from writing
    // stale data after clearSubSession runs.
    pollerDone = true;
    if (poller) clearInterval(poller);
    if (wallTimer) clearTimeout(wallTimer);
    if (track) { try { clearSubSession(track.sessionID, track.taskId); } catch { /* */ } }
    if (subId) { try { await client.session.delete?.({ path: { id: subId } }); } catch { /* */ } }
  }
}

// Agent-mode gating — harness tools + quota coaching are restricted to these agent
// modes (UC_HARNESS_AGENT, comma-separated). Other modes (e.g. Agent-Factory-
// Coordinator) stay fully clean: no tool gating, no system-prompt injection.
const HARNESS_AGENTS = (process.env.UC_HARNESS_AGENT ?? "Usage-Coach-Harness")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

// Quota thresholds (override via env). Provider + lighter model come from config/env (see init).
const num = (e: string, d: number) => { try { const v = Number(process.env[e]); return Number.isFinite(v) && v >= 0 ? v : d; } catch { return d; } };
const STOP_5H = num("UC_STOP_5H", 92), THR_5H = num("UC_THROTTLE_5H", 70);
const STOP_WK = num("UC_STOP_WEEKLY", 95), THR_WK = num("UC_THROTTLE_WEEKLY", 85);
const STOP_MO = num("UC_STOP_MONTHLY", 98);
// Domain-DB worm (GC) thresholds — override via env. Time-based + size-based eviction.
const WORM_MAX_AGE_DAYS = num("UC_WORM_MAX_AGE_DAYS", 180);
const WORM_MAX_NODES = num("UC_WORM_MAX_NODES", 100000);

function humanRemaining(iso?: string): string {
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

/** Parse raw codexbar --json output into a Quota object. Pure function — no I/O. */
export function parseQuotaResponse(rawText: string): Quota | null {
  try {
    const text = (rawText || "").trim();
    if (!text || text === "[]") return null;
    const u = (JSON.parse(text)[0]?.usage) as { primary?: QuotaWindow; secondary?: QuotaWindow; tertiary?: QuotaWindow } | undefined;
    if (!u) return null;
    return {
      weekly: u.primary ?? { usedPercent: 0 },
      monthly: u.secondary ?? { usedPercent: 0 },
      fiveHour: u.tertiary ?? { usedPercent: 0 },
    };
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
    p.on("error", () => resolve(null));
    p.on("close", () => {
      resolve(parseQuotaResponse(out));
    });
  });
}

/** fetchQuota with retry: max 3 attempts with 1s, 2s delays between failures. */
async function fetchQuotaWithRetry(provider: string, maxRetries = 3): Promise<Quota | null> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const q = await fetchQuota(provider);
    if (q) return q;
    if (attempt < maxRetries - 1) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return null;
}

function coach(q: Quota | null, lighter: string): Coaching {
  if (!q) return { decision: "GO", advice: "quota unavailable — retrying. proceeding cautiously.", weekly: -2, monthly: -2, fiveHour: -2 };
  const wk = Math.round(q.weekly?.usedPercent ?? 0), mo = Math.round(q.monthly?.usedPercent ?? 0), h5 = Math.round(q.fiveHour?.usedPercent ?? 0);
  if (Number.isNaN(wk) || Number.isNaN(mo) || Number.isNaN(h5)) return { decision: "THROTTLE", advice: "invalid quota data — proceeding with caution. switch to lighter model if available.", weekly: Number.isNaN(wk) ? 0 : wk, monthly: Number.isNaN(mo) ? 0 : mo, fiveHour: Number.isNaN(h5) ? 0 : h5 };
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

// Resolve the current session's agent name + model + provider via the SDK client.
// Cached per sessionID (60s TTL). Also detects model changes (triggers quota refresh).
const agentCache = new Map<string, { agent: string; model: string; provider: string; ts: number }>();
// Global: last-known model/provider (updated by resolveAgent, read by refreshBackground)
let currentModel = "";
let currentProvider = "";
let currentAgent = "";
let modelChanged = false; // set by resolveAgent on model change, cleared by refreshBackground

function isFreeModel(model: string, provider: string): boolean {
  if (!model && !provider) return false;
  if (provider === "opencode") return true;
  if (model.toLowerCase().includes("free")) return true;
  return false;
}

// Map opencode providerID (e.g. "zai-coding-plan") to codexbar provider name (e.g. "zai").
function providerToCodexbar(provider: string): string {
  if (!provider) return "";
  const first = provider.split("-")[0];
  return first || provider; // fallback to full provider if first segment is empty (e.g. "-openai")
}

async function resolveAgent(client: any, sessionID: string): Promise<string> {
  if (!sessionID) return "";
  const hit = agentCache.get(sessionID);
  if (hit && Date.now() - hit.ts < 60000) {
    currentModel = hit.model;
    currentProvider = hit.provider;
    return hit.agent;
  }
  try {
    const s: any = await client.session.get({ path: { id: sessionID } });
    // Debug: dump the raw session object structure to find model/provider fields
    log(`resolveAgent raw session: ${JSON.stringify(s?.data?.info ?? s?.data ?? s?.info ?? s).slice(0, 500)}`);
    const info = s?.data?.info ?? s?.data ?? s?.info ?? s;
    const agent = String(info?.agent ?? "");
    // model might be an object like { id: "...", providerID: "..." } or a string
    const rawModel = info?.model;
    const model = typeof rawModel === "string" ? rawModel : (rawModel?.id ?? rawModel?.modelID ?? rawModel?.name ?? "");
    const rawProvider = info?.providerID ?? info?.provider ?? (typeof rawModel === "object" ? rawModel?.providerID ?? rawModel?.provider : "");
    const provider = typeof rawProvider === "string" ? rawProvider : (rawProvider?.id ?? "");
    // Detect model change
    if (currentModel && model && currentModel !== model) {
      log(`MODEL CHANGED: ${currentModel} → ${model} (provider: ${currentProvider} → ${provider})`);
      modelChanged = true;
    }
    agentCache.set(sessionID, { agent, model, provider, ts: Date.now() });
    currentModel = model;
    currentProvider = provider;
    return agent;
  } catch (e) { log(`resolveAgent err: ${String(e)}`); return ""; }
}
function isHarnessAgent(agent: string): boolean {
  if (!agent) return false;
  return HARNESS_AGENTS.includes(agent.toLowerCase());
}

const LOADING: Coaching = { decision: "GO", advice: "quota loading…", weekly: -1, monthly: -1, fiveHour: -1 };

export default async function UsageCoachPlugin(input: {
  project: unknown; client: unknown;
  $: (s: TemplateStringsArray, ...v: unknown[]) => Promise<{ stdout?: { toString(): string } | string }>;
  directory: string; worktree: string;
}) {
  pipeLog(`UsageCoachPlugin CALLED | dir=${input.directory} | worktree=${input.worktree}`);
  // Top-level guard: even if init fails, opencode keeps working.
  try {
    setStateDir(input.directory); // per-directory state isolation
    initDomain(STATE_DIR); // domain DB shares the same per-project state dir
    // Provider + lighter model: env > config > empty (codexbar picks its default).
    // No hardcoded provider — this plugin is provider-agnostic.
    const cfg0 = readHarnessCfg(input.directory);
    const PROVIDER = process.env.UC_PROVIDER ?? cfg0.provider ?? "";
    const LIGHTER = process.env.UC_LIGHTER_MODEL ?? cfg0.lighterModel ?? "a lighter model";
    let last: Coaching | null = null;
    let lastKnownQuota: Quota | null = null; // persists across refresh cycles for retry fallback
    let lastFetchedAt = 0;
    let refreshing = false;

    // Background refresh: never awaited. Skips re-call within TTL.
    // Also triggered on model change (lastFetchedAt reset by caller).
    const refreshBackground = () => {
      try {
        if (refreshing) return;
        if (last && !modelChanged && Date.now() - lastFetchedAt < TTL_MS) return;
        refreshing = true;
        modelChanged = false; // consumed

        // Free model short-circuit: no quota to track.
        if (isFreeModel(currentModel, currentProvider)) {
          last = { decision: "GO", advice: `${currentModel || currentProvider || "free model"} — no quota limit.`, weekly: -1, monthly: -1, fiveHour: -1, model: currentModel, provider: currentProvider, isFree: true };
          lastFetchedAt = Date.now();
          writeState({ ...last, providers: [], model: currentModel, provider: currentProvider, isFree: true, agent: currentAgent, updatedAt: new Date().toISOString() } as any);
          log(`FREE | model=${currentModel} provider=${currentProvider}`);
          refreshing = false;
          return;
        }

        // Paid model: fetch quota for the ACTIVE provider (detected from session), mapped to codexbar name.
        const activeProvider = providerToCodexbar(currentProvider) || PROVIDER;
        fetchQuotaWithRetry(activeProvider).then(async (q) => {
          try {
            if (q) lastKnownQuota = q; // cache for retry fallback
            const effectiveQ = q ?? lastKnownQuota; // fall back to last known good
            last = coach(effectiveQ, LIGHTER); lastFetchedAt = Date.now();
            // also fetch per-provider coach view (best-effort, non-blocking on failure)
            let providers: ProviderCoach[] = [];
            try { providers = await fetchProvidersCoach(); } catch { /* */ }
            // If fetchQuota failed (top-level weekly < 0) but providers have real data,
            // restore the top-level from providers[0] so the TUI/advice show real numbers.
            if (providers.length > 0 && last.weekly < 0) {
              const p0 = providers[0];
              last = { ...last, weekly: p0.weekly, fiveHour: p0.fiveHour, monthly: p0.weekly >= 0 ? 0 : -1, advice: p0.advice, decision: p0.weekly >= STOP_WK ? "STOP" : p0.weekly >= THR_WK ? "THROTTLE" : "GO" };
            }
            writeState({ ...last, providers, model: currentModel, provider: currentProvider, isFree: false, agent: currentAgent, updatedAt: new Date().toISOString() } as any);
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

    return {
      event: async ({ event }: { event: { type: string } }) => {
        try {
          if (event.type === "session.created" || event.type === "session.idle") refreshBackground();
          // Worm (GC): run the domain-DB eviction on idle. Cheap no-op when nothing is stale.
          if (event.type === "session.idle") { try { const r = evictStale(WORM_MAX_AGE_DAYS, WORM_MAX_NODES); if (r.removed) log(`evictStale: removed ${r.removed}, kept ${r.kept} (maxAge=${WORM_MAX_AGE_DAYS}d, maxNodes=${WORM_MAX_NODES})`); } catch (e) { log(`evictStale err: ${String(e)}`); } }
        }
        catch (e) { log(`event err: ${String(e)}`); }
      },

      // ACT(1) — model/agent detection on EVERY tool call (cached 60s, negligible overhead).
      // Then hard-gate harness tools by agent mode + quota STOP.
      "tool.execute.before": async (_input: { tool: string; sessionID: string; callID: string }) => {
        // Detect model + agent on every tool call (bash, read, write, etc.) — not just harness tools.
        const agent = await resolveAgent(input.client, _input.sessionID);
        currentAgent = agent;
        refreshBackground(); // picks up model changes immediately

        const harnessTools = ["unknown_scan", "question", "generate", "generate_batch", "grade", "investigate", "verify_diagnosis", "generalize", "harness_start", "task_update", "harness_done", "record_failure", "reverse_interview"];
        if (!harnessTools.includes(_input.tool)) return; // only harness tools are gated below
        if (!isHarnessAgent(agent)) {
          throw new Error(`[${PLUGIN_NAME}] '${_input.tool}' is restricted to agent mode ${JSON.stringify(HARNESS_AGENTS)} (current: ${JSON.stringify(agent || "unknown")}). Switch to that agent mode to use it.`);
        }
        // (2) quota gate: STOP blocks quota-consuming harness tools.
        let decision: Decision;
        try { decision = current().decision; } catch { decision = "GO"; } // safe default
        if (decision === "STOP") {
          throw new Error(`[${PLUGIN_NAME}] blocked: quota limit exceeded. ${current().advice}`);
        }
      },

      // ACT(2) inject coaching into system prompt — ONLY in the harness agent mode,
      // so other modes' system prompts stay completely clean. Silent on error.
      "experimental.chat.system.transform": async (_input: { sessionID?: string }, output: { system: string[] }) => {
        try {
          if (_input.sessionID) {
            const agent = await resolveAgent(input.client, _input.sessionID);
            refreshBackground(); // picks up model changes immediately
            if (!isHarnessAgent(agent)) return; // not harness mode — don't inject
          }
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
          description: "Start the harness: register the total task count on the panel. Call once when the harness loop begins. IMPORTANT: each generate/generate_batch sub-session is step-limited (default 30). If any task seems too large, split it into smaller subtasks BEFORE starting — oversized tasks will timeout.",
          args: { name: tool.schema.string(), total: tool.schema.number() },
          async execute(args: { name: string; total: number }, ctx: any) {
            writeHarness(ctx.sessionID, { name: args.name, total: args.total, current: 0, tasks: [], usage: {}, active: true, scanRequired: true, startedAt: new Date().toISOString() });
            return `Harness '${args.name}' started (${args.total} tasks).

⚠ DIAGNOSIS GATE — unknown_scan is REQUIRED before generate/generate_batch.
  unknown_scan({ prompt: "<user request>", tasks: [{id:1, title:"..."}, ...] })
  If you skip it, generate will inject a ⚠ warning into the sub-session prompt.
  Review the report: if QUESTIONS are flagged → call question() to present them
  to the user BEFORE generate (it is enforced — generate will block with a
  warning until answers are recorded). If TASK REFINEMENTS are suggested →
  apply via task_update. Unknown unknowns found will be automatically injected
  into generate prompts as context.

STEP LIMIT (default ${DEFAULT_MAX_STEPS}): each generate call creates a sub-session that is automatically aborted if it exceeds ${DEFAULT_MAX_STEPS} assistant steps. Before starting the loop, review each task: can it be completed in a focused, single-pass effort? If a task seems too broad (multiple files, multiple features, open-ended research), SPLIT it now into 2-3 smaller subtasks. A timeout wastes quota — split upfront.

DETERMINISTIC LOOP — first classify the tasks:
  INDEPENDENT = task B does NOT need task A's output  ->  use PATH A (parallel, faster)
  DEPENDENT   = task B needs task A's output          ->  use PATH B (sequential)

PATH A — INDEPENDENT (parallel via generate_batch):
  1. task_update(1..${args.total}, title, "generating")
  2. generate_batch({tasks: [{id:1, prompt:"Task: <title1>. Perform it."}, ...]})  -> all results + NEXT
  3. for each i: task_update(i, title, "grading") + grade({prompt:"Evaluate... PASS/FAIL first line. Task: <title>"})  -> verdict + NEXT
  4. for each i: PASS -> task_update(i, title, "completed", "PASS"); FAIL -> revise (up to 2x) or task_update(i, title, "failed", "FAIL")

PATH B — DEPENDENT (sequential):
  for i in 1..${args.total}:
    1. task_update(i, title, "generating")
    2. generate({prompt:"Task: <title>. Perform it."})  -> work + NEXT
    3. task_update(i, title, "grading")
    4. grade(...)  -> verdict + NEXT
    5. PASS -> task_update(i, title, "completed", "PASS"); FAIL -> revise (up to 2x) or failed

Then: harness_done(). Follow the [usage-coach NEXT] directive each tool returns. Do NOT improvise the sequence.`;
          },
        }),
        unknown_scan: tool({
          description: "Pre-flight gap analysis: call AFTER harness_start, BEFORE generate. Scans the codebase against the user's request to find blind spots (unknown unknowns) that could waste 30+ steps if discovered late. Returns identified unknowns + task split suggestions + user confirmation questions. Writes results to harness.json for TUI display.",
          args: {
            prompt: tool.schema.string().describe("The user's original request (the full prompt that triggered the harness)."),
            tasks: tool.schema.array(tool.schema.object({ id: tool.schema.number(), title: tool.schema.string() })).optional().describe("Tasks registered via harness_start (id + title). If omitted, a single task derived from the prompt is assumed."),
            skip_scan: tool.schema.boolean().optional().describe("true: skip codebase scan and do prompt analysis only (default false; auto-skips for dirs with <5 files)."),
          },
          async execute(args: { prompt: string; tasks?: Array<{ id: number; title: string }>; skip_scan?: boolean }, ctx: any) {
            const tasks = args.tasks && args.tasks.length > 0
              ? args.tasks
              : [{ id: 1, title: args.prompt.slice(0, 80) }];

            // ── PHASE 1 — Codebase Profile (deterministic, via spawn — NOT input.$ which leaks to TUI) ──
            let profile: CodebaseProfile;
            if (args.skip_scan) {
              profile = { skipped: true, reason: "skip_scan requested", language: "unknown", frameworks: [], structure: [], manifestFiles: [], keyDeps: [], configFiles: [], totalFiles: 0 };
            } else {
              try {
                // Use spawnSync (not input.$ / BunShell) — BunShell leaks stdout to the TUI.
                const dir = ctx.directory || ".";
                const result = spawnSync("find", [
                  dir, "-maxdepth", "4", "-type", "f",
                  "-not", "-path", "*/node_modules/*",
                  "-not", "-path", "*/.git/*",
                  "-not", "-path", "*/dist/*",
                  "-not", "-path", "*/.cache/*",
                ], { encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 });
                const fileList = result.stdout || "";
                profile = parseFileList(fileList, ctx.directory);
                if (profile.totalFiles < 5) {
                  profile = { ...profile, skipped: true, reason: `directory nearly empty (${profile.totalFiles} files)` };
                }
              } catch (e) {
                profile = { skipped: true, reason: `scan error: ${String(e).slice(0, 100)}`, language: "unknown", frameworks: [], structure: [], manifestFiles: [], keyDeps: [], configFiles: [], totalFiles: 0 };
              }
            }

            // ── PHASE 2 — Domain DB Query (graph-enhanced, maxDepth=2) ──
            let domainNodes: any[] = [];
            let domainHits = 0;
            try {
              const combined = `${args.prompt} ${tasks.map((t) => t.title).join(" ")}`;
              const kw = extractKeywords(combined);
              if (kw.length) {
                const graph = queryDomainGraph(kw, 2);
                domainNodes = graph.nodes || [];
                domainHits = domainNodes.length;
              }
            } catch (e) { log(`unknown_scan domain query err: ${String(e)}`); }

            // ── PHASE 3 — Gap Analysis (model-assisted, quota-aware) ──
            const cfg = readHarnessCfg(ctx.directory);
            if (!cfg.generator) {
              const result: UnknownScanResult = {
                scannedAt: new Date().toISOString(), codebaseProfile: profile,
                knownKnowns: [], knownUnknowns: [], unknownKnowns: [], unknownUnknowns: [],
                questions: [], taskRefinements: [], domainHits, domainMisses: 0,
                rawAnalysis: "ERROR: no generator configured",
              };
              writeUnknownScan(ctx.sessionID, result);
              return formatReport(result) + '\n\nERROR: no generator model configured. Set "generator" in harness.config.json for model-assisted analysis.';
            }
            let decision = "GO"; try { decision = current().decision; } catch { /* */ }
            if (decision === "STOP") {
              const result: UnknownScanResult = {
                scannedAt: new Date().toISOString(), codebaseProfile: profile,
                knownKnowns: [], knownUnknowns: [], unknownKnowns: [], unknownUnknowns: [],
                questions: [], taskRefinements: [], domainHits, domainMisses: 0,
                rawAnalysis: "quota STOP — model analysis skipped",
              };
              writeUnknownScan(ctx.sessionID, result);
              return formatReport(result) + "\n\n[usage-coach] quota STOP — model-assisted analysis skipped. Proceed with caution.";
            }
            const throttle = decision === "THROTTLE" && cfg.lighterModel;
            const model = throttle ? cfg.lighterModel! : cfg.generator;
            const gapPrompt = buildGapPrompt(args.prompt, tasks, profile, domainNodes);
            const raw = await runModel(input.client, model, gapPrompt, ctx.directory, undefined, 15);

            // ── PHASE 3b — Parse model output ──
            const result = parseGapAnalysis(raw, profile, domainHits);

            // ── PHASE 4 — Domain DB Store (new findings) ──
            try {
              for (const uk of result.unknownKnowns.slice(0, 5)) {
                const kw = extractKeywords(uk.finding);
                if (kw.length) saveInvestigationResult(kw, uk.finding, "unknown_scan");
              }
              for (const uu of result.unknownUnknowns.slice(0, 3)) {
                const kw = extractKeywords(uu.finding);
                if (kw.length) saveInvestigationResult(kw, `${uu.finding} (impact: ${uu.impact})`, "unknown_scan");
              }
            } catch (e) { log(`unknown_scan save err: ${String(e)}`); }

            // ── PHASE 5 — Persist + Return ──
            writeUnknownScan(ctx.sessionID, result);
            return formatReport(result);
          },
        }),
        question: tool({
          description: "Present unknown_scan questions to the user. REQUIRED after unknown_scan finds questions — call BEFORE generate. First call (no answers) returns the questions formatted for presentation. Present them to the user, then call again with their answers.",
          args: {
            answers: tool.schema.record(tool.schema.string(), tool.schema.string()).optional().describe("User's answers keyed by question ID (e.g. {\"Q1\": \"yes\", \"Q2\": \"node\"}). Omit on first call to get the questions."),
          },
          async execute(args: { answers?: Record<string, string> }, ctx: any) {
            const h = readHarness(ctx.sessionID);
            if (!h || !h.unknownScan || !h.unknownScan.questions?.length) {
              return "No questions from unknown_scan. [usage-coach NEXT] proceed to generate.";
            }
            const questions = h.unknownScan.questions;

            // First call: no answers → present questions to the user
            if (!args.answers) {
              const lines = [`unknown_scan found ${questions.length} question(s) that need user input before proceeding:\n`];
              questions.forEach((q) => {
                lines.push(`[${q.id}] ${q.question}`);
              });
              lines.push("\nPresent ALL of these questions to the user. Collect their answers, then call question({ answers: { \"" + questions[0].id + "\": \"...\" } }) with ALL answers.");
              lines.push("[usage-coach NEXT] Present the questions above to the user verbatim. After they respond, call question({answers:{...}}) to record answers, then proceed to generate.");
              return lines.join("\n");
            }

            // Second call: answers provided → store them
            h.questionsResolved = true;
            h.questionAnswers = args.answers;
            writeHarness(ctx.sessionID, h);

            const answered = Object.keys(args.answers).length;
            const lines = [`Questions resolved (${answered}/${questions.length} answered).\n`];
            questions.forEach((q) => {
              const ans = args.answers![q.id];
              if (ans) lines.push(`  ${q.id}: ${q.question}\n  → ${ans}`);
            });
            lines.push("\n[usage-coach NEXT] Answers recorded. Proceed to generate — they will be injected into the sub-session prompt.");
            return lines.join("\n");
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
            const cfg = readHarnessCfg(ctx.directory);
            const h = readHarness(ctx.sessionID) ?? { name: "batch", total: 0, current: 0, tasks: [], usage: {}, active: true };
            h.tasks = h.tasks.filter((x: any) => x.id !== args.id);
            // Model is required for quota tracking. Auto-fill from config.generator if not provided.
            const model = args.model || cfg.generator || "";
            if (!model) return `ERROR: task ${args.id} has no model and no generator configured. Set "generator" in harness.config.json.`;
            h.tasks.push({ id: args.id, title: args.title, status: args.status, model, revisions: args.revisions ?? 0, score: args.score ?? null, startedAt: new Date().toISOString() });
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
        record_failure: tool({
          description: "Stage 1 (RECORD) of the learning loop. Append a failure record to failures.ndjson for later root-cause analysis.",
          args: {
            task: tool.schema.string(),
            prompt: tool.schema.string(),
            gradeResult: tool.schema.string(),
            model: tool.schema.string().optional(),
            revisions: tool.schema.number().optional(),
          },
          async execute(args: { task: string; prompt: string; gradeResult: string; model?: string; revisions?: number }, _ctx: any) {
            const rec = { ts: new Date().toISOString(), task: args.task, prompt: args.prompt, gradeResult: args.gradeResult, model: args.model, revisions: args.revisions };
            try { mkdirSync(STATE_DIR, { recursive: true }); appendFileSync(failuresFile(), JSON.stringify(rec) + "\n"); } catch (e) { log(`record_failure err: ${String(e)}`); }
            return `Failure recorded. [usage-coach NEXT] call investigate({failure: ${JSON.stringify(rec)}}) to find the root cause.`;
          },
        }),
        investigate: tool({
          description: "Stage 2 (INVESTIGATE) of the learning loop. Run the generator to analyze the ROOT CAUSE of a failure (not just the symptom).",
          args: {
            task: tool.schema.string(),
            prompt: tool.schema.string(),
            gradeResult: tool.schema.string(),
            model: tool.schema.string().optional(),
          },
          async execute(args: { task: string; prompt: string; gradeResult: string; model?: string }, ctx: any) {
            const cfg = readHarnessCfg(ctx.directory);
            if (!cfg.generator) return "ERROR: no generator model configured. Set \"generator\" in harness.config.json (see harness.config.example.json).";
            // Query domain DB for known facts before analyzing root cause.
            let domainPrefix = "";
            let keywords: string[] = [];
            let domainEmpty = true;
            try {
              keywords = extractKeywords(`${args.task} ${args.gradeResult}`);
              if (keywords.length) {
                const { nodes, edges } = queryDomain(keywords);
                if ((nodes && nodes.length) || (edges && edges.length)) {
                  domainEmpty = false;
                  domainPrefix = `Known facts from domain DB: ${JSON.stringify({ nodes, edges })}. Use these if relevant.\n\n---\n\n`;
                }
              }
            } catch (e) { log(`investigate domain query err: ${String(e)}`); }
            const rcaPrompt = `A task failed. Analyze the ROOT CAUSE (not just the symptom).\nTask: ${args.task}\nWhat was expected (from grade): ${args.gradeResult}\nRead relevant files in the directory if needed.\nOutput a structured root cause:\ncategory: (one of: constraint-violation, missing-context, tool-misuse, model-limitation, other)\nexplanation: <why it failed>\nevidence: <file/line or specific quote>`;
            const invTaskId = findActiveTaskId(ctx.sessionID, "revising");
            const out = await runModel(input.client, cfg.generator, domainPrefix + rcaPrompt, ctx.directory,
              invTaskId ? { sessionID: ctx.sessionID, taskId: invTaskId } : undefined);
            // Investigate-if-unknown, then store: only persist the finding when the domain DB was empty.
            if (domainEmpty && keywords.length) {
              try { saveInvestigationResult(keywords, out, "investigate"); } catch (e) { log(`investigate save err: ${String(e)}`); }
            }
            return out + "\n[usage-coach NEXT] call verify_diagnosis with this diagnosis.";
          },
        }),
        verify_diagnosis: tool({
          description: "Stage 3 (VERIFY) of the learning loop. Run the grader to check whether a diagnosis is CORRECT and ACTIONABLE (leads to a useful rule). Returns PASS/FAIL + a [usage-coach NEXT] directive.",
          args: {
            diagnosis: tool.schema.string(),
            task: tool.schema.string(),
            gradeResult: tool.schema.string(),
          },
          async execute(args: { diagnosis: string; task: string; gradeResult: string }, ctx: any) {
            const cfg = readHarnessCfg(ctx.directory);
            const model = cfg.grader ?? cfg.generator;
            if (!model) return "FAIL\n(ERROR: no grader/generator model configured.)\n[usage-coach NEXT] configure grader in harness.config.json, then retry verify_diagnosis.";
            const verifyPrompt = `Verify this root-cause analysis for a failure.\nTask: ${args.task}\nGrade feedback: ${args.gradeResult}\nDiagnosis: ${args.diagnosis}\nIs the diagnosis CORRECT and ACTIONABLE (leads to a useful rule)?\nOutput PASS (the diagnosis is right) or FAIL (re-investigate needed), then reason.`;
            const verTaskId = findActiveTaskId(ctx.sessionID, "revising");
            const out = await runModel(input.client, model, verifyPrompt, ctx.directory,
              verTaskId ? { sessionID: ctx.sessionID, taskId: verTaskId } : undefined);
            let verdict = "FAIL";
            if (!out.startsWith("ERROR:")) {
              const f = (out.split("\n").find((l) => l.trim()) ?? "").trim();
              if (/^pass\b/i.test(f)) verdict = "PASS";
              else verdict = "FAIL";
            }
            const next = verdict === "PASS"
              ? `\n[usage-coach NEXT] call generalize with this verified diagnosis.`
              : `\n[usage-coach NEXT] FAIL — re-investigate the root cause.`;
            return out + "\n" + next;
          },
        }),
        generalize: tool({
          description: "Stage 4 (GENERALIZE) of the learning loop. Run the generator to turn a verified root cause into a reusable rule and append it to rules.md, so the next generate call includes it. Returns the rule text and a [usage-coach NEXT] directive.",
          args: {
            diagnosis: tool.schema.string(),
            task: tool.schema.string(),
          },
          async execute(args: { diagnosis: string; task: string }, ctx: any) {
            const cfg = readHarnessCfg(ctx.directory);
            if (!cfg.generator) return "ERROR: no generator model configured. Set \"generator\" in harness.config.json (see harness.config.example.json).";
            const genPrompt = `Turn this verified root cause into a GENERAL, REUSABLE rule for future tasks of this kind.\nDiagnosis: ${args.diagnosis}\nFailed task: ${args.task}\nOutput a single rule in the form: 'For <task-type> tasks, always <check/do X> because <reason>.'\nKeep it concrete and actionable.`;
            const genRuleTaskId = findActiveTaskId(ctx.sessionID, "revising");
            const out = await runModel(input.client, cfg.generator, genPrompt, ctx.directory,
              genRuleTaskId ? { sessionID: ctx.sessionID, taskId: genRuleTaskId } : undefined);
            const rule = out;
            try {
              const date = new Date().toISOString().slice(0, 10);
              mkdirSync(STATE_DIR, { recursive: true });
              appendFileSync(rulesFile(), `## Rule (${date})\n${rule}\nOrigin: ${args.task}\n\n`);
            } catch (e) { log(`generalize err: ${String(e)}`); }
            return `${rule}\n[usage-coach NEXT] rule saved to rules.md. The next generate call will include it. Call task_update for the original failed task -> failed, then proceed.`;
          },
        }),
        // Per-role model execution (config-driven, quota-aware, same server, no deadlock).
        // P1: quota decision drives model selection + concurrency.
        generate: tool({
          description: "Run the GENERATOR model on a prompt. Quota-aware: on THROTTLE, auto-switches to lighterModel if configured. Returns the model's text response. Step-limited: aborts after max_steps (default 30) to prevent runaway tasks.",
          args: { prompt: tool.schema.string(), max_steps: tool.schema.number().optional().describe("Maximum sub-session steps before timeout (default 30). Increase for complex tasks, decrease to fail fast on scope creep.") },
          async execute(args: { prompt: string; max_steps?: number }, ctx: any) {
            const cfg = readHarnessCfg(ctx.directory);
            if (!cfg.generator) {
              const h = readHarness(ctx.sessionID);
              if (h) { h.active = false; writeHarness(ctx.sessionID, h); }
              return "ERROR: no generator model configured. Set \"generator\" in harness.config.json (see harness.config.example.json). HARNESS TERMINATED — configure a generator model, then restart the harness.";
            }
            let decision = "GO"; try { decision = current().decision; } catch { /* */ }
            const throttle = decision === "THROTTLE" && cfg.lighterModel;
            const model = throttle ? cfg.lighterModel! : cfg.generator;
            // Stage 5 (reference): inject accumulated rules from past failures into the prompt.
            const rules = readRules();
            let prefix = rules ? `Lessons learned from previous failures (apply where relevant):\n${rules}\n\n---\n\n` : "";
            // Also inject known facts from the domain DB (same project scope).
            let keywords: string[] = [];
            let domainEmpty = true;
            try {
              keywords = extractKeywords(args.prompt);
              if (keywords.length) {
                const { nodes, edges } = queryDomain(keywords);
                if ((nodes && nodes.length) || (edges && edges.length)) {
                  domainEmpty = false;
                  prefix = `Known facts from domain DB: ${JSON.stringify({ nodes, edges })}. Use these if relevant.\n\n---\n\n` + prefix;
                }
              }
            } catch (e) { log(`generate domain query err: ${String(e)}`); }
            // Inject prior impl-notes (graph-matched for this task, fallback to last-5).
            try {
              const priorNotes = keywords.length ? readImplNotesByGraph(keywords, 5) : readImplNotes(5);
              if (priorNotes) {
                prefix = `Notes from previous runs (context for this task):\n${priorNotes}\n\n---\n\n` + prefix;
              }
            } catch (e) { log(`generate impl-notes read err: ${String(e)}`); }
            // Append the impl-notes writing instruction so the sub-session emits a <impl-notes> block.
            prefix += IMPL_NOTE_INSTRUCTION;
            // ── Diagnosis gate: warn if unknown_scan was required but not done ──
            const gate = checkScanGate(ctx.sessionID);
            if (gate.warning) {
              prefix = `${gate.warning}\n\n---\n\n` + prefix;
            }
            // ── Scan findings injection: if scan WAS done, inject the summary so the
            // sub-session knows about blind spots without manual copying. ──
            if (gate.summary) {
              prefix = `Pre-flight scan findings (from unknown_scan — heed these):\n${gate.summary}\n\n---\n\n` + prefix;
            }
            const genTaskId = findActiveTaskId(ctx.sessionID, "generating");
            const maxSteps = args.max_steps ?? DEFAULT_MAX_STEPS;
            const out = await runModel(input.client, model, prefix + args.prompt, ctx.directory,
              genTaskId ? { sessionID: ctx.sessionID, taskId: genTaskId } : undefined, maxSteps);
            // Investigate-if-unknown, then store: only persist the finding when the domain DB was empty
            // AND the output is not a timeout/error message.
            const isTimeoutOrError = out.startsWith("Task appears too large") || out.startsWith("ERROR:");
            if (domainEmpty && keywords.length && !isTimeoutOrError) {
              try { saveInvestigationResult(keywords, out, "generate"); } catch (e) { log(`generate save err: ${String(e)}`); }
            }
            // Extract + persist impl-notes from sub-session output (optional — no block = no-op).
            if (!isTimeoutOrError) {
              try {
                const { notes } = extractImplNotes(out);
                if (notes) {
                  appendImplNotes(notes, args.prompt);
                  if (keywords.length) {
                    const noteNodeId = saveInvestigationResult(keywords, notes, "impl-note", 0.5);
                    if (noteNodeId) linkImplNoteToDomain(noteNodeId, notes);
                  }
                }
              } catch (e) { log(`generate impl-notes extract err: ${String(e)}`); }
            }
            // On timeout, the output already carries its own [usage-coach NEXT] directive.
            if (out.startsWith("Task appears too large")) return out;
            return out + (throttle ? `\n[usage-coach] quota THROTTLE — used lighter model ${cfg.lighterModel}` : "") + `\n[usage-coach NEXT] call task_update(i, title, "grading"), then grade to evaluate this work.`;
          },
        }),
        generate_batch: tool({
          description: "Run the GENERATOR model on MULTIPLE tasks. Quota-aware: GO = full parallel; THROTTLE = lighter model + concurrency capped at 2; STOP = refused. Use for INDEPENDENT tasks. Step-limited: each sub-session aborts after max_steps (default 30). Resilient: failed tasks are retried sequentially (once); if retry also fails, re-run them individually with generate().",
          args: { tasks: tool.schema.array(tool.schema.object({ id: tool.schema.number(), prompt: tool.schema.string() })), max_steps: tool.schema.number().optional().describe("Maximum sub-session steps per task before timeout (default 30).") },
          async execute(args: { tasks: Array<{ id: number; prompt: string }>; max_steps?: number }, ctx: any) {
            const cfg = readHarnessCfg(ctx.directory);
            if (!cfg.generator) {
              const h = readHarness(ctx.sessionID);
              if (h) { h.active = false; writeHarness(ctx.sessionID, h); }
              return "ERROR: no generator model configured. Set \"generator\" in harness.config.json (see harness.config.example.json). HARNESS TERMINATED — configure a generator model, then restart the harness.";
            }
            let decision = "GO"; try { decision = current().decision; } catch { /* */ }
            if (decision === "STOP") return "ERROR: quota STOP — halt the harness loop now. Call task_update(current, \"halted_quota\") and stop.";
            const throttle = decision === "THROTTLE" && cfg.lighterModel;
            const model = throttle ? cfg.lighterModel! : cfg.generator;
            // GO: run all in parallel. THROTTLE: cap concurrency at 2 to avoid spiking quota.
            const limit = decision === "THROTTLE" ? 2 : args.tasks.length;
            // Shared prefix components (rules + prior impl-notes) computed once for all tasks.
            const rules = readRules();
            const priorNotes = readImplNotes(5);
            const maxSteps = args.max_steps ?? DEFAULT_MAX_STEPS;

            // ── Diagnosis gate (shared by all tasks in this batch) ──
            const gate = checkScanGate(ctx.sessionID);
            const gatePrefix = gate.warning
              ? `${gate.warning}\n\n---\n\n`
              : (gate.summary ? `Pre-flight scan findings (from unknown_scan — heed these):\n${gate.summary}\n\n---\n\n` : "");

            // Inner runner: execute a single task's runModel + impl-notes extraction.
            // Returns { id, result } on success, or { id, error } on rejection.
            const runOne = async (t: { id: number; prompt: string }): Promise<{ id: number; result: string }> => {
              let prefix = gatePrefix;
              prefix += rules ? `Lessons learned from previous failures (apply where relevant):\n${rules}\n\n---\n\n` : "";
              if (priorNotes) prefix = `Notes from previous runs (context for this task):\n${priorNotes}\n\n---\n\n` + prefix;
              prefix += IMPL_NOTE_INSTRUCTION;
              const r = await runModel(input.client, model, prefix + t.prompt, ctx.directory,
                { sessionID: ctx.sessionID, taskId: t.id }, maxSteps);
              // Extract + persist impl-notes (optional — no block = no-op).
              const isTimeoutOrError = r.startsWith("Task appears too large") || r.startsWith("ERROR:");
              if (!isTimeoutOrError) {
                try {
                  const { notes } = extractImplNotes(r);
                  if (notes) {
                    appendImplNotes(notes, t.prompt);
                    const kw = extractKeywords(t.prompt);
                    if (kw.length) {
                      const noteNodeId = saveInvestigationResult(kw, notes, "impl-note", 0.5);
                      if (noteNodeId) linkImplNoteToDomain(noteNodeId, notes);
                    }
                  }
                } catch (e) { log(`generate_batch impl-notes extract err: ${String(e)}`); }
              }
              return { id: t.id, result: r };
            };

            // Process tasks in concurrency-limited batches using Promise.allSettled
            // (not Promise.all — one rejection must not kill the entire batch).
            const results: string[] = [];
            const failed: Array<{ id: number; prompt: string; error: string }> = [];

            for (let i = 0; i < args.tasks.length; i += limit) {
              const batch = args.tasks.slice(i, i + limit);
              const settled = await Promise.allSettled(batch.map((t) => runOne(t)));
              for (let j = 0; j < settled.length; j++) {
                const s = settled[j];
                const t = batch[j];
                if (s.status === "fulfilled") {
                  results.push(`[task ${s.value.id}] ${s.value.result}`);
                } else {
                  const err = String(s.reason ?? "unknown rejection");
                  log(`generate_batch task ${t.id} REJECTED: ${err}`);
                  failed.push({ id: t.id, prompt: t.prompt, error: err });
                }
              }
            }

            // ── Automatic retry for rejected tasks (sequential, one at a time) ──
            if (failed.length > 0) {
              log(`generate_batch: retrying ${failed.length} failed task(s) sequentially`);
              for (const f of failed) {
                try {
                  const r = await runOne(f);
                  results.push(`[task ${r.id}] (retry) ${r.result}`);
                } catch (e2) {
                  const err2 = String(e2 ?? "unknown rejection on retry");
                  log(`generate_batch task ${f.id} retry ALSO FAILED: ${err2}`);
                  results.push(`[task ${f.id}] ERROR: task failed on both batch and retry. Error: ${err2}`);
                }
              }
            }

            const failedCount = results.filter((r) => r.includes("ERROR:")).length;
            const note = throttle ? `\n[usage-coach] quota THROTTLE — lighter model ${cfg.lighterModel}, concurrency capped at ${limit}` : "";
            // If any task still failed after retry, tell the orchestrator to fall back to sequential generate.
            const failNext = failedCount > 0
              ? `\n[usage-coach NEXT] ${failedCount} task(s) failed even after retry. Re-run each failed task individually with generate() (sequential), NOT generate_batch. This isolates failures and avoids batch-level abort.`
              : "";
            return results.join("\n\n") + note + failNext;
          },
        }),
        grade: tool({
          description: "Run the GRADER model on a prompt. Returns PASS/FAIL on the first line + a [usage-coach NEXT] directive. Falls back to generator if grader quota is out.",
          args: { prompt: tool.schema.string() },
          async execute(args: { prompt: string }, ctx: any) {
            const cfg = readHarnessCfg(ctx.directory);
            const model = cfg.grader ?? cfg.generator;
            if (!model) return "FAIL\n(ERROR: no grader/generator model configured.)\n[usage-coach NEXT] configure grader in harness.config.json, then retry grade.";
            const gradeTaskId = findActiveTaskId(ctx.sessionID, "grading");
            const out = await runModel(input.client, model, args.prompt, ctx.directory,
              gradeTaskId ? { sessionID: ctx.sessionID, taskId: gradeTaskId } : undefined);
            // Determine verdict from the first non-empty line.
            let verdict = "FAIL";
            if (!out.startsWith("ERROR:")) {
              const f = (out.split("\n").find((l) => l.trim()) ?? "").trim();
              if (/^pass\b/i.test(f)) verdict = "PASS";
              else if (/^fail\b/i.test(f)) verdict = "FAIL";
              else verdict = "FAIL"; // no clear verdict -> FAIL to trigger a revise
            }
            const next = verdict === "PASS"
              ? `\n[usage-coach NEXT] PASS -> call task_update(i, title, "completed", "PASS"), then proceed to next task (or harness_done if last).`
              : `\n[usage-coach NEXT] FAIL -> if revisions < 2: task_update(i, title, "revising", revisions+1) + generate({prompt: "Apply feedback:\\n{grade result}\\nTask: {title}"}); else: run the learning loop before failing —\n  1. record_failure({task, prompt, gradeResult, model, revisions})\n  2. investigate({task, prompt, gradeResult}) -> diagnosis\n  3. verify_diagnosis({diagnosis, task, gradeResult}) -> if PASS: generalize({diagnosis, task}) (saves rule to rules.md)\n  4. task_update(i, title, "failed", "FAIL") -> next task.\nThe next generate call will automatically include the new rule.`;
            return out + "\n" + next;
          },
        }),
        reverse_interview: tool({
          description: "Reverse interview: identify ambiguities in the task and ask the user " +
            "one question at a time, highest design-impact first. Call WITHOUT answer to start " +
            "or get the next question. Call WITH answer to record the user's response and advance. " +
            "Returns the next question or a completion summary. ALWAYS present the question to the " +
            "user verbatim — do NOT answer it yourself.",
          args: {
            task: tool.schema.string().describe(
              "The current task description (what the user asked for)."
            ),
            context: tool.schema.string().optional().describe(
              "Additional context from unknown_scan, codebase exploration, or prior turns. " +
              "Injected into the question-generation prompt for better prioritization."
            ),
            answer: tool.schema.string().optional().describe(
              "The user's response to the previous question. Omit on the first call " +
              "(or when there is no answer to record)."
            ),
            force_complete: tool.schema.boolean().optional().describe(
              "Force the interview to end now and return the summary. Use when the user " +
              "says 'that's enough' or 'just proceed'."
            ),
          },
          async execute(args: { task: string; context?: string; answer?: string; force_complete?: boolean }, ctx: any) {
            const sessionID = ctx.sessionID;
            const cfg = readHarnessCfg(ctx.directory);
            // Throttle-aware model resolver (shared by planning + completion).
            const resolveModel = (): string | null => {
              if (!cfg.generator) return null;
              let decision = "GO"; try { decision = current().decision; } catch { /* */ }
              const throttle = decision === "THROTTLE" && cfg.lighterModel;
              return throttle ? cfg.lighterModel! : cfg.generator;
            };
            let state = readInterview(sessionID);

            // --- FORCED COMPLETION (user said "that's enough") ---
            if (args.force_complete) {
              if (state && state.phase !== "complete") {
                return await completeInterview(state, sessionID, input.client, resolveModel(), ctx.directory);
              }
              return "No active interview to complete.\n[usage-coach NEXT] proceed to harness_start → generate.";
            }

            // --- RECORD ANSWER (if provided, against an in-progress interview) ---
            if (args.answer !== undefined && args.answer !== null &&
                state && state.phase === "asking" && state.currentIndex < state.questions.length) {
              const q = state.questions[state.currentIndex];
              state.answers.push({
                questionId: q.id, questionText: q.text,
                answer: String(args.answer), ts: new Date().toISOString(),
              });
              state.currentIndex++;
              writeInterview(sessionID, state);
              // All questions answered or hard cap reached -> complete.
              const maxQ = state.maxQuestions;
              if (state.currentIndex >= state.questions.length || state.answers.length >= maxQ) {
                return await completeInterview(state, sessionID, input.client, resolveModel(), ctx.directory);
              }
            }

            // --- START NEW INTERVIEW (no prior state, or previous one complete) ---
            if (!state || state.phase === "complete") {
              if (!cfg.generator) return "ERROR: no generator model configured. Set \"generator\" in harness.config.json (see harness.config.example.json).\n[usage-coach NEXT] proceed to harness_start → generate using best-effort assumptions.";
              const model = resolveModel()!;
              const userRequest = args.task;
              const mQ = DEFAULT_MAX_QUESTIONS;

              // Domain knowledge lookup via graph traversal (design §6.4/§6.5).
              let graphNodes: DomainNode[] = [];
              try {
                const keywords = extractKeywords(args.task + " " + (args.context ?? ""));
                if (keywords.length) {
                  const g = queryDomainGraph(keywords, 2);
                  graphNodes = g.nodes || [];
                }
              } catch (e) { log(`reverse_interview domain query err: ${String(e)}`); }

              const domainSection = graphNodes.length
                ? `\nDomain knowledge (from local graph DB — do NOT ask about things already known):\n${
                    graphNodes.slice(0, 20).map((n) =>
                      `- [d${n.distance ?? 9}] ${n.name} (${n.type}): ${String(n.props?.result ?? JSON.stringify(n.props)).slice(0, 150)}`
                    ).join("\n")
                  }\n`
                : "";

              const planningPrompt = `You are a senior architect conducting a reverse interview.
Analyze this task and identify the TOP ambiguities that, if left unresolved, would lead to the WRONG implementation.

Task: ${args.task}
User request: ${userRequest}
Additional context: ${args.context ?? "none"}${domainSection}

Rules:
1. Focus on questions whose answers CHANGE THE ARCHITECTURE or SCOPE.
   "What database?" is high-impact. "Variable naming?" is low-impact — exclude it.
2. Maximum ${mQ} questions.
3. Rank by design impact: critical > high > medium > low.
4. For each question, explain WHY it matters (the consequence of guessing wrong).
5. Categorize each: architecture | scope | constraint | preference | constraint-env | tradeoff.
6. For each question, name the core CONCEPT it targets (a single word/phrase).

Output JSON ONLY (no markdown fences, no prose):
{"questions":[{"text":"the question (concise, specific)","why":"what goes wrong if we guess","priority":"critical|high|medium|low","category":"architecture|scope|constraint|preference|constraint-env|tradeoff","optional":true,"concept":"single-word-concept"}]}
If the task is already well-specified with no significant ambiguities, return {"questions":[]}.`;

              const out = await runModel(input.client, model, planningPrompt, ctx.directory);

              // Quota/error guard — abandon gracefully, let the harness proceed.
              if (out.startsWith("ERROR:") || out.startsWith("Task appears too large")) {
                return `Cannot generate interview questions: ${out}\n[usage-coach NEXT] proceed to harness_start → generate using best-effort assumptions, or wait for quota reset and retry reverse_interview.`;
              }

              const parsed = parseInterviewQuestions(out, mQ, graphNodes);
              if (parsed.length === 0) {
                // No ambiguities found — record a completed interview and short-circuit.
                state = {
                  id: `int_${Date.now().toString(36)}`,
                  task: args.task, userRequest,
                  startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
                  questions: [], answers: [], currentIndex: 0,
                  phase: "complete", maxQuestions: mQ,
                  summary: "No significant ambiguities found. The task appears well-specified.",
                };
                writeInterview(sessionID, state);
                return "No significant ambiguities found — the task appears well-specified.\n[usage-coach NEXT] proceed directly to harness_start → generate.";
              }

              state = {
                id: `int_${Date.now().toString(36)}`,
                task: args.task, userRequest,
                startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
                questions: parsed, answers: [], currentIndex: 0,
                phase: "asking", maxQuestions: mQ,
              };
              writeInterview(sessionID, state);
            }

            // --- ASK NEXT QUESTION ---
            const q = state!.questions[state!.currentIndex];
            const total = state!.questions.length;
            const qNum = state!.currentIndex + 1;
            return formatQuestionOutput(qNum, total, q);
          },
        }),

        coach_config: tool({
          description: 'View or update harness model configuration (generator, grader, lighterModel, provider). Call with no args to view current config. Pass any combination of generator/grader/lighterModel/provider to update. Example: coach_config({ generator: "anthropic/claude-sonnet-4-20250514", grader: "opencode/mimo-v2.5-free" })',
          args: {
            generator: tool.schema.string().optional(),
            grader: tool.schema.string().optional(),
            lighterModel: tool.schema.string().optional(),
            provider: tool.schema.string().optional(),
          },
          async execute(args: { generator?: string; grader?: string; lighterModel?: string; provider?: string }, ctx: any) {
            const dir = (ctx as any)?.directory ?? input.directory;
            const current = readHarnessCfg(dir);

            // If no args → view mode
            const hasUpdates = args.generator !== undefined || args.grader !== undefined ||
                               args.lighterModel !== undefined || args.provider !== undefined;
            if (!hasUpdates) {
              const envOverrides: string[] = [];
              if (process.env.UC_PROVIDER) envOverrides.push(`UC_PROVIDER=${process.env.UC_PROVIDER}`);
              if (process.env.UC_LIGHTER_MODEL) envOverrides.push(`UC_LIGHTER_MODEL=${process.env.UC_LIGHTER_MODEL}`);
              return [
                `Harness Configuration`,
                `═══════════════════════════════════════════════`,
                `  generator:     ${current.generator ?? "(not set — harness won't work!)"}`,
                `  grader:        ${current.grader ?? "(defaults to generator)"}`,
                `  lighterModel:  ${current.lighterModel ?? "(not set — no THROTTLE fallback)"}`,
                `  provider:      ${current.provider ?? "(auto-detected from model)"}`,
                `═══════════════════════════════════════════════`,
                envOverrides.length > 0 ? `\nEnvironment overrides (take precedence):\n  ${envOverrides.join("\n  ")}` : "",
                `\nConfig file: ~/.config/opencode-usage-coach/harness.config.json`,
                `\nTo update, call: coach_config({ generator: "provider/model-id", ... })`,
              ].filter(Boolean).join("\n");
            }

            // Build updates object (only fields that were provided)
            const updates: HarnessCfg = {};
            if (args.generator !== undefined) updates.generator = args.generator.trim();
            if (args.grader !== undefined) updates.grader = args.grader.trim();
            if (args.lighterModel !== undefined) updates.lighterModel = args.lighterModel.trim();
            if (args.provider !== undefined) updates.provider = args.provider.trim();

            const writtenPath = writeHarnessCfg(updates);
            const updated = readHarnessCfg(dir);

            return [
              `✅ Harness config updated successfully!`,
              `═══════════════════════════════════════════════`,
              `  generator:     ${updated.generator ?? "(not set)"}`,
              `  grader:        ${updated.grader ?? "(defaults to generator)"}`,
              `  lighterModel:  ${updated.lighterModel ?? "(not set)"}`,
              `  provider:      ${updated.provider ?? "(auto-detected)"}`,
              `═══════════════════════════════════════════════`,
              `\nSaved to: ${writtenPath}`,
              `\nNote: Changes take effect immediately for new generate/grade calls.`,
              `       A running harness will pick up the new config on the next tool call.`,
            ].join("\n");
          },
        }),
      },
    };
  } catch (e) {
    // Init failure: return no-op so opencode keeps working.
    pipeLog(`PLUGIN INIT FAILED (no-op): ${String(e)}`);
    log(`PLUGIN INIT FAILED (no-op): ${String(e)}`);
    return NOOP_HOOKS;
  }
}

export { UsageCoachPlugin as server };

// ── Named exports for unit testing ──────────────────────────────────────────
export {
  coach, parseFileList, extractKeywords, extractImplNotes,
  detectLanguage, buildScanSummary, parseGapAnalysis, providerAdvice,
  buildGapPrompt, formatReport, isFreeModel, providerToCodexbar,
  isHarnessAgent, humanRemaining,
  setStateDir, readHarness, writeHarness, readRules,
  checkScanGate, updateSubSession, clearSubSession, findActiveTaskId,
  readHarnessCfg, writeHarnessCfg,
};
export type { Quota, Coaching, CodebaseProfile, UnknownScanResult, HarnessJson };
