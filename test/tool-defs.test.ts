// tool-defs.test.ts — rigorous tests for the version-agnostic tool definitions.
// Structural guarantees (16 defs, names, schemas, protocol descriptions) plus
// behavioral execution through the ToolHost bridge with fully isolated state
// (UC_STATE_DIR/setStateDir pattern from tool-lifecycle.test.ts, plus a fake
// HOME so readHarnessCfg never sees the developer's real global config).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { buildToolDefs, type ToolHost, type ToolDef } from "../src/tool-defs.js";
import { TOOL_NAMES, TOOL_SCHEMAS } from "../src/tool-schemas.js";
import { UsageCoachPlugin } from "../src/index.js";
import { setStateDir, readHarness } from "../src/index.js";
import { initDomain } from "../src/domain.js";
import type { SessionOps } from "../src/rt.js";
import { readFileSync as readSrc } from "node:fs";
import { fileURLToPath } from "node:url";

// ── Setup: isolated state dir + isolated HOME (readHarnessCfg global path) ──

let stateDir: string;
let workDir: string;
let fakeHome: string;
const realHome = process.env.HOME;

/** Deterministic fake SessionOps — no model calls happen in these tests,
 *  but the host must be complete so any accidental runModel path fails loudly
 *  with a recognizable marker instead of touching the network. */
function fakeSessionOps(): SessionOps {
  return {
    async create() { return "fake-sub-session"; },
    async prompt() { throw new Error("fake SessionOps: prompt must not be called in these tests"); },
    async messages() { return []; },
    async abort() { /* */ },
    async delete() { /* */ },
    async get() { return null; },
  };
}

function makeHost(directory: string): ToolHost {
  return {
    rt: { directory, session: fakeSessionOps() },
    current: () => ({ decision: "GO", advice: "", weekly: -1, monthly: -1, fiveHour: -1 }),
    refresh() { /* no-op in tests */ },
  };
}

let host: ToolHost;

before(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "uc-defs-home-"));
  process.env.HOME = fakeHome; // isolate readHarnessCfg's ~/.config lookup
  stateDir = mkdtempSync(join(tmpdir(), "uc-defs-state-"));
  process.env.UC_STATE_DIR = stateDir;
  setStateDir(stateDir);
  initDomain(stateDir); // applyReward writes into STATE_DIR/shared
  workDir = mkdtempSync(join(tmpdir(), "uc-defs-work-"));
  // grade_batch requires a configured model even on the deterministic-checks
  // path (checked before gradeOne) — provide one via the workdir config.
  writeFileSync(join(workDir, "harness.config.json"), JSON.stringify({ generator: "fake/gen", grader: "fake/grader" }));
  host = makeHost(workDir);
});

after(() => {
  process.env.HOME = realHome;
  delete process.env.UC_STATE_DIR;
  for (const d of [fakeHome, stateDir, workDir]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
  }
});

function byName(name: string): ToolDef {
  const def = buildToolDefs().find((d) => d.name === name);
  assert.ok(def, `def ${name} must exist`);
  return def!;
}

// ── Structural guarantees ────────────────────────────────────────────────────

test("buildToolDefs returns exactly 16 defs, name-set equal to TOOL_NAMES", () => {
  const defs = buildToolDefs();
  assert.equal(defs.length, 16, "exactly 16 tool defs");
  assert.deepEqual([...defs.map((d) => d.name)].sort(), [...TOOL_NAMES].sort(), "name set equals TOOL_NAMES");
});

test("every def: async execute fn, full protocol description, schema identity with TOOL_SCHEMAS", () => {
  for (const def of buildToolDefs()) {
    assert.equal(typeof def.execute, "function", `${def.name}: execute is a function`);
    assert.equal(def.execute.constructor.name, "AsyncFunction", `${def.name}: execute is an async function`);
    // Full protocol text — guards against regressions to one-liner descriptions.
    // (harness_done's genuine V1 protocol text is 55 chars — the one exception.)
    assert.ok(
      def.description.length >= 60 || def.name === "harness_done",
      `${def.name}: description >= 60 chars (got ${def.description.length}: ${JSON.stringify(def.description.slice(0, 60))})`,
    );
    // Single source: schema is the SAME object as TOOL_SCHEMAS' entry.
    assert.equal(def.schema, TOOL_SCHEMAS[def.name].schema, `${def.name}: schema object identity with TOOL_SCHEMAS`);
    assert.equal(def.description, TOOL_SCHEMAS[def.name].description, `${def.name}: description identical to TOOL_SCHEMAS`);
  }
});

test("harness_done description is its exact (short) protocol text", () => {
  assert.equal(byName("harness_done").description, "Mark the harness as complete — call when the loop ends.");
});

test("description protocol spot-checks (quota / PASS/FAIL / revising / unknown_scan)", () => {
  assert.ok(/quota/i.test(byName("generate").description), "generate description mentions quota");
  assert.ok(byName("grade").description.includes("PASS/FAIL"), "grade description mentions PASS/FAIL");
  assert.ok(byName("task_update").description.includes("revising"), "task_update description mentions revising");
  // harness_start's unknown_scan guidance lives in its RETURN text (DIAGNOSIS
  // GATE banner), asserted behaviorally below.
});

