// v2-session.test.ts — makeV2SessionOps: the V2 adapter for the SessionOps facade.
// Verifies the full contract with a hand-rolled mock ctx (plain object, async fns
// recording every call + a global order log): flat `{ sessionID }` wire payloads,
// the prompt→wait→context completion sequence (switchModel BEFORE prompt),
// LAST-assistant-message selection, parts synthesis, array normalization,
// error swallowing, and generate.text splitting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeV2SessionOps } from "../src/v2-session.js";
import type { SessionOps } from "../src/rt.js";

// ── Mock ctx ─────────────────────────────────────────────────────────────────
// Builds `ctx.session.<m>` / `ctx.generate.<m>` from an impl table keyed by
// "<ns>.<method>". Each impl's single arg is recorded; its return value (or
// throw) becomes the method's async result. `order` records the cross-method
// call sequence (how "switchModel before prompt" is asserted).
function mockCtx(methods: Record<string, (arg: any) => any> = {}): { ctx: any; calls: Record<string, any[]>; order: string[] } {
  const calls: Record<string, any[]> = {};
  const order: string[] = [];
  const ctx: any = { session: {}, generate: {} };
  for (const [name, impl] of Object.entries(methods)) {
    calls[name] = [];
    const [ns, fn] = name.split(".");
    ctx[ns][fn] = (arg: any) => {
      calls[name].push(arg);
      order.push(name);
      return Promise.resolve().then(() => impl(arg));
    };
  }
  return { ctx, calls, order };
}

// ── create ───────────────────────────────────────────────────────────────────

test("create: unwraps bare { id } and sends { title } only — no directory key on the wire", async () => {
  const { ctx, calls } = mockCtx({ "session.create": () => ({ id: "ses_1" }) });
  const ops = makeV2SessionOps(ctx);
  assert.equal(await ops.create("/work/dir", "uc-harness-sub"), "ses_1");
  assert.deepEqual(calls["session.create"], [{ title: "uc-harness-sub" }]);
  assert.ok(!("directory" in calls["session.create"][0]), "V2 create must not send a directory query");
});

test("create: unwraps { data: { id } } when the id lives under data", async () => {
  const { ctx } = mockCtx({ "session.create": () => ({ data: { id: "ses_2" } }) });
  assert.equal(await makeV2SessionOps(ctx).create("/d", "t"), "ses_2");
});

test("create: throws `session.create returned no id` with the response snippet (sliced to 200)", async () => {
  const { ctx } = mockCtx({ "session.create": () => ({ data: "x".repeat(300) }) });
  await assert.rejects(
    makeV2SessionOps(ctx).create("/d", "t"),
    (e: unknown) => {
      assert.ok(e instanceof Error, "must throw an Error");
      const msg = (e as Error).message;
      assert.ok(msg.startsWith("session.create returned no id (response: "), `bad prefix: ${msg.slice(0, 60)}`);
      assert.ok(msg.includes("x".repeat(199)), "snippet must carry the 200-char slice of the response");
      assert.ok(!msg.includes("x".repeat(201)), "snippet must be truncated to 200 chars");
      return true;
    },
  );
});

test("create: empty response {} yields `{}` in the error snippet", async () => {
  const { ctx } = mockCtx({ "session.create": () => ({}) });
  await assert.rejects(
    makeV2SessionOps(ctx).create("/d", "t"),
    /session\.create returned no id \(response: \{\}\)$/,
  );
});

// ── prompt (admission → wait → context → V1-shaped completion) ───────────────

