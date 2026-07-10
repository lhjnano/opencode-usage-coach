// domain-extra.test.ts — tests for uncovered domain.ts functions:
//   writeEdges, traverseNeighborhood, queryDomainGraph, touchNodes (direct).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import {
  initDomain,
  addDomainNode,
  addDomainEdge,
  readEdges,
  readNodes,
  writeEdges,
  queryDomain,
  queryDomainGraph,
  traverseNeighborhood,
  touchNodes,
} from "../src/domain.js";
import type { DomainEdge } from "../src/domain.js";

let stateDir: string;

before(() => {
  stateDir = mkdtempSync(join(tmpdir(), "uc-domain-extra-"));
  initDomain(stateDir);
});

after(() => {
  try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* */ }
});

// ── writeEdges (batch append) ────────────────────────────────────────────────

test("writeEdges: appends multiple edges in a single batch", () => {
  const a = addDomainNode({ type: "fact", name: "batch-a", props: {}, source: "", confidence: 0.7 });
  const b = addDomainNode({ type: "fact", name: "batch-b", props: {}, source: "", confidence: 0.7 });
  const c = addDomainNode({ type: "fact", name: "batch-c", props: {}, source: "", confidence: 0.7 });

  const edges: DomainEdge[] = [
    { from: a, to: b, rel: "depends-on", ts: "2025-01-01T00:00:00Z" },
    { from: b, to: c, rel: "part-of", ts: "2025-01-01T00:00:01Z" },
  ];
  writeEdges(edges);

  const all = readEdges();
  assert.ok(all.some((e) => e.from === a && e.to === b && e.rel === "depends-on"), "edge a->b should exist");
  assert.ok(all.some((e) => e.from === b && e.to === c && e.rel === "part-of"), "edge b->c should exist");
});

test("writeEdges: is a no-op for empty array", () => {
  const before = readEdges().length;
  writeEdges([]);
  assert.equal(readEdges().length, before, "no new edges added");
});

test("writeEdges: stamps ts when not provided", () => {
  const a = addDomainNode({ type: "fact", name: "nots-a", props: {}, source: "", confidence: 0.7 });
  const b = addDomainNode({ type: "fact", name: "nots-b", props: {}, source: "", confidence: 0.7 });

  writeEdges([{ from: a, to: b, rel: "related-to" }]);
  const edge = readEdges().find((e) => e.from === a && e.to === b && e.rel === "related-to");
  assert.ok(edge, "edge should exist");
  assert.ok(edge!.ts, "ts should be auto-stamped when not provided");
});

// ── traverseNeighborhood (multi-hop BFS) ─────────────────────────────────────

test("traverseNeighborhood: returns empty for unknown seed ids", () => {
  const result = traverseNeighborhood(["nonexistent"]);
  assert.equal(result.nodes.length, 0);
  assert.equal(result.edges.length, 0);
});

test("traverseNeighborhood: returns seed node at distance 0 with 1-hop neighbor at distance 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "uc-tn-"));
  initDomain(dir);
  try {
    const seed = addDomainNode({ type: "fact", name: "seed-node", props: {}, source: "", confidence: 0.7 });
    const hop1 = addDomainNode({ type: "fact", name: "hop1-node", props: {}, source: "", confidence: 0.7 });
    addDomainEdge({ from: seed, to: hop1, rel: "depends-on" });

    const { nodes, edges } = traverseNeighborhood([seed], 2);
    const seedN = nodes.find((n) => n.id === seed);
    const hop1N = nodes.find((n) => n.id === hop1);
    assert.ok(seedN, "seed should be in the result");
    assert.equal(seedN!.distance, 0, "seed should have distance 0");
    assert.ok(hop1N, "1-hop neighbor should be in the result");
    assert.equal(hop1N!.distance, 1, "1-hop neighbor should have distance 1");
    assert.ok(edges.some((e) => e.from === seed && e.to === hop1), "edge should be included");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    initDomain(stateDir);
  }
});