test("tool-defs.ts stays host-version agnostic (no @opencode-ai/plugin import)", () => {
  const src = readSrc(fileURLToPath(new URL("../src/tool-defs.ts", import.meta.url)), "utf8");
  const imports = src.match(/^\s*import[^;]+;/gm) ?? [];
  assert.ok(
    imports.every((stmt) => !stmt.includes("@opencode-ai/plugin")),
    `tool-defs.ts must not import the V1 host package; imports: ${imports.join(" | ")}`,
  );
});

// ── Behavioral tests (isolated state dir, GO coaching host) ──────────────────

test("harness_start({name,total}) returns the start banner and writes harness.json", async () => {
  const out = await byName("harness_start").execute({ name: "t", total: 2 }, { sessionID: "s-hs" }, host);
  assert.ok(out.includes("Harness 't' started (2 tasks)"), `banner present (${out.slice(0, 40)}...)`);
  assert.ok(out.includes("unknown_scan"), "DIAGNOSIS GATE banner mentions unknown_scan");
  assert.ok(out.includes("PATH A — INDEPENDENT") && out.includes("PATH B — DEPENDENT"), "loop protocol paths included");
  const h = readHarness("s-hs");
  assert.ok(h, "harness.json written");
  assert.equal(h!.total, 2);
  assert.equal(h!.active, true);
  assert.equal(h!.scanRequired, true);
  // read back from disk explicitly (not just through the helper)
  const onDisk = JSON.parse(readFileSync(join(stateDir, "s-hs", "harness.json"), "utf8"));
  assert.equal(onDisk.total, 2);
  assert.equal(onDisk.active, true);
});

test("task_update transitions status and persists score/model fields into harness.json", async () => {
  await byName("harness_start").execute({ name: "tu", total: 1 }, { sessionID: "s-tu" }, host);
  let out = await byName("task_update").execute({ id: 1, title: "T1", status: "generating" }, { sessionID: "s-tu" }, host);
  assert.equal(out, "task 1 -> generating");
  out = await byName("task_update").execute({ id: 1, title: "T1", status: "grading" }, { sessionID: "s-tu" }, host);
  assert.equal(out, "task 1 -> grading");
  out = await byName("task_update").execute({ id: 1, title: "T1", status: "completed", score: "PASS" }, { sessionID: "s-tu" }, host);
  assert.equal(out, "task 1 -> completed (PASS)");
  const t = readHarness("s-tu")!.tasks.find((x: any) => x.id === 1)!;
  assert.equal(t.status, "completed");
  assert.equal(t.score, "PASS");
  assert.equal(t.model, "fake/gen", "model auto-filled from workdir harness.config.json");
  // invalid status falls back to "generating" (protocol behavior preserved)
  out = await byName("task_update").execute({ id: 2, title: "T2", status: "bogus" }, { sessionID: "s-tu" }, host);
  assert.equal(out, "task 2 -> generating");
});

test("harness_done marks the harness inactive (active=false, current=total)", async () => {
  await byName("harness_start").execute({ name: "hd", total: 3 }, { sessionID: "s-hd" }, host);
  const out = await byName("harness_done").execute({}, { sessionID: "s-hd" }, host);
  assert.equal(out, "Harness complete.");
  const h = readHarness("s-hd")!;
  assert.equal(h.active, false);
  assert.equal(h.current, h.total);
});

test("grade with deterministic checks: first line PASS + 'grader model skipped' (no model call)", async () => {
  writeFileSync(join(workDir, "out.md"), "hello world\n");
  const out = await byName("grade").execute(
    { prompt: "out.md exists", checks: [{ type: "file-exists", path: "out.md" }] },
    { sessionID: "s-grade" },
    host,
  );
  assert.equal(out.split("\n")[0], "PASS", "first line is exactly PASS");
  assert.ok(out.includes("grader model skipped"), "grader model skipped banner");
  assert.ok(out.includes("(verified by 1 deterministic check(s)"), "check count reported");
  assert.ok(out.includes("graded claim: out.md exists"), "graded claim echoed");
  assert.ok(out.includes("[usage-coach NEXT] PASS ->"), "PASS NEXT directive");

  // FAIL side: missing file → first line FAIL
  const fail = await byName("grade").execute(
    { prompt: "missing file", checks: [{ type: "file-exists", path: "does-not-exist.txt" }] },
    { sessionID: "s-grade" },
    host,
  );
  assert.equal(fail.split("\n")[0], "FAIL");
  assert.ok(fail.includes("MISSING"));
});