test("prompt: full sequence — switchModel(providerID,id) BEFORE prompt, then wait, then context; exact wire args", async () => {
  const { ctx, calls, order } = mockCtx({
    "session.switchModel": () => ({}),
    "session.prompt": () => ({ type: "message" }), // admission inbox item, NOT completion
    "session.wait": () => ({}),
    "session.context": () => [{ role: "assistant", parts: [{ type: "text", text: "done" }] }],
  });
  const ops = makeV2SessionOps(ctx);
  const resp = await ops.prompt("ses_9", "anthropic", "claude-sonnet-4", "hello world");
  assert.deepEqual(calls["session.switchModel"],
    [{ sessionID: "ses_9", model: { providerID: "anthropic", id: "claude-sonnet-4" } }]);
  assert.deepEqual(calls["session.prompt"], [{ sessionID: "ses_9", text: "hello world" }]);
  assert.deepEqual(calls["session.wait"], [{ sessionID: "ses_9" }]);
  assert.deepEqual(calls["session.context"], [{ sessionID: "ses_9" }]);
  // Ordering: model must be selected before the message is admitted; wait before context.
  assert.ok(order.indexOf("session.switchModel") < order.indexOf("session.prompt"),
    `switchModel must precede prompt (order: ${order.join(" → ")})`);
  assert.ok(order.indexOf("session.prompt") < order.indexOf("session.wait"),
    `prompt must precede wait (order: ${order.join(" → ")})`);
  assert.ok(order.indexOf("session.wait") < order.indexOf("session.context"),
    `wait must precede context (order: ${order.join(" → ")})`);
  assert.deepEqual(resp, { data: { parts: [{ type: "text", text: "done" }] } });
});

test("prompt: returns parts of the LAST assistant message when several exist (not the first)", async () => {
  const { ctx } = mockCtx({
    "session.switchModel": () => ({}),
    "session.prompt": () => ({}),
    "session.wait": () => ({}),
    "session.context": () => [
      { role: "user", parts: [{ type: "text", text: "q1" }] },
      { role: "assistant", parts: [{ type: "text", text: "FIRST answer" }] },
      { role: "user", parts: [{ type: "text", text: "q2" }] },
      { role: "assistant", parts: [{ type: "text", text: "LAST answer" }] },
    ],
  });
  const resp = await makeV2SessionOps(ctx).prompt("s", "p", "m", "t");
  assert.deepEqual(resp, { data: { parts: [{ type: "text", text: "LAST answer" }] } });
});

test("prompt: probes role/parts through the .info wrapper shape", async () => {
  const { ctx } = mockCtx({
    "session.switchModel": () => ({}),
    "session.prompt": () => ({}),
    "session.wait": () => ({}),
    "session.context": () => [
      { info: { role: "user", parts: [] } },
      { info: { role: "assistant", parts: [{ type: "text", text: "via info" }] } },
    ],
  });
  const resp = await makeV2SessionOps(ctx).prompt("s", "p", "m", "t");
  assert.deepEqual(resp, { data: { parts: [{ type: "text", text: "via info" }] } });
});

test("prompt: synthesizes a text part when the assistant message has no parts array but carries .text", async () => {
  const { ctx } = mockCtx({
    "session.switchModel": () => ({}),
    "session.prompt": () => ({}),
    "session.wait": () => ({}),
    "session.context": () => [{ role: "assistant", text: "bare text field" }],
  });
  const resp = await makeV2SessionOps(ctx).prompt("s", "p", "m", "t");
  assert.deepEqual(resp, { data: { parts: [{ type: "text", text: "bare text field" }] } });
});

test("prompt: synthesis probes .info.text when the bare .text field is absent", async () => {
  const { ctx } = mockCtx({
    "session.switchModel": () => ({}),
    "session.prompt": () => ({}),
    "session.wait": () => ({}),
    "session.context": () => [{ role: "assistant", info: { role: "assistant", text: "nested text" } }],
  });
  const resp = await makeV2SessionOps(ctx).prompt("s", "p", "m", "t");
  assert.deepEqual(resp, { data: { parts: [{ type: "text", text: "nested text" }] } });
});

test("prompt: no assistant message in the transcript → { data: { parts: [] } } (V1-shaped empty completion)", async () => {
  const { ctx } = mockCtx({
    "session.switchModel": () => ({}),
    "session.prompt": () => ({}),
    "session.wait": () => ({}),
    "session.context": () => [{ role: "user", parts: [{ type: "text", text: "q" }] }],
  });
  assert.deepEqual(await makeV2SessionOps(ctx).prompt("s", "p", "m", "t"), { data: { parts: [] } });
});

