// index.test.ts — tests for pure/no-I-O functions in src/index.ts.
// Uses node:test + node:assert/strict (same style as domain.test.ts).
//
// NOTE: coach() and providerAdvice() read module-level threshold constants
// (STOP_5H=92, THR_5H=70, STOP_WK=95, THR_WK=85, STOP_MO=98) set from env
// vars at import time. The test env does not set these, so defaults apply.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  coach,
  parseFileList,
  extractKeywords,
  extractImplNotes,
  detectLanguage,
  buildScanSummary,
  parseGapAnalysis,
  providerAdvice,
} from "../src/index.js";

// ── Helpers ──────────────────────────────────────────────────────────────────
const makeQuota = (weekly: number, monthly: number, fiveHour: number) => ({
  weekly: { usedPercent: weekly },
  monthly: { usedPercent: monthly },
  fiveHour: { usedPercent: fiveHour },
});

const emptyProfile = {
  skipped: false,
  language: "unknown",
  frameworks: [],
  structure: [],
  manifestFiles: [],
  keyDeps: [],
  configFiles: [],
  totalFiles: 0,
} as const;

// ── extractKeywords ──────────────────────────────────────────────────────────
test("extractKeywords: extracts meaningful tokens from text", () => {
  const kw = extractKeywords("Write a parser for the config file");
  assert.ok(kw.includes("write"), "should include 'write'");
  assert.ok(kw.includes("parser"), "should include 'parser'");
  assert.ok(kw.includes("config"), "should include 'config'");
  assert.ok(!kw.includes("the"), "should exclude stop word 'the'");
  assert.ok(!kw.includes("for"), "should exclude stop word 'for'");
});

test("extractKeywords: filters short tokens and stop words", () => {
  const kw = extractKeywords("the and for with that this from into your you");
  assert.equal(kw.length, 0, "all tokens are stop words or too short");
});

test("extractKeywords: returns empty array for null/undefined/empty input", () => {
  assert.deepEqual(extractKeywords(null as unknown as string), []);
  assert.deepEqual(extractKeywords(undefined as unknown as string), []);
  assert.deepEqual(extractKeywords(""), []);
});

test("extractKeywords: preserves numbers and underscores, deduplicates", () => {
  const kw = extractKeywords("test_123 hello_world test_123 foo");
  assert.ok(kw.includes("test_123"));
  assert.ok(kw.includes("hello_world"));
  // Deduplicated: test_123 appears twice in input but once in output.
  assert.equal(kw.filter((k) => k === "test_123").length, 1);
});

// ── extractImplNotes ─────────────────────────────────────────────────────────
test("extractImplNotes: extracts the impl-notes block and returns clean text", () => {
  const output = [
    "Here is the result of my work.",
    "",
    "<impl-notes>",
    "- **Decision**: Used option A because of X",
    "- **Constraint**: Y is limited",
    "</impl-notes>",
  ].join("\n");
  const { notes, cleanText } = extractImplNotes(output);
  assert.ok(notes.includes("**Decision**: Used option A"), "notes should contain the bullet content");
  assert.ok(!cleanText.includes("<impl-notes>"), "cleanText should not contain the block");
  assert.ok(cleanText.includes("Here is the result"), "cleanText should preserve surrounding text");
});

test("extractImplNotes: returns empty notes and unchanged text when no block present", () => {
  const output = "Just regular output with no notes block.";
  const { notes, cleanText } = extractImplNotes(output);
  assert.equal(notes, "");
  assert.equal(cleanText, output);
});

test("extractImplNotes: handles empty string", () => {
  const { notes, cleanText } = extractImplNotes("");
  assert.equal(notes, "");
  assert.equal(cleanText, "");
});

// ── detectLanguage ───────────────────────────────────────────────────────────
test("detectLanguage: detects TypeScript when .ts/.tsx dominate", () => {
  assert.equal(detectLanguage({ ts: 5, tsx: 2, js: 1 }), "TypeScript");
});

test("detectLanguage: detects JavaScript when no TypeScript present", () => {
  assert.equal(detectLanguage({ js: 3, jsx: 2 }), "JavaScript");
});

test("detectLanguage: detects Python and Go from their extensions", () => {
  assert.equal(detectLanguage({ py: 10 }), "Python");
  assert.equal(detectLanguage({ go: 7 }), "Go");
});

test("detectLanguage: returns 'unknown' for empty or unrecognized extensions", () => {
  assert.equal(detectLanguage({}), "unknown");
  assert.equal(detectLanguage({ md: 3, txt: 2 }), "unknown");
});

