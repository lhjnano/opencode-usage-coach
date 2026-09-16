// domain-reward.test.ts — applyReward closed loop (v0.16.0 phase2-brief Task B /
// 스캔 반영 결정 4): injection drain → confidence ±δ (layer-aware rewrite) →
// claim marker in rewards.ndjson, plus ranker-index rebuild after the bump.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import {
  initDomain,
  getSharedDir,
  addDomainNode,
  saveInvestigationResult,
  logDomainInjection,
  applyReward,
  queryDomain,
  readNodes,
} from "../src/domain.js";

// 0.5 + 0.05 === 0.55000000000000004 in IEEE754 — numeric assertions use approx.
const approx = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

const dirs: string[] = [];

function freshDb(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `uc-reward-${label}-`));
  dirs.push(dir);
  initDomain(dir); // plain dir → SHARED_DIR = <dir>/shared (same derivation as prod's top-level cache)
  return dir;
}

type RewardRec = {
  ts: string;
  outcome: string;
  nodeIds: string[];
  delta: number;
  note?: string;
  claimedInjectionTs: string[];
};

function readRewards(): RewardRec[] {
  const p = join(getSharedDir(), "rewards.ndjson");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as RewardRec);
}

function readInjections(): Array<{ ts: string; keywords: string[]; nodeIds: string[] }> {
  const p = join(getSharedDir(), "injections.ndjson");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function nodeById(id: string) {
  return readNodes().find((n) => n.id === id);
}

before(() => {
  // Pin δ so an outer UC_REWARD_DELTA cannot change the expected arithmetic;
  // keep the autoLink gate off so saveInvestigationResult creates no edges.
  process.env.UC_REWARD_DELTA = "0.05";
  delete process.env.UC_AUTOLINK;
});

after(() => {
  delete process.env.UC_REWARD_DELTA;
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
  }
});

// ── outcome arithmetic ───────────────────────────────────────────────────────

test("applyReward pass: bumps confidence by +δ on claimed injection nodeIds", () => {
  freshDb("pass");
  const a = addDomainNode({ type: "fact", name: "reward-target", props: {}, source: "", confidence: 0.5 });
  logDomainInjection(["reward", "target"], [a]);

  const r = applyReward("pass");
  assert.equal(r.applied, 1);
  const n = nodeById(a);
  assert.ok(n, "node should exist");
  assert.ok(approx(n.confidence, 0.55), `confidence should be ~0.55, got ${n.confidence}`);
});

test("applyReward fail: decreases confidence by −δ", () => {
  freshDb("fail");
  const a = addDomainNode({ type: "fact", name: "punish-target", props: {}, source: "", confidence: 0.5 });
  logDomainInjection(["punish", "target"], [a]);

  const r = applyReward("fail");
  assert.equal(r.applied, 1);
  const n = nodeById(a)!;
  assert.ok(approx(n.confidence, 0.45), `confidence should be ~0.45, got ${n.confidence}`);
});

test("applyReward clamps at both bounds: pass caps at 1, fail floors at 0", () => {
  freshDb("clamp-hi");
  const hi = addDomainNode({ type: "fact", name: "clamp-high", props: {}, source: "", confidence: 0.98 });
  logDomainInjection(["clamp", "high"], [hi]);
  const r1 = applyReward("pass");
  assert.equal(r1.applied, 1);
  assert.equal(nodeById(hi)!.confidence, 1); // exact clamp boundary

  freshDb("clamp-lo");
  const lo = addDomainNode({ type: "fact", name: "clamp-low", props: {}, source: "", confidence: 0.02 });
  logDomainInjection(["clamp", "low"], [lo]);
  const r2 = applyReward("fail");
  assert.equal(r2.applied, 1);
  assert.equal(nodeById(lo)!.confidence, 0); // exact clamp boundary
});

test("applyReward drains nodeIds across BOTH layers with a layer-aware rewrite (no cross-layer duplication)", () => {
  const dir = freshDb("layers");
  const p = addDomainNode({ type: "fact", name: "proj-reward", props: {}, source: "", confidence: 0.5 });
  const s = saveInvestigationResult(["shared", "reward"], "shared finding", "test", 0.5);
  logDomainInjection(["proj", "shared", "reward"], [p, s]);

  const r = applyReward("pass");
  assert.equal(r.applied, 2, "one node per layer should be bumped");

  assert.ok(approx(nodeById(p)!.confidence, 0.55), "project node bumped");
  assert.ok(approx(nodeById(s)!.confidence, 0.55), "shared node bumped");

  // Layer isolation: each file still holds exactly its own node — the per-layer
  // rewrite must never copy a node id into the other layer's file.
  const projRaw = readFileSync(join(dir, "nodes.ndjson"), "utf8").split("\n").filter(Boolean);
  const sharedRaw = readFileSync(join(getSharedDir(), "nodes.ndjson"), "utf8").split("\n").filter(Boolean);
  assert.equal(projRaw.length, 1);
  assert.equal(sharedRaw.length, 1);
  assert.ok(projRaw[0]!.includes(p) && !projRaw[0]!.includes(s));
  assert.ok(sharedRaw[0]!.includes(s) && !sharedRaw[0]!.includes(p));
});