test("traverseNeighborhood: traverses bidirectionally (to->from edges counted)", () => {
  const dir = mkdtempSync(join(tmpdir(), "uc-tn-bidir-"));
  initDomain(dir);
  try {
    const a = addDomainNode({ type: "fact", name: "tnb-a", props: {}, source: "", confidence: 0.7 });
    const b = addDomainNode({ type: "fact", name: "tnb-b", props: {}, source: "", confidence: 0.7 });
    // Edge goes b→a (reverse direction from seed a).
    addDomainEdge({ from: b, to: a, rel: "related-to" });

    const { nodes } = traverseNeighborhood([a], 2);
    const ids = nodes.map((n) => n.id);
    assert.ok(ids.includes(b), "b should be reachable from a via reverse edge traversal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    initDomain(stateDir);
  }
});

test("traverseNeighborhood: respects maxDepth limit", () => {
  const dir = mkdtempSync(join(tmpdir(), "uc-tn-depth-"));
  initDomain(dir);
  try {
    const a = addDomainNode({ type: "fact", name: "d-a", props: {}, source: "", confidence: 0.7 });
    const b = addDomainNode({ type: "fact", name: "d-b", props: {}, source: "", confidence: 0.7 });
    const c = addDomainNode({ type: "fact", name: "d-c", props: {}, source: "", confidence: 0.7 });
    addDomainEdge({ from: a, to: b, rel: "depends-on" });
    addDomainEdge({ from: b, to: c, rel: "depends-on" });

    // maxDepth=1: from a, only b is reachable (c is 2 hops away).
    const { nodes } = traverseNeighborhood([a], 1);
    const ids = nodes.map((n) => n.id);
    assert.ok(ids.includes(a), "seed a should be included");
    assert.ok(ids.includes(b), "1-hop b should be included");
    assert.ok(!ids.includes(c), "2-hop c should NOT be included with maxDepth=1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    initDomain(stateDir);
  }
});

test("traverseNeighborhood: respects maxNodes cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "uc-tn-cap-"));
  initDomain(dir);
  try {
    const a = addDomainNode({ type: "fact", name: "c-a", props: {}, source: "", confidence: 0.7 });
    for (let i = 0; i < 10; i++) {
      const n = addDomainNode({ type: "fact", name: `c-n${i}`, props: {}, source: "", confidence: 0.7 });
      addDomainEdge({ from: a, to: n, rel: "related-to" });
    }
    const { nodes } = traverseNeighborhood([a], 3, { maxNodes: 5 });
    assert.ok(nodes.length <= 5, `should cap at maxNodes=5, got ${nodes.length}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    initDomain(stateDir);
  }
});

// ── queryDomainGraph (keyword match + BFS expand) ────────────────────────────

test("queryDomainGraph: returns queryDomain results when maxDepth=0", () => {
  const dir = mkdtempSync(join(tmpdir(), "uc-qdg0-"));
  initDomain(dir);
  try {
    addDomainNode({ type: "fact", name: "qdg-seed", props: { ok: true }, source: "", confidence: 0.7 });
    const qd = queryDomain(["qdg-seed"]);
    const qdg = queryDomainGraph(["qdg-seed"], 0);
    assert.equal(qdg.nodes.length, qd.nodes.length, "maxDepth=0 should match queryDomain");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    initDomain(stateDir);
  }
});

test("queryDomainGraph: expands beyond keyword-matched seeds via BFS", () => {
  const dir = mkdtempSync(join(tmpdir(), "uc-qdg-"));
  initDomain(dir);
  try {
    const seed = addDomainNode({ type: "fact", name: "qdg-keyword", props: {}, source: "", confidence: 0.7 });
    const neighbor = addDomainNode({ type: "fact", name: "qdg-neighbor", props: {}, source: "", confidence: 0.7 });
    addDomainEdge({ from: seed, to: neighbor, rel: "related-to" });

    // maxDepth=0 → only the seed.
    const shallow = queryDomainGraph(["qdg-keyword"], 0);
    const shallowIds = shallow.nodes.map((n) => n.id);
    assert.ok(shallowIds.includes(seed), "seed should be in shallow result");
    assert.ok(!shallowIds.includes(neighbor), "neighbor should NOT be in shallow result");

    // maxDepth=2 → seed + neighbor.
    const deep = queryDomainGraph(["qdg-keyword"], 2);
    const deepIds = deep.nodes.map((n) => n.id);
    assert.ok(deepIds.includes(seed), "seed should be in deep result");
    assert.ok(deepIds.includes(neighbor), "neighbor should be in deep result (BFS-expanded)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    initDomain(stateDir);
  }
});

// ── touchNodes (direct call) ─────────────────────────────────────────────────

test("touchNodes: directly increments accessCount and sets lastAccessed", () => {
  const dir = mkdtempSync(join(tmpdir(), "uc-touch-direct-"));
  initDomain(dir);
  try {
    const id = addDomainNode({ type: "fact", name: "touch-target", props: {}, source: "", confidence: 0.7 });
    touchNodes(new Set([id]));
    const after = readNodes().find((n) => n.id === id);
    assert.ok(after?.lastAccessed, "lastAccessed should be set");
    assert.equal(after?.accessCount, 1, "accessCount should be 1");

    touchNodes(new Set([id]));
    const after2 = readNodes().find((n) => n.id === id);
    assert.equal(after2?.accessCount, 2, "accessCount should be 2 after second touch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    initDomain(stateDir);
  }
});

test("touchNodes: no-op for empty set", () => {
  const before = readNodes().length;
  touchNodes(new Set());
  assert.equal(readNodes().length, before, "no change when touching empty set");
});
