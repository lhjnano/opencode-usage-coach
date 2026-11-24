// v2-shape-stall.test.ts — 사실 38 regression: V2 message shape + the lastTs
// per-poll refresh bug that made stall detection structurally unable to fire.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeV2SessionOps } from "../src/v2-session.js";
import { runModel } from "../src/index.js";
import { mkdirSync, readFileSync } from "node:fs";

// 1) messages() normalization: V2 items → canonical role/parts/ts
test("messages(): V2 {type,content,time} items normalized to role/parts/ts", async () => {
  const now = Date.now();
  const items = [
    { type: "model-switched", time: { created: now - 5000 } },
    { type: "user", text: "hi", time: { created: now - 4000 } },
    { type: "assistant", content: [{ type: "reasoning", text: "t" }], time: { created: now - 3000 } },
  ];
  const ops = makeV2SessionOps({ session: { context: async () => ({ data: items }) } } as any);
  const out = await ops.messages("s1");
  assert.equal(out[2].role, "assistant");
  assert.deepEqual(out[2].parts, [{ type: "reasoning", text: "t" }]);
  assert.ok(out[2].ts && Date.parse(out[2].ts) > 0, "time.created → ISO ts");
  assert.equal(out[1].role, "user");
});

test("messages(): V1-shaped items pass through untouched", async () => {
  const v1 = [{ role: "assistant", parts: [{ type: "text", text: "x" }], ts: "2026-01-01T00:00:00Z" }];
  const ops = makeV2SessionOps({ session: { context: async () => ({ data: v1 }) } } as any);
  const out = await ops.messages("s1");
  assert.deepEqual(out, v1);
});

// 2) THE stall regression: a stream with NO observable ts must NOT register as
// progress every poll. Before the fix, lastTs defaulted to now() per poll →
// step-limit and stall were both structurally blind → only the 30-min wall cut
// hangs (STALLED=0, WALL-CLOCK=202 — 사실 34/38).
test("runModel: no-ts V2 stream with UC_STALL_MIN=1 now fires STALLED (not wall-clock)", async () => {
  process.env.UC_STATE_DIR = "/tmp/opencode/uc-stalltest";
  process.env.UC_STALL_MIN = "1"; // 1분 무진행 → STALLED 경로
  mkdirSync("/tmp/opencode/uc-stalltest", { recursive: true });
  // NOTE: STALL_MS is module-level const read at import — the plugin process
  // reads it at startup. Here we re-import fresh with the env set (tsx caches
  // by URL; a query suffix forces a fresh module graph).
  const { runModel: rm } = await import(`/home/lhjnano/idea/opencode-usage-coach/src/index.js?stall=${Date.now()}`);
  const msgs = [
    { type: "model-switched", time: { created: Date.now() - 120000 } },
    { type: "user", text: "go", time: { created: Date.now() - 119000 } },
    { type: "assistant", content: [{ type: "reasoning", text: "stuck" }], time: { created: Date.now() - 118000 } },
  ];
  const session = {
    create: async () => "ses_stalltest",
    prompt: () => new Promise(() => {}), // never completes — hang
    messages: async () => msgs,          // FROZEN stream: nothing ever changes
    abort: async () => {},
    delete: async () => {},
    get: async () => null,
  };
  const t0 = Date.now();
  const out = await rm(session, "zai-coding-plan/glm-test", "stall-verification", "/tmp/opencode/uc-stalltest");
  const secs = Math.round((Date.now() - t0) / 1000);
  assert.ok(out.startsWith("ERROR: stalled"), `must take the STALLED branch, got: ${out.split("\n")[0].slice(0, 80)}`);
  assert.ok(secs < 120, `should abort around STALL_MIN=1min, took ${secs}s`);
  // runModel logs via the module-level STATE_DIR (setStateDir is a plugin-init
  // concern), so the line lands in the global coach.log — find it by session id.
  const { homedir } = await import("node:os");
  const { join: j } = await import("node:path");
  const glog = readFileSync(j(homedir(), ".cache", "opencode-usage-coach", "coach.log"), "utf8");
  const mine = glog.split("\n").filter((l) => l.includes("ses_stalltest"));
  assert.ok(mine.some((l) => l.includes("STALLED")), "STALLED line logged");
  const dump = mine.find((l) => l.includes("WALLDUMP"));
  assert.ok(dump && dump.includes("WALLDUMP[n=3 asst=1"), `WALLDUMP carries the frozen V2 signature: ${dump?.match(/WALLDUMP\[[^\]]*\]/)?.[0]}`);
});
