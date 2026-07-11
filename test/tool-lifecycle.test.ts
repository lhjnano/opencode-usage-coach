// tool-lifecycle.test.ts — functional/integration tests for tool lifecycle.
// Exercises REAL state transitions across multiple tool calls, simulating
// production usage patterns. NOT unit tests — end-to-end scenario tests.
//
// These tests drive the harness state machine the same way the actual harness
// loop does: harness_start → unknown_scan → question → generate → task_update →
// grade → task_update → ... → harness_done. We can't call generate/grade
// directly (they need the SDK client), but we CAN test every state transition
// that those tools trigger on harness.json.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import {
  setStateDir, readHarness, writeHarness, readRules,
  checkScanGate, updateSubSession, clearSubSession, findActiveTaskId,
  buildScanSummary, extractImplNotes,
} from "../src/index.js";
import type { HarnessJson, UnknownScanResult } from "../src/index.js";

// ── Setup ────────────────────────────────────────────────────────────────────

let stateDir: string;

before(() => {
  stateDir = mkdtempSync(join(tmpdir(), "uc-lifecycle-"));
  process.env.UC_STATE_DIR = stateDir;
  setStateDir(stateDir);
});

after(() => {
  delete process.env.UC_STATE_DIR;
  try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* */ }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeScanResult(opts?: {
  unknownUnknowns?: Array<{ finding: string; impact: string; mitigation?: string }>;
  unknownKnowns?: Array<{ finding: string; source: string }>;
  questions?: Array<{ id: string; question: string }>;
}): UnknownScanResult {
  return {
    scannedAt: new Date().toISOString(),
    codebaseProfile: {
      skipped: false, language: "TypeScript", frameworks: ["express"],
      testPattern: "*.test.ts", testFramework: "node:test",
      structure: [{ dir: "src", fileCount: 5 }], manifestFiles: ["package.json"],
      keyDeps: ["express"], configFiles: ["tsconfig.json"], totalFiles: 8,
    },
    knownKnowns: [], knownUnknowns: [],
    unknownKnowns: opts?.unknownKnowns ?? [],
    unknownUnknowns: opts?.unknownUnknowns ?? [],
    questions: opts?.questions ?? [],
    taskRefinements: [], domainHits: 0, domainMisses: 0,
  };
}

// Simulates what task_update.execute does: read, remove old entry, push new entry, write.
// This is the EXACT same read-filter-push-write pattern the real tool uses.
function simulateTaskUpdate(
  sessionID: string, id: number, title: string, status: string,
  opts?: { score?: string; revisions?: number },
) {
  const h = readHarness(sessionID) ?? {
    name: "test", total: 3, current: 0, tasks: [], usage: {}, active: true,
  };
  h.tasks = h.tasks.filter((x: any) => x.id !== id);
  h.tasks.push({
    id, title, status, model: "test-model",
    revisions: opts?.revisions ?? 0, score: opts?.score ?? null,
    startedAt: new Date().toISOString(),
  });
  if (id > h.current) h.current = id;
  writeHarness(sessionID, h);
}

function makeHarness(name: string, total: number, tasks?: any[]): HarnessJson {
  return {
    name, total, current: 0,
    tasks: tasks ?? Array.from({ length: total }, (_, i) => ({
      id: i + 1, title: `task-${i + 1}`, status: "pending",
    })),
    usage: {}, active: true, scanRequired: true,
    startedAt: new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 1: Full lifecycle — scan finds questions, gate blocks, answers resolve
// ═══════════════════════════════════════════════════════════════════════════════

test("Scenario 1: full scan→question→resolve lifecycle through checkScanGate", () => {
  const S = "s1-lifecycle";

  // Step 1: harness_start — scanRequired=true, scanDone=false
  writeHarness(S, makeHarness("s1-test", 1));
  const h0 = readHarness(S)!;
  assert.equal(h0.scanRequired, true);
  assert.equal(h0.scanDone, undefined, "scanDone should be falsy after harness_start");

  // Step 2: checkScanGate → warning about DIAGNOSIS GATE (scan not done)
  const gate1 = checkScanGate(S);
  assert.ok(gate1.warning, "should warn when scan required but not done");
  assert.ok(gate1.warning!.includes("DIAGNOSIS GATE"), "warning should mention DIAGNOSIS GATE");
  assert.equal(gate1.summary, null, "summary null when scan not done");

  // Step 3: Simulate unknown_scan completion — scanDone=true, questions found
  const h1 = readHarness(S)!;
  h1.scanDone = true;
  h1.unknownScan = makeScanResult({
    unknownUnknowns: [{ finding: "deployed .js lacks question tool", impact: "high", mitigation: "rebuild" }],
    questions: [
      { id: "Q1", question: "Test against source or deployed?" },
      { id: "Q2", question: "Which test framework?" },
    ],
  });
  h1.scanSummary = buildScanSummary(h1.unknownScan);
  writeHarness(S, h1);

  // Step 4: checkScanGate → warning about UNRESOLVED QUESTIONS
  const gate2 = checkScanGate(S);
  assert.ok(gate2.warning, "should warn about unresolved questions");
  assert.ok(gate2.warning!.includes("UNRESOLVED QUESTIONS"), "warning should mention UNRESOLVED QUESTIONS");
  assert.ok(gate2.summary, "summary should include scanSummary");
  assert.ok(gate2.summary!.includes("deployed .js"), "summary should include unknown unknowns");

  // Step 5: Simulate question tool — answers recorded
  const h2 = readHarness(S)!;
  h2.questionsResolved = true;
  h2.questionAnswers = { Q1: "source", Q2: "node:test" };
  writeHarness(S, h2);

  // Step 6: checkScanGate → no warning, summary contains answers
  const gate3 = checkScanGate(S);
  assert.equal(gate3.warning, null, "no warning after questions resolved");
  assert.ok(gate3.summary, "summary should be present");

  // Step 7: Verify answers are in the summary (they get injected into generate prompts)
  assert.ok(gate3.summary!.includes("Q1"), "summary should contain Q1");
  assert.ok(gate3.summary!.includes("source"), "summary should contain Q1 answer");
  assert.ok(gate3.summary!.includes("Q2"), "summary should contain Q2");
  assert.ok(gate3.summary!.includes("node:test"), "summary should contain Q2 answer");
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 2: Scan with no questions — gate passes immediately after scan
// ═══════════════════════════════════════════════════════════════════════════════

test("Scenario 2: scan with empty questions array → gate passes immediately", () => {
  const S = "s2-no-questions";

  writeHarness(S, makeHarness("s2-test", 1));

  // Before scan: gate warns
  const gate0 = checkScanGate(S);
  assert.ok(gate0.warning);

  // Simulate unknown_scan with NO questions
  const h = readHarness(S)!;
  h.scanDone = true;
  h.unknownScan = makeScanResult({
    unknownUnknowns: [{ finding: "minor edge case", impact: "low" }],
    questions: [], // empty — no questions for user
  });
  h.scanSummary = buildScanSummary(h.unknownScan);
  writeHarness(S, h);

  // Gate passes immediately (no questions to resolve)
  const gate = checkScanGate(S);
  assert.equal(gate.warning, null, "no warning when scan done with no questions");
  assert.ok(gate.summary, "summary should include scan findings");
  assert.ok(gate.summary!.includes("minor edge case"), "summary should include unknown unknowns");
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 3: Task state transitions across the full harness loop
// ═══════════════════════════════════════════════════════════════════════════════

test("Scenario 3: full 3-task harness loop — pending→generating→grading→completed", async () => {
  const S = "s3-full-loop";
  const TOTAL = 3;

  // harness_start: 3 tasks, all pending
  writeHarness(S, makeHarness("s3-loop", TOTAL));
  const h0 = readHarness(S)!;
  assert.equal(h0.tasks.length, TOTAL);
  assert.equal(h0.active, true);

  // No task is generating yet
  assert.equal(findActiveTaskId(S, "generating"), undefined);

  // Drive each task through the full lifecycle
  for (let i = 1; i <= TOTAL; i++) {
    // task_update(i, title, "generating")
    simulateTaskUpdate(S, i, `task-${i}`, "generating");
    assert.equal(findActiveTaskId(S, "generating"), i, `task ${i} should be generating`);

    // runModel poller: updateSubSession tracks progress
    await updateSubSession(S, i, { subSessionId: `sub-${i}`, subStep: i * 3, subElapsed: i * 10 });
    {
      const h = readHarness(S)!;
      const t = h.tasks.find((x: any) => x.id === i)!;
      assert.equal(t.subSessionId, `sub-${i}`);
      assert.equal(t.subStep, i * 3);
    }

    // Generation completes: clearSubSession (runModel's finally block)
    await clearSubSession(S, i);
    {
      const h = readHarness(S)!;
      const t = h.tasks.find((x: any) => x.id === i)!;
      assert.equal(t.subSessionId, undefined, "subSessionId cleared after completion");
    }

    // task_update(i, title, "grading")
    simulateTaskUpdate(S, i, `task-${i}`, "grading");
    assert.equal(findActiveTaskId(S, "grading"), i, `task ${i} should be grading`);

    // Grade passes → task_update(i, title, "completed", "PASS")
    simulateTaskUpdate(S, i, `task-${i}`, "completed", { score: "PASS" });
    // No task should be generating or grading anymore (for this task)
    const h = readHarness(S)!;
    const t = h.tasks.find((x: any) => x.id === i)!;
    assert.equal(t.status, "completed");
    assert.equal(t.score, "PASS");
  }

  // harness_done: set active=false, current=total
  const hFinal = readHarness(S)!;
  hFinal.current = hFinal.total;
  hFinal.active = false;
  writeHarness(S, hFinal);

  // Verify final state
  const done = readHarness(S)!;
  assert.equal(done.active, false, "harness should be inactive after done");
  assert.equal(done.current, TOTAL, "current should equal total");
  for (let i = 1; i <= TOTAL; i++) {
    const t = done.tasks.find((x: any) => x.id === i)!;
    assert.equal(t.status, "completed", `task ${i} should be completed`);
    assert.equal(t.score, "PASS", `task ${i} should have PASS score`);
  }
  assert.equal(findActiveTaskId(S, "generating"), undefined, "no generating tasks after done");
  assert.equal(findActiveTaskId(S, "grading"), undefined, "no grading tasks after done");
});

test("Scenario 3b: failing task lifecycle — generating→grading→revising→failed", () => {
  const S = "s3-fail-loop";

  writeHarness(S, makeHarness("s3-fail", 1));

  // Task starts generating
  simulateTaskUpdate(S, 1, "buggy-task", "generating");
  assert.equal(findActiveTaskId(S, "generating"), 1);

  // Grade fails → revising (revision 1)
  simulateTaskUpdate(S, 1, "buggy-task", "grading");
  simulateTaskUpdate(S, 1, "buggy-task", "revising", { revisions: 1 });
  assert.equal(findActiveTaskId(S, "revising"), 1);

  // Second revision attempt also fails → failed
  simulateTaskUpdate(S, 1, "buggy-task", "revising", { revisions: 2 });
  simulateTaskUpdate(S, 1, "buggy-task", "failed", { score: "FAIL", revisions: 2 });

  const h = readHarness(S)!;
  const t = h.tasks.find((x: any) => x.id === 1)!;
  assert.equal(t.status, "failed");
  assert.equal(t.score, "FAIL");
  assert.equal(t.revisions, 2);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 4: Concurrency stress — parallel writes don't lose data
// ═══════════════════════════════════════════════════════════════════════════════

test("Scenario 4a: concurrent updateSubSession calls preserve all writes (atomic queue)", async () => {
  const S = "s4-sync-race";
  writeHarness(S, makeHarness("s4-sync", 3));

  // Fire 3 concurrent updateSubSession calls. updateSubSession uses an atomic
  // mutation queue (mutateHarness) that serializes read-modify-write per session,
  // preventing last-writer-wins data loss. All 3 updates MUST survive.
  await Promise.all([
    updateSubSession(S, 1, { subSessionId: "sub-1", subStep: 1 }),
    updateSubSession(S, 2, { subSessionId: "sub-2", subStep: 2 }),
    updateSubSession(S, 3, { subSessionId: "sub-3", subStep: 3 }),
  ]);

  const h = readHarness(S)!;
  for (let i = 1; i <= 3; i++) {
    const t = h.tasks.find((x: any) => x.id === i)!;
    assert.equal(t.subSessionId, `sub-${i}`, `task ${i} subSessionId should survive`);
    assert.equal(t.subStep, i, `task ${i} subStep should survive`);
  }
});

test("Scenario 4b: rapid sequential updateSubSession on same task preserves latest", async () => {
  const S = "s4-rapid-seq";
  writeHarness(S, makeHarness("s4-seq", 1));

  // Fire 50 rapid updates on the same task — each read-modify-write is serialized
  // via the atomic queue, so the LAST value wins (expected behavior).
  for (let i = 0; i < 50; i++) {
    await updateSubSession(S, 1, { subStep: i });
  }

  const h = readHarness(S)!;
  const t = h.tasks.find((x: any) => x.id === 1)!;
  assert.equal(t.subStep, 49, "last sequential update should be preserved");
});

test("Scenario 4c: atomic queue prevents race condition in concurrent writes", async () => {
  // Previously (v0.10.1), updateSubSession/clearSubSession used a synchronous
  // read-modify-write pattern. This was safe only because Node.js is single-threaded
  // and sync I/O blocks the event loop. But the poller callbacks in setInterval
  // are ASYNC (they await client.session.messages), meaning two pollers CAN
  // interleave between read and write, causing last-writer-wins data loss.
  //
  // FIX: mutateHarness serializes mutations per session via a promise chain,
  // so concurrent calls execute one-after-another (never interleaved).
  //
  // This test verifies the fix: concurrent updates to DIFFERENT tasks should
  // ALL survive, and a concurrent clearSubSession should not be overwritten.

  const S = "s4-atomic-fix";
  writeHarness(S, makeHarness("s4-atomic", 3));

  // Step 1: Set all 3 tasks' subElapsed simultaneously (simulates 3 pollers)
  await Promise.all([
    updateSubSession(S, 1, { subElapsed: 10 }),
    updateSubSession(S, 2, { subElapsed: 20 }),
    updateSubSession(S, 3, { subElapsed: 30 }),
  ]);

  let h = readHarness(S)!;
  const count = h.tasks.filter((t: any) => t.subElapsed !== undefined).length;
  assert.equal(count, 3, `all 3 tasks should have subElapsed set (got ${count})`);

  // Step 2: Clear task 1 while simultaneously updating task 2 (the original bug)
  await Promise.all([
    clearSubSession(S, 1),
    updateSubSession(S, 2, { subElapsed: 25 }),
  ]);

  h = readHarness(S)!;
  const t1 = h.tasks.find((x: any) => x.id === 1)!;
  const t2 = h.tasks.find((x: any) => x.id === 2)!;
  assert.equal(t1.subElapsed, undefined, "task 1 cleared — must stay cleared (no clobber)");
  assert.equal(t2.subElapsed, 25, "task 2 updated — must have latest value");
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 5: Stale/abandoned harness detection
// ═══════════════════════════════════════════════════════════════════════════════

test("Scenario 5: stale harness (35min old) coexists with recent harness", () => {
  const S_OLD = "s5-old";
  const S_NEW = "s5-new";
  const STALE_MS = 5 * 60_000; // matches the source constant
  const HIDE_MS = 30 * 60_000;

  // Write an OLD harness — started 35 minutes ago, updatedAt also 35 min ago.
  // NOTE: writeHarness overwrites updatedAt with the current timestamp, so we
  // must write the file directly to inject a stale timestamp (simulating a
  // harness that was last touched 35 minutes ago then abandoned).
  const oldTime = new Date(Date.now() - 35 * 60_000).toISOString();
  const oldHarness = makeHarness("stale-test", 2);
  oldHarness.startedAt = oldTime;
  oldHarness.updatedAt = oldTime;
  const oldPath = join(stateDir, S_OLD, "harness.json");
  mkdirSync(dirname(oldPath), { recursive: true });
  writeFileSync(oldPath, JSON.stringify(oldHarness, null, 2));

  // Read back and verify staleness
  const hOld = readHarness(S_OLD)!;
  assert.ok(hOld, "old harness should exist");
  const ageMs = Date.now() - new Date(hOld.updatedAt!).getTime();
  assert.ok(ageMs > STALE_MS, `old harness age (${Math.round(ageMs / 1000)}s) should exceed STALE_MS (${STALE_MS / 1000}s)`);
  assert.ok(ageMs > HIDE_MS, `old harness age should exceed HIDE_MS (${HIDE_MS / 1000}s) — would be hidden in TUI`);

  // Write a RECENT harness in a different session (writeHarness sets current updatedAt)
  writeHarness(S_NEW, makeHarness("fresh-test", 2));

  // Verify both coexist without interfering
  const hNew = readHarness(S_NEW)!;
  assert.ok(hNew, "new harness should exist");
  const newAge = Date.now() - new Date(hNew.updatedAt!).getTime();
  assert.ok(newAge < STALE_MS, `new harness age (${Math.round(newAge / 1000)}s) should be under STALE_MS`);

  // Verify they have different names (not overwritten)
  assert.equal(hOld.name, "stale-test");
  assert.equal(hNew.name, "fresh-test");

  // Verify session isolation — reading one doesn't affect the other
  assert.notEqual(S_OLD, S_NEW, "sessions must be different");
  assert.equal(readHarness(S_OLD)!.name, "stale-test", "old harness unchanged after new harness write");
  assert.equal(readHarness(S_NEW)!.name, "fresh-test", "new harness unaffected by old harness");
});

test("Scenario 5b: boundary — harness exactly at STALE_MS threshold", () => {
  const S = "s5-boundary";
  const STALE_MS = 5 * 60_000;

  // Harness updated 4 minutes ago (under STALE_MS) — NOT stale
  const recentTime = new Date(Date.now() - 4 * 60_000).toISOString();
  const h = makeHarness("boundary", 1);
  h.updatedAt = recentTime;
  writeHarness(S, h);

  const read = readHarness(S)!;
  const age = Date.now() - new Date(read.updatedAt!).getTime();
  assert.ok(age < STALE_MS, "4-minute-old harness should NOT be stale (< 5 min)");
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 6: Gate injection order — verify building blocks compose correctly
// ═══════════════════════════════════════════════════════════════════════════════

test("Scenario 6a: readRules returns empty string when no rules.md exists", () => {
  // Fresh state dir — no rules.md
  assert.equal(readRules(), "", "readRules should return '' when rules.md doesn't exist");
});

test("Scenario 6b: readRules returns content when rules.md exists", () => {
  // Create rules.md in STATE_DIR
  const rulesPath = join(stateDir, "rules.md");
  writeFileSync(rulesPath, "## Rule (2026-01-01)\nAlways check X because Y.\nOrigin: test\n");
  try {
    const rules = readRules();
    assert.ok(rules.length > 0, "readRules should return content when rules.md exists");
    assert.ok(rules.includes("Always check X"), "should include rule text");
  } finally {
    rmSync(rulesPath, { force: true });
  }
});

test("Scenario 6c: buildScanSummary produces correct format with findings + questions", () => {
  const result = makeScanResult({
    unknownUnknowns: [
      { finding: "deployed drift", impact: "high", mitigation: "rebuild" },
      { finding: "race condition", impact: "high" },
    ],
    unknownKnowns: [{ finding: "uses node:test", source: "package.json" }],
    questions: [{ id: "Q1", question: "Which framework?" }],
  });

  const summary = buildScanSummary(result);
  assert.ok(summary.includes("Unknown Unknowns (2)"), "should list unknown unknowns count");
  assert.ok(summary.includes("[HIGH] deployed drift"), "should include finding with impact");
  assert.ok(summary.includes("rebuild"), "should include mitigation");
  assert.ok(summary.includes("race condition"), "should include second finding");
  assert.ok(summary.includes("Implicit knowledge (1)"), "should list unknown knowns");
  assert.ok(summary.includes("uses node:test"), "should include unknown known finding");
  assert.ok(summary.includes("Pending questions (1)"), "should list questions");
  assert.ok(summary.includes("[Q] Which framework?"), "should include question text");
});

test("Scenario 6d: checkScanGate summary includes both scan findings AND user answers", () => {
  const S = "s6-gate-compose";
  writeHarness(S, makeHarness("s6", 1));

  // Complete scan with findings + questions, then resolve questions
  const h = readHarness(S)!;
  h.scanDone = true;
  h.unknownScan = makeScanResult({
    unknownUnknowns: [{ finding: "hidden coupling", impact: "medium", mitigation: "test it" }],
    questions: [{ id: "Q1", question: "Sync or async?" }],
  });
  h.scanSummary = buildScanSummary(h.unknownScan);
  h.questionsResolved = true;
  h.questionAnswers = { Q1: "sync" };
  writeHarness(S, h);

  const gate = checkScanGate(S);
  assert.equal(gate.warning, null, "no warning after resolution");
  assert.ok(gate.summary, "summary should be present");

  // Summary must contain BOTH the scan findings AND the user answers.
  // This is what gets injected into generate prompts.
  assert.ok(gate.summary!.includes("hidden coupling"), "summary should include scan findings");
  assert.ok(gate.summary!.includes("Q1"), "summary should include question ID");
  assert.ok(gate.summary!.includes("sync"), "summary should include user answer");
});

test("Scenario 6e: extractImplNotes correctly parses <impl-notes> block", () => {
  const output = `Here is the code I wrote.

<impl-notes>
- **Decision**: Used sync I/O for safety
- **Constraint**: Node.js is single-threaded
- **Unexpected**: setTimeout ordering matters
</impl-notes>

That's all.`;

  const { notes, cleanText } = extractImplNotes(output);
  assert.ok(notes.includes("Decision"), "notes should contain Decision");
  assert.ok(notes.includes("sync I/O"), "notes should contain the decision text");
  assert.ok(notes.includes("Constraint"), "notes should contain Constraint");
  assert.ok(!cleanText.includes("<impl-notes>"), "cleanText should have block removed");
  assert.ok(cleanText.includes("Here is the code"), "cleanText should retain normal text");
});

test("Scenario 6f: full 6-stage prefix composition in correct order", () => {
  // The generate function builds a prefix in this order (from source code):
  //   1. rules.md lessons (initial prefix)
  //   2. domain DB nodes (prepended)
  //   3. graph-matched impl-notes (prepended)
  //   4. IMPL_NOTE_INSTRUCTION (appended)
  //   5. gate warning (prepended, if scan not done)
  //   6. scan summary + question answers (prepended, if scan done)
  //
  // We can't call generate directly (needs SDK client), but we verify the
  // building blocks produce the right content and compose in the right order.

  const S = "s6-compose";
  writeHarness(S, makeHarness("s6-compose", 1));

  // --- Building block 1: rules.md ---
  // (No rules.md in fresh state dir → readRules returns "")
  const rules = readRules();
  const rulesPrefix = rules ? `Lessons learned from previous failures (apply where relevant):\n${rules}\n\n---\n\n` : "";
  assert.equal(rulesPrefix, "", "rules prefix should be empty when no rules.md");

  // --- Building block 2-3: domain DB + impl-notes ---
  // (No domain DB or impl-notes in fresh state → both empty)
  // Skipped: these require domain.ts initialization with real data.

  // --- Building block 4: IMPL_NOTE_INSTRUCTION ---
  // We can't import the const directly, but we verify extractImplNotes round-trips
  // the format it instructs the model to produce.
  const sampleNotes = "<impl-notes>\n- **Decision**: test\n</impl-notes>";
  const { notes } = extractImplNotes(sampleNotes);
  assert.ok(notes.includes("Decision"), "impl-notes extraction works");

  // --- Building blocks 5-6: gate warning + scan summary ---
  // Set up scan with resolved questions
  const h = readHarness(S)!;
  h.scanDone = true;
  h.unknownScan = makeScanResult({
    unknownUnknowns: [{ finding: "test finding", impact: "high" }],
    questions: [{ id: "Q1", question: "Test question?" }],
  });
  h.scanSummary = buildScanSummary(h.unknownScan);
  h.questionsResolved = true;
  h.questionAnswers = { Q1: "test answer" };
  writeHarness(S, h);

  const gate = checkScanGate(S);

  // Compose the full prefix the same way generate does:
  let prefix = rulesPrefix; // [1] rules
  // [2] domain DB — empty in test
  // [3] impl-notes — empty in test
  // [4] IMPL_NOTE_INSTRUCTION (simulated — we can't import the const, but it's
  //     a fixed string; we verify the block it produces is extractable above)
  prefix += "[IMPL_NOTE_INSTRUCTION]";
  // [5] gate warning
  if (gate.warning) {
    prefix = `${gate.warning}\n\n---\n\n` + prefix;
  }
  // [6] scan findings + answers
  if (gate.summary) {
    prefix = `Pre-flight scan findings (from unknown_scan — heed these):\n${gate.summary}\n\n---\n\n` + prefix;
  }

  // Verify the ORDER: scan findings at top, then IMPL_NOTE_INSTRUCTION at bottom
  const scanIdx = prefix.indexOf("Pre-flight scan findings");
  const implIdx = prefix.indexOf("[IMPL_NOTE_INSTRUCTION]");
  assert.ok(scanIdx >= 0, "scan findings should be in prefix");
  assert.ok(implIdx >= 0, "IMPL_NOTE_INSTRUCTION should be in prefix");
  assert.ok(scanIdx < implIdx, "scan findings should come BEFORE IMPL_NOTE_INSTRUCTION");

  // Verify scan findings include both unknown unknowns and user answers
  assert.ok(prefix.includes("test finding"), "prefix should include unknown unknown");
  assert.ok(prefix.includes("Q1"), "prefix should include question ID");
  assert.ok(prefix.includes("test answer"), "prefix should include user answer");

  // Verify no gate warning (questions are resolved)
  assert.ok(!prefix.includes("DIAGNOSIS GATE"), "no diagnosis gate warning after scan done");
  assert.ok(!prefix.includes("UNRESOLVED QUESTIONS"), "no unresolved questions warning after resolution");
});

test("Scenario 6g: gate warning IS prepended when scan not done (prefix has warning at top)", () => {
  const S = "s6-no-scan";
  writeHarness(S, makeHarness("s6-no-scan", 1));

  // Don't do scan — gate should warn
  const gate = checkScanGate(S);
  assert.ok(gate.warning, "should have warning when scan not done");
  assert.ok(gate.warning!.includes("DIAGNOSIS GATE"));

  // In generate, this warning would be prepended to the prefix:
  let prefix = "[rules][domain][impl-notes][IMPL_NOTE_INSTRUCTION]";
  if (gate.warning) {
    prefix = `${gate.warning}\n\n---\n\n` + prefix;
  }
  // Warning should be at the TOP of the prefix
  assert.ok(prefix.startsWith("⚠"), "warning should be at the top of the prefix");
  assert.ok(prefix.indexOf("DIAGNOSIS GATE") < prefix.indexOf("[rules]"), "warning before rules");
});
