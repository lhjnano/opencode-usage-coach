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
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { tool } from "@opencode-ai/plugin";
// evalChecks/formatCheckReport (grade-checks), webSearch (web-search), and
// queryDomain/logDomainInjection/applyReward (domain) are consumed by the tool
// bodies, which now live in tool-defs.ts.
import { initDomain, queryDomainGraph, saveInvestigationResult, evictStale, evictSharedStale, sweepDeadEdges, addDomainEdge, readNodes, readEdges } from "./domain.js";
import type { DomainNode } from "./domain.js";
import type { WebResult } from "./web-search.js";
import { makeV1SessionOps } from "./v1-session.js";
import { convertSchema, type SchemaLibLike } from "./schema-convert.js";
import { buildToolDefs, type ToolHost } from "./tool-defs.js";
import type { Runtime, SessionOps } from "./rt.js";
// The quota state machine (coach/codexbar fetch/TTL refresh) now lives in
// quota.ts and is shared with the V2 adapter (v2.ts). The functions below are
// re-exported at the bottom of this file so existing `from "./index.js"`
// imports (tests, tool-defs.ts) keep working unchanged.
import { createQuotaMachine, type Coaching, type Decision } from "./quota.js";
// V2 adapter — imported ONLY for the v2Setup FUNCTION DECLARATION (hoisted at
// module instantiation, unlike a const). The default `dual` export below
// references it without calling into v2.ts, which keeps the deferred
// index ↔ v2 import cycle safe in BOTH evaluation orders (index-first: dist;
// v2-first: test/v2-adapter.test.ts imports src/v2.js before src/index.js).
import { v2Setup } from "./v2.js";

export const PLUGIN_NAME = "opencode-usage-coach";

// Step-limit enforcement for sub-sessions: prevents runaway tasks from burning quota.
// Each generate/generate_batch call creates a sub-session whose agent loop is monitored;
// if the assistant-turn count exceeds maxSteps, the session is aborted.
const DEFAULT_MAX_STEPS = Number(process.env.UC_MAX_STEPS ?? 30) || 30;

/** Resolve max steps: explicit arg > harness.config.json > env var > default 30. */
function resolveMaxSteps(cfg: HarnessCfg, explicit?: number): number {
  return explicit ?? cfg.maxSteps ?? DEFAULT_MAX_STEPS;
}

/** A generate_batch task as declared by the orchestrator. */
type BatchTask = { id: number; prompt: string; files?: string[] };

/** Normalize a file path for overlap comparison: trim, drop leading './', lowercase. */
function normalizeFilePath(p: string): string {
  return p.trim().replace(/^(\.\/)+/, "").toLowerCase();
}

/** Resolve generate_batch concurrency, preventing parallel grade-attribution
 *  problems: tasks whose (normalized) files overlap must run sequentially.
 *  Empty batch -> 0; any file overlap forces limit=1 (strongest constraint —
 *  wins over THROTTLE too); otherwise THROTTLE caps at 2, GO runs all in parallel. */
function resolveBatchLimit(tasks: BatchTask[], decision: string): number {
  if (tasks.length === 0) return 0;
  const seen = new Set<string>();
  for (const t of tasks) {
    const files = new Set((t.files ?? []).map(normalizeFilePath).filter(Boolean));
    for (const f of files) if (seen.has(f)) return 1;
    for (const f of files) seen.add(f);
  }
  return decision === "THROTTLE" ? 2 : tasks.length;
}
const WATCHDOG_POLL_MS = Math.max(1000, Number(process.env.UC_WATCHDOG_POLL_MS ?? 3000) || 3000);
// Wall-clock timeout: if the prompt hasn't completed within this many minutes,
// abort the sub-session regardless of step count. Prevents zombie pollers from
// aborted/interrupted generate calls running forever. Override via UC_WALL_TIMEOUT_MIN.
const WALL_TIMEOUT_MS = (Math.max(1, Number(process.env.UC_WALL_TIMEOUT_MIN ?? 30) || 30)) * 60 * 1000;
// Stall detection (v0.17.0): a sub-session whose message stream shows NO progress
// (same step count AND same last-message ts) for this many minutes is aborted early,
// instead of holding its generate_batch slot until the 30-min wall clock. Only
// enforced while the messages endpoint keeps responding (if polling itself fails,
// progress is unobservable and we fall back to the wall clock). Override UC_STALL_MIN;
// 0 disables. Set conservatively (12 min) so a single long generation turn is not
// falsely aborted.
const STALL_MS = (Math.max(0, Number(process.env.UC_STALL_MIN ?? 12) || 0)) * 60 * 1000;
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

// Quota domain types (Quota/QuotaWindow/Decision/Coaching) live in quota.ts and
// are re-exported at the bottom of this file.

const NOOP_HOOKS = {}; // returned on init failure so opencode keeps working