test("generate without generator configured returns the exact ERROR string (error-path fidelity)", async () => {
  const emptyDir = mkdtempSync(join(tmpdir(), "uc-defs-empty-"));
  try {
    const emptyHost = makeHost(emptyDir); // no harness.config.json anywhere (HOME is fake)
    const out = await byName("generate").execute({ prompt: "do something" }, { sessionID: "s-gen-err" }, emptyHost);
    assert.ok(
      out.startsWith("ERROR: no generator model configured."),
      `error path preserved (${out.slice(0, 60)}...)`,
    );
    assert.ok(out.includes("HARNESS TERMINATED"), "termination directive included");
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test("grade_batch with checks for 2 tasks returns per-task [task N] PASS/FAIL blocks + summary", async () => {
  writeFileSync(join(workDir, "a.txt"), "aaa\n");
  const out = await byName("grade_batch").execute(
    {
      tasks: [
        { id: 1, prompt: "a.txt exists", checks: [{ type: "file-exists", path: "a.txt" }] },
        { id: 2, prompt: "missing.txt exists", checks: [{ type: "file-exists", path: "missing.txt" }] },
      ],
    },
    { sessionID: "s-gb" },
    host,
  );
  assert.ok(out.includes("[task 1] PASS"), "task 1 PASS block");
  assert.ok(out.includes("[task 2] FAIL"), "task 2 FAIL block");
  assert.ok(out.includes("grader model skipped"), "deterministic path taken");
  assert.ok(out.includes("[usage-coach] Graded 2 task(s): 1 PASS, 1 FAIL."), "batch summary line");
  assert.ok(out.includes("[usage-coach NEXT] task 1: PASS ->"), "task 1 NEXT directive");
  assert.ok(out.includes("[usage-coach NEXT] task 2: FAIL ->"), "task 2 NEXT directive");
});

test("question with no scan on record returns the no-questions NEXT directive", async () => {
  const out = await byName("question").execute({}, { sessionID: "s-q-none" }, host);
  assert.equal(out, "No questions from unknown_scan. [usage-coach NEXT] proceed to generate.");
});

test("record_failure appends a failure record to failures.ndjson under the isolated state dir", async () => {
  const out = await byName("record_failure").execute(
    { task: "T", prompt: "P", gradeResult: "FAIL", model: "fake/gen", revisions: 1 },
    { sessionID: "s-rf" },
    host,
  );
  assert.ok(out.startsWith("Failure recorded."));
  const ndjson = readFileSync(join(stateDir, "failures.ndjson"), "utf8").trim().split("\n");
  const rec = JSON.parse(ndjson[ndjson.length - 1]);
  assert.equal(rec.task, "T");
  assert.equal(rec.gradeResult, "FAIL");
  assert.equal(rec.revisions, 1);
});

test("coach_analyze reports zero-task baseline on a fresh harness", async () => {
  await byName("harness_start").execute({ name: "ca", total: 1 }, { sessionID: "s-ca" }, host);
  const out = await byName("coach_analyze").execute({}, { sessionID: "s-ca" }, host);
  assert.ok(out.includes("Knowledge Injection Effectiveness"));
  assert.ok(out.includes("Total graded tasks: 0"));
  assert.ok(out.includes("→ Need more data"));
});

test("call.directory fallback: tools read config from host.rt.directory when call.directory is absent", async () => {
  // Same workdir via the HOST (not the call) — the V1 adapter relies on this
  // when the host ctx omits directory.
  const out = await byName("task_update").execute({ id: 1, title: "T", status: "generating" }, { sessionID: "s-nodir" }, host);
  assert.equal(out, "task 1 -> generating");
  assert.equal(readHarness("s-nodir")!.tasks.find((x: any) => x.id === 1)!.model, "fake/gen");
});

// ── V1 adapter integration: the plugin's tool map is rebuilt FROM the defs ──

test("V1 plugin factory serves the same 16 defs through tool() + convertSchema (full descriptions intact)", async () => {
  const e2eDir = mkdtempSync(join(tmpdir(), "uc-defs-e2e-"));
  try {
    // NOOP_HOOKS on init failure types the factory return loosely — cast for assertions.
    const hooks = (await UsageCoachPlugin({
      project: {}, client: {},
      $: async () => ({ stdout: "" }),
      directory: e2eDir, worktree: e2eDir,
    })) as Record<string, any>;
    // hooks survive (no init failure → NOOP_HOOKS would have no .tool)
    assert.ok(hooks.tool, "tool map present (plugin init did not fail)");
    assert.equal(typeof hooks.event, "function");
    assert.equal(typeof hooks["tool.execute.before"], "function");
    assert.equal(typeof hooks["experimental.chat.system.transform"], "function");
    // the map is exactly the 16 defs
    assert.deepEqual(Object.keys(hooks.tool), [...TOOL_NAMES], "V1 tool map keys == TOOL_NAMES in order");
    // the V1 registration carries the SAME full protocol descriptions (single source)
    for (const name of TOOL_NAMES) {
      assert.equal(
        hooks.tool[name].description,
        TOOL_SCHEMAS[name].description,
        `${name}: V1-registered description identical to TOOL_SCHEMAS`,
      );
    }
    // and the V1-wrapped execute drives the shared def end-to-end (real zod args path)
    const out = await hooks.tool.harness_start.execute({ name: "e2e", total: 2 }, { sessionID: "s-e2e" });
    assert.ok(out.startsWith("Harness 'e2e' started (2 tasks)."));
    assert.equal(readHarness("s-e2e")!.total, 2);
  } finally {
    rmSync(e2eDir, { recursive: true, force: true });
  }
});
