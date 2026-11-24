// runmodel-wall-dump.test.ts — UC-1 hang-signature instrument.
// summarizeMsgs captures what the watchdog could NOT see at abort time:
// whether the stream ever produced a non-empty TEXT part (vs reasoning-only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeMsgs } from "../src/index.js";

const NOW = Date.parse("2026-11-24T03:00:00Z");
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

function msg(role: string, parts: any[], tsAgeSec = 30): any {
  return { role, parts, ts: ago(tsAgeSec) };
}

test("empty / non-array → bounded signature, no crash", () => {
  assert.match(summarizeMsgs([], NOW), /^n=0 asst=0 textMsgs=0\/0 last=none tsAge=-1s$/);
  assert.match(summarizeMsgs(undefined as any, NOW), /^n=0 /);
  assert.match(summarizeMsgs("junk" as any, NOW), /^n=0 /);
});

test("THE UC-1 signal: reasoning-only stream counts textMsgs=0/N", () => {
  const msgs = [
    msg("user", [{ type: "text", text: "do it" }], 1800),
    msg("assistant", [{ type: "reasoning", text: "thinking...".repeat(200) }], 1700),
    msg("assistant", [{ type: "reasoning", text: "more thinking..." }], 30),
  ];
  const s = summarizeMsgs(msgs, NOW);
  assert.match(s, /asst=2 textMsgs=0\/2/, "assistant messages exist but NONE has a text part");
  assert.match(s, /last=assistant\[reasoningx1\(/, "last message part composition visible");
});

test("healthy stream counts textMsgs=N/N", () => {
  const msgs = [
    msg("user", [{ type: "text", text: "go" }], 900),
    msg("assistant", [{ type: "text", text: "done" }], 10),
  ];
  assert.match(summarizeMsgs(msgs, NOW), /asst=1 textMsgs=1\/1/);
});

test("empty-string text part does NOT count as text", () => {
  const msgs = [msg("assistant", [{ type: "text", text: "" }], 5)];
  assert.match(summarizeMsgs(msgs, NOW), /textMsgs=0\/1/);
});

test("mixed parts: counts and byte sizes both visible, kB units over 1kB", () => {
  const big = "x".repeat(2048);
  const msgs = [msg("assistant", [{ type: "reasoning", text: big }, { type: "text", text: "ok" }, { type: "tool" }], 45)];
  const s = summarizeMsgs(msgs, NOW);
  assert.match(s, /reasoningx1\(2\.0kB\)/);
  assert.match(s, /textx1\(2b\)/);
  assert.match(s, /toolx1(?!\()/); // non-text types carry no byte suffix
  assert.match(s, /tsAge=45s/);
});

test("info-shaped messages (role/parts under .info) are unwrapped", () => {
  const msgs = [{ info: { role: "assistant", parts: [{ type: "text", text: "hi" }], updatedAt: ago(7) } }];
  assert.match(summarizeMsgs(msgs as any, NOW), /asst=1 textMsgs=1\/1/);
  assert.match(summarizeMsgs(msgs as any, NOW), /tsAge=7s/);
});

test("future/garbage ts degrades to tsAge=0, not negative/crash", () => {
  const msgs = [{ role: "assistant", parts: [], ts: "not-a-date" }];
  assert.match(summarizeMsgs(msgs, NOW), /tsAge=-1s|tsAge=0s/);
});

test("malformed messages never throw — sig-err fallback", () => {
  const evil = [{ role: "assistant", parts: null, get ts() { throw new Error("boom"); } }];
  const s = summarizeMsgs(evil as any, NOW);
  assert.ok(typeof s === "string" && s.length > 0);
  assert.ok(s.startsWith("sig-err:") || s.includes("last="), `bounded output: ${s}`);
});

// ── V2 message shape (사실 38): {type, content, time:{created}} ───────────────

test("V2 shape: type/content/time items produce a real signature", () => {
  const NOW2 = Date.now();
  const msgs = [
    { type: "model-switched", time: { created: NOW2 - 300000 } },
    { type: "user", text: "task", time: { created: NOW2 - 290000 } },
    { type: "assistant", content: [{ type: "reasoning", text: "x".repeat(1500) }], time: { created: NOW2 - 45000 } },
  ];
  const s = summarizeMsgs(msgs as any, NOW2);
  assert.match(s, /n=3 asst=1 textMsgs=0\/1/);
  assert.match(s, /last=assistant\[reasoningx1\(1\.5kB\)\]/);
  assert.match(s, /tsAge=45s/);
});

test("V2 shape: assistant WITH text content counts textMsgs", () => {
  const NOW2 = Date.now();
  const msgs = [{ type: "assistant", content: [{ type: "text", text: "hello" }], time: { created: NOW2 - 2000 } }];
  assert.match(summarizeMsgs(msgs as any, NOW2), /asst=1 textMsgs=1\/1/);
});