// Always log to file (not gated on UC_DEBUG) — essential for runtime diagnosis.
function log(msg: string) { try { appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`); } catch { /* */ } }
// Exported for quota.ts (the quota machine's default stateWriter) — same
// behavior as when it lived next to the V1 closure.
export function writeState(c: Coaching) { try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify({ ...c, updatedAt: new Date().toISOString() })); } catch { /* */ } }

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
    const STOP = new Set([
      // articles / prepositions / conjunctions
      "the", "and", "for", "with", "that", "this", "from", "into", "your", "you",
      "are", "was", "but", "not", "all", "any", "use", "task", "prompt",
      // generic verbs
      "apply", "add", "make", "set", "get", "run", "try", "put", "let", "new",
      "will", "can", "has", "had", "have", "been", "were", "they", "them",
      "when", "then", "than", "also", "just", "like", "what", "which", "how",
      "should", "would", "could", "must", "does", "doing", "done", "via",
      // generic nouns / adjectives
      "some", "more", "most", "such", "each", "other", "very", "much",
      "here", "there", "where", "while", "about", "after", "before",
      "main", "call", "file", "code", "data", "line", "name", "type",
      "true", "false", "null", "void", "return", "function", "const",
      "note", "notes", "result", "output", "input", "detail",
      "reason", "reasons", "improve", "fix", "fixed", "error", "issue",
      "thing", "things", "stuff", "case", "cases", "way", "ways",
      "first", "second", "third", "last", "next", "prev", "previous",
      "following", "above", "below", "since", "until", "without",
    ]);
    const seen = new Set<string>();
    const out: string[] = [];
    // Strip path-like substrings BEFORE tokenizing — otherwise every task prompt's
    // "Working directory: /home/lhjnano/services/x" pollutes keywords with generic
    // path fragments (home, lhjnano, services...), causing 100% domain-DB hit rates
    // that dump ~600KB of the graph into each generate prompt.
    const clean = (text ?? "")
      .replace(/\b[\w.-]+(?:\/[\w.-]+)+\b/g, " ");   // slash-paths (a/b/c, ./x/y)
    for (const raw of clean.toLowerCase().split(/[^a-z0-9_-]+/)) {
      const t = raw.trim();
      if (t.length < 3 || STOP.has(t) || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= 8) break;
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

// ── Atomic harness mutation ───────────────────────────────────────────────────
// Concurrent pollers (from parallel generate_batch tasks) all read-modify-write
// harness.json. Without serialization, later writes overwrite earlier ones (e.g.
// clearSubSession is undone by a concurrent updateSubSession that read stale data).
// This queue chains mutations so they execute one-after-another, never interleaved.
const harnessQueue: Map<string, Promise<void>> = new Map();
function mutateHarness(sessionID: string, fn: (h: HarnessJson) => HarnessJson | void): Promise<void> {
  const prev = harnessQueue.get(sessionID) ?? Promise.resolve();
  const next = prev.then(() => {
    const h = readHarness(sessionID);
    if (!h) return;
    const result = fn(h);
    writeHarness(sessionID, result ?? h);
  }).catch(() => { /* swallow — queue must not break */ });
  harnessQueue.set(sessionID, next);
  // Auto-cleanup: drop the entry once the chain settles to avoid unbounded growth.
  next.finally(() => { if (harnessQueue.get(sessionID) === next) harnessQueue.delete(sessionID); });
  return next;
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
// signal (additive, V2): forwarded to runModel so a cancelled tool call also
// cancels the summary sub-session.
export async function completeInterview(state: InterviewState, sessionID: string, session: SessionOps, model: string | null, directory: string, signal?: AbortSignal): Promise<string> {
  if (state.phase === "complete") return formatCompleteOutput(state);
  const pairs = state.answers.map((a, i) => `Q${i + 1}: ${a.questionText}\nA: ${a.answer}`).join("\n\n");
  let summary = "";
  const constraints: Record<string, string> = {};
  if (model) {
    const sumPrompt = `Summarize this reverse interview as actionable constraints for implementation.\n\nQ&A pairs:\n${pairs || "(none)"}\n\nOutput JSON ONLY (no markdown fences, no prose):\n{"summary":"human-readable bullet list of resolved decisions","constraints":{"key":"value"}}`;
    const out = await runModel(session, model, sumPrompt, directory, undefined, undefined, signal);
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
// Both go through mutateHarness (atomic queue) so parallel pollers can't clobber each other.
function updateSubSession(sessionID: string, taskId: number, fields: Record<string, any>): Promise<void> {
  return mutateHarness(sessionID, (h) => {
    const t = h.tasks.find((x: any) => x.id === taskId);
    if (t) Object.assign(t, fields);
  });
}
function clearSubSession(sessionID: string, taskId: number): Promise<void> {
  return mutateHarness(sessionID, (h) => {
    const t = h.tasks.find((x: any) => x.id === taskId);
    if (!t) return;
    t.subSessionId = undefined;
    t.subStep = undefined;
    t.lastActivity = undefined;
    t.subElapsed = undefined;
    t.lastPollTs = undefined;
  });
}
// ── Knowledge injection effectiveness tracking ──────────────────────────────
// Analyzes harness.json files to determine if injected knowledge correlates
// with grade PASS/FAIL. Call from a tool or script after enough data accumulates.
function analyzeInjection(sessionID: string): {
  total: number; passed: number; failed: number;
  withInjection: { total: number; passRate: number };
  withoutInjection: { total: number; passRate: number };
  byCategory: Record<string, { total: number; passed: number }>;
} {
  try {
    const h = readHarness(sessionID);
    if (!h) return { total: 0, passed: 0, failed: 0, withInjection: { total: 0, passRate: 0 }, withoutInjection: { total: 0, passRate: 0 }, byCategory: {} };
    const tasks = h.tasks.filter((t: any) => t.score === "PASS" || t.score === "FAIL");
    let withInj = 0, withInjPass = 0, withoutInj = 0, withoutInjPass = 0;
    const cats: Record<string, { total: number; passed: number }> = {};
    for (const t of tasks) {
      const inj = t.injected as any;
      const hasAny = inj && (inj.rules > 0 || inj.implNotes > 0 || inj.domainNodes > 0 || inj.hasScanFindings);
      if (hasAny) { withInj++; if (t.score === "PASS") withInjPass++; }
      else { withoutInj++; if (t.score === "PASS") withoutInjPass++; }
      // By category.
      if (inj) {
        for (const k of ["rules", "implNotes", "domainNodes", "hasScanFindings"]) {
          const v = inj[k];
          if ((typeof v === "number" && v > 0) || v === true) {
            if (!cats[k]) cats[k] = { total: 0, passed: 0 };
            cats[k].total++;
            if (t.score === "PASS") cats[k].passed++;
          }
        }
      }
    }
    return {
      total: tasks.length,
      passed: tasks.filter((t: any) => t.score === "PASS").length,
      failed: tasks.filter((t: any) => t.score === "FAIL").length,
      withInjection: { total: withInj, passRate: withInj > 0 ? Math.round(withInjPass * 100 / withInj) : 0 },
      withoutInjection: { total: withoutInj, passRate: withoutInj > 0 ? Math.round(withoutInjPass * 100 / withoutInj) : 0 },
      byCategory: cats,
    };
  } catch { return { total: 0, passed: 0, failed: 0, withInjection: { total: 0, passRate: 0 }, withoutInjection: { total: 0, passRate: 0 }, byCategory: {} }; }
}

// Find the harness task currently in a given status (for correlating runModel with a task).
function findActiveTaskId(sessionID: string, status: string): number | undefined {
  try {
    const h = readHarness(sessionID);
    if (!h) return undefined;
    return h.tasks.find((x: any) => x.status === status)?.id;
  } catch { return undefined; }
}

// Task title lookup for reward notes (applyReward wiring). Best-effort: undefined
// when harness state is absent or the task has no usable title — applyReward
// treats note as optional.
function harnessTaskTitle(sessionID: string, taskId: number | undefined): string | undefined {
  if (taskId === undefined) return undefined;
  try {
    const t = readHarness(sessionID)?.tasks.find((x: any) => x.id === taskId);
    return typeof t?.title === "string" && t.title ? t.title : undefined;
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
  webResults?: WebResult[];
  docRefs?: Array<{ name: string; url: string }>;
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
  webResults?: WebResult[],
  docRefs?: Array<{ name: string; url: string }>,
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
  const webResultsStr = webResults && webResults.length
    ? webResults.slice(0, 8).map((r, i) => `${i + 1}. [${r.tier}] ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n")
    : "(no web results — either network issue or no relevant findings)";
  const docRefsStr = docRefs && docRefs.length
    ? docRefs.map((d) => `- ${d.name}: ${d.url}`).join("\n")
    : "(none)";
  return `You are a pre-flight gap analyst. Compare the user's request (the MAP) with the actual codebase (the TERRITORY) and classify every gap.

USER REQUEST:
${userRequest}

PROPOSED TASKS:
${taskList}

CODEBASE PROFILE:
${profileStr}

EXISTING DOMAIN KNOWLEDGE (from local DB):
${domainStr}

WEB SEARCH RESULTS (from official docs references, GitHub issues, and code search):
${webResultsStr}

OFFICIAL DOCUMENTATION REFERENCES:
${docRefsStr}

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

// Wrap a grading prompt with the verification protocol. Forces evidence-based
// verdicts instead of eyeballing: file:line citations, real test runs, and an
// explicit search for what is NOT visible (WYSIATI). The first-line contract
// keeps the /^pass\b/i and /^fail\b/i verdict parsing in grade/grade_batch valid.
function buildGradePrompt(userPrompt: string): string {
  return `[usage-coach] Verification protocol — obey ALL of these:
1. PASS requires evidence cited as file:line references (e.g., src/index.ts:42). No citations -> FAIL.
2. If the project has tests, run them and report the command and the result. If you cannot run them, state why.
3. Do not judge only by what is visible — actively check for missing edge cases and unhandled errors (WYSIATI).
4. OUTPUT CONTRACT: your FIRST line must be exactly "PASS" or "FAIL" with nothing else on it; all evidence and reasoning go on the following lines.

---

${userPrompt}`;
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
  if (r.webResults && r.webResults.length) {
    L.push(`\nWEB SEARCH (${r.webResults.length} results):`);
    if (r.docRefs && r.docRefs.length) {
      L.push(`  Official docs: ${r.docRefs.map((d) => d.name).join(", ")}`);
    }
    L.push("  Top results:");
    for (let i = 0; i < Math.min(r.webResults.length, 5); i++) {
      const w = r.webResults[i];
      L.push(`    ${i + 1}. [${w.tier}] ${w.title}`);
      L.push(`       ${w.url}`);
      L.push(`       ${w.snippet.slice(0, 100)}`);
    }
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
type HarnessCfg = { generator?: string; grader?: string; provider?: string; lighterModel?: string; maxSteps?: number; domainMaxNodes?: number; domainAutoLink?: boolean };
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
// All session ops go through the version-agnostic SessionOps facade (see rt.ts) —
// runModel never touches the raw V1 client.
async function runModel(session: SessionOps, model: string, prompt: string, directory: string, track?: { sessionID: string; taskId: number }, maxSteps: number = DEFAULT_MAX_STEPS, signal?: AbortSignal): Promise<string> {
  const t0 = Date.now();
  const subStart = Date.now();
  let poller: ReturnType<typeof setInterval> | null = null;
  let wallTimer: ReturnType<typeof setTimeout> | null = null;
  let subId: string | null = null;
  let timedOut = false;
  let stalled = false; // v0.17.0: no message-stream progress for STALL_MS while polls succeed
  let pollerDone = false; // set in finally — stops pending async poller callbacks from writing stale data
  // Stall-detection state: progress = step count changed OR last-message ts changed.
  let lastStepSeen = -1;
  let lastTsSeen = "";
  let lastProgressAt = Date.now();
  let lastPollOk = true;
  // Deferred promise: resolves when the step limit is exceeded (races against prompt).
  let signalTimeout!: () => void;
  const timeoutSignal = new Promise<void>((resolve) => { signalTimeout = resolve; });
  // AbortSignal cancellation (additive, V2): mirrors the wall-clock timeout path —
  // flip timedOut, abort the sub-session, resolve the race. `subId` guard: the
  // signal may fire before session.create resolves (nothing to abort yet; the
  // timedOut branch / finally block still clean up whatever gets created).
  const onAbort = () => {
    if (timedOut) return;
    timedOut = true;
    log(`runModel(${model}): SIGNAL aborted, aborting session ${subId}`);
    try { if (subId) session.abort(subId); } catch { /* */ }
    signalTimeout();
  };
  try {
    // Pre-aborted signal: bail before creating anything — no sub-session, no cleanup needed.
    if (signal?.aborted) return "ERROR: cancelled before start (signal already aborted).";
    signal?.addEventListener("abort", onAbort, { once: true });
    const slash = model.indexOf("/");
    const providerID = slash >= 0 ? model.slice(0, slash) : model;
    const modelID = slash >= 0 ? model.slice(slash + 1) : "";
    // Sub-session creation via the facade. The facade THROWS `session.create returned
    // no id (...)` when the response carries no id — convert that back into the exact
    // user-visible ERROR string the direct-client code used to return. Any other
    // rejection (transport failure) propagates to the outer catch
    // (`ERROR: runModel exception ...`), exactly as before.
    let id: string;
    try {
      id = await session.create(directory, "uc-harness-sub");
    } catch (e) {
      if (!(e instanceof Error && e.message.startsWith("session.create returned no id"))) throw e;
      log(`runModel(${model}): session.create ${Date.now() - t0}ms`);
      return `ERROR: ${e.message}`;
    }
    log(`runModel(${model}): session.create ${Date.now() - t0}ms`);
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
          const msgList: any[] = await session.messages(id);
          // After await: re-check pollerDone — the finally block may have run
          // while we were waiting for the messages API response.
          if (pollerDone) return;
          if (msgList.length) {
            // Count assistant turns as steps (each assistant message = one loop iteration).
            step = msgList.filter((m: any) => {
              const role = m?.role ?? m?.info?.role;
              return role === "assistant";
            }).length;
            const last = msgList[msgList.length - 1];
            const ts = last?.ts ?? last?.info?.updatedAt ?? last?.info?.completedAt ?? last?.updatedAt;
            if (ts) lastTs = String(ts);
            lastPollOk = true; // endpoint responded — stall detection is trustworthy again
          }
        } catch { lastPollOk = false; /* messages endpoint unavailable — step stays 0 */ }
        // v0.17.0 stall detection: any observable change counts as progress.
        if (lastPollOk && (step !== lastStepSeen || lastTs !== lastTsSeen)) {
          lastStepSeen = step;
          lastTsSeen = lastTs;
          lastProgressAt = Date.now();
        }
        // Step-limit enforcement: abort the sub-session if it exceeds maxSteps.
        if (step > maxSteps) {
          log(`runModel(${model}): STEP LIMIT exceeded (${step} > ${maxSteps}), aborting session ${id}`);
          timedOut = true;
          try { await session.abort(id); } catch { /* */ }
          signalTimeout();
          return;
        }
        // Stall enforcement: no progress while polling works — abort early rather
        // than holding the batch slot until the 30-min wall clock.
        if (STALL_MS > 0 && lastPollOk && Date.now() - lastProgressAt > STALL_MS) {
          stalled = true;
          timedOut = true;
          log(`runModel(${model}): STALLED — no progress for ${Math.round((Date.now() - lastProgressAt) / 1000)}s (step=${step}, maxSteps=${maxSteps}), aborting session ${id}`);
          try { await session.abort(id); } catch { /* */ }
          signalTimeout();
          return;
        }
        // Update TUI progress (only when tracking is enabled and not cleaned up).
        if (track && !pollerDone) {
          const elapsed = Math.round((Date.now() - subStart) / 1000);
          updateSubSession(track.sessionID, track.taskId, {
            subSessionId: id, subStep: step, lastActivity: lastTs, subElapsed: elapsed,
            lastPollTs: Date.now(),
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
        try { session.abort(id); } catch { /* */ }
        signalTimeout();
      }
    }, WALL_TIMEOUT_MS);
    // Race: prompt completes normally vs step-limit/wall-clock timeout.
    // Wrap prompt with .then(onFulfilled, onRejected) so that aborting the session
    // (which causes prompt to reject) never produces an unhandled promise rejection.
    const promptP: Promise<any> = session.prompt(id, providerID, modelID, prompt).then(
      (r: any) => r,
      () => null, // abort causes rejection -> return null (handled via timedOut flag)
    );
    const resp: any = await Promise.race([promptP, timeoutSignal.then(() => null)]);
    const elapsed = Math.round((Date.now() - t0) / 1000);
    log(`runModel(${model}): prompt resolved ${elapsed}s, timedOut=${timedOut}`);

    // Step-limit timeout / stall: the task is too large or wedged — tell the caller.
    if (timedOut) {
      try {
        const summary: any = await session.summarize?.(id);
        log(`runModel(${model}): TIMED OUT summary: ${JSON.stringify(summary?.data ?? summary).slice(0, 300)}`);
      } catch { /* */ }
      try { session.delete(id); } catch { /* */ }
      subId = null;
      if (stalled) {
        return `ERROR: stalled — no message-stream progress for ${Math.round(STALL_MS / 60000)} min (step ${lastStepSeen}/${maxSteps}). The sub-session was wedged (observed today as the 837s no-output case). Retry this task individually with generate(); if it stalls again, split it.\n[usage-coach NEXT] re-run the stalled task alone via generate(), or split it.`;
      }
      log(`runModel(${model}): TIMED OUT after ${elapsed}s (${maxSteps} steps exceeded)`);
      return `Task appears too large (exceeded ${maxSteps} steps, aborted after ${Math.round(elapsed)}s). Consider splitting into smaller subtasks.\n[usage-coach NEXT] split the original task into smaller subtasks (each should complete within ${maxSteps} steps), then re-run generate for each subtask. Rule of thumb from observed costs: split BEFORE starting when the task needs >1 output file or >1 distinct transformation — a failed oversized run costs the full step budget again on retry.`;
    }

    // Normal completion: extract assistant text from the response parts.
    const parts: any[] = resp?.data?.parts ?? resp?.parts ?? [];
    const text = parts.filter((p: any) => p?.type === "text").map((p: any) => p?.text ?? "").join("");
    // Fire-and-forget: summarize + delete are cleanup/diagnostic, NOT on the critical path.
    // Previously these were awaited, causing the harness to stall after the model finished.
    const cleanupStart = Date.now();
    try { if (session.summarize) session.summarize(id).then((summary: any) => log(`runModel(${model}): summary ${Date.now() - cleanupStart}ms: ${JSON.stringify(summary?.data ?? summary).slice(0, 300)}`)).catch(() => {}); } catch { /* */ }
    try { session.delete(id).catch(() => {}); } catch { /* */ }
    subId = null;
    log(`runModel(${model}): done ${elapsed}s, ${text.length} chars (cleanup dispatched)`);
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
    signal?.removeEventListener("abort", onAbort);
    if (track) { try { clearSubSession(track.sessionID, track.taskId); } catch { /* */ } }
    // Fire-and-forget delete — no need to block the return on session cleanup.
    if (subId) { try { session.delete(subId).catch(() => {}); } catch { /* */ } }
  }
}

