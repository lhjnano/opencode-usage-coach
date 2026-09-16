// domain-purge.test.ts — v0.16.0 Phase 2 (knowledge-retrieval-redesign 02편):
//   1. sweepDeadEdges — ghost-edge removal with UNION judgment (both layers)
//   2. traverseNeighborhood fanout cap (UC_FANOUT_CAP, ts-desc deterministic)
//   3. autoLink gate (UC_AUTOLINK, default OFF)
// Every test isolates state via initDomain(<temp dir>) — the live DB is never
// touched. node:test runs each file in its own process, so env mutations here
// cannot leak into other files; per-test set/delete keeps intra-file isolation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, appendFileSync, readFileSync, statSync } from "node:fs";
import {
  initDomain,
  getSharedDir,
  addDomainNode,
  addDomainEdge,
  readEdges,
  saveInvestigationResult,
  sweepDeadEdges,
  traverseNeighborhood,
} from "../src/domain.js";

let stateDir: string;

before(() => {
  stateDir = mkdtempSync(join(tmpdir(), "uc-purge-"));
  initDomain(stateDir);
  delete process.env.UC_AUTOLINK;
  delete process.env.UC_FANOUT_CAP;
});

after(() => {
  try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

// Per-test isolation helper: fresh dir, restored to the file-level dir after.
// Async-aware so fanout tests can await timestamp-spacing sleeps BEFORE cleanup.
async function isolated(name: string, fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `uc-purge-${name}-`));
  initDomain(dir);
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    initDomain(stateDir);
  }
}

