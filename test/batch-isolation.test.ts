// batch-isolation.test.ts — tests for generate_batch file-overlap isolation.
// Covers normalizeFilePath (path canonicalization) and resolveBatchLimit
// (overlap-driven concurrency: any file overlap forces sequential execution,
// which wins over THROTTLE; otherwise THROTTLE caps at 2, GO runs all).
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeFilePath, resolveBatchLimit } from "../src/index.js";

// ── normalizeFilePath ────────────────────────────────────────────────────────

test("normalizeFilePath: canonicalizes './Src/Index.TS' to 'src/index.ts'", () => {
  assert.equal(normalizeFilePath("./Src/Index.TS"), "src/index.ts");
});

test("normalizeFilePath: trims surrounding whitespace", () => {
  assert.equal(normalizeFilePath("  src/index.ts  "), "src/index.ts");
});

test("normalizeFilePath: empty input yields empty string", () => {
  assert.equal(normalizeFilePath(""), "");
});

test("normalizeFilePath: strips repeated './' prefixes", () => {
  assert.equal(normalizeFilePath("././a.ts"), "a.ts");
});

test("normalizeFilePath: lowercases and strips './' together", () => {
  assert.equal(normalizeFilePath("./A.ts"), "a.ts");
});

test("normalizeFilePath: whitespace-only input yields empty string", () => {
  assert.equal(normalizeFilePath("   "), "");
});

// BatchTask-shaped helper: { id, prompt, files? } (structural match).
const t = (id: number, files?: string[]) => ({ id, prompt: `task ${id}`, files });

// ── resolveBatchLimit ────────────────────────────────────────────────────────

test("resolveBatchLimit: empty batch returns 0", () => {
  assert.equal(resolveBatchLimit([], "GO"), 0);
  assert.equal(resolveBatchLimit([], "THROTTLE"), 0);
});

test("resolveBatchLimit: file overlap forces limit 1 even on GO", () => {
  const tasks = [t(1, ["a.ts", "b.ts"]), t(2, ["b.ts"])];
  assert.equal(resolveBatchLimit(tasks, "GO"), 1);
});

test("resolveBatchLimit: no overlap + GO runs all tasks in parallel", () => {
  const tasks = [t(1, ["a.ts"]), t(2, ["b.ts"]), t(3, ["c.ts"])];
  assert.equal(resolveBatchLimit(tasks, "GO"), 3);
});

test("resolveBatchLimit: no overlap + THROTTLE caps concurrency at 2", () => {
  const tasks = [t(1, ["a.ts"]), t(2, ["b.ts"]), t(3, ["c.ts"])];
  assert.equal(resolveBatchLimit(tasks, "THROTTLE"), 2);
});

test("resolveBatchLimit: overlap + THROTTLE — overlap (1) wins as the stronger constraint", () => {
  const tasks = [t(1, ["a.ts"]), t(2, ["a.ts"])];
  assert.equal(resolveBatchLimit(tasks, "THROTTLE"), 1);
});

test("resolveBatchLimit: tasks without files never overlap — full parallelism", () => {
  const tasks = [t(1), t(2), t(3)];
  assert.equal(resolveBatchLimit(tasks, "GO"), 3);
  assert.equal(resolveBatchLimit(tasks, "THROTTLE"), 2);
});

test("resolveBatchLimit: mixed files/undefined-files — only real files can overlap", () => {
  const tasks = [t(1, ["a.ts"]), t(2), t(3, ["b.ts"])];
  assert.equal(resolveBatchLimit(tasks, "GO"), 3);
});

test("resolveBatchLimit: './A.ts' and 'a.ts' normalize to the same file → overlap → 1", () => {
  const tasks = [t(1, ["./A.ts"]), t(2, ["a.ts"])];
  assert.equal(resolveBatchLimit(tasks, "GO"), 1);
});

test("resolveBatchLimit: duplicate file within a single task is NOT an overlap", () => {
  // One task listing the same file twice touches only its own work.
  const tasks = [t(1, ["a.ts", "./A.ts"]), t(2, ["b.ts"])];
  assert.equal(resolveBatchLimit(tasks, "GO"), 2);
});

test("resolveBatchLimit: empty-string filenames are ignored (filtered before comparison)", () => {
  const tasks = [t(1, ["  "]), t(2, ["  "])];
  assert.equal(resolveBatchLimit(tasks, "GO"), 2);
});

test("resolveBatchLimit: single task + GO runs alone", () => {
  assert.equal(resolveBatchLimit([t(1, ["a.ts"])], "GO"), 1);
});

test("resolveBatchLimit: single task + THROTTLE returns the cap 2 (slice overshoot is harmless)", () => {
  // THROTTLE returns the fixed cap without a min() against tasks.length;
  // the consumer's chunked loop (i += limit) still executes the single task once.
  assert.equal(resolveBatchLimit([t(1, ["a.ts"])], "THROTTLE"), 2);
});