// ── claim accounting ─────────────────────────────────────────────────────────

test("applyReward double-claim: consecutive 2nd call applies nothing", () => {
  freshDb("double");
  const a = addDomainNode({ type: "fact", name: "once-only", props: {}, source: "", confidence: 0.5 });
  logDomainInjection(["once", "only"], [a]);

  const r1 = applyReward("pass");
  assert.equal(r1.applied, 1);
  assert.ok(approx(nodeById(a)!.confidence, 0.55));

  const r2 = applyReward("pass"); // same injection already claimed
  assert.equal(r2.applied, 0, "second call must not re-reward the same injection");
  assert.ok(approx(nodeById(a)!.confidence, 0.55), "confidence unchanged on re-claim");
  assert.equal(readRewards().length, 1, "no duplicate reward record");
});

test("applyReward empty nodeIds: miss injections are drained/claimed but apply nothing", () => {
  freshDb("miss");
  logDomainInjection(["no", "hits"], []); // queryDomain miss — recall denominator record

  const r = applyReward("pass");
  assert.equal(r.applied, 0);

  const recs = readRewards();
  assert.equal(recs.length, 1, "drained miss is claimed via a nodeIds:[] record");
  assert.deepEqual(recs[0]!.nodeIds, []);
  const injTs = readInjections().map((i) => i.ts);
  assert.deepEqual(recs[0]!.claimedInjectionTs, injTs, "miss injection ts is marked claimed");

  const r2 = applyReward("pass"); // nothing left unclaimed → no new record
  assert.equal(r2.applied, 0);
  assert.equal(readRewards().length, 1);
});

test("applyReward note: recorded on the reward record alongside delta/outcome/claim list", () => {
  freshDb("note");
  const a = addDomainNode({ type: "fact", name: "noted", props: {}, source: "", confidence: 0.5 });
  logDomainInjection(["noted"], [a]);
  const injTs = readInjections().map((i) => i.ts);

  applyReward("pass", "Task: write reward tests");

  const rec = readRewards()[0]!;
  assert.equal(rec.outcome, "pass");
  assert.equal(rec.note, "Task: write reward tests");
  assert.ok(approx(rec.delta, 0.05));
  assert.deepEqual(rec.nodeIds, [a]);
  assert.deepEqual(rec.claimedInjectionTs, injTs);
  assert.ok(rec.ts, "reward record carries its own ts");
});

test("applyReward no-op: nothing to drain → applied=0 and no rewards.ndjson is created", () => {
  freshDb("noop");
  const r = applyReward("fail");
  assert.equal(r.applied, 0);
  assert.equal(existsSync(join(getSharedDir(), "rewards.ndjson")), false);
});

// ── ranker index rebuild (priors) ────────────────────────────────────────────

test("applyReward confidence bump is reflected by the next queryDomain (ranker index rebuilt from fingerprint)", () => {
  freshDb("priors");
  const a = addDomainNode({ type: "fact", name: "findme-node", props: {}, source: "", confidence: 0.5 });

  // Warm the ranker cache — the index now holds the pre-reward confidence 0.5.
  const q1 = queryDomain(["findme"]);
  assert.equal(q1.nodes.length, 1);
  assert.equal(q1.nodes[0]!.id, a);
  assert.ok(approx(q1.nodes[0]!.confidence, 0.5), "pre-reward query sees 0.5");

  logDomainInjection(["findme"], [a]);
  assert.equal(applyReward("pass").applied, 1);

  // The confidence rewrite changes the nodes-file stat fingerprint, so
  // ensureIndex() rebuilds and the BM25 priors read the new confidence —
  // syncCacheAfterTouch is intentionally bypassed (worm-fields only).
  const q2 = queryDomain(["findme"]);
  assert.equal(q2.nodes.length, 1);
  assert.equal(q2.nodes[0]!.id, a);
  assert.ok(approx(q2.nodes[0]!.confidence, 0.55), `post-reward query should see ~0.55, got ${q2.nodes[0]!.confidence}`);
});