// Agent-mode gating — harness tools + quota coaching are restricted to these agent
// modes (UC_HARNESS_AGENT, comma-separated). Other modes (e.g. Agent-Factory-
// Coordinator) stay fully clean: no tool gating, no system-prompt injection.
export const HARNESS_AGENTS = (process.env.UC_HARNESS_AGENT ?? "Usage-Coach-Harness")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

// Quota thresholds (STOP_5H/THR_5H/STOP_WK/THR_WK/STOP_MO), the codexbar fetch
// layer (captureStdout/fetchQuota/fetchQuotaWithRetry/fetchProvidersCoach),
// coach()/providerAdvice()/humanRemaining()/parseQuotaResponse(),
// isFreeModel/providerToCodexbar, LOADING and the quota machine itself now live
// in quota.ts (re-exported below; behavior identical).
// Domain-DB worm (GC) thresholds — override via env. Time-based + size-based eviction.
const num = (e: string, d: number) => { try { const v = Number(process.env[e]); return Number.isFinite(v) && v >= 0 ? v : d; } catch { return d; } };
export const WORM_MAX_AGE_DAYS = num("UC_WORM_MAX_AGE_DAYS", 180);
export const WORM_MAX_NODES = num("UC_WORM_MAX_NODES", 100000);
// Shared-layer worm defaults: tighter than the project layer — the shared DB is the
// cross-project accumulation point (2,128 nodes at wiring time; 212 already past 60d).
export const SHARED_WORM_MAX_AGE_DAYS = num("UC_SHARED_WORM_MAX_AGE_DAYS", 60);
export const SHARED_WORM_MAX_NODES = num("UC_SHARED_WORM_MAX_NODES", 3000);

