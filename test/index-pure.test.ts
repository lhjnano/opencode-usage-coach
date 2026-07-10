// index-pure.test.ts — tests for additional pure functions in src/index.ts.
// Uses node:test + node:assert/strict (same style as index.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGapPrompt,
  formatReport,
  isFreeModel,
  providerToCodexbar,
  isHarnessAgent,
  humanRemaining,
} from "../src/index.js";
import type { CodebaseProfile, UnknownScanResult } from "../src/index.js";

// ── Helpers ──────────────────────────────────────────────────────────────────
const emptyProfile: CodebaseProfile = {
  skipped: false, language: "unknown", frameworks: [], structure: [],
  manifestFiles: [], keyDeps: [], configFiles: [], totalFiles: 0,
};

const skippedProfile: CodebaseProfile = {
  skipped: true, reason: "directory nearly empty", language: "unknown",
  frameworks: [], structure: [], manifestFiles: [], keyDeps: [],
  configFiles: [], totalFiles: 0,
};

// ── buildGapPrompt ───────────────────────────────────────────────────────────
test("buildGapPrompt: returns a string containing user request and task titles", () => {
  const prompt = buildGapPrompt(
    "Add a login page",
    [{ id: 1, title: "Create login form" }, { id: 2, title: "Add auth middleware" }],
    emptyProfile,
    [],
  );
  assert.equal(typeof prompt, "string");
  assert.ok(prompt.includes("Add a login page"), "should contain user request");
  assert.ok(prompt.includes("1: Create login form"), "should contain task 1 title");
  assert.ok(prompt.includes("2: Add auth middleware"), "should contain task 2 title");
});

test("buildGapPrompt: works with empty domainNodes", () => {
  const prompt = buildGapPrompt("Do something", [{ id: 1, title: "Task A" }], emptyProfile, []);
  assert.ok(prompt.includes("no prior knowledge stored"), "should mention empty domain DB");
});

test("buildGapPrompt: works with skipped profile", () => {
  const prompt = buildGapPrompt("Do something", [{ id: 1, title: "Task A" }], skippedProfile, []);
  assert.ok(prompt.includes("skipped"), "should mention profile was skipped");
  assert.ok(prompt.includes(skippedProfile.reason!), "should include the skip reason");
});

// ── formatReport ─────────────────────────────────────────────────────────────
test("formatReport: formats a complete result with all sections", () => {
  const result: UnknownScanResult = {
    scannedAt: new Date("2026-01-15T10:00:00Z").toISOString(),
    codebaseProfile: {
      skipped: false, language: "TypeScript", frameworks: ["express"],
      testPattern: "*.test.ts", testFramework: "node:test",
      structure: [{ dir: "src", fileCount: 5 }, { dir: "test", fileCount: 2 }],
      manifestFiles: ["package.json"], keyDeps: ["express", "tsx"],
      configFiles: ["tsconfig.json"], totalFiles: 8,
    },
    knownKnowns: [{ taskId: 1, title: "setup", note: "needs config file" }],
    knownUnknowns: [{ taskId: 1, gap: "format unclear", suggestion: "use JSON" }],
    unknownKnowns: [{ finding: "uses vitest", source: "package.json" }],
    unknownUnknowns: [{ finding: "env vars at import", impact: "high", mitigation: "set before import" }],
    questions: [{ id: "Q1", question: "Which framework?" }],
    taskRefinements: [{ taskId: 1, action: "split", detail: "separate concerns" }],
    domainHits: 3, domainMisses: 2,
  };
  const report = formatReport(result);
  assert.ok(report.includes("Unknown Scan Report"), "should have title");
  assert.ok(report.includes("TypeScript"), "should include language");
  assert.ok(report.includes("express"), "should include framework");
  assert.ok(report.includes("Known Knowns (1)"), "should include known knowns section");
  assert.ok(report.includes("needs config file"), "should include known known note");
  assert.ok(report.includes("Known Unknowns (1)"), "should include known unknowns section");
  assert.ok(report.includes("Unknown Knowns (1)"), "should include unknown knowns section");
  assert.ok(report.includes("Unknown Unknowns (1)"), "should include unknown unknowns section");
  assert.ok(report.includes("Questions for the user (1)"), "should include questions section");
  assert.ok(report.includes("Task Refinement Suggestions"), "should include task refinements");
  assert.ok(report.includes("[usage-coach NEXT]"), "should include usage-coach NEXT directive");
});

test("formatReport: handles skipped profile gracefully", () => {
  const result: UnknownScanResult = {
    scannedAt: new Date().toISOString(),
    codebaseProfile: skippedProfile,
    knownKnowns: [], knownUnknowns: [], unknownKnowns: [], unknownUnknowns: [],
    questions: [], taskRefinements: [], domainHits: 0, domainMisses: 0,
  };
  const report = formatReport(result);
  assert.ok(report.includes("SKIPPED"), "should show SKIPPED for profile");
  assert.ok(report.includes(skippedProfile.reason!), "should include the skip reason");
});

