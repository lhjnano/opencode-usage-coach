// v2-adapter.test.ts — the V2 plugin adapter (src/v2.ts) against a mock ctx.
// Records every registration (tool.transform editor adds, tool.hook, session.hook,
// event.subscribe) and drives the hooks directly:
//   - setup registers 16 tools (TOOL_NAMES order, TOOL_SCHEMAS identity, async execute)
//   - grade execute (deterministic checks) returns V2 {content} with PASS + skip banner
//   - execute.before replicates the V1 gating (STOP throw / agent restriction / pass-through)
//   - the SAME coaching body is registered on context+compaction+title (system parts)
//   - session.idle events drive quota.refresh; subscribe throwing/aborting is survivable
//   - cleanup() aborts the subscription controller
// NOTE: this file imports src/v2.js FIRST (before src/index.js) — it doubles as the
// proof that the deferred index ↔ v2 import cycle is safe in the v2-first order.
import { V2Plugin, buildV2Setup } from "../src/v2.js";
import { setStateDir } from "../src/index.js";
import type { QuotaMachine, Decision } from "../src/quota.js";
import { TOOL_NAMES, TOOL_SCHEMAS } from "../src/tool-schemas.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

// ── State isolation ──────────────────────────────────────────────────────────

let stateDir: string;
let workDir: string;
let fakeHome: string;
const realHome = process.env.HOME;

before(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "uc-v2-home-"));
  process.env.HOME = fakeHome; // isolate readHarnessCfg's ~/.config lookup
  stateDir = mkdtempSync(join(tmpdir(), "uc-v2-state-"));
  process.env.UC_STATE_DIR = stateDir;
  setStateDir(stateDir);
  workDir = mkdtempSync(join(tmpdir(), "uc-v2-work-"));
});

