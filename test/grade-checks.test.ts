// grade-checks.test.ts — deterministic verification checks for grade()/grade_batch().
// evalChecks replaces the grader-model round-trip for mechanical tasks:
// every check type, boundary conditions, and the walk-safety rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalChecks, formatCheckReport, type GradeCheck } from "../src/grade-checks.js";

function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), "uc-grade-checks-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root, "src", "app.ts"), "export const A = 1;\nexport const B = 2;\n");
  writeFileSync(join(root, "src", "util.ts"), "// helper\nexport const C = 3;\n");
  writeFileSync(join(root, "README.md"), "hello world\n");
  // must NOT be scanned by directory grep:
  writeFileSync(join(root, "node_modules", "pkg", "x.ts"), "export const A = 999;\n");
  return root;
}

test("file-exists: present vs missing", () => {
  const root = makeTree();
  const r = evalChecks(root, [
    { type: "file-exists", path: "src/app.ts" },
    { type: "file-exists", path: "src/nope.ts" },
  ]);
  assert.equal(r.results[0].pass, true);
  assert.equal(r.results[1].pass, false);
  assert.equal(r.pass, false);
});

test("grep: counts across a directory, skips node_modules", () => {
  const root = makeTree();
  const r = evalChecks(root, [{ type: "grep", pattern: "export const A", minCount: 1 }]);
  assert.equal(r.pass, true, "src/app.ts has 1 match");
  // minCount above the true count (node_modules copy must not inflate it)
  const r2 = evalChecks(root, [{ type: "grep", pattern: "export const A", minCount: 2 }]);
  assert.equal(r2.pass, false, "node_modules match must be skipped");
  // scoped to a single file
  const r3 = evalChecks(root, [{ type: "grep", pattern: "export const", path: "src/app.ts", minCount: 2 }]);
  assert.equal(r3.pass, true);
});

test("grep-absent: zero matches passes, any match fails", () => {
  const root = makeTree();
  const ok = evalChecks(root, [{ type: "grep-absent", pattern: "TODO FIXME", path: "src" }]);
  assert.equal(ok.pass, true);
  const bad = evalChecks(root, [{ type: "grep-absent", pattern: "helper", path: "src" }]);
  assert.equal(bad.pass, false);
  assert.match(bad.results[0].detail, /util\.ts/);
});

test("grep: invalid regex is a FAIL, not a crash", () => {
  const root = makeTree();
  const r = evalChecks(root, [{ type: "grep", pattern: "([unclosed" }]);
  assert.equal(r.pass, false);
  assert.match(r.results[0].detail, /invalid regex/);
});

test("grep: nonexistent path is a FAIL with no-targets detail", () => {
  const root = makeTree();
  const r = evalChecks(root, [{ type: "grep", pattern: "x", path: "does/not/exist" }]);
  assert.equal(r.pass, false);
  assert.match(r.results[0].detail, /no scan targets/);
});

test("line-count: min/max bounds on non-empty lines", () => {
  const root = makeTree();
  const ok = evalChecks(root, [{ type: "line-count", path: "src/app.ts", min: 2, max: 2 }]);
  assert.equal(ok.pass, true);
  const tooFew = evalChecks(root, [{ type: "line-count", path: "src/app.ts", min: 3 }]);
  assert.equal(tooFew.pass, false);
  const missing = evalChecks(root, [{ type: "line-count", path: "src/nope.ts", min: 1 }]);
  assert.equal(missing.pass, false);
});

test("empty checks array does not claim a pass", () => {
  const root = makeTree();
  const r = evalChecks(root, []);
  assert.equal(r.pass, false, "no checks = no verification");
});

test("unknown check type is a FAIL, not a crash", () => {
  const root = makeTree();
  const r = evalChecks(root, [{ type: "bogus" } as unknown as GradeCheck]);
  assert.equal(r.pass, false);
  assert.match(r.results[0].detail, /unknown check type/);
});

test("formatCheckReport: one line per check with PASS/FAIL prefix", () => {
  const root = makeTree();
  const r = evalChecks(root, [
    { type: "file-exists", path: "src/app.ts" },
    { type: "file-exists", path: "src/nope.ts" },
  ]);
  const lines = formatCheckReport(r).split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^PASS \[file-exists\]/);
  assert.match(lines[1], /^FAIL \[file-exists\]/);
});