test("prompt: empty transcript → { data: { parts: [] } }", async () => {
  const { ctx } = mockCtx({
    "session.switchModel": () => ({}),
    "session.prompt": () => ({}),
    "session.wait": () => ({}),
    "session.context": () => [],
  });
  assert.deepEqual(await makeV2SessionOps(ctx).prompt("s", "p", "m", "t"), { data: { parts: [] } });
});

test("prompt: switchModel rejects → prompt rejects (no swallowing, context never called)", async () => {
  const { ctx, calls } = mockCtx({
    "session.switchModel": () => { throw new Error("switchModel boom"); },
    "session.prompt": () => ({}),
    "session.wait": () => ({}),
    "session.context": () => [],
  });
  await assert.rejects(makeV2SessionOps(ctx).prompt("s", "p", "m", "t"), /switchModel boom/);
  assert.equal(calls["session.context"].length, 0, "context must not be fetched after the failure");
});

test("prompt: wait rejects → prompt rejects (completion failure propagates)", async () => {
  const { ctx } = mockCtx({
    "session.switchModel": () => ({}),
    "session.prompt": () => ({}),
    "session.wait": () => { throw new Error("wait boom"); },
    "session.context": () => [],
  });
  await assert.rejects(makeV2SessionOps(ctx).prompt("s", "p", "m", "t"), /wait boom/);
});

// ── messages ─────────────────────────────────────────────────────────────────

test("messages: normalizes a bare readonly array to a fresh mutable copy", async () => {
  const list: readonly any[] = [{ role: "user" }, { role: "assistant" }];
  const { ctx, calls } = mockCtx({ "session.context": () => list });
  const ops = makeV2SessionOps(ctx);
  const out = await ops.messages("ses_m");
  assert.deepEqual(out, [{ role: "user" }, { role: "assistant" }]);
  assert.notEqual(out, list, "readonly input must be copied (slice), not passed through");
  assert.deepEqual(calls["session.context"], [{ sessionID: "ses_m" }]);
});

test("messages: normalizes { data: [...] }-wrapped responses to the inner array", async () => {
  const list = [{ role: "user", text: "q" }];
  const { ctx } = mockCtx({ "session.context": () => ({ data: list }) });
  assert.deepEqual(await makeV2SessionOps(ctx).messages("s"), list);
});

test("messages: undefined / non-array response → []", async () => {
  const cUndef = mockCtx({ "session.context": () => undefined }).ctx;
  const cObj = mockCtx({ "session.context": () => ({ nope: true }) }).ctx;
  assert.deepEqual(await makeV2SessionOps(cUndef).messages("s"), []);
  assert.deepEqual(await makeV2SessionOps(cObj).messages("s"), []);
});

// ── abort / delete (error swallowing) ────────────────────────────────────────

test("abort: sends interrupt { sessionID, continue: false } and resolves even when ctx rejects", async () => {
  const { ctx, calls } = mockCtx({ "session.interrupt": () => { throw new Error("interrupt boom"); } });
  const ops = makeV2SessionOps(ctx);
  assert.equal(await ops.abort("ses_a"), undefined, "must resolve, not reject");
  assert.deepEqual(calls["session.interrupt"], [{ sessionID: "ses_a", continue: false }]);
});

test("delete: sends remove { sessionID } and resolves even when ctx rejects", async () => {
  const { ctx, calls } = mockCtx({ "session.remove": () => { throw new Error("remove boom"); } });
  const ops = makeV2SessionOps(ctx);
  assert.equal(await ops.delete("ses_d"), undefined, "must resolve, not reject");
  assert.deepEqual(calls["session.remove"], [{ sessionID: "ses_d" }]);
});

// ── get ──────────────────────────────────────────────────────────────────────

test("get: unwraps { data } and passes bare SessionInfo through", async () => {
  const info = { id: "s", agent: "build", model: { providerID: "p", id: "m" } };
  const cWrapped = mockCtx({ "session.get": () => ({ data: info }) }).ctx;
  const cBare = mockCtx({ "session.get": () => info }).ctx;
  assert.equal(await makeV2SessionOps(cWrapped).get("s"), info, "data-unwrapped");
  assert.equal(await makeV2SessionOps(cBare).get("s"), info, "bare passthrough");
});

