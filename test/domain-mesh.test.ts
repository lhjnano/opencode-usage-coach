// domain-mesh.test.ts — tests for shared layer + auto-link mesh formation.
// Verifies that saveInvestigationResult:
//   1. Writes to the SHARED layer (cross-project)
//   2. Auto-creates related-to edges when keywords overlap (>= 2)
//   3. readNodes reads from BOTH layers
//   4. touchNodes/evictStale only affect the project layer (no duplication)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import {
  initDomain,
  getSharedDir,
  readNodes,
  readEdges,
  addDomainNode,
  addDomainEdge,
  queryDomain,
  saveInvestigationResult,
  touchNodes,
  evictStale,
} from "../src/domain.js";

let stateDir: string;
let sharedDir: string;

before(() => {
  // Create a realistic .../projects/<hash>/ structure so initDomain can derive SHARED_DIR.
  const root = mkdtempSync(join(tmpdir(), "uc-mesh-"));
  stateDir = join(root, "projects", "testhash123");
  mkdirSync(stateDir, { recursive: true });
  initDomain(stateDir);
  sharedDir = getSharedDir();
});

after(() => {
  // Clean the whole root (stateDir parent).
  try {
    const root = join(stateDir, "..", "..");
    rmSync(root, { recursive: true, force: true });
  } catch { /* */ }
});

// ── Shared layer ─────────────────────────────────────────────────────────────

test("getSharedDir returns a sibling of the projects/ directory", () => {
  assert.ok(sharedDir, "shared dir should be set");
  assert.ok(!sharedDir.includes("projects"), "shared dir should NOT be inside projects/");
});

test("saveInvestigationResult writes to the SHARED layer, not the project layer", () => {
  saveInvestigationResult(["oauth", "callback", "redirect"], "OAuth callback must match redirect URI");
  // Project file should NOT exist or be empty (no project-layer nodes written).
  const projFile = join(stateDir, "nodes.ndjson");
  const projLines = existsSync(projFile)
    ? readFileSync(projFile, "utf8").split("\n").filter(Boolean)
    : [];
  assert.equal(projLines.length, 0, "project layer should NOT receive investigation nodes");
  // Shared file should have the node.
  const sharedRaw = readFileSync(join(sharedDir, "nodes.ndjson"), "utf8");
  assert.ok(sharedRaw.includes("oauth"), "shared layer should contain the investigation node");
});

// ── Auto-link mesh formation ─────────────────────────────────────────────────

test("saveInvestigationResult auto-creates related-to edges when keywords overlap >= 2", () => {
  // Fresh dir so we don't have noise from other tests.
  const root = mkdtempSync(join(tmpdir(), "uc-autolink-"));
  const sd = join(root, "projects", "autolink");
  mkdirSync(sd, { recursive: true });
  initDomain(sd);
  try {
    // Save first investigation.
    saveInvestigationResult(["oauth", "callback", "token"], "OAuth callback returns token");
    // Save second investigation with 2 overlapping keywords (oauth, callback).
    saveInvestigationResult(["oauth", "callback", "refresh"], "OAuth callback also handles refresh");

    const edges = readEdges();
    const autoEdges = edges.filter((e: any) => e.rel === "related-to");
    assert.ok(autoEdges.length >= 1, `should have >= 1 auto-link edge, got ${autoEdges.length}`);

    // Verify the note format.
    const edge = autoEdges[0];
    assert.ok((edge.note ?? "").startsWith("auto:"), "auto-link note should start with 'auto:'");
  } finally {
    rmSync(root, { recursive: true, force: true });
    initDomain(stateDir);
  }
});