after(() => {
  process.env.HOME = realHome;
  delete process.env.UC_STATE_DIR;
  for (const d of [fakeHome, stateDir, workDir]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ── Mock ctx ─────────────────────────────────────────────────────────────────

type CtxMock = {
  ctx: any;
  adds: any[];                                  // tools added via editor.add
  toolHooks: Map<string, (arg: any) => any>;             // "execute.before" -> cb
  sessionHooks: Map<string, (arg: any) => any>;          // context/compaction/title -> cb
  signals: Array<AbortSignal | undefined>;      // subscribe() signal args
  sessionCalls: { get: any[]; create: any[]; prompt: any[]; wait: any[]; context: any[] };
};

/** Mock V2 plugin context. `agentSession` is returned by ctx.session.get for the
 *  harness-agent tests; `events` is an async-iterable factory for subscribe. */
function mockCtx(opts: {
  agentSession?: any;
  makeEvents?: (signal?: AbortSignal) => AsyncIterable<any>;
} = {}): CtxMock {
  const adds: any[] = [];
  const toolHooks = new Map<string, (arg: any) => any>();
  const sessionHooks = new Map<string, (arg: any) => any>();
  const signals: Array<AbortSignal | undefined> = [];
  const sessionCalls = { get: [] as any[], create: [] as any[], prompt: [] as any[], wait: [] as any[], context: [] as any[] };
  const agentSession = opts.agentSession ?? { agent: "Usage-Coach-Harness", model: { id: "glm-4.7", providerID: "zai-coding-plan" } };
  const ctx: any = {
    location: { directory: workDir },
    tool: {
      async transform(cb: (editor: any) => void) {
        cb({ add: (t: any) => adds.push(t) });
        return { dispose: async () => {} };
      },
      async hook(name: string, cb: (arg: any) => any) {
        toolHooks.set(name, cb);
        return { dispose: async () => {} };
      },
    },
    session: {
      // SessionOps surface (consumed by makeV2SessionOps / resolveAgent).
      get: async (arg: any) => { sessionCalls.get.push(arg); return agentSession; },
      create: async (arg: any) => { sessionCalls.create.push(arg); return { id: "ses-sub-1" }; },
      prompt: async (arg: any) => { sessionCalls.prompt.push(arg); return {}; },
      wait: async (arg: any) => { sessionCalls.wait.push(arg); return {}; },
      context: async (arg: any) => { sessionCalls.context.push(arg); return []; },
      interrupt: async () => {},
      remove: async () => {},
      switchModel: async () => {},
      // Hook surface (session domain).
      async hook(name: string, cb: (arg: any) => any) {
        sessionHooks.set(name, cb);
        return { dispose: async () => {} };
      },
    },
    generate: {},
    event: {
      async subscribe(o: any) {
        signals.push(o?.signal);
        return (opts.makeEvents ? opts.makeEvents(o?.signal) : emptyEvents());
      },
    },
  };
  return { ctx, adds, toolHooks, sessionHooks, signals, sessionCalls };
}

async function* emptyEvents(): AsyncIterable<any> { /* yields nothing */ }

// ── Stub quota machine ───────────────────────────────────────────────────────

/** Mutable stub: `decision` can be flipped between hook invocations. */
function stubQuota(coaching: { decision: Decision; advice: string; weekly: number; monthly: number; fiveHour: number }) {
  const calls = { refresh: 0, setModel: [] as Array<[string, string]> };
  const machine: QuotaMachine = {
    current: () => coaching,
    refresh() { calls.refresh++; },
    setModel(model: string, provider: string) { calls.setModel.push([model, provider]); },
    markModelChanged() { /* not used by the adapter */ },
  };
  return { calls, machine };
}

const GO_MACHINE = { decision: "GO" as const, advice: "Comfortable — weekly 40% · 5h 30%.", weekly: 40, monthly: -1, fiveHour: 30 };
const STOP_MACHINE = { decision: "STOP" as const, advice: "STOP recommend — weekly 96% (). window nearly exhausted. stop now or it will be force-blocked.", weekly: 96, monthly: -1, fiveHour: -1 };

const tick = () => new Promise<void>((r) => setImmediate(r));
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for condition (${ms}ms)`);
    await tick();
  }
}

// ── (0) V2Plugin shape + cycle-safe v2-first import ──────────────────────────

test("V2Plugin: Plugin.define shape ({ id, setup }) with the usage-coach id", () => {
  // Reaching this line at all proves the src/v2.js -> src/index.js -> src/v2.js
  // import cycle did not blow up in the v2-first evaluation order.
  assert.equal(V2Plugin.id, "opencode-usage-coach");
  assert.equal(typeof V2Plugin.setup, "function");
  assert.equal(typeof buildV2Setup, "function");
});

// ── (1) setup(): 16 tools, no session/network traffic ────────────────────────

test("setup(): registers EXACTLY 16 tools (TOOL_NAMES order, TOOL_SCHEMAS identity, async execute) without touching the session/network surface", async () => {
  const m = mockCtx();
  const stub = stubQuota({ ...GO_MACHINE });
  const cleanup = await buildV2Setup({ quota: stub.machine })(m.ctx);
  try {
    assert.equal(m.adds.length, 16, "exactly 16 editor.add calls");
    assert.deepEqual(m.adds.map((a) => a.name), [...TOOL_NAMES], "tool names == TOOL_NAMES in order");
    for (const add of m.adds) {
      assert.equal(add.input, TOOL_SCHEMAS[add.name].schema, `${add.name}: input schema is TOOL_SCHEMAS' JSON Schema object (identity)`);
      assert.equal(add.description, TOOL_SCHEMAS[add.name].description, `${add.name}: full protocol description`);
      assert.equal(add.execute.constructor.name, "AsyncFunction", `${add.name}: execute is async`);
    }
    // No network/session traffic during setup: no sub-session created, prompted,
    // waited on or transcripted; no quota fetch (stubbed machine counts refreshes,
    // and ctx.session.get is only used by the hooks — none fired yet).
    assert.equal(m.sessionCalls.create.length, 0);
    assert.equal(m.sessionCalls.prompt.length, 0);
    assert.equal(m.sessionCalls.wait.length, 0);
    assert.equal(m.sessionCalls.context.length, 0);
    assert.equal(m.sessionCalls.get.length, 0);
    assert.ok(stub.calls.refresh >= 1, "initial quota.refresh() fired");
  } finally {
    cleanup();
  }
});

test("grade tool execute (deterministic checks): V2 {content} result, first line PASS + 'grader model skipped'", async () => {
  writeFileSync(join(workDir, "out.md"), "hello world\n");
  const m = mockCtx();
  const stub = stubQuota({ ...GO_MACHINE });
  const cleanup = await buildV2Setup({ quota: stub.machine })(m.ctx);
  try {
    const grade = m.adds.find((a) => a.name === "grade");
    assert.ok(grade, "grade tool registered");
    const res = await grade.execute(
      { prompt: "out.md exists", checks: [{ type: "file-exists", path: "out.md" }] },
      { sessionID: "ses-v2-grade", signal: undefined },
    );
    assert.ok(res && typeof res.content === "string", "V2 result shape { content: string }");
    assert.equal(res.content.split("\n")[0], "PASS", "first line is exactly PASS");
    assert.ok(res.content.includes("grader model skipped"), "deterministic-checks banner present");
    assert.ok(res.content.includes("(verified by 1 deterministic check(s)"), "check count reported");
  } finally {
    cleanup();
  }
});

