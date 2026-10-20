// tool-defs.ts — version-agnostic tool definitions shared by the V1 and V2 adapters.
//
// Every harness tool (name + description + JSON Schema + execute body) is defined
// here ONCE. The V1 adapter (index.ts) wraps each def in `tool()` and converts
// the JSON Schema args via schema-convert; the future V2 adapter consumes the
// defs directly. The bodies are byte-for-byte the original V1 bodies — only the
// version-bound references were translated:
//   ctx.sessionID   -> call.sessionID
//   ctx.directory   -> call.directory ?? host.rt.directory
//   rt.session      -> host.rt.session
//   current()       -> host.current()          (quota coaching, lives in index.ts)
//   refreshBackground() -> host.refresh()
//
// Quota state machinery (current/refreshBackground/LOADING/...) stays in index.ts
// (V1-lifecycle bound) and is exposed to tools exclusively through ToolHost.
//
// NOTE: this module imports shared helpers from index.js (where they live today),
// creating a deferred index.ts <-> tool-defs.ts import cycle. It is safe: every
// cross-module reference sits inside function bodies evaluated long after both
// modules finish loading, and `STATE_DIR` is consumed as a live `let` binding so
// setStateDir() calls are always observed. This module must NOT import
// "@opencode-ai/plugin" — it is host-version agnostic.
import { mkdirSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { Runtime, CallCtx } from "./rt.js";
import { TOOL_SCHEMAS, TOOL_NAMES } from "./tool-schemas.js";
import { applyReward, logDomainInjection, queryDomain, queryDomainGraph, saveInvestigationResult } from "./domain.js";
import type { DomainNode } from "./domain.js";
import { searchContext as webSearch, type WebResult } from "./web-search.js";
import { evalChecks, formatCheckReport, type GradeCheck } from "./grade-checks.js";
import {
  DEFAULT_MAX_QUESTIONS, DEFAULT_MAX_STEPS, IMPL_NOTE_INSTRUCTION, STATE_DIR,
  analyzeInjection, appendImplNotes, buildGapPrompt, buildGradePrompt, checkScanGate,
  completeInterview, extractImplNotes, extractKeywords, failuresFile, findActiveTaskId,
  formatQuestionOutput, formatReport, harnessTaskTitle, linkImplNoteToDomain, log,
  mutateHarness, parseFileList, parseGapAnalysis, parseInterviewQuestions, readHarness,
  readHarnessCfg, readImplNotes, readImplNotesByGraph, readInterview, readRules,
  resolveBatchLimit, resolveMaxSteps, rulesFile, runModel, writeHarness, writeHarnessCfg,
  writeInterview, writeUnknownScan,
} from "./index.js";
import type { CodebaseProfile, UnknownScanResult, BatchTask, HarnessCfg } from "./index.js";

export type ToolHost = {
  rt: Runtime;
  /** Current quota coaching (decision/advice/percentages). May throw when unavailable — same as current() today. */
  current(): { decision: string; advice: string; weekly: number; monthly: number; fiveHour: number };
  /** Trigger the background quota refresh (cheap, dedup'd). */
  refresh(): void;
};

export type ToolDef = {
  name: string;
  description: string; // FULL original V1 description (protocol text — keep verbatim)
  schema: any;         // JSON Schema from TOOL_SCHEMAS
  execute(args: any, call: CallCtx, host: ToolHost): Promise<string>;
};

/** Build the 16 harness tool definitions (order follows TOOL_NAMES). */
export function buildToolDefs(): ToolDef[] {
  const defs: ToolDef[] = [

    {
      name: TOOL_NAMES[0],
      description: TOOL_SCHEMAS.harness_start.description,
      schema: TOOL_SCHEMAS.harness_start.schema,
      async execute(args: { name: string; total: number }, call: CallCtx) {
        writeHarness(call.sessionID!, { name: args.name, total: args.total, current: 0, tasks: [], usage: {}, active: true, scanRequired: true, startedAt: new Date().toISOString() });
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

PATH A — INDEPENDENT (parallel via generate_batch + grade_batch):
  1. task_update(1..${args.total}, title, "generating")
  2. generate_batch({tasks: [{id:1, prompt:"Task: <title1>. Perform it."}, ...]})  -> all results + NEXT
  3. task_update(1..${args.total}, title, "grading")
  4. grade_batch({tasks: [{id:1, prompt:"Evaluate... PASS/FAIL first line. Task: <title1>"}, ...]})  -> all verdicts + per-task NEXT
  5. for each i: PASS -> task_update(i, title, "completed", "PASS"); FAIL -> revise (up to 2x) or task_update(i, title, "failed", "FAIL")
  Note: grade_batch runs all grades IN PARALLEL — much faster than grading one-by-one.
  After revisions, you can grade_batch the revised tasks together too.

PATH B — DEPENDENT (sequential — one task at a time):
  Optional: task_update(1..N, title, "pending")  ← pre-register all tasks first
  for i in 1..${args.total}:
    1. task_update(i, title, "generating")
    2. generate({prompt:"Task: <title>. Perform it."})  -> work + NEXT
    3. task_update(i, title, "grading")
    4. grade(...)  -> verdict + NEXT
    5. PASS -> task_update(i, title, "completed", "PASS"); FAIL -> revise (up to 2x) or failed
  Note: use single grade() here — tasks are dependent, grading is one at a time.

Then: harness_done(). Follow the [usage-coach NEXT] directive each tool returns. Do NOT improvise the sequence.`;
      },
    },

    {
      name: TOOL_NAMES[1],
      description: TOOL_SCHEMAS.unknown_scan.description,
      schema: TOOL_SCHEMAS.unknown_scan.schema,
      async execute(args: { prompt: string; tasks?: Array<{ id: number; title: string }>; skip_scan?: boolean }, call: CallCtx, host: ToolHost) {
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
            const dir = (call.directory ?? host.rt.directory) || ".";
            const result = spawnSync("find", [
              dir, "-maxdepth", "4", "-type", "f",
              "-not", "-path", "*/node_modules/*",
              "-not", "-path", "*/.git/*",
              "-not", "-path", "*/dist/*",
              "-not", "-path", "*/.cache/*",
            ], { encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 });
            const fileList = result.stdout || "";
            profile = parseFileList(fileList, call.directory ?? host.rt.directory);
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

        // ── PHASE 2.5 — Web Search (3-tier: official docs → GitHub issues → code) ──
        let webResults: WebResult[] = [];
        let docRefs: Array<{ name: string; url: string }> = [];
        try {
          const searchQuery = `${args.prompt} ${tasks.map((t) => t.title).join(" ")}`.slice(0, 256);
          const webResp = await webSearch(searchQuery, profile.frameworks, profile.keyDeps);
          webResults = webResp.results;
          docRefs = webResp.docRefs;
          if (webResp.error) log(`unknown_scan web search: ${webResp.error}`);
          log(`unknown_scan web search: ${webResults.length} results, ${docRefs.length} doc refs`);
        } catch (e) { log(`unknown_scan web search err: ${String(e).slice(0, 200)}`); }

        // ── PHASE 3 — Gap Analysis (model-assisted, quota-aware) ──
        const cfg = readHarnessCfg(call.directory ?? host.rt.directory);
        if (!cfg.generator) {
          const result: UnknownScanResult = {
            scannedAt: new Date().toISOString(), codebaseProfile: profile,
            knownKnowns: [], knownUnknowns: [], unknownKnowns: [], unknownUnknowns: [],
            questions: [], taskRefinements: [], domainHits, domainMisses: 0,
            rawAnalysis: "ERROR: no generator configured",
          };
          writeUnknownScan(call.sessionID!, result);
          return formatReport(result) + '\n\nERROR: no generator model configured. Set "generator" in harness.config.json for model-assisted analysis.';
        }
        let decision = "GO"; try { decision = host.current().decision; } catch { /* */ }
        if (decision === "STOP") {
          const result: UnknownScanResult = {
            scannedAt: new Date().toISOString(), codebaseProfile: profile,
            knownKnowns: [], knownUnknowns: [], unknownKnowns: [], unknownUnknowns: [],
            questions: [], taskRefinements: [], domainHits, domainMisses: 0,
            rawAnalysis: "quota STOP — model analysis skipped",
          };
          writeUnknownScan(call.sessionID!, result);
          return formatReport(result) + "\n\n[usage-coach] quota STOP — model-assisted analysis skipped. Proceed with caution.";
        }
        const throttle = decision === "THROTTLE" && cfg.lighterModel;
        const model = throttle ? cfg.lighterModel! : cfg.generator;
        const gapPrompt = buildGapPrompt(args.prompt, tasks, profile, domainNodes, webResults, docRefs);
        const raw = await runModel(host.rt.session, model, gapPrompt, call.directory ?? host.rt.directory, undefined, 15, call.signal);

        // ── PHASE 3b — Parse model output ──
        const result = parseGapAnalysis(raw, profile, domainHits);
        result.webResults = webResults;
        result.docRefs = docRefs;

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
        writeUnknownScan(call.sessionID!, result);
        return formatReport(result);
      },
    },

    {
      name: TOOL_NAMES[2],
      description: TOOL_SCHEMAS.question.description,
      schema: TOOL_SCHEMAS.question.schema,
      async execute(args: { answers?: Record<string, string> }, call: CallCtx) {
        const h = readHarness(call.sessionID!);
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
        writeHarness(call.sessionID!, h);

        const answered = Object.keys(args.answers).length;
        const lines = [`Questions resolved (${answered}/${questions.length} answered).\n`];
        questions.forEach((q) => {
          const ans = args.answers![q.id];
          if (ans) lines.push(`  ${q.id}: ${q.question}\n  → ${ans}`);
        });
        lines.push("\n[usage-coach NEXT] Answers recorded. Proceed to generate — they will be injected into the sub-session prompt.");
        return lines.join("\n");
      },
    },

    {
      name: TOOL_NAMES[3],
      description: TOOL_SCHEMAS.task_update.description,
      schema: TOOL_SCHEMAS.task_update.schema,
      async execute(args: { id: number; title: string; status: string; revisions?: number; score?: string; model?: string }, call: CallCtx, host: ToolHost) {
        const VALID_STATUSES = ["pending", "generating", "grading", "revising", "completed", "failed", "timed_out", "halted_quota"];
        // Default to "generating" if status is missing/invalid — keeps the harness moving
        // instead of blocking with an error that the model has to retry.
        const status = args.status && VALID_STATUSES.includes(args.status) ? args.status : "generating";
        const cfg = readHarnessCfg(call.directory ?? host.rt.directory);
        const h = readHarness(call.sessionID!) ?? { name: "batch", total: 0, current: 0, tasks: [], usage: {}, active: true };
        h.tasks = h.tasks.filter((x: any) => x.id !== args.id);
        // Model is required for quota tracking. Auto-fill from config.generator if not provided.
        const model = args.model || cfg.generator || "";
        if (!model) return `ERROR: task ${args.id} has no model and no generator configured. Set "generator" in harness.config.json.`;
        h.tasks.push({ id: args.id, title: args.title, status, model, revisions: args.revisions ?? 0, score: args.score ?? null, startedAt: new Date().toISOString() });
        if (args.id > h.current) h.current = args.id;
        writeHarness(call.sessionID!, h);
        return `task ${args.id} -> ${status}${args.score ? ` (${args.score})` : ""}`;
      },
    },

    {
      name: TOOL_NAMES[4],
      description: TOOL_SCHEMAS.harness_done.description,
      schema: TOOL_SCHEMAS.harness_done.schema,
      async execute(_args: any, call: CallCtx) {
        const h = readHarness(call.sessionID!);
        if (h) { h.current = h.total; h.active = false; writeHarness(call.sessionID!, h); }
        return "Harness complete.";
      },
    },

    {
      name: TOOL_NAMES[5],
      description: TOOL_SCHEMAS.record_failure.description,
      schema: TOOL_SCHEMAS.record_failure.schema,
      async execute(args: { task: string; prompt: string; gradeResult: string; model?: string; revisions?: number }) {
        const rec = { ts: new Date().toISOString(), task: args.task, prompt: args.prompt, gradeResult: args.gradeResult, model: args.model, revisions: args.revisions };
        try { mkdirSync(STATE_DIR, { recursive: true }); appendFileSync(failuresFile(), JSON.stringify(rec) + "\n"); } catch (e) { log(`record_failure err: ${String(e)}`); }
        return `Failure recorded. [usage-coach NEXT] call investigate({failure: ${JSON.stringify(rec)}}) to find the root cause.`;
      },
    },

    {
      name: TOOL_NAMES[6],
      description: TOOL_SCHEMAS.investigate.description,
      schema: TOOL_SCHEMAS.investigate.schema,
      async execute(args: { task: string; prompt: string; gradeResult: string; model?: string }, call: CallCtx, host: ToolHost) {
        const cfg = readHarnessCfg(call.directory ?? host.rt.directory);
        if (!cfg.generator) return "ERROR: no generator model configured. Set \"generator\" in harness.config.json (see harness.config.example.json).";
        // Query domain DB for known facts before analyzing root cause.
        let domainPrefix = "";
        let keywords: string[] = [];
        let domainEmpty = true;
        try {
          keywords = extractKeywords(`${args.task} ${args.gradeResult}`);
          if (keywords.length) {
            const { nodes, edges } = queryDomain(keywords, { maxNodes: cfg.domainMaxNodes ?? 12 });
            // Injection provenance — record even on miss (nodeIds: []) so recall has a denominator.
            logDomainInjection(keywords, nodes.map((n) => n.id));
            if ((nodes && nodes.length) || (edges && edges.length)) {
              domainEmpty = false;
              domainPrefix = `Known facts from domain DB: ${JSON.stringify({ nodes, edges })}. Use these if relevant.\n\n---\n\n`;
            }
          }
        } catch (e) { log(`investigate domain query err: ${String(e)}`); }
        const rcaPrompt = `A task failed. Analyze the ROOT CAUSE (not just the symptom).\nTask: ${args.task}\nWhat was expected (from grade): ${args.gradeResult}\nRead relevant files in the directory if needed.\nOutput a structured root cause:\ncategory: (one of: constraint-violation, missing-context, tool-misuse, model-limitation, other)\nexplanation: <why it failed>\nevidence: <file/line or specific quote>`;
        const invTaskId = findActiveTaskId(call.sessionID!, "revising");
        const out = await runModel(host.rt.session, cfg.generator, domainPrefix + rcaPrompt, call.directory ?? host.rt.directory,
          invTaskId ? { sessionID: call.sessionID!, taskId: invTaskId } : undefined, undefined, call.signal);
        // Investigate-if-unknown, then store: only persist the finding when the domain DB was empty.
        if (domainEmpty && keywords.length) {
          try { saveInvestigationResult(keywords, out, "investigate"); } catch (e) { log(`investigate save err: ${String(e)}`); }
        }
        return out + "\n[usage-coach NEXT] call verify_diagnosis with this diagnosis.";
      },
    },

    {
      name: TOOL_NAMES[7],
      description: TOOL_SCHEMAS.verify_diagnosis.description,
      schema: TOOL_SCHEMAS.verify_diagnosis.schema,
      async execute(args: { diagnosis: string; task: string; gradeResult: string }, call: CallCtx, host: ToolHost) {
        const cfg = readHarnessCfg(call.directory ?? host.rt.directory);
        const model = cfg.grader ?? cfg.generator;
        if (!model) return "FAIL\n(ERROR: no grader/generator model configured.)\n[usage-coach NEXT] configure grader in harness.config.json, then retry verify_diagnosis.";
        const verifyPrompt = `Verify this root-cause analysis for a failure.\nTask: ${args.task}\nGrade feedback: ${args.gradeResult}\nDiagnosis: ${args.diagnosis}\nIs the diagnosis CORRECT and ACTIONABLE (leads to a useful rule)?\nOutput PASS (the diagnosis is right) or FAIL (re-investigate needed), then reason.`;
        const verTaskId = findActiveTaskId(call.sessionID!, "revising");
        const out = await runModel(host.rt.session, model, verifyPrompt, call.directory ?? host.rt.directory,
          verTaskId ? { sessionID: call.sessionID!, taskId: verTaskId } : undefined, undefined, call.signal);
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
    },

    {
      name: TOOL_NAMES[8],
      description: TOOL_SCHEMAS.generalize.description,
      schema: TOOL_SCHEMAS.generalize.schema,
      async execute(args: { diagnosis: string; task: string }, call: CallCtx, host: ToolHost) {
        const cfg = readHarnessCfg(call.directory ?? host.rt.directory);
        if (!cfg.generator) return "ERROR: no generator model configured. Set \"generator\" in harness.config.json (see harness.config.example.json).";
        const genPrompt = `Turn this verified root cause into a GENERAL, REUSABLE rule for future tasks of this kind.\nDiagnosis: ${args.diagnosis}\nFailed task: ${args.task}\nOutput a single rule in the form: 'For <task-type> tasks, always <check/do X> because <reason>.'\nKeep it concrete and actionable.`;
        const genRuleTaskId = findActiveTaskId(call.sessionID!, "revising");
        const out = await runModel(host.rt.session, cfg.generator, genPrompt, call.directory ?? host.rt.directory,
          genRuleTaskId ? { sessionID: call.sessionID!, taskId: genRuleTaskId } : undefined, undefined, call.signal);
        const rule = out;
        try {
          const date = new Date().toISOString().slice(0, 10);
          mkdirSync(STATE_DIR, { recursive: true });
          appendFileSync(rulesFile(), `## Rule (${date})\n${rule}\nOrigin: ${args.task}\n\n`);
        } catch (e) { log(`generalize err: ${String(e)}`); }
        return `${rule}\n[usage-coach NEXT] rule saved to rules.md. The next generate call will include it. Call task_update for the original failed task -> failed, then proceed.`;
      },
    },

    // Per-role model execution (config-driven, quota-aware, same server, no deadlock).
    // P1: quota decision drives model selection + concurrency.
    {
      name: TOOL_NAMES[9],
      description: TOOL_SCHEMAS.generate.description,
      schema: TOOL_SCHEMAS.generate.schema,
      async execute(args: { prompt: string; max_steps?: number }, call: CallCtx, host: ToolHost) {
        const cfg = readHarnessCfg(call.directory ?? host.rt.directory);
        if (!cfg.generator) {
          const h = readHarness(call.sessionID!);
          if (h) { h.active = false; writeHarness(call.sessionID!, h); }
          return "ERROR: no generator model configured. Set \"generator\" in harness.config.json (see harness.config.example.json). HARNESS TERMINATED — configure a generator model, then restart the harness.";
        }
        let decision = "GO"; try { decision = host.current().decision; } catch { /* */ }
        const throttle = decision === "THROTTLE" && cfg.lighterModel;
        const model = throttle ? cfg.lighterModel! : cfg.generator;
        // Stage 5 (reference): inject accumulated rules from past failures into the prompt.
        const rules = readRules();
        let prefix = rules ? `Lessons learned from previous failures (apply where relevant):\n${rules}\n\n---\n\n` : "";
        // Also inject known facts from the domain DB (same project scope).
        let keywords: string[] = [];
        let domainEmpty = true;
        let domainNodeCount = 0;
        let domainEdgeCount = 0;
        try {
          keywords = extractKeywords(args.prompt);
          if (keywords.length) {
            const { nodes, edges } = queryDomain(keywords, { maxNodes: cfg.domainMaxNodes ?? 12 });
            // Injection provenance — record even on miss (nodeIds: []) so recall has a denominator.
            logDomainInjection(keywords, nodes.map((n) => n.id));
            if ((nodes && nodes.length) || (edges && edges.length)) {
              domainEmpty = false;
              domainNodeCount = nodes.length;
              domainEdgeCount = edges.length;
              prefix = `Known facts from domain DB: ${JSON.stringify({ nodes, edges })}. Use these if relevant.\n\n---\n\n` + prefix;
              log(`generate domain HIT: ${nodes.length} nodes, ${edges.length} edges (kw=[${keywords.join(",")}])`);
            } else {
              log(`generate domain MISS: 0 nodes (kw=[${keywords.join(",")}])`);
            }
          }
        } catch (e) { log(`generate domain query err: ${String(e)}`); }
        // Inject prior impl-notes (graph-matched for this task, fallback to last-5).
        let notesLines = 0;
        try {
          const priorNotes = keywords.length ? readImplNotesByGraph(keywords, 5) : readImplNotes(5);
          if (priorNotes) {
            notesLines = priorNotes.split("\n").filter(Boolean).length;
            prefix = `Notes from previous runs (context for this task):\n${priorNotes}\n\n---\n\n` + prefix;
          }
        } catch (e) { log(`generate impl-notes read err: ${String(e)}`); }
        // Append the impl-notes writing instruction so the sub-session emits a <impl-notes> block.
        prefix += IMPL_NOTE_INSTRUCTION;
        // ── Diagnosis gate: warn if unknown_scan was required but not done ──
        const gate = checkScanGate(call.sessionID!);
        if (gate.warning) {
          prefix = `${gate.warning}\n\n---\n\n` + prefix;
        }
        // ── Scan findings injection: if scan WAS done, inject the summary so the
        // sub-session knows about blind spots without manual copying. ──
        if (gate.summary) {
          prefix = `Pre-flight scan findings (from unknown_scan — heed these):\n${gate.summary}\n\n---\n\n` + prefix;
        }
        const genTaskId = findActiveTaskId(call.sessionID!, "generating");
        const maxSteps = resolveMaxSteps(cfg, args.max_steps);
        // Record injected knowledge stats for effectiveness tracking.
        const injected = {
          rules: rules ? rules.split("\n").filter(Boolean).length : 0,
          implNotes: notesLines,
          domainNodes: domainNodeCount,
          domainEdges: domainEdgeCount,
          hasScanFindings: !!(gate.summary),
        };
        if (genTaskId) {
          try { mutateHarness(call.sessionID!, (h) => {
            const t = h.tasks.find((x: any) => x.id === genTaskId);
            if (t) t.injected = injected;
          }); } catch { /* */ }
        }
        const out = await runModel(host.rt.session, model, prefix + args.prompt, call.directory ?? host.rt.directory,
          genTaskId ? { sessionID: call.sessionID!, taskId: genTaskId } : undefined, maxSteps, call.signal);
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
    },

    {
      name: TOOL_NAMES[10],
      description: TOOL_SCHEMAS.generate_batch.description,
      schema: TOOL_SCHEMAS.generate_batch.schema,
      async execute(args: { tasks: BatchTask[]; max_steps?: number }, call: CallCtx, host: ToolHost) {
        const cfg = readHarnessCfg(call.directory ?? host.rt.directory);
        if (!cfg.generator) {
          const h = readHarness(call.sessionID!);
          if (h) { h.active = false; writeHarness(call.sessionID!, h); }
          return "ERROR: no generator model configured. Set \"generator\" in harness.config.json (see harness.config.example.json). HARNESS TERMINATED — configure a generator model, then restart the harness.";
        }
        let decision = "GO"; try { decision = host.current().decision; } catch { /* */ }
        if (decision === "STOP") return "ERROR: quota STOP — halt the harness loop now. Call task_update(current, \"halted_quota\") and stop.";
        const throttle = decision === "THROTTLE" && cfg.lighterModel;
        const model = throttle ? cfg.lighterModel! : cfg.generator;
        // GO: run all in parallel. THROTTLE: cap concurrency at 2 to avoid spiking quota.
        // File overlap between tasks forces sequential (limit=1) — the strongest constraint.
        const limit = resolveBatchLimit(args.tasks, decision);
        if (limit === 1 && args.tasks.length > 1) log(`generate_batch: file overlap detected, forcing sequential (limit=1)`);
        // Shared prefix components (rules + prior impl-notes) computed once for all tasks.
        const rules = readRules();
        const priorNotes = readImplNotes(5);
        const maxSteps = resolveMaxSteps(cfg, args.max_steps);

        // ── Diagnosis gate (shared by all tasks in this batch) ──
        const gate = checkScanGate(call.sessionID!);
        const gatePrefix = gate.warning
          ? `${gate.warning}\n\n---\n\n`
          : (gate.summary ? `Pre-flight scan findings (from unknown_scan — heed these):\n${gate.summary}\n\n---\n\n` : "");

        // Inner runner: execute a single task's runModel + impl-notes extraction.
        // Returns { id, result } on success, or { id, error } on rejection.
        const runOne = async (t: BatchTask): Promise<{ id: number; result: string }> => {
          let prefix = gatePrefix;
          prefix += rules ? `Lessons learned from previous failures (apply where relevant):\n${rules}\n\n---\n\n` : "";
          if (priorNotes) prefix = `Notes from previous runs (context for this task):\n${priorNotes}\n\n---\n\n` + prefix;
          prefix += IMPL_NOTE_INSTRUCTION;
          const r = await runModel(host.rt.session, model, prefix + t.prompt, call.directory ?? host.rt.directory,
            { sessionID: call.sessionID!, taskId: t.id }, maxSteps, call.signal);
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
        const failed: Array<{ id: number; prompt: string; files?: string[]; error: string }> = [];

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
              failed.push({ id: t.id, prompt: t.prompt, files: t.files, error: err });
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
    },

    {
      name: TOOL_NAMES[11],
      description: TOOL_SCHEMAS.grade.description,
      schema: TOOL_SCHEMAS.grade.schema,
      async execute(args: { prompt: string; checks?: Array<Record<string, any>> }, call: CallCtx, host: ToolHost) {
        // Deterministic path (v0.18.0): checks replace the grader-model round-trip.
        if (args.checks && args.checks.length > 0) {
          const r = evalChecks(call.directory ?? host.rt.directory, args.checks as unknown as GradeCheck[]);
          // Reward loop: a deterministic verdict is a CLEAR verdict — pay it too.
          try {
            const gr2 = applyReward(r.pass ? "pass" : "fail", harnessTaskTitle(call.sessionID!, findActiveTaskId(call.sessionID!, "grading")));
            log(`applyReward(${r.pass ? "pass" : "fail"}): applied ${gr2.applied}`);
          } catch (e) { log(`applyReward err: ${String(e)}`); }
          const next2 = r.pass
            ? `\n[usage-coach NEXT] PASS -> call task_update(i, title, "completed", "PASS"), then proceed to next task (or harness_done if last).`
            : `\n[usage-coach NEXT] FAIL -> if revisions < 2: task_update(i, title, "revising", revisions+1) + generate({prompt: "Apply feedback:\\n{grade result}\\nTask: {title}"}); else: run the learning loop (record_failure -> investigate -> verify_diagnosis -> generalize), then task_update(i, title, "failed", "FAIL").`;
          return `${r.pass ? "PASS" : "FAIL"}\n(verified by ${r.results.length} deterministic check(s) — grader model skipped)\n${formatCheckReport(r)}\ngraded claim: ${args.prompt.slice(0, 300)}\n${next2}`;
        }
        const cfg = readHarnessCfg(call.directory ?? host.rt.directory);
        const model = cfg.grader ?? cfg.generator;
        if (!model) return "FAIL\n(ERROR: no grader/generator model configured.)\n[usage-coach NEXT] configure grader in harness.config.json, then retry grade.";
        const gradeTaskId = findActiveTaskId(call.sessionID!, "grading");
        const out = await runModel(host.rt.session, model, buildGradePrompt(args.prompt), call.directory ?? host.rt.directory,
          gradeTaskId ? { sessionID: call.sessionID!, taskId: gradeTaskId } : undefined, undefined, call.signal);
        // Determine verdict from the first non-empty line.
        let verdict = "FAIL";
        let verdictClear = false; // true only when the line explicitly matched pass/fail
        if (!out.startsWith("ERROR:")) {
          const f = (out.split("\n").find((l) => l.trim()) ?? "").trim();
          if (/^pass\b/i.test(f)) { verdict = "PASS"; verdictClear = true; }
          else if (/^fail\b/i.test(f)) { verdict = "FAIL"; verdictClear = true; }
          else verdict = "FAIL"; // no clear verdict -> FAIL to trigger a revise
        }
        // Reward closed loop (v0.16.0): a CLEAR verdict pays confidence ±δ on the
        // generate-phase injections (applyReward drains every unclaimed injection).
        // Unclear verdicts (ERROR: / no pass-fail match) pay nothing — no reward.
        // Best-effort: a reward bug must never break grading.
        if (verdictClear) {
          try {
            const r = applyReward(verdict === "PASS" ? "pass" : "fail", harnessTaskTitle(call.sessionID!, gradeTaskId));
            log(`applyReward(${verdict.toLowerCase()}): applied ${r.applied}`);
          } catch (e) { log(`applyReward err: ${String(e)}`); }
        }
        const next = verdict === "PASS"
          ? `\n[usage-coach NEXT] PASS -> call task_update(i, title, "completed", "PASS"), then proceed to next task (or harness_done if last).`
          : `\n[usage-coach NEXT] FAIL -> if revisions < 2: task_update(i, title, "revising", revisions+1) + generate({prompt: "Apply feedback:\\n{grade result}\\nTask: {title}"}); else: run the learning loop before failing —\n  1. record_failure({task, prompt, gradeResult, model, revisions})\n  2. investigate({task, prompt, gradeResult}) -> diagnosis\n  3. verify_diagnosis({diagnosis, task, gradeResult}) -> if PASS: generalize({diagnosis, task}) (saves rule to rules.md)\n  4. task_update(i, title, "failed", "FAIL") -> next task.\nThe next generate call will automatically include the new rule.`;
        return out + "\n" + next;
      },
    },

    {
      name: TOOL_NAMES[12],
      description: TOOL_SCHEMAS.grade_batch.description,
      schema: TOOL_SCHEMAS.grade_batch.schema,
      async execute(args: { tasks: Array<{ id: number; prompt: string; checks?: Array<Record<string, any>> }> }, call: CallCtx, host: ToolHost) {
        const cfg = readHarnessCfg(call.directory ?? host.rt.directory);
        const model = cfg.grader ?? cfg.generator;
        if (!model) {
          return "ERROR: no grader/generator model configured. Set \"grader\" or \"generator\" in harness.config.json.";
        }

        // ── Quota gate ──
        let decision = "GO"; try { decision = host.current().decision; } catch { /* */ }
        if (decision === "STOP") {
          return "ERROR: quota STOP — halt the harness loop now. Call task_update(current, \"halted_quota\") and stop.";
        }
        // GO: grade all in parallel. THROTTLE: cap at 2 to avoid quota spike.
        const limit = decision === "THROTTLE" ? 2 : args.tasks.length;

        // ── Inner runner: grade a single task ──
        const gradeOne = async (t: { id: number; prompt: string; checks?: Array<Record<string, any>> }): Promise<{ id: number; result: string }> => {
          // Deterministic path (v0.18.0): checks replace the grader-model round-trip.
          if (t.checks && t.checks.length > 0) {
            const r = evalChecks(call.directory ?? host.rt.directory, t.checks as unknown as GradeCheck[]);
            try {
              const title = harnessTaskTitle(call.sessionID!, t.id);
              const rw = applyReward(r.pass ? "pass" : "fail", title ? `batch #${t.id} ${title}` : `batch #${t.id}`);
              log(`applyReward(${r.pass ? "pass" : "fail"}) batch #${t.id}: applied ${rw.applied}`);
            } catch (e) { log(`applyReward err: ${String(e)}`); }
            const next2 = r.pass
              ? `[usage-coach NEXT] task ${t.id}: PASS -> task_update(${t.id}, title, "completed", "PASS"), then proceed.`
              : `[usage-coach NEXT] task ${t.id}: FAIL -> if revisions < 2: task_update(${t.id}, title, "revising") + generate({prompt:"Apply feedback:\\n${formatCheckReport(r).slice(0, 500)}\\nTask: {title}"}); else: record_failure + investigate + verify + generalize, then task_update(${t.id}, title, "failed", "FAIL").`;
            return { id: t.id, result: `[task ${t.id}] ${r.pass ? "PASS" : "FAIL"}\n(verified by ${r.results.length} deterministic check(s) — grader model skipped)\n${formatCheckReport(r)}\n${next2}` };
          }
          const gradeTaskId = findActiveTaskId(call.sessionID!, "grading");
          const out = await runModel(host.rt.session, model, buildGradePrompt(t.prompt), call.directory ?? host.rt.directory,
            gradeTaskId ? { sessionID: call.sessionID!, taskId: gradeTaskId } : undefined, undefined, call.signal);

          // Parse verdict from first non-empty line
          let verdict = "FAIL";
          let verdictClear = false; // true only when the line explicitly matched pass/fail
          if (!out.startsWith("ERROR:")) {
            const f = (out.split("\n").find((l) => l.trim()) ?? "").trim();
            if (/^pass\b/i.test(f)) { verdict = "PASS"; verdictClear = true; }
            else if (/^fail\b/i.test(f)) { verdict = "FAIL"; verdictClear = true; }
          }
          // Reward closed loop (v0.16.0): pay per-task verdict, note = "batch #<id> <title>".
          // applyReward's drain is one synchronous read-check-append block, so batch tasks
          // resolved in any order stay consistent — the FIRST reward call drains ALL
          // unclaimed injections; later calls in the same batch drain nothing and append
          // no reward record. Best-effort like grade().
          if (verdictClear) {
            try {
              const title = harnessTaskTitle(call.sessionID!, t.id);
              const r = applyReward(verdict === "PASS" ? "pass" : "fail", title ? `batch #${t.id} ${title}` : `batch #${t.id}`);
              log(`applyReward(${verdict.toLowerCase()}) batch #${t.id}: applied ${r.applied}`);
            } catch (e) { log(`applyReward err: ${String(e)}`); }
          }

          const next = verdict === "PASS"
            ? `[usage-coach NEXT] task ${t.id}: PASS -> task_update(${t.id}, title, "completed", "PASS"), then proceed.`
            : `[usage-coach NEXT] task ${t.id}: FAIL -> if revisions < 2: task_update(${t.id}, title, "revising") + generate({prompt:"Apply feedback:\\n${out.slice(0, 500)}\\nTask: {title}"}); else: record_failure + investigate + verify + generalize, then task_update(${t.id}, title, "failed", "FAIL").`;

          return { id: t.id, result: `[task ${t.id}] ${verdict}\n${out}\n${next}` };
        };

        // ── Parallel execution with concurrency cap ──
        const results: string[] = [];
        const failed: Array<{ id: number; prompt: string; error: string }> = [];

        for (let i = 0; i < args.tasks.length; i += limit) {
          const batch = args.tasks.slice(i, i + limit);
          const settled = await Promise.allSettled(batch.map((t) => gradeOne(t)));
          for (let j = 0; j < settled.length; j++) {
            const s = settled[j];
            const t = batch[j];
            if (s.status === "fulfilled") {
              results.push(s.value.result);
            } else {
              const err = String(s.reason ?? "unknown rejection");
              log(`grade_batch task ${t.id} REJECTED: ${err}`);
              failed.push({ id: t.id, prompt: t.prompt, error: err });
            }
          }
        }

        // ── Retry failed grades sequentially ──
        if (failed.length > 0) {
          log(`grade_batch: retrying ${failed.length} failed grade(s) sequentially`);
          for (const f of failed) {
            try {
              const r = await gradeOne(f);
              results.push(r.result.replace(`[task ${r.id}]`, `[task ${r.id}] (retry)`));
            } catch (e2) {
              const err2 = String(e2 ?? "unknown rejection on retry");
              log(`grade_batch task ${f.id} retry ALSO FAILED: ${err2}`);
              results.push(`[task ${f.id}] FAIL\n(ERROR: grade failed on both batch and retry: ${err2})\n[usage-coach NEXT] task ${f.id}: grade error — re-run grade() individually for this task.`);
            }
          }
        }

        const throttleNote = decision === "THROTTLE"
          ? `\n[usage-coach] quota THROTTLE — grader concurrency capped at ${limit}.`
          : "";
        const passCount = results.filter((r) => /\[task \d+\] PASS/.test(r)).length;
        const summary = `\n[usage-coach] Graded ${results.length} task(s): ${passCount} PASS, ${results.length - passCount} FAIL.`;
        return results.join("\n\n") + summary + throttleNote;
      },
    },

    {
      name: TOOL_NAMES[13],
      description: TOOL_SCHEMAS.reverse_interview.description,
      schema: TOOL_SCHEMAS.reverse_interview.schema,
      async execute(args: { task: string; context?: string; answer?: string; force_complete?: boolean }, call: CallCtx, host: ToolHost) {
        const sessionID = call.sessionID!;
        const cfg = readHarnessCfg(call.directory ?? host.rt.directory);
        // Throttle-aware model resolver (shared by planning + completion).
        const resolveModel = (): string | null => {
          if (!cfg.generator) return null;
          let decision = "GO"; try { decision = host.current().decision; } catch { /* */ }
          const throttle = decision === "THROTTLE" && cfg.lighterModel;
          return throttle ? cfg.lighterModel! : cfg.generator;
        };
        let state = readInterview(sessionID);

        // --- FORCED COMPLETION (user said "that's enough") ---
        if (args.force_complete) {
          if (state && state.phase !== "complete") {
            return await completeInterview(state, sessionID, host.rt.session, resolveModel(), call.directory ?? host.rt.directory, call.signal);
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
            return await completeInterview(state, sessionID, host.rt.session, resolveModel(), call.directory ?? host.rt.directory, call.signal);
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

          const out = await runModel(host.rt.session, model, planningPrompt, call.directory ?? host.rt.directory, undefined, undefined, call.signal);

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
    },

    {
      name: TOOL_NAMES[14],
      description: TOOL_SCHEMAS.coach_config.description,
      schema: TOOL_SCHEMAS.coach_config.schema,
      async execute(args: { generator?: string; grader?: string; lighterModel?: string; provider?: string; maxSteps?: number; domainMaxNodes?: number }, call: CallCtx, host: ToolHost) {
        const dir = call.directory ?? host.rt.directory;
        const current = readHarnessCfg(dir);

        // If no args → view mode
        const hasUpdates = args.generator !== undefined || args.grader !== undefined ||
                           args.lighterModel !== undefined || args.provider !== undefined ||
                           args.maxSteps !== undefined || args.domainMaxNodes !== undefined;
        if (!hasUpdates) {
          const envOverrides: string[] = [];
          if (process.env.UC_PROVIDER) envOverrides.push(`UC_PROVIDER=${process.env.UC_PROVIDER}`);
          if (process.env.UC_LIGHTER_MODEL) envOverrides.push(`UC_LIGHTER_MODEL=${process.env.UC_LIGHTER_MODEL}`);
          if (process.env.UC_MAX_STEPS) envOverrides.push(`UC_MAX_STEPS=${process.env.UC_MAX_STEPS}`);
          return [
            `Harness Configuration`,
            `═══════════════════════════════════════════════`,
            `  generator:     ${current.generator ?? "(not set — harness won't work!)"}`,
            `  grader:        ${current.grader ?? "(defaults to generator)"}`,
            `  lighterModel:  ${current.lighterModel ?? "(not set — no THROTTLE fallback)"}`,
            `  provider:      ${current.provider ?? "(auto-detected from model)"}`,
            `  maxSteps:      ${current.maxSteps ?? 30}  (env: UC_MAX_STEPS)`,
            `═══════════════════════════════════════════════`,
            envOverrides.length > 0 ? `\nEnvironment overrides (take precedence):\n  ${envOverrides.join("\n  ")}` : "",
            `\nConfig file: ~/.config/opencode-usage-coach/harness.config.json`,
            `\nTo update, call: coach_config({ generator: "provider/model-id", maxSteps: 15, ... })`,
          ].filter(Boolean).join("\n");
        }

        // Build updates object (only fields that were provided)
        const updates: HarnessCfg = {};
        if (args.generator !== undefined) updates.generator = args.generator.trim();
        if (args.grader !== undefined) updates.grader = args.grader.trim();
        if (args.lighterModel !== undefined) updates.lighterModel = args.lighterModel.trim();
        if (args.provider !== undefined) updates.provider = args.provider.trim();
        if (args.maxSteps !== undefined) updates.maxSteps = args.maxSteps;
        if (args.domainMaxNodes !== undefined) updates.domainMaxNodes = args.domainMaxNodes;

        const writtenPath = writeHarnessCfg(updates);
        const updated = readHarnessCfg(dir);

        return [
          `✅ Harness config updated successfully!`,
          `═══════════════════════════════════════════════`,
          `  generator:     ${updated.generator ?? "(not set)"}`,
          `  grader:        ${updated.grader ?? "(defaults to generator)"}`,
          `  lighterModel:  ${updated.lighterModel ?? "(not set)"}`,
          `  provider:      ${updated.provider ?? "(auto-detected)"}`,
          `  maxSteps:      ${updated.maxSteps ?? 30}`,
          `  domainMaxNodes: ${updated.domainMaxNodes ?? "(default 12)"}`,
          `═══════════════════════════════════════════════`,
          `\nSaved to: ${writtenPath}`,
          `\nNote: Changes take effect immediately for new generate/grade calls.`,
          `       A running harness will pick up the new config on the next tool call.`,
        ].join("\n");
      },
    },

    {
      name: TOOL_NAMES[15],
      description: TOOL_SCHEMAS.coach_analyze.description,
      schema: TOOL_SCHEMAS.coach_analyze.schema,
      async execute(_args: Record<string, never>, call: CallCtx) {
        const a = analyzeInjection(call.sessionID!);
        const lines = [
          "═══ Knowledge Injection Effectiveness ═══",
          `Total graded tasks: ${a.total} (PASS: ${a.passed}, FAIL: ${a.failed})`,
          "",
          `With injection:    ${a.withInjection.total} tasks → ${a.withInjection.passRate}% PASS`,
          `Without injection: ${a.withoutInjection.total} tasks → ${a.withoutInjection.passRate}% PASS`,
          "",
          "By category (PASS rate when injected):",
        ];
        for (const [cat, d] of Object.entries(a.byCategory)) {
          const rate = d.total > 0 ? Math.round(d.passed * 100 / d.total) : 0;
          lines.push(`  ${cat}: ${d.passed}/${d.total} = ${rate}%`);
        }
        const delta = a.withInjection.passRate - a.withoutInjection.passRate;
        if (a.withInjection.total > 0 && a.withoutInjection.total > 0) {
          lines.push("");
          lines.push(delta > 0
            ? `→ Injection helps: +${delta}% PASS rate with knowledge injection.`
            : delta < 0
            ? `→ Injection HURTS: ${delta}% PASS rate. Injected knowledge may be noise.`
            : `→ No measurable difference (${delta}%).`);
        } else {
          lines.push("", "→ Need more data (both groups need 5+ tasks).");
        }
        return lines.join("\n");
      },
    },
  ];

  // Structural guarantee: the def list lines up with TOOL_NAMES 1:1 (order included).
  if (defs.length !== TOOL_NAMES.length || defs.some((d, i) => d.name !== TOOL_NAMES[i])) {
    throw new Error(`tool-defs: buildToolDefs() out of sync with TOOL_NAMES`);
  }
  return defs;
}
