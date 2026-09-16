// domain-rank.test.ts — v0.15.0 queryDomain ranker (token match + BM25 + priors).
// INTENDED SEMANTIC CHANGE v0.15.0: token match replaces substring — ASCII
// partial-token/prefix hits are gone; Hangul recovers partial matching via
// bigrams ("다크모드" → 다크/크모/모드). Every test isolates state via
// initDomain(<temp dir>) — the live DB is never touched.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import {
  initDomain,
  getSharedDir,
  addDomainNode,
  addDomainEdge,
  readNodes,
  queryDomain,
  queryDomainGraph,
  logDomainInjection,
  tokenize,
} from "../src/domain.js";

let stateDir: string;

before(() => {
  stateDir = mkdtempSync(join(tmpdir(), "uc-domain-rank-"));
  initDomain(stateDir);
  // Rank weights must come from the documented defaults (α=0.3, β=0.2, γ=0.1)
  // for these assertions — strip any env overrides defensively.
  delete process.env.UC_RANK_ALPHA;
  delete process.env.UC_RANK_BETA;
  delete process.env.UC_RANK_GAMMA;
});

after(() => {
  try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

// Per-test isolation helper: fresh dir, restored to the file-level dir after.
function isolated(name: string, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), `uc-rank-${name}-`));
  initDomain(dir);
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    initDomain(stateDir);
  }
}

// ── 1. Tokenizer ─────────────────────────────────────────────────────────────

test("tokenize: Hangul runs become bigrams", () => {
  assert.deepEqual(tokenize("다크모드"), ["다크", "크모", "모드"]);
});

test("tokenize: ASCII words split on non-alphanumerics, len≥2 kept whole", () => {
  assert.deepEqual(tokenize("root --bg 0d1117"), ["root", "bg", "0d1117"]);
});

test("tokenize: single-char ASCII tokens are dropped, single-char Hangul kept as unigram", () => {
  assert.deepEqual(tokenize("a b cd"), ["cd"]);
  assert.deepEqual(tokenize("모"), ["모"]);
});

test("tokenize: lowercase + dedup, mixed ASCII/Hangul runs", () => {
  assert.deepEqual(tokenize("test TEST Latest"), ["test", "latest"]);
  assert.deepEqual(tokenize("dark모드"), ["dark", "모드"]);
  assert.deepEqual(tokenize(""), []);
});

// ── 2. IDF decay: sparse token beats a flooded token ─────────────────────────

test("IDF decay: rare-token node outranks nodes matching the flooded 'test' token", () => {
  isolated("idf", () => {
    // 10 nodes all matching "test" (df high → idf low) + 1 unique "pretendard".
    for (let i = 0; i < 10; i++) {
      addDomainNode({ type: "fact", name: "test", props: {}, source: "", confidence: 0.5 });
    }
    const rare = addDomainNode({ type: "fact", name: "pretendard", props: {}, source: "", confidence: 0.5 });
    // Old substring scoring was per-keyword-count → 1 match each → tie.
    // BM25: idf(pretendard) ≫ idf(test) so the rare-token node must win.
    const { nodes } = queryDomain(["test", "pretendard"], { maxNodes: 20 });
    assert.ok(nodes.length >= 2, "both candidate groups should appear");
    assert.equal(nodes[0]?.id, rare, "rare-token node should rank first");
  });
});

// ── 3. Priors: confidence breaks BM25 ties (α default 0.3) ──────────────────

test("priors: with identical BM25, higher-confidence node ranks first (α=0.3)", () => {
  isolated("priors", () => {
    // Identical names → identical tokens/tf/docLen → identical BM25.
    const high = addDomainNode({ type: "fact", name: "priorscan", props: {}, source: "", confidence: 0.9 });
    const low = addDomainNode({ type: "fact", name: "priorscan", props: {}, source: "", confidence: 0.1 });
    const { nodes } = queryDomain(["priorscan"], { maxNodes: 10 });
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0]?.id, high, "higher confidence should rank first");
    assert.equal(nodes[1]?.id, low);
  });
});

// ── 4. Cache: stat-fingerprint rebuild after addDomainNode ───────────────────

test("cache refresh: a node added after the index is built is immediately queryable", () => {
  isolated("cache-add", () => {
    addDomainNode({ type: "fact", name: "warmer", props: {}, source: "", confidence: 0.5 });
    // Build the index.
    queryDomain(["warmer"]);
    // Append new content — mtime+size fingerprint changes → rebuild on next query.
    const fresh = addDomainNode({ type: "fact", name: "uniquemint", props: { tag: "post-index" }, source: "", confidence: 0.5 });
    const { nodes } = queryDomain(["uniquemint"]);
    assert.ok(nodes.some((n) => n.id === fresh), "new node must be hit right after addDomainNode");
  });
});

test("cache consistency: touch-only rewrite (via query) must not lose nodes", () => {
  isolated("cache-touch", () => {
    for (let i = 0; i < 3; i++) {
      addDomainNode({ type: "fact", name: "syncprobe", props: { i }, source: "", confidence: 0.5 });
    }
    const first = queryDomain(["syncprobe"], { maxNodes: 10 });
    assert.equal(first.nodes.length, 3);
    // First query touched the nodes → project file rewritten (touch-only).
    // Second query must return the same node set via the synced cache.
    const second = queryDomain(["syncprobe"], { maxNodes: 10 });
    assert.deepEqual(second.nodes.map((n) => n.id), first.nodes.map((n) => n.id));
    // Worm actually fired on disk.
    assert.ok(readNodes().every((n) => (n.accessCount ?? 0) >= 1), "touchNodes should have bumped accessCount");
  });
});