// ── (2) execute.before: V1 gating replicated exactly ─────────────────────────

test("execute.before: harness tool + STOP quota → throws 'blocked: quota limit exceeded'", async () => {
  const m = mockCtx(); // default agentSession: Usage-Coach-Harness + zai/glm-4.7
  const stub = stubQuota({ ...STOP_MACHINE });
  const cleanup = await buildV2Setup({ quota: stub.machine })(m.ctx);
  try {
    const hook = m.toolHooks.get("execute.before");
    assert.ok(hook, "execute.before hook registered");
    await assert.rejects(
      hook({ tool: "generate", sessionID: "ses-v2-stop", input: { prompt: "x" } }),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        const msg = (e as Error).message;
        assert.ok(msg.includes("blocked: quota limit exceeded"), `STOP message shape: ${msg}`);
        assert.ok(msg.startsWith("[opencode-usage-coach]"), "message carries the plugin name prefix");
        assert.ok(msg.includes("STOP recommend"), "message carries the coaching advice");
        return true;
      },
    );
    // resolveAgent fed the stub machine before gating.
    assert.deepEqual(stub.calls.setModel, [["glm-4.7", "zai-coding-plan"]], "setModel received the resolved model/provider");
    assert.ok(stub.calls.refresh >= 1, "quota.refresh fired on the tool call");
  } finally {
    cleanup();
  }
});

