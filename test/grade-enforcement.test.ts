// grade-enforcement.test.ts — tests for the grade prompt verification protocol.
// The prefix built by buildGradePrompt must force evidence-based verdicts
// (file:line citations, WYSIATI awareness) while preserving the output
// contract the /^pass\b/i and /^fail\b/i verdict parsers rely on
// (first line: exactly PASS or FAIL).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGradePrompt } from "../src/index.js";

test("buildGradePrompt: demands file:line evidence citations", () => {
  const p = buildGradePrompt("grade task 1");
  assert.ok(p.includes("file:line"), "must require file:line citations");
});

test("buildGradePrompt: warns against WYSIATI / missing edge cases", () => {
  const p = buildGradePrompt("grade task 1");
  assert.ok(p.includes("WYSIATI"), "must mention WYSIATI");
  assert.ok(p.includes("missing edge cases"), "must mention missing edge cases");
});

test("buildGradePrompt: locks the first-line PASS/FAIL output contract", () => {
  const p = buildGradePrompt("grade task 1");
  assert.ok(/first line/i.test(p), "must pin the first line");
  assert.ok(/"PASS" or "FAIL"/.test(p), "must name the exact verdict tokens");
});

test("buildGradePrompt: preserves the original userPrompt after the protocol prefix", () => {
  const userPrompt = "Evaluate task 3: implement retry with backoff.";
  const p = buildGradePrompt(userPrompt);
  assert.ok(p.includes(userPrompt), "user prompt must appear verbatim");
  assert.ok(p.endsWith(userPrompt), "user prompt must be the tail of the wrapped prompt");
  assert.ok(p.indexOf(userPrompt) > 0, "user prompt must come after the protocol prefix");
});

test("buildGradePrompt: empty-string input does not crash and still carries the protocol", () => {
  const p = buildGradePrompt("");
  assert.equal(typeof p, "string");
  assert.ok(p.includes("file:line"), "protocol present even with an empty body");
  assert.ok(p.trim().length > 0, "wrapped prompt is non-empty");
});