// ── 5. API compatibility: caps + queryDomainGraph(maxDepth=0) parity ─────────

test("maxNodes caps matched nodes", () => {
  isolated("cap-nodes", () => {
    for (let i = 0; i < 30; i++) {
      addDomainNode({ type: "fact", name: "capfull", props: {}, source: "", confidence: 0.5 });
    }
    const { nodes } = queryDomain(["capfull"], { maxNodes: 5 });
    assert.equal(nodes.length, 5);
  });
});

test("maxEdges caps returned edges", () => {
  isolated("cap-edges", () => {
    const seed = addDomainNode({ type: "fact", name: "edgeseed", props: {}, source: "", confidence: 0.5 });
    for (let i = 0; i < 12; i++) {
      const n = addDomainNode({ type: "fact", name: `edgnb${i}`, props: {}, source: "", confidence: 0.5 });
      addDomainEdge({ from: seed, to: n, rel: "related-to" });
    }
    const { edges } = queryDomain(["edgeseed"], { maxNodes: 20, maxEdges: 5 });
    assert.equal(edges.length, 5, "all 12 touching edges exist; cap must apply");
  });
});

test("queryDomainGraph maxDepth=0 returns exactly queryDomain's result (parity)", () => {
  isolated("parity", () => {
    const a = addDomainNode({ type: "fact", name: "paritykw", props: {}, source: "", confidence: 0.7 });
    const b = addDomainNode({ type: "fact", name: "parityother", props: {}, source: "", confidence: 0.7 });
    addDomainEdge({ from: a, to: b, rel: "related-to" });
    const qd = queryDomain(["paritykw"], { maxNodes: 10, maxEdges: 60 });
    const qdg = queryDomainGraph(["paritykw"], 0, { maxNodes: 10, maxEdges: 60 });
    assert.deepEqual(qdg.nodes.map((n) => n.id), qd.nodes.map((n) => n.id), "same node order");
    assert.deepEqual(
      qdg.edges.map((e) => `${e.from}>${e.to}:${e.rel}`),
      qd.edges.map((e) => `${e.from}>${e.to}:${e.rel}`),
      "same edge list",
    );
  });
});

// ── 6. Guards: empty query / empty DB → empty result, never NaN ──────────────

test("guards: empty keywords, punctuation-only keywords, and empty DB all return empty results", () => {
  isolated("guards", () => {
    // Empty DB first (N=0) — every division must be guarded.
    const emptyDb = queryDomain(["anything"]);
    assert.deepEqual(emptyDb, { nodes: [], edges: [] });
    // Now with content: zero query tokens must short-circuit.
    addDomainNode({ type: "fact", name: "guarded", props: {}, source: "", confidence: 0.5 });
    assert.deepEqual(queryDomain([]), { nodes: [], edges: [] });
    assert.deepEqual(queryDomain(["   "]), { nodes: [], edges: [] });
    assert.deepEqual(queryDomain(["---", "..."]), { nodes: [], edges: [] });
    // No NaN leaks into results that do come back.
    const ok = queryDomain(["guarded"]);
    for (const n of ok.nodes) {
      assert.ok(!Number.isNaN(n.confidence), "no NaN confidence");
    }
  });
});

// ── 7. Hangul regression: bigram recovers partial matching ───────────────────

test("hangul: query '다크모드' hits a node whose props contain '다크 테마' (bigram 다크)", () => {
  isolated("hangul", () => {
    const id = addDomainNode({
      type: "fact",
      name: "theme-support",
      props: { result: "다크 테마 적용 가이드" },
      source: "",
      confidence: 0.7,
    });
    const { nodes } = queryDomain(["다크모드"]);
    assert.ok(nodes.some((n) => n.id === id), "bigram '다크' must bridge the query and the doc");
  });
});

// ── 8. logDomainInjection: provenance lines (incl. misses) in SHARED_DIR ─────

test("logDomainInjection: appends one JSON line per call, including empty nodeIds", () => {
  isolated("injection-log", () => {
    logDomainInjection(["kw-a", "kw-b"], ["node-1"]);
    logDomainInjection(["miss-q"], []);
    const raw = readFileSync(join(getSharedDir(), "injections.ndjson"), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 2, "exactly one line per call");
    const rec1 = JSON.parse(lines[0] ?? "{}") as { ts?: string; keywords?: string[]; nodeIds?: string[] };
    assert.deepEqual(rec1.keywords, ["kw-a", "kw-b"]);
    assert.deepEqual(rec1.nodeIds, ["node-1"]);
    assert.ok(typeof rec1.ts === "string" && rec1.ts.length > 0);
    const rec2 = JSON.parse(lines[1] ?? "{}") as { nodeIds?: string[] };
    assert.deepEqual(rec2.nodeIds, [], "misses are logged with nodeIds:[] for recall denominators");
  });
});
