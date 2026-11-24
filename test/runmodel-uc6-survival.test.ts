// runmodel-uc6-survival.test.ts — UC-6 (사실 40): declared-file side effects keep
// a frozen marathon turn alive. Frozen transcript + file touches every 20s under
// UC_STALL_MIN=1 must NOT fire STALLED; the same stream without files is proven
// to STALL by v2-shape-stall.test.ts (the negative control).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as j } from "node:path";

process.env.UC_STALL_MIN = "1";
const DIR = "/tmp/opencode/uc-uc6test";
mkdirSync(DIR, { recursive: true });
const OUT = j(DIR, "out.md");
writeFileSync(OUT, "seed");

test("UC-6: frozen transcript + touching declared file survives past STALL_MIN", async () => {
  const { runModel } = await import(new URL(`../src/index.js?uc6=${Date.now()}`, import.meta.url).href);
  const frozen = [
    { type: "model-switched", time: { created: Date.now() - 200000 } },
    { type: "user", text: "marathon", time: { created: Date.now() - 199000 } },
    { type: "assistant", content: [{ type: "reasoning", text: "" }], time: { created: Date.now() - 198000 } },
  ];
  let resolvePrompt!: (v: any) => void;
  const promptP = new Promise<any>((res) => { resolvePrompt = res; });
  const session = {
    create: async () => "ses_uc6",
    prompt: () => promptP, // marathon: completes only when we say so (t=85s)
    messages: async () => frozen, // transcript frozen the whole time
    abort: async () => { throw new Error("must not be called"); },
    delete: async () => {},
    get: async () => null,
  };
  // Side effects: touch the declared file every 20s (worker writing in bursts)
  const touch = setInterval(() => {
    const now = new Date();
    utimesSync(OUT, now, now);
  }, 20_000);
  const t0 = Date.now();
  const done = runModel(session, "zai-coding-plan/glm-test", "marathon task", DIR, undefined, 30, undefined, ["out.md"]);
  setTimeout(() => resolvePrompt({ data: { parts: [{ type: "text", text: "marathon completed" }] } }), 85_000);
  const out = await done;
  clearInterval(touch);
  const secs = Math.round((Date.now() - t0) / 1000);
  assert.ok(!out.startsWith("ERROR: stalled"), `frozen+files must survive, got: ${out.split("\n")[0].slice(0, 60)}`);
  assert.ok(secs >= 80, `ran to our controlled completion (${secs}s), not an early abort`);
  assert.match(out, /marathon completed/);
  const glog = readFileSync(j(homedir(), ".cache", "opencode-usage-coach", "coach.log"), "utf8");
  const mine = glog.split("\n").filter((l) => l.includes("UC-6 file progress") && l.includes("glm-test"));
  assert.ok(mine.length >= 2, `file-progress resets are logged (${mine.length} found)`);
  const mineSes = glog.split("\n").filter((l) => l.includes("ses_uc6"));
  assert.ok(mineSes.some((l) => l.includes("session ses_uc6 created")), "session created lines present");
  assert.ok(!mineSes.some((l) => l.includes("STALLED")), "no stall fired for this session");
});