// ── coach ────────────────────────────────────────────────────────────────────
test("coach: returns GO with -2 values for null quota (fetch failed)", () => {
  const c = coach(null, "lighter-model");
  assert.equal(c.decision, "GO");
  assert.equal(c.weekly, -2);
  assert.equal(c.monthly, -2);
  assert.equal(c.fiveHour, -2);
});

test("coach: returns GO for comfortable usage levels", () => {
  const c = coach(makeQuota(30, 20, 40), "lighter-model");
  assert.equal(c.decision, "GO");
  assert.equal(c.weekly, 30);
  assert.equal(c.fiveHour, 40);
});

test("coach: returns STOP when 5h window exceeds threshold (92%)", () => {
  const c = coach(makeQuota(50, 30, 95), "lighter-model");
  assert.equal(c.decision, "STOP");
  assert.ok(c.advice.includes("STOP"), "advice should contain STOP");
});

test("coach: returns STOP when weekly exceeds threshold (95%)", () => {
  const c = coach(makeQuota(96, 50, 30), "lighter-model");
  assert.equal(c.decision, "STOP");
});

test("coach: returns THROTTLE when 5h is high but below STOP", () => {
  const c = coach(makeQuota(50, 30, 75), "lighter-model");
  assert.equal(c.decision, "THROTTLE");
  assert.ok(c.advice.includes("Throttle"), "advice should contain Throttle");
  assert.ok(c.advice.includes("lighter-model"), "advice should mention the lighter model");
});

test("coach: returns THROTTLE when weekly is high but below STOP", () => {
  const c = coach(makeQuota(88, 50, 30), "lighter-model");
  assert.equal(c.decision, "THROTTLE");
});

// ── providerAdvice ───────────────────────────────────────────────────────────
test("providerAdvice: recommends STOP when either limit nearly exhausted", () => {
  assert.equal(providerAdvice(95, 96), "STOP — finish current only");
  assert.equal(providerAdvice(93, 50), "STOP — finish current only");
});

test("providerAdvice: recommends small tasks when 5h throttled", () => {
  const advice = providerAdvice(75, 50);
  assert.ok(advice.startsWith("small tasks only"), `expected small-tasks advice, got: ${advice}`);
  assert.ok(advice.includes("5h"), "should mention the 5h window");
});

test("providerAdvice: recommends moderate tasks at ~50% usage", () => {
  const advice = providerAdvice(55, 50);
  assert.ok(advice.startsWith("moderate tasks OK"), `expected moderate advice, got: ${advice}`);
});

test("providerAdvice: recommends big tasks when usage is low", () => {
  const advice = providerAdvice(20, 30);
  assert.ok(advice.startsWith("big tasks OK"), `expected big-tasks advice, got: ${advice}`);
});

// ── parseGapAnalysis ─────────────────────────────────────────────────────────
test("parseGapAnalysis: parses valid JSON model output into structured result", () => {
  const raw = JSON.stringify({
    knownKnowns: [{ taskId: 1, title: "setup", note: "config file needed" }],
    knownUnknowns: [{ taskId: 1, gap: "unclear format", suggestion: "use JSON" }],
    unknownKnowns: [{ finding: "uses vitest", source: "package.json" }],
    unknownUnknowns: [{ finding: "env vars", impact: "high", mitigation: "document them" }],
    questions: [{ id: "Q1", question: "Which framework?" }],
    taskRefinements: [{ taskId: 1, action: "split", detail: "separate config" }],
  });
  const result = parseGapAnalysis(raw, emptyProfile, 2);
  assert.equal(result.knownKnowns.length, 1);
  assert.equal(result.knownKnowns[0].note, "config file needed");
  assert.equal(result.unknownUnknowns.length, 1);
  assert.equal(result.unknownUnknowns[0].impact, "high");
  assert.equal(result.questions.length, 1);
  assert.equal(result.domainHits, 2);
  assert.equal(result.domainMisses, 2, "unknownKnowns + unknownUnknowns = 2 misses");
});

test("parseGapAnalysis: returns base result for error/timeout strings", () => {
  const result = parseGapAnalysis("ERROR: model unavailable", emptyProfile, 0);
  assert.equal(result.knownKnowns.length, 0);
  assert.equal(result.unknownUnknowns.length, 0);
  assert.equal(result.rawAnalysis, "ERROR: model unavailable");
});