// Append an edge directly into the SHARED layer (mirrors autoLinkKeywords' writer).
function addSharedEdge(from: string, to: string): void {
  mkdirSync(getSharedDir(), { recursive: true });
  appendFileSync(
    join(getSharedDir(), "edges.ndjson"),
    JSON.stringify({ from, to, rel: "related-to", ts: new Date().toISOString() }) + "\n",
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── 1. sweepDeadEdges: ghost removal (union judgment) ────────────────────────

test("sweepDeadEdges: removes edges whose BOTH endpoints are missing, keeps healthy edges", async () => {
  await isolated("proj-ghost", () => {
    const a = addDomainNode({ type: "fact", name: "sweep-a", props: {}, source: "", confidence: 0.7 });
    const b = addDomainNode({ type: "fact", name: "sweep-b", props: {}, source: "", confidence: 0.7 });
    addDomainEdge({ from: a, to: b, rel: "depends-on" });              // healthy
    addDomainEdge({ from: a, to: "node_ghost_x", rel: "related-to" }); // ghost to
    addDomainEdge({ from: "node_ghost_y", to: b, rel: "related-to" }); // ghost from

    const res = sweepDeadEdges();
    assert.equal(res.removed, 2, "both half-ghost edges (one live endpoint) must be removed");
    assert.equal(res.kept, 1);

    const remaining = readEdges();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.from, a);
    assert.equal(remaining[0]?.to, b);
  });
});

test("sweepDeadEdges: UNION judgment protects cross-layer edges (shared edge -> project node)", async () => {
  await isolated("cross-layer", () => {
    // Project-layer node (addDomainNode) + shared-layer node (saveInvestigationResult,
    // autoLink OFF so no noise edges are auto-created).
    const projId = addDomainNode({ type: "fact", name: "proj-side", props: {}, source: "", confidence: 0.7 });
    const sharedId = saveInvestigationResult(["sweep", "crosslayer", "kw"], "shared-side finding");

    // autoLink-style edge: written into the SHARED edge file but pointing at a
    // PROJECT-layer node id. Per-layer checks would delete this — union must keep it.
    addSharedEdge(sharedId, projId);
    // Reverse direction: project edge file pointing at a shared-layer node.
    addDomainEdge({ from: projId, to: sharedId, rel: "related-to" });
    // True ghost: shared edge into nothing.
    addSharedEdge(sharedId, "node_ghost_z");

    const res = sweepDeadEdges();
    assert.equal(res.removed, 1, "only the both-ghost edge is removed");
    assert.equal(res.kept, 2, "both cross-layer edges survive the union judgment");

    const remaining = readEdges();
    assert.equal(remaining.length, 2);
    assert.ok(remaining.some((e) => e.from === sharedId && e.to === projId), "shared->project kept");
    assert.ok(remaining.some((e) => e.from === projId && e.to === sharedId), "project->shared kept");
    assert.ok(!remaining.some((e) => e.to === "node_ghost_z"), "ghost edge gone");
  });
});

test("sweepDeadEdges: removed=0 is a no-op — edge files are not rewritten", async () => {
  await isolated("no-op", (dir) => {
    const a = addDomainNode({ type: "fact", name: "noop-a", props: {}, source: "", confidence: 0.7 });
    const b = addDomainNode({ type: "fact", name: "noop-b", props: {}, source: "", confidence: 0.7 });
    addDomainEdge({ from: a, to: b, rel: "part-of" });
    addSharedEdge(b, a);

    // Snapshot both raw edge files via the module's own layout: project dir is
    // the current initDomain dir, shared dir from getSharedDir.
    const projRaw = readFileSync(join(dir, "edges.ndjson"), "utf8");
    const sharedRaw = readFileSync(join(getSharedDir(), "edges.ndjson"), "utf8");
    const projMtime = statSync(join(dir, "edges.ndjson")).mtimeMs;
    const sharedMtime = statSync(join(getSharedDir(), "edges.ndjson")).mtimeMs;

    const res = sweepDeadEdges();
    assert.deepEqual(res, { removed: 0, kept: 2 });
    assert.equal(readFileSync(join(dir, "edges.ndjson"), "utf8"), projRaw, "project edge file untouched");
    assert.equal(readFileSync(join(getSharedDir(), "edges.ndjson"), "utf8"), sharedRaw, "shared edge file untouched");
    assert.equal(statSync(join(dir, "edges.ndjson")).mtimeMs, projMtime, "project edge file not rewritten (mtime)");
    assert.equal(statSync(join(getSharedDir(), "edges.ndjson")).mtimeMs, sharedMtime, "shared edge file not rewritten (mtime)");
  });
});

test("sweepDeadEdges: empty/missing DB → {removed:0, kept:0}, never throws", async () => {
  await isolated("empty", () => {
    assert.deepEqual(sweepDeadEdges(), { removed: 0, kept: 0 });
  });
});

// ── 2. traverseNeighborhood fanout cap ───────────────────────────────────────

test("fanout cap: hub with 20 neighbors expands only the 12 newest (ts desc), deterministically", async () => {
  await isolated("fanout-default", async () => {
    delete process.env.UC_FANOUT_CAP; // documented default 12
    const hub = addDomainNode({ type: "fact", name: "hubnode", props: {}, source: "", confidence: 0.7 });
    const neighborIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      // Strict ts ordering: addDomainNode stamps ms-resolution ISO timestamps,
      // so space creations apart to make "newest 12" unambiguous.
      await sleep(2);
      neighborIds.push(addDomainNode({ type: "fact", name: `fanout-nb-${i}`, props: {}, source: "", confidence: 0.7 }));
      addDomainEdge({ from: hub, to: neighborIds[neighborIds.length - 1]!, rel: "related-to" });
    }

    const { nodes, edges } = traverseNeighborhood([hub], 1);
    // hub + 12 followed neighbors (cap applies, not maxNodes=60).
    assert.equal(nodes.length, 13, `hub + cap(12) expected, got ${nodes.length}`);
    assert.equal(edges.length, 12, "only capped edges are traversed");

    // The followed set must be the 12 NEWEST neighbors (ts desc), not file-order luck.
    const followed = nodes.filter((n) => n.id !== hub).map((n) => n.id).sort();
    const expected = neighborIds.slice(8).sort(); // 12 newest of 20
    assert.deepEqual(followed, expected, "cap must follow the newest (ts desc) neighbors");

    // Determinism: two runs return identical node id lists.
    const run1 = traverseNeighborhood([hub], 1).nodes.map((n) => n.id);
    const run2 = traverseNeighborhood([hub], 1).nodes.map((n) => n.id);
    assert.deepEqual(run1, run2, "ts-desc + id tiebreak must make the result deterministic");
  });
});

test("fanout cap: UC_FANOUT_CAP env overrides the default", async () => {
  await isolated("fanout-env", async () => {
    process.env.UC_FANOUT_CAP = "5";
    try {
      const hub = addDomainNode({ type: "fact", name: "hubenv", props: {}, source: "", confidence: 0.7 });
      for (let i = 0; i < 10; i++) {
        await sleep(2);
        const n = addDomainNode({ type: "fact", name: `hubenv-nb-${i}`, props: {}, source: "", confidence: 0.7 });
        addDomainEdge({ from: hub, to: n, rel: "related-to" });
      }
      const { nodes } = traverseNeighborhood([hub], 1);
      assert.equal(nodes.length, 6, "hub + 5 (env cap)");
    } finally {
      delete process.env.UC_FANOUT_CAP;
    }
  });
});

