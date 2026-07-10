// adversarial.test.ts — exception-path & edge-case tests.
// Targets error handling that would break in production, NOT happy paths.
// If a test reveals a REAL BUG, the test asserts the ACTUAL (buggy) behavior
// and is annotated with "BUG:" so we have a regression test.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import {
  setStateDir, readHarness, writeHarness,
  checkScanGate,
  coach, parseQuotaResponse, providerToCodexbar,
} from "../src/index.js";
import type { Quota, HarnessJson } from "../src/index.js";
import {
  barFill, barEmpty, computeStaleness, isHarnessVisible,
  taskQuotaPct, computeHarnessRender,
  STALE_MS, HIDE_MS,
} from "../src/tui-logic.js";
import type { HarnessState, QuotaState, TaskState } from "../src/tui-logic.js";

// ── State isolation ──────────────────────────────────────────────────────────
const SESSION = "adv-session";
let stateDir: string;

before(() => {
  stateDir = mkdtempSync(join(tmpdir(), "uc-adv-"));
  process.env.UC_STATE_DIR = stateDir;
  setStateDir(stateDir);
});

after(() => {
  delete process.env.UC_STATE_DIR;
  try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function makeQuota(weeklyPct: number, monthlyPct = 0, fiveHourPct = 0): Quota {
  return {
    weekly: { usedPercent: weeklyPct },
    monthly: { usedPercent: monthlyPct },
    fiveHour: { usedPercent: fiveHourPct },
  };
}

function makeHarnessState(overrides: Partial<HarnessState> = {}): HarnessState {
  return {
    name: "test", total: 1, current: 0,
    tasks: [{ id: 1, title: "task", status: "generating" }],
    active: true,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. parseQuotaResponse adversarial tests
// ═══════════════════════════════════════════════════════════════════════════════

test("parseQuotaResponse: empty string → null", () => {
  assert.equal(parseQuotaResponse(""), null);
});

test("parseQuotaResponse: '[]' → null", () => {
  assert.equal(parseQuotaResponse("[]"), null);
});

test("parseQuotaResponse: valid JSON but no 'usage' key → null", () => {
  assert.equal(parseQuotaResponse('[{"foo":"bar"}]'), null);
});

test("parseQuotaResponse: usage present but missing primary/secondary/tertiary → defaults to {usedPercent:0}", () => {
  const result = parseQuotaResponse('[{"usage":{}}]');
  assert.ok(result, "should return a Quota, not null");
  assert.equal(result!.weekly.usedPercent, 0);
  assert.equal(result!.monthly.usedPercent, 0);
  assert.equal(result!.fiveHour.usedPercent, 0);
});

test("parseQuotaResponse: malformed JSON (truncated) → null", () => {
  assert.equal(parseQuotaResponse('[{"usage":'), null);
});

test("parseQuotaResponse: malformed JSON (extra trailing chars) → null", () => {
  assert.equal(parseQuotaResponse('[{"usage":{"primary":{"usedPercent":50}}}] garbage'), null);
});

test("parseQuotaResponse: negative usedPercent → preserved (no clamping)", () => {
  const result = parseQuotaResponse('[{"usage":{"primary":{"usedPercent":-10}}}]');
  assert.ok(result);
  assert.equal(result!.weekly.usedPercent, -10);
});

test("parseQuotaResponse: usedPercent > 100 → preserved (no clamping)", () => {
  const result = parseQuotaResponse('[{"usage":{"primary":{"usedPercent":150}}}]');
  assert.ok(result);
  assert.equal(result!.weekly.usedPercent, 150);
});

test("parseQuotaResponse: non-numeric usedPercent (string '50') → preserved as-is in object", () => {
  // BUG: parseQuotaResponse does not validate usedPercent type — a string "50" passes through.
  // coach() will later coerce via Math.round("50") = 50, but the raw object has a string.
  const result = parseQuotaResponse('[{"usage":{"primary":{"usedPercent":"50"}}}]');
  assert.ok(result);
  // Actual behavior: the string is preserved in the QuotaWindow
  assert.equal(result!.weekly.usedPercent, "50");
});

test("parseQuotaResponse: 1000+ entries in array → only reads [0]", () => {
  const entries = Array.from({ length: 1000 }, (_, i) => ({
    usage: { primary: { usedPercent: i } },
  }));
  const result = parseQuotaResponse(JSON.stringify(entries));
  assert.ok(result);
  assert.equal(result!.weekly.usedPercent, 0, "should read only index 0 (usedPercent: 0)");
});

test("parseQuotaResponse: null input → null (no crash)", () => {
  assert.equal(parseQuotaResponse(null as unknown as string), null);
});

test("parseQuotaResponse: undefined input → null (no crash)", () => {
  assert.equal(parseQuotaResponse(undefined as unknown as string), null);
});

test("parseQuotaResponse: extra whitespace/newlines around valid JSON → parses correctly", () => {
  const raw = '\n  \n [{"usage":{"primary":{"usedPercent":42},"secondary":{"usedPercent":33},"tertiary":{"usedPercent":11}}}]  \n';
  const result = parseQuotaResponse(raw);
  assert.ok(result);
  assert.equal(result!.weekly.usedPercent, 42);
  assert.equal(result!.monthly.usedPercent, 33);
  assert.equal(result!.fiveHour.usedPercent, 11);
});

test("parseQuotaResponse: array with null first element → null", () => {
  assert.equal(parseQuotaResponse('[null]'), null);
});

test("parseQuotaResponse: valid JSON but first element is not an object → null", () => {
  assert.equal(parseQuotaResponse('["string"]'), null);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. coach() adversarial tests
// ═══════════════════════════════════════════════════════════════════════════════

test("coach(null, 'lighter') → GO with weekly -2 (fetch failed sentinel)", () => {
  const c = coach(null, "lighter-model");
  assert.equal(c.decision, "GO");
  assert.equal(c.weekly, -2);
  assert.equal(c.monthly, -2);
  assert.equal(c.fiveHour, -2);
  assert.ok(c.advice.includes("quota unavailable"));
});

test("coach: partial quota (only weekly set, monthly/fiveHour undefined) → uses 0 defaults", () => {
  const q: Quota = {
    weekly: { usedPercent: 50 },
    monthly: undefined as unknown as Quota["monthly"],
    fiveHour: undefined as unknown as Quota["fiveHour"],
  };
  const c = coach(q, "lighter");
  assert.equal(c.decision, "GO");
  assert.equal(c.weekly, 50);
  assert.equal(c.monthly, 0);
  assert.equal(c.fiveHour, 0);
});

test("coach: exact STOP_5H boundary (h5=92) → STOP", () => {
  const c = coach(makeQuota(50, 50, 92), "lighter");
  assert.equal(c.decision, "STOP");
  assert.equal(c.fiveHour, 92);
});

test("coach: exact STOP_WK boundary (wk=95) → STOP", () => {
  // h5 must be below STOP_5H so it doesn't trigger first
  const c = coach(makeQuota(95, 50, 50), "lighter");
  assert.equal(c.decision, "STOP");
  assert.equal(c.weekly, 95);
});

test("coach: exact STOP_MO boundary (mo=98) → STOP", () => {
  const c = coach(makeQuota(50, 98, 50), "lighter");
  assert.equal(c.decision, "STOP");
  assert.equal(c.monthly, 98);
});

test("coach: h5=91 (just below STOP_5H=92) but >= THR_5H=70 → THROTTLE", () => {
  const c = coach(makeQuota(50, 50, 91), "lighter");
  assert.equal(c.decision, "THROTTLE");
});

test("coach: h5=70 (exactly THR_5H=70) → THROTTLE", () => {
  const c = coach(makeQuota(50, 50, 70), "lighter");
  assert.equal(c.decision, "THROTTLE");
});

test("coach: h5=69 (just below THR_5H=70) → GO", () => {
  const c = coach(makeQuota(50, 50, 69), "lighter");
  assert.equal(c.decision, "GO");
});

test("coach: NaN usedPercent → THROTTLE (invalid data guarded)", () => {
  // FIXED: NaN now triggers Number.isFinite guard → THROTTLE with 0 values
  const q: Quota = {
    weekly: { usedPercent: NaN },
    monthly: { usedPercent: NaN },
    fiveHour: { usedPercent: NaN },
  };
  const c = coach(q, "lighter");
  assert.equal(c.decision, "THROTTLE");
  assert.equal(c.weekly, 0);
  assert.equal(c.fiveHour, 0);
});

test("coach: Infinity usedPercent → STOP (Infinity >= threshold is true)", () => {
  const c = coach(makeQuota(50, 50, Infinity), "lighter");
  assert.equal(c.decision, "STOP");
  assert.equal(c.fiveHour, Infinity);
});

test("coach: extremely high h5=999 → STOP", () => {
  const c = coach(makeQuota(50, 50, 999), "lighter");
  assert.equal(c.decision, "STOP");
  assert.equal(c.fiveHour, 999);
});

test("coach: string usedPercent '50' → coerced to 50 via Math.round", () => {
  const q: Quota = {
    weekly: { usedPercent: "50" as unknown as number },
    monthly: { usedPercent: "60" as unknown as number },
    fiveHour: { usedPercent: "70" as unknown as number },
  };
  const c = coach(q, "lighter");
  assert.equal(c.weekly, 50);
  // THR_5H=70, so h5=70 → THROTTLE
  assert.equal(c.decision, "THROTTLE");
});

test("coach: all zeros → GO", () => {
  const c = coach(makeQuota(0, 0, 0), "lighter");
  assert.equal(c.decision, "GO");
  assert.equal(c.weekly, 0);
  assert.equal(c.monthly, 0);
  assert.equal(c.fiveHour, 0);
});

test("coach: h5 STOP takes priority over wk THROTTLE (order matters)", () => {
  // h5=92 (STOP), wk=85 (THR_WK) — STOP should win because h5 is checked first
  const c = coach(makeQuota(85, 50, 92), "lighter");
  assert.equal(c.decision, "STOP");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. providerToCodexbar edge cases
// ═══════════════════════════════════════════════════════════════════════════════

test("providerToCodexbar: empty string → ''", () => {
  assert.equal(providerToCodexbar(""), "");
});

test("providerToCodexbar: multiple dashes 'a-b-c-d' → 'a'", () => {
  assert.equal(providerToCodexbar("a-b-c-d"), "a");
});

test("providerToCodexbar: just dash '-' → '' (fallback to full provider, which is also '-')", () => {
  // FIXED: empty first segment falls back to full provider string
  assert.equal(providerToCodexbar("-"), "-");
});

test("providerToCodexbar: no dash 'openai' → 'openai'", () => {
  assert.equal(providerToCodexbar("openai"), "openai");
});

test("providerToCodexbar: unicode provider name → first segment", () => {
  assert.equal(providerToCodexbar("가나다-abc"), "가나다");
});

test("providerToCodexbar: provider with leading dash '-openai' → full string (fallback)", () => {
  // FIXED: empty first segment falls back to full provider string
  assert.equal(providerToCodexbar("-openai"), "-openai");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. taskQuotaPct loading vs failed states
// ═══════════════════════════════════════════════════════════════════════════════

test("taskQuotaPct: s.fiveHour=-1 (loading) → label '…', pct 0", () => {
  const task: TaskState = { id: 1, title: "t", status: "generating" };
  const s: QuotaState = { decision: "GO", advice: "", weekly: 0, monthly: 0, fiveHour: -1 };
  const { pct, label } = taskQuotaPct(task, s);
  assert.equal(pct, 0);
  assert.equal(label, "\u2026"); // …
});

test("taskQuotaPct: s.fiveHour=-2 (failed) → label 'retry', pct 0", () => {
  const task: TaskState = { id: 1, title: "t", status: "generating" };
  const s: QuotaState = { decision: "GO", advice: "", weekly: 0, monthly: 0, fiveHour: -2 };
  const { pct, label } = taskQuotaPct(task, s);
  assert.equal(pct, 0);
  assert.equal(label, "retry");
});

test("taskQuotaPct: s.fiveHour=-99 (very negative sentinel) → label 'retry', pct 0", () => {
  const task: TaskState = { id: 1, title: "t", status: "generating" };
  const s: QuotaState = { decision: "GO", advice: "", weekly: 0, monthly: 0, fiveHour: -99 };
  const { pct, label } = taskQuotaPct(task, s);
  assert.equal(pct, 0);
  assert.equal(label, "retry");
});

test("taskQuotaPct: provider match — model 'zai-coding-plan/glm-5.1' + provider id 'zai' → uses provider fiveHour", () => {
  const task: TaskState = { id: 1, title: "t", status: "generating", model: "zai-coding-plan/glm-5.1" };
  const s: QuotaState = {
    decision: "GO", advice: "", weekly: 50, monthly: 50, fiveHour: 99,
    providers: [{ id: "zai", name: "ZAI", fiveHour: 42, weekly: 10, fiveHourReset: "", weeklyReset: "", advice: "" }],
  };
  const { pct, label } = taskQuotaPct(task, s);
  assert.equal(pct, 42);
  assert.equal(label, "42%");
});

test("taskQuotaPct: provider mismatch — model 'anthropic/claude' + only 'zai' provider → falls back to s.fiveHour", () => {
  const task: TaskState = { id: 1, title: "t", status: "generating", model: "anthropic/claude" };
  const s: QuotaState = {
    decision: "GO", advice: "", weekly: 50, monthly: 50, fiveHour: 77,
    providers: [{ id: "zai", name: "ZAI", fiveHour: 42, weekly: 10, fiveHourReset: "", weeklyReset: "", advice: "" }],
  };
  const { pct, label } = taskQuotaPct(task, s);
  assert.equal(pct, 77);
  assert.equal(label, "77%");
});

test("taskQuotaPct: no providers array, s.fiveHour=50 → uses 50", () => {
  const task: TaskState = { id: 1, title: "t", status: "generating", model: "zai/glm-5.1" };
  const s: QuotaState = { decision: "GO", advice: "", weekly: 0, monthly: 0, fiveHour: 50 };
  const { pct, label } = taskQuotaPct(task, s);
  assert.equal(pct, 50);
  assert.equal(label, "50%");
});

test("taskQuotaPct: null quota state → label '…' (defaults to -1)", () => {
  const task: TaskState = { id: 1, title: "t", status: "generating" };
  const { pct, label } = taskQuotaPct(task, null);
  assert.equal(pct, 0);
  assert.equal(label, "\u2026"); // …
});

test("taskQuotaPct: task without model, null state → label '…'", () => {
  const task: TaskState = { id: 1, title: "t", status: "generating" };
  const { label } = taskQuotaPct(task, null);
  assert.equal(label, "\u2026");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. checkScanGate adversarial
// ═══════════════════════════════════════════════════════════════════════════════

test("checkScanGate: scanDone=true but unknownScan=null → passes gate (no crash)", () => {
  writeHarness(SESSION, {
    name: "test", total: 1, current: 0,
    tasks: [{ id: 1, title: "t", status: "pending" }],
    scanRequired: true, scanDone: true,
    active: true,
  } as HarnessJson);
  const { warning, summary } = checkScanGate(SESSION);
  assert.equal(warning, null);
  assert.equal(summary, null);
});

test("checkScanGate: questionsResolved=true but questionAnswers=null → passes (no crash)", () => {
  writeHarness(SESSION, {
    name: "test", total: 1, current: 0,
    tasks: [{ id: 1, title: "t", status: "pending" }],
    scanRequired: true, scanDone: true,
    unknownScan: {
      scannedAt: new Date().toISOString(),
      codebaseProfile: { skipped: true, reason: "test", language: "unknown",
        frameworks: [], structure: [], manifestFiles: [], keyDeps: [], configFiles: [], totalFiles: 0 },
      knownKnowns: [], knownUnknowns: [], unknownKnowns: [], unknownUnknowns: [],
      questions: [{ id: "Q1", question: "which?" }],
      taskRefinements: [], domainHits: 0, domainMisses: 0,
    },
    questionsResolved: true,
    // questionAnswers intentionally omitted (undefined)
    active: true,
  } as HarnessJson);
  const { warning, summary } = checkScanGate(SESSION);
  assert.equal(warning, null, "should not warn when questionsResolved=true even without answers");
  // summary should be the scanSummary (no answers appended since questionAnswers is undefined)
  assert.equal(summary, null);
});

test("checkScanGate: unknownScan.questions = [] (empty array) → passes immediately", () => {
  writeHarness(SESSION, {
    name: "test", total: 1, current: 0,
    tasks: [{ id: 1, title: "t", status: "pending" }],
    scanRequired: true, scanDone: true,
    unknownScan: {
      scannedAt: new Date().toISOString(),
      codebaseProfile: { skipped: true, reason: "test", language: "unknown",
        frameworks: [], structure: [], manifestFiles: [], keyDeps: [], configFiles: [], totalFiles: 0 },
      knownKnowns: [], knownUnknowns: [], unknownKnowns: [], unknownUnknowns: [],
      questions: [], // empty, not undefined
      taskRefinements: [], domainHits: 0, domainMisses: 0,
    },
    active: true,
  } as HarnessJson);
  const { warning } = checkScanGate(SESSION);
  assert.equal(warning, null);
});

test("checkScanGate: corrupt harness file (invalid JSON) → returns {null, null} silently", () => {
  // Write invalid JSON directly to the harness file path
  const harnessDir = join(stateDir, SESSION);
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(join(harnessDir, "harness.json"), "{ this is not valid JSON }");
  const { warning, summary } = checkScanGate(SESSION);
  assert.equal(warning, null);
  assert.equal(summary, null);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. computeStaleness edge cases
// ═══════════════════════════════════════════════════════════════════════════════

test("computeStaleness: updatedAt exactly STALE_MS ago → NOT stale (> is exclusive)", () => {
  const now = Date.now();
  const h = makeHarnessState({ updatedAt: new Date(now - STALE_MS).toISOString() });
  const s = computeStaleness(h, now);
  assert.equal(s.isStale, false, "boundary should not be stale (strict >)");
});

test("computeStaleness: updatedAt just over STALE_MS → IS stale", () => {
  const now = Date.now();
  const h = makeHarnessState({ updatedAt: new Date(now - STALE_MS - 1).toISOString() });
  const s = computeStaleness(h, now);
  assert.equal(s.isStale, true);
});

test("computeStaleness: updatedAt exactly HIDE_MS ago → NOT hidden (> is exclusive)", () => {
  const now = Date.now();
  const h = makeHarnessState({ updatedAt: new Date(now - HIDE_MS).toISOString() });
  const s = computeStaleness(h, now);
  assert.equal(s.shouldHide, false, "boundary should not hide (strict >)");
});

test("computeStaleness: updatedAt just over HIDE_MS → IS hidden", () => {
  const now = Date.now();
  const h = makeHarnessState({ updatedAt: new Date(now - HIDE_MS - 1).toISOString() });
  const s = computeStaleness(h, now);
  assert.equal(s.shouldHide, true);
});

test("computeStaleness: updatedAt in the future → not stale, not hidden", () => {
  const now = Date.now();
  const h = makeHarnessState({ updatedAt: new Date(now + 60000).toISOString() });
  const s = computeStaleness(h, now);
  assert.equal(s.isStale, false);
  assert.equal(s.shouldHide, false);
  assert.ok(s.hAge < 0, "hAge should be negative");
});

test("computeStaleness: updatedAt = undefined → hAge 0, not stale, not hidden", () => {
  const h = makeHarnessState({});
  delete (h as Partial<HarnessState>).updatedAt;
  const s = computeStaleness(h);
  assert.equal(s.hAge, 0);
  assert.equal(s.isStale, false);
  assert.equal(s.shouldHide, false);
});

test("computeStaleness: task with subSessionId suppresses stale marking even if updatedAt is very old", () => {
  const now = Date.now();
  const h = makeHarnessState({
    updatedAt: new Date(now - STALE_MS * 10).toISOString(),
    tasks: [{ id: 1, title: "t", status: "generating", subSessionId: "sub-123" }],
  });
  const s = computeStaleness(h, now);
  assert.equal(s.hasActiveSub, true);
  assert.equal(s.isStale, false, "active sub should suppress stale");
  assert.equal(s.shouldHide, false, "active sub should suppress hide");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. isHarnessVisible adversarial
// ═══════════════════════════════════════════════════════════════════════════════

test("isHarnessVisible: active=true but tasks=[] → NOT visible (empty harness hidden)", () => {
  const h: HarnessState = {
    name: "test", total: 0, current: 0, tasks: [], active: true,
    updatedAt: new Date().toISOString(),
  };
  const staleness = computeStaleness(h);
  assert.equal(isHarnessVisible(h, staleness), false);
});

test("isHarnessVisible: active=undefined (not set) → hidden (only active=true is visible)", () => {
  // FIXED: changed from h.active === false to h.active !== true
  // An incompletely initialized harness is now hidden.
  const h: HarnessState = {
    name: "test", total: 1, current: 0,
    tasks: [{ id: 1, title: "t", status: "generating" }],
    updatedAt: new Date().toISOString(),
    // active intentionally undefined
  };
  const staleness = computeStaleness(h);
  assert.equal(isHarnessVisible(h, staleness), false);
});

test("isHarnessVisible: active=true but shouldHide=true → hidden regardless", () => {
  const h = makeHarnessState({
    active: true,
    updatedAt: new Date(Date.now() - HIDE_MS - 1).toISOString(),
  });
  const staleness = computeStaleness(h);
  assert.equal(staleness.shouldHide, true);
  assert.equal(isHarnessVisible(h, staleness), false);
});

test("isHarnessVisible: null harness → false", () => {
  assert.equal(isHarnessVisible(null, { hAge: 0, hasActiveSub: false, isStale: false, shouldHide: false }), false);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Harness state corruption recovery
// ═══════════════════════════════════════════════════════════════════════════════

test("writeHarness with malformed task (missing id) → readHarness still returns the data", () => {
  const h = {
    name: "test", total: 1, current: 0,
    tasks: [{ title: "no-id", status: "pending" }], // missing id
    active: true,
  } as HarnessJson;
  writeHarness(SESSION, h);
  const read = readHarness(SESSION);
  assert.ok(read, "readHarness should not crash");
  assert.equal(read!.tasks[0].title, "no-id");
});

test("writeHarness with tasks=null → readHarness returns object with tasks=null", () => {
  const h = {
    name: "test", total: 0, current: 0,
    tasks: null,
    active: true,
  } as unknown as HarnessJson;
  writeHarness(SESSION, h);
  const read = readHarness(SESSION);
  assert.ok(read, "readHarness should return a parsed object");
  assert.equal(read!.tasks, null);
});

test("Harness.json with invalid JSON → readHarness returns null (not crash)", () => {
  const harnessDir = join(stateDir, SESSION);
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(join(harnessDir, "harness.json"), '{"broken": ');
  const result = readHarness(SESSION);
  assert.equal(result, null);
});

test("Harness.json with empty file → readHarness returns null (not crash)", () => {
  const harnessDir = join(stateDir, "corrupt-session");
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(join(harnessDir, "harness.json"), "");
  const result = readHarness("corrupt-session");
  assert.equal(result, null);
});

test("readHarness for non-existent session → null (not crash)", () => {
  assert.equal(readHarness("never-existed"), null);
});

test("computeHarnessRender with null harness → invisible, no crash", () => {
  const result = computeHarnessRender(null, null);
  assert.equal(result.visible, false);
  assert.equal(result.tasks.length, 0);
  assert.equal(result.header, null);
});

test("computeHarnessRender with null quota state → tasks still render with '…' label", () => {
  const h = makeHarnessState({
    tasks: [{ id: 1, title: "task", status: "generating", model: "zai/glm" }],
  });
  const result = computeHarnessRender(h, null);
  assert.equal(result.visible, true);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].quota.label, "\u2026"); // …
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. barFill / barEmpty adversarial
// ═══════════════════════════════════════════════════════════════════════════════

test("barFill(0) → 0 filled (p<=0 check)", () => {
  assert.equal(barFill(0).length, 0);
});

test("barFill(-1) → 0 filled", () => {
  assert.equal(barFill(-1).length, 0);
});

test("barFill(NaN) → empty string (NaN guarded by Number.isFinite check)", () => {
  // FIXED: NaN now caught by !Number.isFinite(p) guard → treated as 0 → 0 blocks
  assert.equal(barFill(NaN), "");
});

test("barFill(1) → minimum 1 block (not 0)", () => {
  assert.equal(barFill(1).length, 1);
});

test("barFill(100) → exactly 10 blocks", () => {
  assert.equal(barFill(100).length, 10);
});

test("barFill(999) → clamped to 10 blocks", () => {
  assert.equal(barFill(999).length, 10);
});

test("barEmpty + barFill always sum to 10 for valid percentages", () => {
  for (const p of [1, 10, 25, 50, 75, 99, 100]) {
    assert.equal(barFill(p).length + barEmpty(p).length, 10);
  }
});

test("barEmpty(0) → 10 empty (all empty)", () => {
  assert.equal(barEmpty(0).length, 10);
});

test("barEmpty(-5) → 10 empty", () => {
  assert.equal(barEmpty(-5).length, 10);
});
