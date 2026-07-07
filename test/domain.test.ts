// domain.test.ts — tests for the domain knowledge-base helpers (src/domain.ts).
// Uses node:test + node:assert. State dir is an isolated temp dir under os.tmpdir().
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import {
  initDomain,
  readNodes,
  readEdges,
  addDomainNode,
  addDomainEdge,
  queryDomain,
  traverse,
  saveInvestigationResult,
} from "../src/domain.js";

let stateDir: string;

before(() => {
  // Fresh isolated temp dir per test run — never touches real project state.
  stateDir = mkdtempSync(join(tmpdir(), "uc-domain-"));
  initDomain(stateDir);
});

after(() => {
  try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

test("addDomainNode returns an id and readNodes includes it", () => {
  const id = addDomainNode({
    type: "api-method",
    name: "session.prompt",
    props: { returns: "AssistantMessage", blocking: true },
    source: "https://opencode.ai/docs/sdk",
    confidence: 0.95,
  });
  assert.ok(typeof id === "string" && id.length > 0, "addDomainNode should return a non-empty id");
  const nodes = readNodes();
  const found = nodes.find((n: any) => n.id === id);
  assert.ok(found, "readNodes should include the added node");
  assert.equal(found.name, "session.prompt");
  assert.equal(found.type, "api-method");
});

test("addDomainEdge connects two nodes and readEdges includes it", () => {
  const a = addDomainNode({ type: "api-method", name: "session.prompt", props: {}, source: "", confidence: 0.9 });
  const b = addDomainNode({ type: "concept", name: "AssistantMessage", props: {}, source: "", confidence: 0.9 });
  addDomainEdge({ from: a, to: b, rel: "returns", note: "blocks until sub-session completes" });
  const edges = readEdges();
  const found = edges.find((e: any) => e.from === a && e.to === b && e.rel === "returns");
  assert.ok(found, "readEdges should include the added edge");
  assert.equal(found.note, "blocks until sub-session completes");
});

test("queryDomain matches a node-name keyword and returns connected edges", () => {
  const m = addDomainNode({ type: "api-method", name: "session.status", props: { official: false }, source: "", confidence: 0.8 });
  const idle = addDomainNode({ type: "concept", name: "session.idle", props: {}, source: "", confidence: 0.8 });
  addDomainEdge({ from: m, to: idle, rel: "contradicts" });
  const { nodes, edges } = queryDomain(["session.status"]);
  const names = nodes.map((n: any) => n.name);
  assert.ok(names.includes("session.status"), "query should return the matched node");
  assert.ok(edges.some((e: any) => e.rel === "contradicts"), "query should return connected edges");
});

test("traverse follows edges from a node to related nodes (with optional rel filter)", () => {
  const a = addDomainNode({ type: "api-method", name: "runModel", props: {}, source: "", confidence: 0.9 });
  const b = addDomainNode({ type: "api-method", name: "session.prompt", props: {}, source: "", confidence: 0.9 });
  addDomainEdge({ from: a, to: b, rel: "depends-on" });
  const reached = traverse(a);
  const reachedIds = reached.map((n: any) => n.id);
  assert.ok(reachedIds.includes(b), "traverse should reach the related node");
  // rel filter passes matching edges ...
  const filtered = traverse(a, "depends-on");
  assert.ok(filtered.map((n: any) => n.id).includes(b), "traverse with matching rel should reach b");
  // ... and skips non-matching ones.
  const none = traverse(a, "returns");
  assert.ok(!none.map((n: any) => n.id).includes(b), "traverse with non-matching rel should not reach b");
});

test("append-only: adding more nodes preserves existing ones", () => {
  const before = readNodes().length;
  addDomainNode({ type: "fact", name: "tool-timeout", props: { range: "60-120s" }, source: "", confidence: 0.7 });
  addDomainNode({ type: "limit", name: "not-configurable", props: {}, source: "", confidence: 0.7 });
  const after = readNodes();
  assert.equal(after.length, before + 2, "new nodes should be appended, not replace existing ones");
  // Earlier nodes (added by other tests in this same state dir) must survive.
  const names = after.map((n: any) => n.name);
  assert.ok(names.includes("session.prompt"), "earlier nodes must survive subsequent appends");
});

test("saveInvestigationResult stores a fact node and makes it queryable", () => {
  // Isolate in a fresh state dir so the "was empty before" assertion holds.
  const dir = mkdtempSync(join(tmpdir(), "uc-domain-save-"));
  initDomain(dir);
  try {
    const before = queryDomain(["session.prompt"]);
    assert.equal(before.nodes.length, 0, "fresh domain should have no matching nodes");

    saveInvestigationResult(["session.prompt", "blocking"], "session.prompt blocks until done");

    const nodes = readNodes();
    const fact = nodes.find(
      (n: any) =>
        n.type === "fact" &&
        n.name.includes("session.prompt") &&
        n.name.includes("blocking"),
    );
    assert.ok(fact, "readNodes should include a fact node whose name contains the keywords");
    assert.equal(fact.props.result, "session.prompt blocks until done", "node props.result should be set");

    const { nodes: found } = queryDomain(["session.prompt"]);
    assert.ok(
      found.some((n: any) => n.id === fact.id),
      "queryDomain should now return the saved fact node",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    initDomain(stateDir);
  }
});