test("get: null-safe — undefined/null responses become null", async () => {
  const cUndef = mockCtx({ "session.get": () => undefined }).ctx;
  const cNull = mockCtx({ "session.get": () => null }).ctx;
  assert.equal(await makeV2SessionOps(cUndef).get("s"), null);
  assert.equal(await makeV2SessionOps(cNull).get("s"), null);
});

test("get: sends { sessionID } and rejects propagate (no swallowing)", async () => {
  const { ctx, calls } = mockCtx({ "session.get": () => { throw new Error("get boom"); } });
  await assert.rejects(makeV2SessionOps(ctx).get("ses_g"), /get boom/);
  assert.deepEqual(calls["session.get"], [{ sessionID: "ses_g" }]);
});

// ── generateText ─────────────────────────────────────────────────────────────

test("generateText: splits 'provider/model' into { model: { providerID, id } } and returns r.text", async () => {
  const { ctx, calls } = mockCtx({ "generate.text": () => ({ text: "gen result" }) });
  const ops = makeV2SessionOps(ctx);
  assert.equal(await ops.generateText!("anthropic/claude-sonnet-4", "hi"), "gen result");
  assert.deepEqual(calls["generate.text"],
    [{ model: { providerID: "anthropic", id: "claude-sonnet-4" }, prompt: "hi" }]);
});

test("generateText: probes r.data.text when the bare .text field is absent", async () => {
  const { ctx } = mockCtx({ "generate.text": () => ({ data: { text: "wrapped" } }) });
  assert.equal(await makeV2SessionOps(ctx).generateText!("p/m", "hi"), "wrapped");
});

test("generateText: missing text fields resolve to empty string (never undefined)", async () => {
  const { ctx } = mockCtx({ "generate.text": () => ({}) });
  assert.equal(await makeV2SessionOps(ctx).generateText!("p/m", "hi"), "");
});

test("generateText: model without a slash → providerID carries the whole string, id empty", async () => {
  const { ctx, calls } = mockCtx({ "generate.text": () => ({ text: "x" }) });
  await makeV2SessionOps(ctx).generateText!("openrouter", "hi");
  assert.deepEqual(calls["generate.text"], [{ model: { providerID: "openrouter", id: "" }, prompt: "hi" }]);
});

// ── facade shape ─────────────────────────────────────────────────────────────

test("makeV2SessionOps: omits summarize (not in the V2 domain) — `?.` call sites see undefined", async () => {
  const ops: SessionOps = makeV2SessionOps(mockCtx({}).ctx);
  // Optional-call assert runs FIRST: assert.equal's `asserts actual is T`
  // signature would otherwise narrow the member to undefined for later lines.
  assert.equal(await ops.summarize?.("s"), undefined, "optional call must be a no-op");
  assert.equal(ops.summarize, undefined, "V2 adapter must not define summarize");
});

test("makeV2SessionOps: returns every required SessionOps member bound to the given ctx", async () => {
  const { ctx, calls } = mockCtx({
    "session.create": () => ({ id: "wire" }),
    "session.switchModel": () => ({}),
    "session.prompt": () => ({}),
    "session.wait": () => ({}),
    "session.context": () => [],
    "session.interrupt": () => ({}),
    "session.remove": () => ({}),
    "session.get": () => ({ agent: "a" }),
    "generate.text": () => ({ text: "t" }),
  });
  const ops = makeV2SessionOps(ctx);
  await Promise.all([
    ops.create("/d", "t"), ops.prompt("s", "p", "m", "x"), ops.messages("s"),
    ops.abort("s"), ops.delete("s"), ops.get("s"), ops.generateText!("p/m", "x"),
  ]);
  assert.deepEqual(Object.keys(calls).sort(),
    ["generate.text", "session.context", "session.create", "session.get",
      "session.interrupt", "session.prompt", "session.remove", "session.switchModel", "session.wait"]);
});