// (humanRemaining / ProviderCoach / captureStdout / fetchEnabledProviders /
//  providerAdvice / fetchProvidersCoach / parseQuotaResponse / fetchQuota /
//  fetchQuotaWithRetry / coach / isFreeModel / providerToCodexbar / LOADING /
//  codexbarMissing + accessors all moved to quota.ts — re-exported below.)

// Resolve the current session's agent name + model + provider via the SDK client.
// Cached per sessionID (60s TTL). Model-change detection moved into
// QuotaMachine.setModel() — callers feed the returned {model, provider} into the
// machine, which flips `modelChanged` (forces the next quota refresh).
export type AgentInfo = { agent: string; model: string; provider: string };
const agentCache = new Map<string, { agent: string; model: string; provider: string; ts: number }>();
// Last-known agent name (updated by the execute.before hooks, read via writeState payload)
let currentAgent = "";

const EMPTY_AGENT: AgentInfo = { agent: "", model: "", provider: "" };

export async function resolveAgent(session: SessionOps, sessionID: string): Promise<AgentInfo> {
  if (!sessionID) return EMPTY_AGENT;
  const hit = agentCache.get(sessionID);
  if (hit && Date.now() - hit.ts < 60000) {
    return { agent: hit.agent, model: hit.model, provider: hit.provider };
  }
  try {
    // The facade already unwraps `data.info ?? data ?? info ?? s` (null when empty).
    const info: any = await session.get(sessionID);
    // Debug: dump the raw session object structure to find model/provider fields
    log(`resolveAgent raw session: ${JSON.stringify(info).slice(0, 500)}`);
    const agent = String(info?.agent ?? "");
    // model might be an object like { id: "...", providerID: "..." } or a string
    const rawModel = info?.model;
    const model = typeof rawModel === "string" ? rawModel : (rawModel?.id ?? rawModel?.modelID ?? rawModel?.name ?? "");
    const rawProvider = info?.providerID ?? info?.provider ?? (typeof rawModel === "object" ? rawModel?.providerID ?? rawModel?.provider : "");
    const provider = typeof rawProvider === "string" ? rawProvider : (rawProvider?.id ?? "");
    agentCache.set(sessionID, { agent, model, provider, ts: Date.now() });
    return { agent, model, provider };
  } catch (e) { log(`resolveAgent err: ${String(e)}`); return EMPTY_AGENT; }
}
export function isHarnessAgent(agent: string): boolean {
  if (!agent) return false;
  return HARNESS_AGENTS.includes(agent.toLowerCase());
}

