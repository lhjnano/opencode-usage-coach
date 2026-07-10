// index-stateful.test.ts — tests for stateful harness functions in src/index.ts.
// Uses node:test + node:assert. STATE_DIR is redirected to an isolated temp dir.
//
// KEY: setStateDir checks process.env.UC_STATE_DIR first; if set, it uses that
// path. So we set UC_STATE_DIR to a temp dir BEFORE calling setStateDir.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import {
  setStateDir, readHarness, writeHarness,
  checkScanGate, updateSubSession, clearSubSession, findActiveTaskId,
} from "../src/index.js";
import type { HarnessJson } from "../src/index.js";

const SESSION = "test-session";

let stateDir: string;

before(() => {
  stateDir = mkdtempSync(join(tmpdir(), "uc-state-"));
  // setStateDir prioritises UC_STATE_DIR, so setting it gives us the temp dir.
  process.env.UC_STATE_DIR = stateDir;
  setStateDir(stateDir);
});

after(() => {
  delete process.env.UC_STATE_DIR;
  try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

function freshHarness(): HarnessJson {
  return {
    name: "test", total: 3, current: 0,
    tasks: [
      { id: 1, title: "task-a", status: "pending" },
      { id: 2, title: "task-b", status: "generating" },
      { id: 3, title: "task-c", status: "completed" },
    ],
    usage: {},
    active: true,
    scanRequired: true,
  };
}

beforeEach(() => {
  writeHarness(SESSION, freshHarness());
});

// ── checkScanGate ────────────────────────────────────────────────────────────

test("checkScanGate: warns when scanRequired but scanDone is false", () => {
  const { warning, summary } = checkScanGate(SESSION);
  assert.ok(warning, "should return a warning when scan is required but not done");
  assert.ok(warning!.includes("DIAGNOSIS GATE"), "warning should mention the diagnosis gate");
  assert.equal(summary, null, "summary should be null when scan not done");
});

test("checkScanGate: passes when scanDone is true and no questions", () => {
  const h = readHarness(SESSION)!;
  h.scanDone = true;
  writeHarness(SESSION, h);

  const { warning, summary } = checkScanGate(SESSION);
  assert.equal(warning, null, "no warning when scan is done and no questions");
  assert.equal(summary, null, "summary should be null when no scanSummary set");
});

test("checkScanGate: warns when scan done but questions unresolved", () => {
  const h = readHarness(SESSION)!;
  h.scanDone = true;
  h.scanSummary = "scan summary text";
  h.unknownScan = {
    scannedAt: new Date().toISOString(),
    codebaseProfile: {
      skipped: true, reason: "test", language: "unknown",
      frameworks: [], structure: [], manifestFiles: [],
      keyDeps: [], configFiles: [], totalFiles: 0,
    },
    knownKnowns: [], knownUnknowns: [], unknownKnowns: [],
    unknownUnknowns: [], questions: [{ id: "Q1", question: "which framework?" }],
    taskRefinements: [], domainHits: 0, domainMisses: 0,
  };
  writeHarness(SESSION, h);

  const { warning, summary } = checkScanGate(SESSION);
  assert.ok(warning, "should warn about unresolved questions");
  assert.ok(warning!.includes("UNRESOLVED QUESTIONS"), "warning should mention unresolved questions");
  assert.equal(summary, "scan summary text", "summary should include scanSummary");
});

test("checkScanGate: passes with answers in summary when questions resolved", () => {
  const h = readHarness(SESSION)!;
  h.scanDone = true;
  h.scanSummary = "scan summary";
  h.unknownScan = {
    scannedAt: new Date().toISOString(),
    codebaseProfile: {
      skipped: true, reason: "test", language: "unknown",
      frameworks: [], structure: [], manifestFiles: [],
      keyDeps: [], configFiles: [], totalFiles: 0,
    },
    knownKnowns: [], knownUnknowns: [], unknownKnowns: [],
    unknownUnknowns: [], questions: [{ id: "Q1", question: "which framework?" }],
    taskRefinements: [], domainHits: 0, domainMisses: 0,
  };
  h.questionsResolved = true;
  h.questionAnswers = { Q1: "vitest" };
  writeHarness(SESSION, h);

  const { warning, summary } = checkScanGate(SESSION);
  assert.equal(warning, null, "no warning when questions resolved");
  assert.ok(summary, "summary should be non-null");
  assert.ok(summary!.includes("vitest"), "summary should include the user's answer");
});

test("checkScanGate: returns null warning + null summary when scanRequired is false", () => {
  const h = readHarness(SESSION)!;
  h.scanRequired = false;
  writeHarness(SESSION, h);

  const { warning, summary } = checkScanGate(SESSION);
  assert.equal(warning, null);
  assert.equal(summary, null);
});

// ── updateSubSession ─────────────────────────────────────────────────────────

test("updateSubSession: updates fields on an existing task", () => {
  updateSubSession(SESSION, 1, { subSessionId: "sub-123", subStep: 5, status: "generating" });
  const h = readHarness(SESSION)!;
  const t = h.tasks.find((x: any) => x.id === 1);
  assert.equal(t.subSessionId, "sub-123");
  assert.equal(t.subStep, 5);
  assert.equal(t.status, "generating");
});

test("updateSubSession: does nothing (no throw) for non-existent session", () => {
  assert.doesNotThrow(() => {
    updateSubSession("nonexistent-session", 1, { subStep: 99 });
  });
});

test("updateSubSession: does nothing (no throw) for non-existent task", () => {
  updateSubSession(SESSION, 999, { subStep: 99 });
  const h = readHarness(SESSION)!;
  // All tasks unchanged.
  const t = h.tasks.find((x: any) => x.id === 1);
  assert.equal(t.subStep, undefined);
});

// ── clearSubSession ──────────────────────────────────────────────────────────

test("clearSubSession: clears sub-session fields on an existing task", () => {
  // First set the fields via updateSubSession.
  updateSubSession(SESSION, 1, {
    subSessionId: "sub-xyz", subStep: 10, lastActivity: "2025-01-01T00:00:00Z", subElapsed: 30,
  });
  // Then clear them.
  clearSubSession(SESSION, 1);

  const h = readHarness(SESSION)!;
  const t = h.tasks.find((x: any) => x.id === 1);
  assert.equal(t.subSessionId, undefined, "subSessionId should be cleared");
  assert.equal(t.subStep, undefined, "subStep should be cleared");
  assert.equal(t.lastActivity, undefined, "lastActivity should be cleared");
  assert.equal(t.subElapsed, undefined, "subElapsed should be cleared");
});

test("clearSubSession: does nothing (no throw) for non-existent session", () => {
  assert.doesNotThrow(() => {
    clearSubSession("nonexistent-session", 1);
  });
});

// ── findActiveTaskId ─────────────────────────────────────────────────────────

test("findActiveTaskId: returns task id for a task with matching status", () => {
  const id = findActiveTaskId(SESSION, "generating");
  assert.equal(id, 2, "task 2 has status 'generating'");
});

test("findActiveTaskId: returns undefined when no task matches the status", () => {
  const id = findActiveTaskId(SESSION, "failed");
  assert.equal(id, undefined);
});

test("findActiveTaskId: returns undefined for non-existent session", () => {
  const id = findActiveTaskId("nonexistent-session", "generating");
  assert.equal(id, undefined);
});

// ── writeHarness / readHarness round-trip ────────────────────────────────────

test("readHarness returns null for non-existent session", () => {
  const h = readHarness("never-written");
  assert.equal(h, null);
});

test("writeHarness creates the harness file on disk", () => {
  writeHarness(SESSION, freshHarness());
  const dir = join(stateDir, SESSION, "harness.json");
  assert.ok(existsSync(dir), "harness.json should exist in the temp state dir");
});
