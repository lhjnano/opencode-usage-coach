// quota-machine.test.ts — createQuotaMachine behavioral tests (injected fetchQuota).
// Drives the SENSE→DECIDE cycle deterministically: LOADING sentinel, STOP/THROTTLE/GO
// decisions from injected quota payloads, TTL refresh dedup + model-change bypass,
// free-model short-circuit, and the invalid-percent (NaN) guard.
// State isolation: UC_STATE_DIR/setStateDir to a temp dir (log() writes), injected
// stateWriter spy (no state.json writes). codexbar itself is NOT exercised through
// the injected fetchQuota — only the best-effort providers coach view may spawn it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { createQuotaMachine, type Quota, type QuotaMachine } from "../src/quota.js";
import { setStateDir } from "../src/index.js";

let stateDir: string;

before(() => {
  stateDir = mkdtempSync(join(tmpdir(), "uc-quota-"));
  process.env.UC_STATE_DIR = stateDir;
  setStateDir(stateDir);
});

after(() => {
  delete process.env.UC_STATE_DIR;
  try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeQuota(weeklyPct: number | null, monthlyPct: number | null = null, fiveHourPct: number | null = null): Quota {
  return {
    weekly: weeklyPct === null ? null : { usedPercent: weeklyPct },
    monthly: monthlyPct === null ? null : { usedPercent: monthlyPct },
    fiveHour: fiveHourPct === null ? null : { usedPercent: fiveHourPct },
  };
}

/** Controllable fetchQuota: records provider args; each call returns a pending
 *  promise the test resolves via resolveNext(). */
function fetchQueue() {
  const pending: Array<(q: Quota | null) => void> = [];
  const providers: string[] = [];
  return {
    fetchQuota: (provider: string) => {
      providers.push(provider);
      return new Promise<Quota | null>((resolve) => { pending.push(resolve); });
    },
    providers,
    resolveNext: (q: Quota | null) => { pending.shift()?.(q); },
    pendingCount: () => pending.length,
  };
}

function stateSpy() {
  const writes: any[] = [];
  return { writes, stateWriter: (s: any) => { writes.push(s); } };
}

function machine(fetchQ: ReturnType<typeof fetchQueue>, stateW: ReturnType<typeof stateSpy>): QuotaMachine {
  return createQuotaMachine({ directory: "/tmp/uc-test-dir", fetchQuota: fetchQ.fetchQuota, stateWriter: stateW.stateWriter });
}

const tick = () => new Promise<void>((r) => setImmediate(r));
async function until(cond: () => boolean, ms = 15000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for condition (${ms}ms)`);
    await tick();
  }
}

// ── LOADING until the first fetch resolves ───────────────────────────────────

test("current() returns LOADING (GO, 'quota loading…') until the first fetch resolves", async () => {
  const fq = fetchQueue();
  const m = machine(fq, stateSpy());

  const early = m.current();
  assert.equal(early.decision, "GO", "LOADING sentinel is decision GO (never blocks on load)");
  assert.ok(early.advice.includes("quota loading"), `advice carries the loading marker: ${early.advice}`);
  assert.equal(fq.providers.length, 1, "current() kicks off the first refresh lazily");
  assert.equal(fq.pendingCount(), 1, "exactly one fetch in flight");

  fq.resolveNext(makeQuota(40, 20, 30));
  await until(() => m.current().advice.includes("Comfortable"));
  const c = m.current();
  assert.equal(c.decision, "GO");
  assert.equal(c.weekly, 40);
});

// ── Decisions from injected payloads ─────────────────────────────────────────

test("weekly 96% → STOP (>= STOP_WK 95)", async () => {
  const fq = fetchQueue();
  const m = machine(fq, stateSpy());
  m.refresh();
  fq.resolveNext(makeQuota(96, 10, 30));
  await until(() => m.current().decision !== "GO" || m.current().weekly === 96);
  const c = m.current();
  assert.equal(c.decision, "STOP");
  assert.ok(c.advice.includes("weekly 96%"), `STOP advice cites the window: ${c.advice}`);
  assert.ok(c.advice.includes("STOP recommend"), "STOP advice shape preserved");
});

test("5h 93% → STOP (>= STOP_5H 92)", async () => {
  const fq = fetchQueue();
  const m = machine(fq, stateSpy());
  m.refresh();
  fq.resolveNext(makeQuota(40, 10, 93));
  await until(() => m.current().decision === "STOP");
  const c = m.current();
  assert.equal(c.decision, "STOP");
  assert.ok(c.advice.includes("5h window 93%"), `STOP advice cites the 5h window: ${c.advice}`);
});

test("weekly 86% → THROTTLE (>= THR_WK 85, below STOP_WK)", async () => {
  const fq = fetchQueue();
  const m = machine(fq, stateSpy());
  m.refresh();
  fq.resolveNext(makeQuota(86, 10, 30));
  await until(() => m.current().decision === "THROTTLE");
  const c = m.current();
  assert.equal(c.decision, "THROTTLE");
  assert.ok(c.advice.includes("Throttle recommend"), "THROTTLE advice shape preserved");
  assert.ok(c.advice.includes("weekly 86%"), "THROTTLE advice cites the window");
});

test("comfortable → GO with summary parts (weekly/5h/monthly)", async () => {
  const fq = fetchQueue();
  const m = machine(fq, stateSpy());
  m.refresh();
  fq.resolveNext(makeQuota(40, 20, 30));
  await until(() => m.current().advice.includes("Comfortable"));
  const c = m.current();
  assert.equal(c.decision, "GO");
  assert.ok(c.advice.includes("weekly 40%"), "summary part: weekly");
  assert.ok(c.advice.includes("5h 30%"), "summary part: 5h");
  assert.ok(c.advice.includes("monthly 20%"), "summary part: monthly");
});

// ── Refresh dedup within TTL ─────────────────────────────────────────────────

test("refresh() N times within TTL → fetchQuota called once; setModel(model swap) forces a re-fetch", async () => {
  const fq = fetchQueue();
  const sw = stateSpy();
  const m = machine(fq, sw);
  // Establish a current model FIRST — V1 semantics: only a swap BETWEEN two
  // non-empty models counts as a change ("" → model does not force a refresh).
  m.setModel("glm-4.7", "zai-coding-plan");

  for (let i = 0; i < 5; i++) m.refresh();
  assert.equal(fq.providers.length, 1, "in-flight dedup: 5 refresh() calls → 1 fetch");
  fq.resolveNext(makeQuota(40, 20, 30));
  // persist (stateWriter) fires inside the .then chain after the providers view;
  // .finally clears `refreshing` right after — wait for the write, then one tick.
  await until(() => sw.writes.length >= 1);
  await tick();

  // Within TTL (60s default) — no re-fetch even after many refresh() calls.
  for (let i = 0; i < 3; i++) m.refresh();
  assert.equal(fq.providers.length, 1, "TTL dedup: no re-fetch within TTL");

  // markModelChanged() flips the dedup check → forced re-fetch.
  m.markModelChanged();
  m.refresh();
  assert.equal(fq.providers.length, 2, "markModelChanged bypasses the TTL guard");
  fq.resolveNext(makeQuota(50, null, null));
  await until(() => sw.writes.length >= 2);
  await tick(); // .finally (refreshing = false) lands one microtask after the write

  // setModel to a DIFFERENT model also flips it (resolveAgent path).
  m.setModel("glm-5", "zai-coding-plan");
  m.refresh();
  assert.equal(fq.providers.length, 3, "setModel(model swap) bypasses the TTL guard");
  assert.equal(fq.providers[2], "zai", "provider is mapped through providerToCodexbar (zai-coding-plan → zai)");
  fq.resolveNext(makeQuota(10, null, null));
  await until(() => sw.writes.length >= 3);
  await tick();
  await tick();

  // setModel with the SAME model does NOT flip it.
  m.setModel("glm-5", "zai-coding-plan");
  m.refresh();
  assert.equal(fq.providers.length, 3, "same-model setModel stays TTL-deduped");

  // state.json payload shape (paid path): model/provider/agent/isFree=false.
  const last = sw.writes[sw.writes.length - 1];
  assert.equal(last.isFree, false);
  assert.equal(last.model, "glm-5");
  assert.equal(last.provider, "zai-coding-plan");
  assert.ok(typeof last.updatedAt === "string");
});

// ── Free-model short-circuit ─────────────────────────────────────────────────

test("setModel('opencode/x','opencode') → refresh → GO 'no quota limit' with NO fetch", async () => {
  const fq = fetchQueue();
  const sw = stateSpy();
  const m = machine(fq, sw);

  m.setModel("opencode/x", "opencode");
  m.refresh(); // free path resolves synchronously — fetchQuota must NOT be called
  assert.equal(fq.providers.length, 0, "free model short-circuits before any fetch");

  const c = m.current();
  assert.equal(c.decision, "GO");
  assert.ok(c.advice.includes("no quota limit"), `free advice: ${c.advice}`);
  assert.ok(c.advice.includes("opencode/x"), "advice names the model");
  assert.equal(sw.writes.length, 1, "free path persists state synchronously");
  assert.equal(sw.writes[0].isFree, true);
  assert.equal(sw.writes[0].model, "opencode/x");
});

// ── Invalid percent (NaN) guard ──────────────────────────────────────────────

test("NaN usedPercent → THROTTLE 'invalid quota data' (invalid-percent guard)", async () => {
  const fq = fetchQueue();
  const m = machine(fq, stateSpy());
  m.refresh();
  fq.resolveNext(makeQuota(NaN, 10, 30));
  await until(() => m.current().decision === "THROTTLE");
  const c = m.current();
  assert.equal(c.decision, "THROTTLE");
  assert.ok(c.advice.includes("invalid quota data"), `invalid advice: ${c.advice}`);
  // valid windows survive as numbers; the NaN one collapses to 0 (coach() behavior).
  assert.equal(c.weekly, 0);
  assert.equal(c.monthly, 10);
  assert.equal(c.fiveHour, 30);
});

// ── null fetch (codexbar unavailable) fallback shape ─────────────────────────

test("fetch resolves null → GO 'quota unavailable' sentinel (weekly -2)", async () => {
  const fq = fetchQueue();
  const m = machine(fq, stateSpy());
  m.refresh();
  fq.resolveNext(null);
  await until(() => m.current().weekly === -2);
  const c = m.current();
  assert.equal(c.decision, "GO");
  assert.ok(c.advice.includes("quota unavailable"), `unavailable advice: ${c.advice}`);
});