test("fanout cap: maxDepth regression — small graphs still traverse multi-hop", async () => {
  await isolated("depth-regression", () => {
    const a = addDomainNode({ type: "fact", name: "depth-a", props: {}, source: "", confidence: 0.7 });
    const b = addDomainNode({ type: "fact", name: "depth-b", props: {}, source: "", confidence: 0.7 });
    const c = addDomainNode({ type: "fact", name: "depth-c", props: {}, source: "", confidence: 0.7 });
    const d = addDomainNode({ type: "fact", name: "depth-d", props: {}, source: "", confidence: 0.7 });
    addDomainEdge({ from: a, to: b, rel: "depends-on" });
    addDomainEdge({ from: b, to: c, rel: "depends-on" });
    addDomainEdge({ from: c, to: d, rel: "depends-on" });

    const two = traverseNeighborhood([a], 2);
    assert.deepEqual(two.nodes.map((n) => n.id).sort(), [a, b, c].sort(), "2 hops reachable, 3rd not");
    const three = traverseNeighborhood([a], 3);
    assert.deepEqual(three.nodes.map((n) => n.id).sort(), [a, b, c, d].sort(), "3 hops reachable at maxDepth=3");
  });
});

test("fanout cap: empty DB and unknown seeds → empty result, signature unchanged", async () => {
  await isolated("empty-seeds", () => {
    assert.deepEqual(traverseNeighborhood(["nonexistent"]), { nodes: [], edges: [] });
    // opts.maxNodes still honored (signature regression guard).
    const seed = addDomainNode({ type: "fact", name: "sig-seed", props: {}, source: "", confidence: 0.7 });
    const nb = addDomainNode({ type: "fact", name: "sig-nb", props: {}, source: "", confidence: 0.7 });
    addDomainEdge({ from: seed, to: nb, rel: "related-to" });
    const capped = traverseNeighborhood([seed], 1, { maxNodes: 1 });
    assert.equal(capped.nodes.length, 1, "maxNodes opt still caps the result");
  });
});

// ── 3. autoLink gate (UC_AUTOLINK, default OFF) ──────────────────────────────

test("autoLink OFF (default): saveInvestigationResult creates NO related-to edges", async () => {
  await isolated("autolink-off", () => {
    delete process.env.UC_AUTOLINK; // documented default
    saveInvestigationResult(["gatekw", "second", "third"], "first investigation");
    saveInvestigationResult(["gatekw", "second", "fourth"], "second investigation — 2 shared keywords");
    const auto = readEdges().filter((e) => e.rel === "related-to" && (e.note ?? "").startsWith("auto:"));
    assert.equal(auto.length, 0, "gate OFF must block all auto-link edge creation");
  });
});

test("autoLink ON (UC_AUTOLINK=1): saveInvestigationResult creates mesh edges like pre-0.16.0", async () => {
  await isolated("autolink-on", () => {
    process.env.UC_AUTOLINK = "1";
    try {
      saveInvestigationResult(["gatekw2", "alpha", "beta"], "first investigation");
      saveInvestigationResult(["gatekw2", "alpha", "gamma"], "second investigation — 2 shared keywords");
      const auto = readEdges().filter((e) => e.rel === "related-to" && (e.note ?? "").startsWith("auto:"));
      assert.ok(auto.length >= 1, "gate ON must restore pre-0.16.0 auto-linking");
      assert.ok((auto[0]?.note ?? "").startsWith("auto:"), "note format preserved");
    } finally {
      delete process.env.UC_AUTOLINK;
    }
  });
});

test("sweepDeadEdges + autoLink OFF: legacy auto edges all live → sweep is a no-op", async () => {
  await isolated("sweep-after-autolink", () => {
    // Simulate the v0.16 migration story: legacy auto edges exist and point at
    // live nodes. The ghost sweep must keep them — purging LIVE auto edges is
    // the migration's explicit --purge-auto job, not the ghost sweep's.
    process.env.UC_AUTOLINK = "1";
    try {
      saveInvestigationResult(["legacy", "meshkw", "pair"], "legacy finding");
      saveInvestigationResult(["legacy", "meshkw", "trio"], "legacy finding 2");
    } finally {
      delete process.env.UC_AUTOLINK;
    }
    const before = readEdges().filter((e) => e.rel === "related-to").length;
    assert.ok(before >= 1, "auto edges exist from the legacy-era save");

    const res = sweepDeadEdges();
    assert.equal(res.removed, 0, "auto edges all point at live nodes — nothing is a ghost");
    assert.ok(readEdges().some((e) => (e.note ?? "").startsWith("auto:")), "healthy auto edges survive the ghost sweep");
  });
});