// V1 plugin factory (opencode ≤1.x hosts). Kept as the DEFAULT legacy entry; the
// dual default export (bottom of this file) layers the V2 adapter on top. The
// quota state machine (last/lastFetchedAt/refreshing/current/modelChanged,
// refreshBackground/current) now lives in quota.ts — this closure is a thin
// consumer, identical in behavior to the pre-extraction code.
export async function UsageCoachPlugin(input: {
  project: unknown; client: unknown;
  $: (s: TemplateStringsArray, ...v: unknown[]) => Promise<{ stdout?: { toString(): string } | string }>;
  directory: string; worktree: string;
}) {
  pipeLog(`UsageCoachPlugin CALLED | dir=${input.directory} | worktree=${input.worktree}`);
  // Top-level guard: even if init fails, opencode keeps working.
  try {
    setStateDir(input.directory); // per-directory state isolation
    initDomain(STATE_DIR); // domain DB shares the same per-project state dir
    // Version-agnostic runtime: ALL session ops below route through the SessionOps
    // facade instead of touching the V1 client directly. The V2 migration replaces
    // this one line (a ctx-based adapter), not the call sites.
    const rt: Runtime = { directory: input.directory, session: makeV1SessionOps(input.client) };
    // Provider + lighter model: env > config > empty (codexbar picks its default).
    // No hardcoded provider — this plugin is provider-agnostic.
    const cfg0 = readHarnessCfg(input.directory);
    // Auto-link gate priority: HarnessCfg.domainAutoLink (when defined) overrides the
    // UC_AUTOLINK env var — the domain gate (autoLinkKeywords) reads env, so we project
    // the cfg value onto process.env at load time. When cfg is unset, env alone controls.
    if (cfg0.domainAutoLink !== undefined) process.env.UC_AUTOLINK = cfg0.domainAutoLink ? "1" : "0";
    // Quota machine: owns the SENSE→DECIDE cycle (codexbar fetch, TTL dedup,
    // free-model short-circuit, providers coach view, state.json writes).
    const quota = createQuotaMachine({
      directory: input.directory,
      provider: process.env.UC_PROVIDER ?? cfg0.provider ?? "",
      lighter: process.env.UC_LIGHTER_MODEL ?? cfg0.lighterModel ?? "a lighter model",
      getAgent: () => currentAgent,
    });

    // ToolHost — the version-agnostic bridge tool-defs.ts executes against.
    // Tools only ever see the quota machinery through this interface.
    const host: ToolHost = { rt, current: quota.current, refresh: quota.refresh };
    // Rebuild the V1 tool map from the shared definitions: JSON Schema args are
    // converted to `tool.schema` (zod) via schema-convert; the V2 adapter will
    // consume the same defs directly. This loop is the ONLY V1-specific wiring.
    const defs = buildToolDefs();
    const toolMap: Record<string, any> = {};
    for (const def of defs) {
      toolMap[def.name] = tool({
        description: def.description,
        // zod's generic builder signatures are not statically assignable to the
        // structural SchemaLibLike (method bivariance does not span generics),
        // but the runtime shapes line up exactly: every builder returns a
        // chainable node with .describe()/.optional(). Hence the local cast.
        args: convertSchema(def.name, def.schema, tool.schema as unknown as SchemaLibLike),
        async execute(args: any, ctx: any) {
          return def.execute(args, { sessionID: ctx?.sessionID, directory: ctx?.directory ?? rt.directory }, host);
        },
      });
    }

    return {
      event: async ({ event }: { event: { type: string } }) => {
        try {
          if (event.type === "session.created" || event.type === "session.idle") quota.refresh();
          // Worm (GC): run the domain-DB eviction on idle. Cheap no-op when nothing is stale.
          // evictStale = project layer (UC_WORM_*), evictSharedStale = shared layer
          // (UC_SHARED_WORM_*, default 60d/3000) — fixes the "shared grows unbounded"
          // pathology from the v1 diagnosis (wired in v0.16.1).
          if (event.type === "session.idle") { try { const r = evictStale(WORM_MAX_AGE_DAYS, WORM_MAX_NODES); if (r.removed) log(`evictStale: removed ${r.removed}, kept ${r.kept} (maxAge=${WORM_MAX_AGE_DAYS}d, maxNodes=${WORM_MAX_NODES})`); } catch (e) { log(`evictStale err: ${String(e)}`); } try { const sh = evictSharedStale(SHARED_WORM_MAX_AGE_DAYS, SHARED_WORM_MAX_NODES); if (sh.removed) log(`evictSharedStale: removed ${sh.removed}, kept ${sh.kept} (maxAge=${SHARED_WORM_MAX_AGE_DAYS}d, maxNodes=${SHARED_WORM_MAX_NODES})`); } catch (e) { log(`evictSharedStale err: ${String(e)}`); } try { const s = sweepDeadEdges(); log(`sweepDeadEdges: removed ${s.removed}, kept ${s.kept}`); } catch (e) { log(`sweepDeadEdges err: ${String(e)}`); } }
        }
        catch (e) { log(`event err: ${String(e)}`); }
      },

      // ACT(1) — model/agent detection on EVERY tool call (cached 60s, negligible overhead).
      // Then hard-gate harness tools by agent mode + quota STOP.
      "tool.execute.before": async (_input: { tool: string; sessionID: string; callID: string }) => {
        // Detect model + agent on every tool call (bash, read, write, etc.) — not just harness tools.
        const info = await resolveAgent(rt.session, _input.sessionID);
        currentAgent = info.agent;
        quota.setModel(info.model, info.provider);
        quota.refresh(); // picks up model changes immediately

        const harnessTools = ["unknown_scan", "question", "generate", "generate_batch", "grade", "grade_batch", "investigate", "verify_diagnosis", "generalize", "harness_start", "task_update", "harness_done", "record_failure", "reverse_interview"];
        if (!harnessTools.includes(_input.tool)) return; // only harness tools are gated below
        if (!isHarnessAgent(info.agent)) {
          throw new Error(`[${PLUGIN_NAME}] '${_input.tool}' is restricted to agent mode ${JSON.stringify(HARNESS_AGENTS)} (current: ${JSON.stringify(info.agent || "unknown")}). Switch to that agent mode to use it.`);
        }
        // (2) quota gate: STOP blocks quota-consuming harness tools.
        let decision: Decision;
        try { decision = quota.current().decision; } catch { decision = "GO"; } // safe default
        if (decision === "STOP") {
          throw new Error(`[${PLUGIN_NAME}] blocked: quota limit exceeded. ${quota.current().advice}`);
        }
      },

      // ACT(2) inject coaching into system prompt — ONLY in the harness agent mode,
      // so other modes' system prompts stay completely clean. Silent on error.
      "experimental.chat.system.transform": async (_input: { sessionID?: string }, output: { system: string[] }) => {
        try {
          if (_input.sessionID) {
            const info = await resolveAgent(rt.session, _input.sessionID);
            quota.setModel(info.model, info.provider);
            quota.refresh(); // picks up model changes immediately
            if (!isHarnessAgent(info.agent)) return; // not harness mode — don't inject
          }
          const c = quota.current();
          let instruction = "";
          if (c.decision === "STOP") instruction = `[${PLUGIN_NAME}] QUOTA limit exceeded. ${c.advice} Stop making further tool calls, finish the in-progress work, then report the quota status to the user.`;
          else if (c.decision === "THROTTLE") instruction = `[${PLUGIN_NAME}] ${c.advice} Hold off on long/heavy tasks.`;
          else if (c.weekly >= 0 || c.fiveHour >= 0) {
            const parts: string[] = [];
            if (c.weekly >= 0) parts.push(`weekly ${c.weekly}%`);
            if (c.fiveHour >= 0) parts.push(`5h ${c.fiveHour}%`);
            if (c.monthly >= 0) parts.push(`monthly ${c.monthly}%`);
            instruction = `[${PLUGIN_NAME}] quota ok — ${parts.join(" · ")}.`;
          }
          if (instruction) output.system.push(instruction);
        } catch (e) { log(`system.transform err: ${String(e)}`); }
      },

      // Custom tools for the harness agent mode — report status to the panel.
      // Definitions (bodies included) live in tool-defs.ts — version-agnostic and
      // shared with the V2 adapter. This map only adapts them to the V1
      // tool() shape: JSON Schema args are converted via schema-convert.
      tool: toolMap,
    };
  } catch (e) {
    // Init failure: return no-op so opencode keeps working.
    pipeLog(`PLUGIN INIT FAILED (no-op): ${String(e)}`);
    log(`PLUGIN INIT FAILED (no-op): ${String(e)}`);
    return NOOP_HOOKS;
  }
}