test("formatReport: handles empty arrays without crashing", () => {
  const result: UnknownScanResult = {
    scannedAt: new Date().toISOString(),
    codebaseProfile: emptyProfile,
    knownKnowns: [], knownUnknowns: [], unknownKnowns: [], unknownUnknowns: [],
    questions: [], taskRefinements: [], domainHits: 0, domainMisses: 0,
  };
  const report = formatReport(result);
  assert.ok(report.includes("[usage-coach NEXT]"), "should still include NEXT directive");
  assert.ok(!report.includes("Known Knowns ("), "should not render empty known knowns section");
  assert.ok(!report.includes("Unknown Unknowns ("), "should not render empty unknown unknowns section");
});

// ── isFreeModel ──────────────────────────────────────────────────────────────
test("isFreeModel: returns true for provider 'opencode'", () => {
  assert.equal(isFreeModel("anything", "opencode"), true);
});

test("isFreeModel: returns true for model containing 'free' (case-insensitive)", () => {
  assert.equal(isFreeModel("gpt-4-free", "openai"), true);
  assert.equal(isFreeModel("FREE-tier-model", "anthropic"), true);
});

test("isFreeModel: returns false for paid model like 'gpt-4'", () => {
  assert.equal(isFreeModel("gpt-4", "openai"), false);
});

test("isFreeModel: returns false for empty model and provider", () => {
  assert.equal(isFreeModel("", ""), false);
});

// ── providerToCodexbar ───────────────────────────────────────────────────────
test("providerToCodexbar: maps 'zai-coding-plan' to 'zai'", () => {
  assert.equal(providerToCodexbar("zai-coding-plan"), "zai");
});

test("providerToCodexbar: maps 'openai' to 'openai' (no dash)", () => {
  assert.equal(providerToCodexbar("openai"), "openai");
});

test("providerToCodexbar: returns '' for '' input", () => {
  assert.equal(providerToCodexbar(""), "");
});

test("providerToCodexbar: maps 'anthropic-claude' to 'anthropic'", () => {
  assert.equal(providerToCodexbar("anthropic-claude"), "anthropic");
});

// ── isHarnessAgent ───────────────────────────────────────────────────────────
test("isHarnessAgent: returns true for 'usage-coach-harness' (default HARNESS_AGENTS)", () => {
  assert.equal(isHarnessAgent("usage-coach-harness"), true);
});

test("isHarnessAgent: returns false for 'build'", () => {
  assert.equal(isHarnessAgent("build"), false);
});

test("isHarnessAgent: returns false for empty string", () => {
  assert.equal(isHarnessAgent(""), false);
});

// ── humanRemaining ───────────────────────────────────────────────────────────
test("humanRemaining: returns '' for undefined", () => {
  assert.equal(humanRemaining(undefined), "");
});

test("humanRemaining: returns '' for invalid date string", () => {
  assert.equal(humanRemaining("not-a-date"), "");
});

test("humanRemaining: returns 'resets soon' for past date", () => {
  const past = new Date(Date.now() - 60000).toISOString();
  assert.equal(humanRemaining(past), "resets soon");
});

test("humanRemaining: returns 'resets in Xm' for under 60 minutes", () => {
  const mins = 30;
  const iso = new Date(Date.now() + mins * 60000).toISOString();
  const result = humanRemaining(iso);
  assert.ok(result.startsWith("resets in "), `expected 'resets in Xm', got: ${result}`);
  assert.ok(result.endsWith("m"), `expected format ending in 'm', got: ${result}`);
  assert.ok(!result.includes("h"), `should not contain hours, got: ${result}`);
});

test("humanRemaining: returns 'resets in Xh Ym' for under 1 day", () => {
  const mins = 180; // 3 hours
  const iso = new Date(Date.now() + mins * 60000).toISOString();
  const result = humanRemaining(iso);
  assert.ok(result.includes("h "), `expected 'resets in Xh Ym', got: ${result}`);
  assert.ok(result.includes("m"), `expected 'resets in Xh Ym', got: ${result}`);
  assert.ok(result.startsWith("resets in "), `expected 'resets in...', got: ${result}`);
});

test("humanRemaining: returns 'Xd left' for over 1 day", () => {
  const mins = 1440 * 3; // 3 days
  const iso = new Date(Date.now() + mins * 60000).toISOString();
  const result = humanRemaining(iso);
  assert.ok(result.includes("d left"), `expected 'Xd left', got: ${result}`);
  assert.ok(!result.includes("resets in"), `should not say 'resets in' for days, got: ${result}`);
});
