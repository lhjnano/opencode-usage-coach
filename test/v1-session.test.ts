// v1-session.test.ts — makeV1SessionOps: the V1 adapter for the SessionOps facade.
// Verifies the full contract with a hand-rolled mock client (plain object, async
// fns recording every call): response-shape unwrapping, exact wire payloads,
// array normalization, error swallowing, and optional-method behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeV1SessionOps } from "../src/v1-session.js";
import type { SessionOps } from "../src/rt.js";

// ── Mock client ──────────────────────────────────────────────────────────────
// Builds `client.session.<method>` from an impl table. Each impl's single arg is
// recorded; its return value (or throw) becomes the method's async result.
// Methods NOT listed in `methods` are simply absent from client.session — that
// is how the optionality (`?.`) paths get exercised.
function mockClient(methods: Record<string, (arg: any) => any> = {}): { client: any; calls: Record<string, any[]> } {
  const calls: Record<string, any[]> = {};
  const client: any = { session: {} };
  for (const [name, impl] of Object.entries(methods)) {
    calls[name] = [];
    client.session[name] = (arg: any) => {
      calls[name].push(arg);
      return Promise.resolve().then(() => impl(arg));
    };
  }
  return { client, calls };
}

// ── create ───────────────────────────────────────────────────────────────────

test("create: unwraps { data: { info: { id } } } and sends exact body/query", async () => {
  const { client, calls } = mockClient({ create: () => ({ data: { info: { id: "ses_1" } } }) });
  const ops = makeV1SessionOps(client);
  const id = await ops.create("/work/dir", "uc-harness-sub");
  assert.equal(id, "ses_1");
  assert.deepEqual(calls.create, [{ body: { title: "uc-harness-sub" }, query: { directory: "/work/dir" } }]);
});

test("create: unwraps { data: { id } } when info is absent", async () => {
  const { client } = mockClient({ create: () => ({ data: { id: "ses_2" } }) });
  assert.equal(await makeV1SessionOps(client).create("/d", "t"), "ses_2");
});

test("create: unwraps bare { id } when data is absent", async () => {
  const { client } = mockClient({ create: () => ({ id: "ses_3" }) });
  assert.equal(await makeV1SessionOps(client).create("/d", "t"), "ses_3");
});

test("create: throws `session.create returned no id` with the response snippet (sliced to 200)", async () => {
  const { client } = mockClient({ create: () => ({ data: "x".repeat(300) }) });
  await assert.rejects(
    makeV1SessionOps(client).create("/d", "t"),
    (e: unknown) => {
      assert.ok(e instanceof Error, "must throw an Error");
      const msg = e.message;
      assert.ok(msg.startsWith("session.create returned no id (response: "), `bad prefix: ${msg.slice(0, 60)}`);
      // JSON.stringify(data).slice(0, 200) => a quote + 199 x's — never the full 300.
      assert.ok(msg.includes("x".repeat(199)), "snippet must carry the 200-char slice of the response");
      assert.ok(!msg.includes("x".repeat(201)), "snippet must be truncated to 200 chars");
      return true;
    },
  );
});

test("create: empty response {} yields `{}` in the error snippet", async () => {
  const { client } = mockClient({ create: () => ({}) });
  await assert.rejects(
    makeV1SessionOps(client).create("/d", "t"),
    /session\.create returned no id \(response: \{\}\)$/,
  );
});

// ── prompt ───────────────────────────────────────────────────────────────────

test("prompt: sends providerID/modelID split + parts text exactly, resolves with the FULL response", async () => {
  const full = { data: { parts: [{ type: "text", text: "ok" }] } };
  const { client, calls } = mockClient({ prompt: () => full });
  const ops = makeV1SessionOps(client);
  const resp = await ops.prompt("ses_9", "anthropic", "claude-sonnet-4", "hello world");
  assert.deepEqual(calls.prompt, [{
    path: { id: "ses_9" },
    body: { model: { providerID: "anthropic", modelID: "claude-sonnet-4" }, parts: [{ type: "text", text: "hello world" }] },
  }]);
  assert.equal(resp, full, "facade must pass the raw response object through untouched");
});

test("prompt: rejects when the underlying client rejects (no swallowing)", async () => {
  const { client } = mockClient({ prompt: () => { throw new Error("prompt boom"); } });
  await assert.rejects(makeV1SessionOps(client).prompt("s", "p", "m", "t"), /prompt boom/);
});

// ── messages ─────────────────────────────────────────────────────────────────

test("messages: normalizes { data: [...] } to the inner array", async () => {
  const list = [{ role: "user" }, { role: "assistant" }];
  const { client } = mockClient({ messages: () => ({ data: list }) });
  assert.equal(await makeV1SessionOps(client).messages("s"), list);
});

test("messages: normalizes a bare [...] to itself", async () => {
  const list = [{ role: "user" }];
  const { client } = mockClient({ messages: () => list });
  assert.equal(await makeV1SessionOps(client).messages("s"), list);
});

test("messages: undefined response → []", async () => {
  const { client } = mockClient({ messages: () => undefined });
  assert.deepEqual(await makeV1SessionOps(client).messages("s"), []);
});

test("messages: method absent from client.session → [] (optionality preserved)", async () => {
  const { client } = mockClient({}); // no messages method at all
  assert.deepEqual(await makeV1SessionOps(client).messages("s"), []);
});

test("messages: sends { path: { id } }", async () => {
  const { client, calls } = mockClient({ messages: () => [] });
  await makeV1SessionOps(client).messages("ses_m");
  assert.deepEqual(calls.messages, [{ path: { id: "ses_m" } }]);
});