test("auto-link does NOT create edges when keyword overlap < 2", () => {
  const root = mkdtempSync(join(tmpdir(), "uc-nolink-"));
  const sd = join(root, "projects", "nolink");
  mkdirSync(sd, { recursive: true });
  initDomain(sd);
  try {
    saveInvestigationResult(["vitest", "coverage"], "Vitest coverage config");
    // Only 1 shared keyword: "vitest". Should NOT auto-link.
    saveInvestigationResult(["vitest", "snapshot"], "Vitest snapshot testing");
    const autoEdges = readEdges().filter((e: any) => e.rel === "related-to");
    // Note: the overlap threshold is 2, so 1 shared keyword is not enough.
    // But wait — queryDomain matches on name substring, and if "vitest" is in
    // both names, it'll be a candidate. The keyword overlap check counts exact
    // matches: keywords=["vitest","snapshot"], nodeKw from first node =
    // props.keywords=["vitest","coverage"]. overlap = ["vitest"] → length 1 < 2.
    // So no edge should be created.
    // However, both nodes ARE candidates (queryDomain matches "vitest" in name).
    // The edge is only created if overlap.length >= minOverlap(2).
    const linkingEdges = autoEdges.filter((e: any) =>
      e.note.includes("1 shared") || e.note.includes("2 shared"),
    );
    // If minOverlap=2, a 1-shared overlap should NOT create an edge.
    assert.ok(
      !linkingEdges.some((e: any) => e.note.includes("1 shared")),
      "1 shared keyword should NOT trigger auto-link (minOverlap=2)",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    initDomain(stateDir);
  }
});

test("auto-link caps at maxLinks (8) to avoid hub explosion", () => {
  const root = mkdtempSync(join(tmpdir(), "uc-cap-link-"));
  const sd = join(root, "projects", "caplink");
  mkdirSync(sd, { recursive: true });
  initDomain(sd);
  try {
    // Create 12 nodes that all share keywords "shared", "common".
    for (let i = 0; i < 12; i++) {
      saveInvestigationResult(["shared", "common", `item${i}`], `Investigation ${i}`);
    }
    const autoEdges = readEdges().filter((e: any) => e.rel === "related-to");
    // The last node saved should have been linked to up to 8 previous nodes.
    // But since earlier nodes also auto-linked, total edges could be more.
    // Just verify no single node has > 8 outgoing related-to edges.
    // Actually, maxLinks is per-save, so each save caps at 8.
    // The 12th save has 11 candidates but should cap at 8.
    // Count outgoing edges for any single node:
    const outgoing = new Map<string, number>();
    for (const e of autoEdges) {
      outgoing.set(e.from, (outgoing.get(e.from) ?? 0) + 1);
    }
    const maxOut = Math.max(...outgoing.values());
    assert.ok(maxOut <= 8, `no node should have > 8 outgoing auto-links, max was ${maxOut}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    initDomain(stateDir);
  }
});

// ── Cross-layer reads ────────────────────────────────────────────────────────

test("readNodes merges project + shared layers", () => {
  const root = mkdtempSync(join(tmpdir(), "uc-merge-"));
  const sd = join(root, "projects", "merge");
  mkdirSync(sd, { recursive: true });
  initDomain(sd);
  try {
    // Add a project-layer node.
    addDomainNode({ type: "fact", name: "project-specific-fact", props: {}, source: "", confidence: 0.7 });
    // Add a shared-layer node via saveInvestigationResult.
    saveInvestigationResult(["cross", "project", "pattern"], "Cross-project pattern finding");

    const all = readNodes();
    const names = all.map((n: any) => n.name);
    assert.ok(names.includes("project-specific-fact"), "readNodes should include project-layer nodes");
    assert.ok(
      names.some((n) => n.includes("cross") && n.includes("project")),
      "readNodes should include shared-layer nodes",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    initDomain(stateDir);
  }
});

// ── Layer isolation: touchNodes / evictStale ─────────────────────────────────

test("touchNodes only modifies project-layer nodes (no duplication into project)", () => {
  const root = mkdtempSync(join(tmpdir(), "uc-touch-iso-"));
  const sd = join(root, "projects", "touchiso");
  mkdirSync(sd, { recursive: true });
  initDomain(sd);
  const thisSharedDir = getSharedDir(); // get fresh shared dir after re-init
  try {
    // Shared-layer node.
    saveInvestigationResult(["touch", "shared", "keyword"], "Shared node for touch test");
    // Project-layer node.
    const projId = addDomainNode({ type: "fact", name: "proj-node", props: {}, source: "", confidence: 0.7 });

    // Touch both ids — only the project node should be affected.
    touchNodes(new Set([projId]));

    const projNodes = readFileSync(join(sd, "nodes.ndjson"), "utf8").split("\n").filter(Boolean);
    const sharedNodes = readFileSync(join(thisSharedDir, "nodes.ndjson"), "utf8").split("\n").filter(Boolean);
    // Shared node should still be only in shared layer.
    assert.ok(!projNodes.some((l) => l.includes("touch") && l.includes("shared")),
      "shared node should NOT be duplicated into project layer");
    // Project node should have lastAccessed.
    const projNode = JSON.parse(projNodes.find((l) => l.includes("proj-node"))!);
    assert.ok(projNode.lastAccessed, "project node should be touched");
  } finally {
    rmSync(root, { recursive: true, force: true });
    initDomain(stateDir);
  }
});

test("evictStale only removes project-layer nodes (shared nodes survive)", () => {
  const root = mkdtempSync(join(tmpdir(), "uc-evict-iso-"));
  const sd = join(root, "projects", "evictiso");
  mkdirSync(sd, { recursive: true });
  initDomain(sd);
  try {
    // Add a project-layer node.
    addDomainNode({ type: "fact", name: "proj-evict", props: {}, source: "", confidence: 0.7 });
    // Add a shared-layer node.
    saveInvestigationResult(["survive", "shared", "eviction"], "Should survive project eviction");

    // Evict everything from project layer (maxAgeDays=0).
    const res = evictStale(0);
    assert.ok(res.removed >= 1, "project node should be evicted");

    // Shared node should still be readable via readNodes.
    const all = readNodes();
    assert.ok(
      all.some((n: any) => n.name.includes("survive")),
      "shared-layer node should survive project-layer eviction",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    initDomain(stateDir);
  }
});

// ── extractKeywords integration (from index.ts, tested indirectly) ───────────

test("saveInvestigationResult stores keywords in props for auto-link matching", () => {
  const root = mkdtempSync(join(tmpdir(), "uc-kw-props-"));
  const sd = join(root, "projects", "kwprops");
  mkdirSync(sd, { recursive: true });
  initDomain(sd);
  try {
    const kws = ["webpack", "config", "alias"];
    saveInvestigationResult(kws, "Webpack alias config for module resolution");

    const nodes = readNodes();
    const node = nodes.find((n: any) => n.props?.result?.includes("Webpack alias"));
    assert.ok(node, "node should exist");
    assert.deepEqual(
      node!.props.keywords,
      kws,
      "node props.keywords should store the raw keyword array for matching",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    initDomain(stateDir);
  }
});
