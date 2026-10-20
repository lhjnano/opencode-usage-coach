// runmodel-signal.test.ts — AbortSignal cancellation wired into the REAL runModel.
// Uses a fake SessionOps (create → "s1", controllable pending prompt, recording
// abort/delete) and an isolated temp state dir (same pattern as
// index-stateful.test.ts) so log()/cleanup writes never touch real state.
//
// Timeout-path string asserted on mid-flight abort (read from src/index.ts):
//   `Task appears too large (exceeded ${maxSteps} steps, aborted after ...s)...`
// (the signal path flips `timedOut` without setting `stalled`, so runModel
// returns the step-limit/timeout branch, not the stalled branch).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { runModel, setStateDir } from "../src/index.js";
import type { SessionOps } from "../src/rt.js";

let stateDir: string;

before(() => {
  stateDir = mkdtempSync(join(tmpdir(), "uc-rmsignal-"));
  process.env.UC_STATE_DIR = stateDir;
  setStateDir(stateDir);
});

after(() => {
  delete process.env.UC_STATE_DIR;
  try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ── Fake SessionOps ──────────────────────────────────────────────────────────
// create → "s1" (signals `created` so tests can abort exactly after creation);
// prompt → a pending promise the test settles (or never does); abort/delete →
// synchronous recorders; messages → [] (poller sees an empty transcript).
function fakeOps(pendingPrompt: { resolve: (v: any) => void; reject: (e: unknown) => void; promise: Promise<any> }) {
  const calls = { create: [] as any[][], abort: [] as string[], delete: [] as string[] };
  let created!: () => void;
  const createdSignal = new Promise<void>((r) => { created = r; });
  const ops: SessionOps = {
    async create(directory: string, title: string) {
      calls.create.push([directory, title]);
      created();
      return "s1";
    },
    async prompt() { return pendingPrompt.promise; },
    async messages() { return []; },
    async abort(id: string) { calls.abort.push(id); },
    async delete(id: string) { calls.delete.push(id); },
    async get() { return null; },
  };
  return { ops, calls, createdSignal };
}

function neverSettling(): { resolve: (v: any) => void; reject: (e: unknown) => void; promise: Promise<any> } {
  let resolve!: (v: any) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<any>((res, rej) => { resolve = res; reject = rej; });
  return { resolve, reject, promise };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

// ── signal already aborted before the call ──────────────────────────────────

test("pre-aborted signal: returns the cancelled-before-start ERROR and never creates a session", async () => {
  const pending = neverSettling();
  pending.promise.catch(() => {}); // no-op catch: never settles, but stay safe
  const { ops, calls } = fakeOps(pending);
  const controller = new AbortController();
  controller.abort();

  const out = await runModel(ops, "prov/model", "do the thing", "/tmp/fake-dir", undefined, undefined, controller.signal);

  assert.equal(out, "ERROR: cancelled before start (signal already aborted).");
  assert.equal(calls.create.length, 0, "session.create must NOT be called");
  assert.equal(calls.abort.length, 0, "session.abort must NOT be called");
  assert.equal(calls.delete.length, 0, "session.delete must NOT be called");
});

// ── signal aborted mid-flight (after create, while prompt pending) ───────────

test("mid-flight abort: runModel resolves via the TIMEOUT path, aborts 's1', no unhandled rejection", async () => {
  const pending = neverSettling();
  pending.promise.catch(() => {}); // no-op catch on the fake pending prompt (test-side)
  const { ops, calls, createdSignal } = fakeOps(pending);
  const controller = new AbortController();

  const runP = runModel(ops, "prov/model", "work work", "/tmp/fake-dir", undefined, undefined, controller.signal);
  runP.catch(() => {}); // defensive: assert via await below, but never unhandled
  await createdSignal; // sub-session exists now; runModel is racing prompt vs timeout
  await tick();

  controller.abort(); // fires onAbort: timedOut=true, session.abort("s1"), race resolved
  const out = await runP;

  // Signal abort flips `timedOut` (not `stalled`) → the timeout/step-limit branch.
  assert.ok(out.includes("Task appears too large"),
    `must return the TIMEOUT-path string, got: ${JSON.stringify(out.slice(0, 120))}`);
  assert.ok(out.includes("[usage-coach NEXT]"), "timeout path carries the NEXT advice suffix");
  assert.deepEqual(calls.abort, ["s1"], "session.abort called with the sub-session id");
  assert.deepEqual(calls.delete, ["s1"], "timed-out sub-session is deleted");
  assert.equal(calls.create.length, 1, "exactly one sub-session was created");

  // The pending prompt never resolved — reject it now; both runModel's internal
  // handler and the test-side no-op catch keep this from being unhandled.
  pending.reject(new Error("session gone"));
  await tick();
});

// ── no signal / live signal: behavior unchanged ──────────────────────────────

test("no signal: completes normally, extracts parts text, cleans up (behavior unchanged)", async () => {
  const pending = neverSettling();
  const { ops, calls } = fakeOps(pending);
  const runP = runModel(ops, "prov/model", "quick task", "/tmp/fake-dir");
  // Resolve the prompt as soon as it's in flight — small spin keeps ordering deterministic.
  for (let i = 0; i < 50 && calls.create.length === 0; i++) await tick();
  pending.resolve({ data: { parts: [{ type: "text", text: "all done text" }] } });
  const out = await runP;

  assert.equal(out, "all done text");
  assert.equal(calls.abort.length, 0, "no abort on the happy path");
  assert.equal(calls.delete.length, 1, "cleanup delete still dispatched");
});

test("live (never-aborted) signal: completes normally and detaches the listener", async () => {
  const pending = neverSettling();
  const { ops, calls } = fakeOps(pending);
  const controller = new AbortController();
  const runP = runModel(ops, "prov/model", "quick task", "/tmp/fake-dir", undefined, undefined, controller.signal);
  for (let i = 0; i < 50 && calls.create.length === 0; i++) await tick();
  pending.resolve({ data: { parts: [{ type: "text", text: "signal untouched" }] } });
  const out = await runP;

  assert.equal(out, "signal untouched");
  assert.equal(calls.abort.length, 0, "a live signal must not abort anything");
  // finally removed the listener: aborting NOW must have no effect on the (done) run.
  controller.abort();
  await tick();
  assert.equal(calls.abort.length, 0, "listener detached in finally — late abort is a no-op");
  assert.deepEqual(calls.delete, ["s1"]);
});
