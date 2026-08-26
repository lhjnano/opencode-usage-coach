// query-cap.test.ts — regression tests for the domain-DB prompt-flooding fix:
//   1. extractKeywords strips slash-paths (the "100% hit rate / 600KB injection" bug)
//   2. queryDomain caps returned nodes (maxNodes) ranked by keyword-match score
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { extractKeywords, setStateDir } from "../src/index.js";
import { initDomain, addDomainNode, queryDomain } from "../src/domain.js";

let stateDir: string;

before(() => {
  stateDir = mkdtempSync(join(tmpdir(), "uc-query-cap-"));
  setStateDir(stateDir);
  initDomain(join(stateDir, "domain"));
});

after(() => {
  try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* */ }
});

// ── extractKeywords: path stripping ──────────────────────────────────────────

test("extractKeywords: strips slash-paths from working-directory lines", () => {
  const kw = extractKeywords("Task: implement hono routes. Working directory: /home/lhjnano/services/career-studio");
  const names = kw.join(",");
  assert.ok(!kw.includes("home"), `should NOT include 'home' (path fragment), got: ${names}`);
  assert.ok(!kw.includes("lhjnano"), `should NOT include 'lhjnano' (path fragment), got: ${names}`);
  assert.ok(kw.includes("hono") || kw.includes("routes"), "should keep real task keywords");
});

test("extractKeywords: strips relative paths like ./src/lib/foo.ts", () => {
  const kw = extractKeywords("Fix the bug in ./src/lib/crawl.ts and write tests");
  assert.ok(!kw.includes("src"), "should not include 'src' from path");
  assert.ok(!kw.includes("lib"), "should not include 'lib' from path");
  assert.ok(kw.includes("bug") || kw.includes("tests"), "should keep real keywords");
});

test("extractKeywords: plain text without paths is unaffected", () => {
  const kw = extractKeywords("implement oauth callback handler");
  assert.ok(kw.includes("oauth"));
  assert.ok(kw.includes("callback"));
  assert.ok(kw.includes("handler"));
});

// ── queryDomain: maxNodes cap + relevance ranking ────────────────────────────

test("queryDomain: caps results at maxNodes", () => {
  const dir = mkdtempSync(join(tmpdir(), "uc-cap-"));
  initDomain(dir);
  try {
    // 30 nodes all matching 'alpha'
    for (let i = 0; i < 30; i++) {
      addDomainNode({ type: "fact", name: `alpha node ${i}`, props: {}, source: "", confidence: 0.7 });
    }
    const { nodes } = queryDomain(["alpha"], { maxNodes: 5 });
    assert.equal(nodes.length, 5, "cap should limit to 5 of 30 matches");
    // default cap is 20
    const def = queryDomain(["alpha"]);
    assert.ok(def.nodes.length <= 20, `default cap should be <= 20, got ${def.nodes.length}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    initDomain(join(stateDir, "domain"));
  }
});

test("queryDomain: ranks by distinct keyword match count (multi-keyword hits first)", () => {
  const dir = mkdtempSync(join(tmpdir(), "uc-rank-"));
  initDomain(dir);
  try {
    // One node matching BOTH keywords, many matching only one.
    addDomainNode({ type: "fact", name: "alpha beta both", props: {}, source: "", confidence: 0.7 });
    for (let i = 0; i < 10; i++) {
      addDomainNode({ type: "fact", name: `alpha only ${i}`, props: {}, source: "", confidence: 0.7 });
    }
    const { nodes } = queryDomain(["alpha", "beta"], { maxNodes: 3 });
    assert.equal(nodes[0].name, "alpha beta both",
      "the node matching BOTH keywords must rank first");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    initDomain(join(stateDir, "domain"));
  }
});