test("parseGapAnalysis: preserves raw text as finding on JSON parse failure", () => {
  const result = parseGapAnalysis("This is not JSON at all", emptyProfile, 0);
  assert.equal(result.unknownUnknowns.length, 1, "should create one unstructured finding");
  assert.ok(result.unknownUnknowns[0].finding.includes("This is not JSON"));
  assert.equal(result.domainMisses, 1);
});

test("parseGapAnalysis: handles markdown-fenced JSON", () => {
  const raw = "```json\n" + JSON.stringify({
    unknownUnknowns: [{ finding: "hidden coupling", impact: "medium" }],
  }) + "\n```";
  const result = parseGapAnalysis(raw, emptyProfile, 0);
  assert.equal(result.unknownUnknowns.length, 1);
  assert.equal(result.unknownUnknowns[0].finding, "hidden coupling");
});

// ── buildScanSummary ─────────────────────────────────────────────────────────
test("buildScanSummary: formats unknown unknowns and questions into readable text", () => {
  const result = {
    scannedAt: new Date().toISOString(),
    codebaseProfile: { ...emptyProfile },
    knownKnowns: [],
    knownUnknowns: [],
    unknownKnowns: [{ finding: "uses ESLint", source: "package.json" }],
    unknownUnknowns: [
      { finding: "env vars read at import", impact: "high", mitigation: "set before import" },
    ],
    questions: [{ id: "Q1", question: "Which test runner?" }],
    taskRefinements: [],
    domainHits: 0,
    domainMisses: 1,
  };
  const summary = buildScanSummary(result);
  assert.ok(summary.includes("Unknown Unknowns (1)"), "should include unknown unknowns header");
  assert.ok(summary.includes("[HIGH] env vars read at import"), "should include the finding");
  assert.ok(summary.includes("Implicit knowledge (1)"), "should include implicit knowledge header");
  assert.ok(summary.includes("Pending questions (1)"), "should include questions header");
  assert.ok(summary.includes("Which test runner?"), "should include question text");
});

test("buildScanSummary: returns empty string when no actionable findings", () => {
  const result = {
    scannedAt: new Date().toISOString(),
    codebaseProfile: { ...emptyProfile },
    knownKnowns: [],
    knownUnknowns: [],
    unknownKnowns: [],
    unknownUnknowns: [],
    questions: [],
    taskRefinements: [],
    domainHits: 0,
    domainMisses: 0,
  };
  assert.equal(buildScanSummary(result), "");
});

// ── parseFileList ────────────────────────────────────────────────────────────
test("parseFileList: returns skipped profile for empty input", () => {
  const profile = parseFileList("", "/nonexistent");
  assert.equal(profile.skipped, true);
  assert.equal(profile.totalFiles, 0);
});

test("parseFileList: detects language, deps, test pattern from real files", () => {
  const dir = mkdtempSync(join(tmpdir(), "uc-parse-"));
  try {
    // Create a realistic mini-project.
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "test"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      dependencies: { express: "^4" },
      devDependencies: { vitest: "^1", typescript: "^5" },
    }));
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    writeFileSync(join(dir, "src", "index.ts"), "export default 1;");
    writeFileSync(join(dir, "src", "utils.ts"), "export const x = 1;");
    writeFileSync(join(dir, "test", "app.test.ts"), "test('ok', () => {});");

    const rawList = [
      `${dir}/package.json`,
      `${dir}/tsconfig.json`,
      `${dir}/src/index.ts`,
      `${dir}/src/utils.ts`,
      `${dir}/test/app.test.ts`,
    ].join("\n");

    const profile = parseFileList(rawList, dir);
    assert.equal(profile.skipped, false, "should not skip for valid file list");
    assert.equal(profile.language, "TypeScript", "should detect TypeScript from .ts files");
    assert.ok(profile.frameworks.includes("express"), "should detect express framework");
    assert.equal(profile.testFramework, "vitest", "should detect vitest");
    assert.ok(profile.manifestFiles.includes("package.json"), "should find package.json manifest");
    assert.ok(profile.keyDeps.includes("express"), "should parse express dep");
    assert.ok(profile.keyDeps.includes("vitest"), "should parse vitest devDep");
    assert.ok(profile.configFiles.some((f) => f.includes("tsconfig")), "should find tsconfig.json");
    assert.equal(profile.totalFiles, 5);
    // Structure: src/ has 2 files, test/ has 1.
    const srcDir = profile.structure.find((s) => s.dir === "src");
    assert.ok(srcDir, "structure should include src/");
    assert.equal(srcDir.fileCount, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