// ── abort / delete (error swallowing) ────────────────────────────────────────

test("abort: resolves (undefined) even when the client rejects", async () => {
  const { client, calls } = mockClient({ abort: () => { throw new Error("abort boom"); } });
  const ops = makeV1SessionOps(client);
  assert.equal(await ops.abort("ses_a"), undefined, "must resolve, not reject");
  assert.deepEqual(calls.abort, [{ path: { id: "ses_a" } }]);
});

test("abort: method absent from client.session → resolves", async () => {
  const { client } = mockClient({});
  assert.equal(await makeV1SessionOps(client).abort("s"), undefined);
});

test("delete: resolves (undefined) even when the client rejects", async () => {
  const { client, calls } = mockClient({ delete: () => { throw new Error("delete boom"); } });
  const ops = makeV1SessionOps(client);
  assert.equal(await ops.delete("ses_d"), undefined, "must resolve, not reject");
  assert.deepEqual(calls.delete, [{ path: { id: "ses_d" } }]);
});

test("delete: method absent from client.session → resolves", async () => {
  const { client } = mockClient({});
  assert.equal(await makeV1SessionOps(client).delete("s"), undefined);
});

// ── get ──────────────────────────────────────────────────────────────────────

test("get: unwraps all 4 shapes (data.info → data → info → bare)", async () => {
  const info1 = { agent: "build", model: "m1" };
  const data2 = { agent: "plan" };
  const info3 = { agent: "general" };
  const bare4 = { id: "s", agent: "usage" };

  const c1 = mockClient({ get: () => ({ data: { info: info1 } }) }).client;
  const c2 = mockClient({ get: () => ({ data: data2 }) }).client;
  const c3 = mockClient({ get: () => ({ info: info3 }) }).client;
  const c4 = mockClient({ get: () => bare4 }).client;

  assert.equal(await makeV1SessionOps(c1).get("s"), info1, "data.info wins");
  assert.equal(await makeV1SessionOps(c2).get("s"), data2, "data fallback when info missing");
  assert.equal(await makeV1SessionOps(c3).get("s"), info3, "top-level info fallback");
  assert.equal(await makeV1SessionOps(c4).get("s"), bare4, "bare object passthrough");
});

test("get: data.info = null falls through to data (nullish-coalescing precedence)", async () => {
  const data = { info: null, agent: "x" };
  const { client } = mockClient({ get: () => ({ data }) });
  assert.equal(await makeV1SessionOps(client).get("s"), data);
});

test("get: null when the response is null/undefined", async () => {
  const cUndef = mockClient({ get: () => undefined }).client;
  const cNull = mockClient({ get: () => null }).client;
  assert.equal(await makeV1SessionOps(cUndef).get("s"), null);
  assert.equal(await makeV1SessionOps(cNull).get("s"), null);
});

test("get: sends { path: { id } } and rejects propagate (no swallowing)", async () => {
  const { client, calls } = mockClient({ get: () => { throw new Error("get boom"); } });
  await assert.rejects(makeV1SessionOps(client).get("ses_g"), /get boom/);
  assert.deepEqual(calls.get, [{ path: { id: "ses_g" } }]);
});

// ── summarize ────────────────────────────────────────────────────────────────

test("summarize: passthrough of the raw response + exact path arg", async () => {
  const raw = { data: { summary: "done" } };
  const { client, calls } = mockClient({ summarize: () => raw });
  const ops = makeV1SessionOps(client);
  assert.equal(await ops.summarize!("ses_z"), raw, "must return the raw response object");
  assert.deepEqual(calls.summarize, [{ path: { id: "ses_z" } }]);
});

test("summarize: method absent from client.session → resolves undefined (guarded `?.` semantics)", async () => {
  const { client } = mockClient({}); // no summarize method
  const ops = makeV1SessionOps(client);
  assert.equal(await ops.summarize!("s"), undefined);
});

test("summarize: a SessionOps implementation may omit the method entirely (`?.` at call sites)", async () => {
  // Contract check from the consumer side: index.ts calls `session.summarize?.(id)`
  // guarded by `if (session.summarize)` — an adapter without the method must be valid.
  // (The optional-call assert runs FIRST: assert.equal's `asserts actual is T`
  // signature would otherwise narrow the member to undefined for later lines.)
  const minimal: SessionOps = {
    async create() { return "s"; },
    async prompt() { return {}; },
    async messages() { return []; },
    async abort() { /* */ },
    async delete() { /* */ },
    async get() { return null; },
  };
  assert.equal(await minimal.summarize?.("s"), undefined);
  assert.equal(minimal.summarize, undefined);
});

// ── facade shape ─────────────────────────────────────────────────────────────

test("makeV1SessionOps: returns every SessionOps member bound to the given client", async () => {
  const { client, calls } = mockClient({
    create: () => ({ id: "wire" }),
    prompt: () => ({}),
    messages: () => [],
    abort: () => ({}),
    delete: () => ({}),
    get: () => ({ agent: "a" }),
    summarize: () => ({}),
  });
  const ops = makeV1SessionOps(client);
  await Promise.all([
    ops.create("/d", "t"), ops.prompt("s", "p", "m", "x"), ops.messages("s"),
    ops.abort("s"), ops.delete("s"), ops.get("s"), ops.summarize!("s"),
  ]);
  assert.deepEqual(Object.keys(calls).sort(),
    ["abort", "create", "delete", "get", "messages", "prompt", "summarize"]);
});