// ── Dual default export ──────────────────────────────────────────────────────
// One artifact serves both hosts: V2 hosts load the default export and call
// .setup(ctx); V1 1.18.29+ hosts call .server(). `setup` is the v2Setup
// function declaration from v2.ts (referenced, not called, at module scope) so
// the index ↔ v2 import cycle stays safe in either evaluation order.
const dual: any = { id: "opencode-usage-coach", setup: v2Setup, server: UsageCoachPlugin };
export default dual;

export { UsageCoachPlugin as server };

// ── Named exports for unit testing + tool-defs.ts ───────────────────────────
// The second group is consumed by tool-defs.ts (the version-agnostic tool
// definitions). STATE_DIR is exported as a live `let` binding so tool bodies
// observe setStateDir() calls.
export {
  parseFileList, extractKeywords, extractImplNotes,
  detectLanguage, buildScanSummary, parseGapAnalysis,
  buildGapPrompt, formatReport,
  buildGradePrompt, normalizeFilePath, resolveBatchLimit,
  setStateDir, readHarness, writeHarness, readRules,
  checkScanGate, updateSubSession, clearSubSession, findActiveTaskId,
  readHarnessCfg, writeHarnessCfg,
  // ── shared with tool-defs.ts ──
  runModel, writeUnknownScan, mutateHarness, harnessTaskTitle, analyzeInjection,
  readInterview, writeInterview, parseInterviewQuestions, formatQuestionOutput,
  readImplNotes, readImplNotesByGraph, appendImplNotes, linkImplNoteToDomain,
  rulesFile, failuresFile, log, resolveMaxSteps,
  STATE_DIR, DEFAULT_MAX_STEPS, DEFAULT_MAX_QUESTIONS, IMPL_NOTE_INSTRUCTION,
};
// Quota domain: moved to quota.ts, re-exported so every existing
// `from "./index.js"` import (tests, tool-defs.ts, v2.ts) keeps working.
export {
  coach, providerAdvice, humanRemaining, parseQuotaResponse, fetchQuotaWithRetry,
  isCodexbarMissing, __resetCodexbarMissing, isFreeModel, providerToCodexbar,
  createQuotaMachine,
} from "./quota.js";
export type { Quota, QuotaWindow, Decision } from "./quota.js";
export type { CodebaseProfile, UnknownScanResult, HarnessJson, BatchTask, HarnessCfg };