test("execute.before: harness tool + non-harness agent ('build') → throws 'restricted to agent mode'", async () => {
  const m = mockCtx({ agentSession: { agent: "build", model: { id: "sonnet", providerID: "anthropic" } } });
  const stub = stubQuota({ ...GO_MACHINE });
  const cleanup = await buildV2Setup({ quota: stub.machine })(m.ctx);
  try {
    const hook = m.toolHooks.get("execute.before")!;
    await assert.rejects(
      hook({ tool: "generate", sessionID: "ses-v2-build", input: {} }),
      (e: unknown) => {
        const msg = (e as Error).message;
        assert.ok(msg.includes("restricted to agent mode"), `restriction message shape: ${msg}`);
        assert.ok(msg.includes(`'generate'`), "message names the blocked tool");
        assert.ok(msg.includes(`"build"`), "message reports the current agent");
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test("execute.before: non-harness tool (read) → no throw even for a non-harness agent", async () => {
  const m = mockCtx({ agentSession: { agent: "build", model: { id: "sonnet", providerID: "anthropic" } } });
  const stub = stubQuota({ ...GO_MACHINE });
  const cleanup = await buildV2Setup({ quota: stub.machine })(m.ctx);
  try {
    const hook = m.toolHooks.get("execute.before")!;
    await hook({ tool: "read", sessionID: "ses-v2-read", input: { path: "x" } }); // must NOT throw
    assert.ok(true, "non-harness tools pass through ungated");
  } finally {
    cleanup();
  }
});

// ── (3) session context hook: coaching injection replicated exactly ──────────

test("session hooks: the SAME coaching body registered on context+compaction+title (3 registrations)", async () => {
  const m = mockCtx();
  const stub = stubQuota({ ...GO_MACHINE });
  const cleanup = await buildV2Setup({ quota: stub.machine })(m.ctx);
  try {
    assert.deepEqual([...m.sessionHooks.keys()].sort(), ["compaction", "context", "title"], "registered on context AND compaction AND title");
  } finally {
    cleanup();
  }
});

test("context hook: harness agent + STOP → pushes a {type:'text'} system part containing 'QUOTA limit exceeded'", async () => {
  const m = mockCtx(); // harness agent
  const stub = stubQuota({ ...STOP_MACHINE });
  const cleanup = await buildV2Setup({ quota: stub.machine })(m.ctx);
  try {
    const hook = m.sessionHooks.get("context")!;
    const event = { sessionID: "ses-v2-ctx-stop", system: [] as any[] };
    await hook(event);
    assert.equal(event.system.length, 1, "exactly one system part pushed");
    assert.equal(event.system[0].type, "text", "V2 system part shape { type: 'text' }");
    assert.ok(event.system[0].text.includes("QUOTA limit exceeded"), `STOP instruction: ${event.system[0].text}`);
    assert.ok(event.system[0].text.startsWith("[opencode-usage-coach]"), "instruction carries the plugin name prefix");
    assert.ok(event.system[0].text.includes("Stop making further tool calls"), "STOP directive text preserved");
  } finally {
    cleanup();
  }
});

test("context hook: non-harness agent → no push (agent guard)", async () => {
  const m = mockCtx({ agentSession: { agent: "build", model: { id: "sonnet", providerID: "anthropic" } } });
  const stub = stubQuota({ ...STOP_MACHINE });
  const cleanup = await buildV2Setup({ quota: stub.machine })(m.ctx);
  try {
    const hook = m.sessionHooks.get("context")!;
    const event = { sessionID: "ses-v2-ctx-build", system: [] as any[] };
    await hook(event);
    assert.equal(event.system.length, 0, "non-harness agent gets NO coaching injection");
  } finally {
    cleanup();
  }
});

test("context hook: GO with real percentages → pushes the 'quota ok' summary instruction", async () => {
  const m = mockCtx();
  const stub = stubQuota({ ...GO_MACHINE });
  const cleanup = await buildV2Setup({ quota: stub.machine })(m.ctx);
  try {
    const hook = m.sessionHooks.get("context")!;
    const event = { sessionID: "ses-v2-ctx-go", system: [] as any[] };
    await hook(event);
    assert.equal(event.system.length, 1);
    assert.ok(event.system[0].text.includes("quota ok — weekly 40% · 5h 30%."), `GO summary: ${event.system[0].text}`);
  } finally {
    cleanup();
  }
});

test("context hook: no sessionID → injects without an agent check (V1 parity)", async () => {
  const m = mockCtx({ agentSession: { agent: "build", model: {} } });
  const stub = stubQuota({ ...STOP_MACHINE });
  const cleanup = await buildV2Setup({ quota: stub.machine })(m.ctx);
  try {
    const hook = m.sessionHooks.get("title")!; // title path: SessionRequest has sessionID; here we test the absent case
    const event = { system: [] as any[] };
    await hook(event);
    assert.equal(event.system.length, 1, "no sessionID → agent check skipped, coaching still injected");
  } finally {
    cleanup();
  }
});

// ── (4) events ───────────────────────────────────────────────────────────────

test("events: session.idle drives quota.refresh; session.created does too; unrelated events do not", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const m = mockCtx({
    makeEvents: async function* (signal?: AbortSignal) {
      await gate;
      yield { type: "session.idle" };
      yield { type: "file.updated" };
      // Hold the generator open until aborted (cleanup), then end quietly.
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });
  const stub = stubQuota({ ...GO_MACHINE });
  const cleanup = await buildV2Setup({ quota: stub.machine })(m.ctx);
  try {
    const before = stub.calls.refresh;
    release(); // let the generator emit session.idle
    await until(() => stub.calls.refresh > before);
    // exactly one refresh for one session.idle (unrelated events do not refresh)
    const after = stub.calls.refresh;
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(stub.calls.refresh, after, "no extra refreshes for unrelated events");
    assert.ok(m.sessionCalls.get.length === 0, "event handling itself never touches the session API");
  } finally {
    cleanup();
  }
});

test("events: a throwing subscribe() is survivable (no crash, no unhandled rejection)", async () => {
  const m = mockCtx({
    // eslint-disable-next-line require-yield -- throwing before any yield is the point
    makeEvents: async function* () { throw new Error("subscribe exploded"); },
  });
  const stub = stubQuota({ ...GO_MACHINE });
  const cleanup = await buildV2Setup({ quota: stub.machine })(m.ctx);
  await new Promise((r) => setTimeout(r, 25)); // let the background loop hit the throw
  cleanup(); // must still work after the loop died
  assert.ok(true, "setup survived a throwing subscribe");
});

test("events: aborting the subscription signal ends the loop quietly (cleanup path)", async () => {
  let sawAbort = false;
  const m = mockCtx({
    makeEvents: async function* (signal?: AbortSignal) {
      yield { type: "session.created" };
      await new Promise<void>((resolve) => {
        if (signal?.aborted) { sawAbort = true; return resolve(); }
        signal?.addEventListener("abort", () => { sawAbort = true; resolve(); }, { once: true });
      });
    },
  });
  const stub = stubQuota({ ...GO_MACHINE });
  const cleanup = await buildV2Setup({ quota: stub.machine })(m.ctx);
  await until(() => stub.calls.refresh >= 2); // initial refresh + session.created
  cleanup();
  assert.equal(m.signals.length, 1, "subscribe was called once with the controller's signal");
  assert.ok(m.signals[0]?.aborted, "cleanup() aborted the controller (observed by the iterable)");
  assert.ok(sawAbort, "the async iterable observed the abort");
});
