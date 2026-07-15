// cli.test.ts — tests for the CLI entry point (src/cli.ts).
// Uses node:test + node:assert. State dir is an isolated temp dir via UC_STATE_DIR.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import {
  parseArgs,
  readStatus,
  readRules,
  readDecisions,
  readDomainStats,
  projectStateDir,
} from "../src/cli.js";

let stateDir: string;
let savedEnv: string | undefined;

before(() => {
  stateDir = mkdtempSync(join(tmpdir(), "uc-cli-"));
  savedEnv = process.env.UC_STATE_DIR;
  process.env.UC_STATE_DIR = stateDir;
});

after(() => {
  process.env.UC_STATE_DIR = savedEnv;
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

function writeState(overrides: Record<string, unknown> = {}): void {
  const base = {
    decision: "THROTTLE",
    advice: "5h at 74% — throttle active",
    weekly: 31,
    monthly: 12,
    fiveHour: 74,
    model: "zai-coding-plan/glm-5.1",
    provider: "zai",
    isFree: false,
    updatedAt: "2026-07-14T10:00:00.000Z",
  };
  writeFileSync(
    join(stateDir, "state.json"),
    JSON.stringify({ ...base, ...overrides }),
  );
}

function writeHarness(): void {
  const sid = "test-session-001";
  mkdirSync(join(stateDir, sid), { recursive: true });
  writeFileSync(
    join(stateDir, sid, "harness.json"),
    JSON.stringify({
      name: "test-harness",
      total: 3,
      current: 2,
      active: true,
      updatedAt: "2026-07-14T10:05:00.000Z",
      tasks: [
        { id: 1, title: "Task A", status: "completed", score: "PASS", model: "glm-5.1" },
        { id: 2, title: "Task B", status: "generating", model: "glm-5.1", subStep: 12 },
        { id: 3, title: "Task C", status: "pending" },
      ],
    }),
  );
}

function writeRules(): void {
  const content = `# Rules

## Rule 1 (2026-07-06, category: constraint-violation)
For documentation-generation tasks, always count lines BEFORE claiming completion, because the generator underestimates line-count constraints.
Origin: CHANGELOG.md task — output was 34 lines vs 30-line limit.

## Rule 2 (2026-07-10, category: tool-misuse)
For tasks using session.prompt, always pass abortSignal because the call blocks indefinitely on timeout.
Origin: generate task — sub-session hung for 30 minutes.
`;
  writeFileSync(join(stateDir, "rules.md"), content);
}

function writeCoachLog(): void {
  const lines = [
    "2026-07-14T09:00:00.000Z DECIDE GO 5h=38% wk=20%",
    "2026-07-14T09:30:00.000Z DECIDE GO 5h=55% wk=25%",
    "2026-07-14T10:00:00.000Z DECIDE THROTTLE 5h=74% wk=31%",
    "2026-07-14T09:00:00.000Z REFRESH codexbar ok provider=zai",
  ];
  writeFileSync(join(stateDir, "coach.log"), lines.join("\n") + "\n");
}

function writeDomain(): void {
  writeFileSync(
    join(stateDir, "nodes.ndjson"),
    [
      JSON.stringify({ id: "n1", type: "api-method", name: "session.prompt" }),
      JSON.stringify({ id: "n2", type: "concept", name: "AssistantMessage" }),
      JSON.stringify({ id: "n3", type: "limit", name: "tool-timeout" }),
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(stateDir, "edges.ndjson"),
    [
      JSON.stringify({ from: "n1", to: "n2", rel: "returns" }),
      JSON.stringify({ from: "n1", to: "n3", rel: "depends-on" }),
    ].join("\n") + "\n",
  );
}

function writeFailures(): void {
  writeFileSync(
    join(stateDir, "failures.ndjson"),
    [
      JSON.stringify({ ts: "2026-07-06T...", task: "CHANGELOG.md", grade: "FAIL: 34 lines" }),
      JSON.stringify({ ts: "2026-07-08T...", task: "README update", grade: "FAIL: missing section" }),
    ].join("\n") + "\n",
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("parseArgs: default command is status", () => {
  const a = parseArgs(["node", "cli.js"]);
  assert.equal(a.command, "status");
  assert.equal(a.json, false);
  assert.equal(a.aggregate, false);
});

test("parseArgs: --json flag", () => {
  const a = parseArgs(["node", "cli.js", "status", "--json"]);
  assert.equal(a.json, true);
});

test("parseArgs: -j short flag", () => {
  const a = parseArgs(["node", "cli.js", "status", "-j"]);
  assert.equal(a.json, true);
});

test("parseArgs: --dir flag with value", () => {
  const a = parseArgs(["node", "cli.js", "status", "--dir", "/tmp/proj"]);
  assert.equal(a.dir, "/tmp/proj");
});

test("parseArgs: -d short flag", () => {
  const a = parseArgs(["node", "cli.js", "-d", "/tmp/proj"]);
  assert.equal(a.dir, "/tmp/proj");
});

test("parseArgs: --aggregate flag", () => {
  const a = parseArgs(["node", "cli.js", "status", "--aggregate"]);
  assert.equal(a.aggregate, true);
});

test("parseArgs: --limit flag", () => {
  const a = parseArgs(["node", "cli.js", "decisions", "--limit", "5"]);
  assert.equal(a.limit, 5);
});

test("parseArgs: subcommand routing", () => {
  assert.equal(parseArgs(["node", "cli.js", "rules"]).command, "rules");
  assert.equal(parseArgs(["node", "cli.js", "decisions"]).command, "decisions");
  assert.equal(parseArgs(["node", "cli.js", "domain"]).command, "domain");
});

test("parseArgs: --help and --version", () => {
  assert.equal(parseArgs(["node", "cli.js", "--help"]).command, "help");
  assert.equal(parseArgs(["node", "cli.js", "--version"]).command, "version");
  assert.equal(parseArgs(["node", "cli.js", "-h"]).command, "help");
  assert.equal(parseArgs(["node", "cli.js", "-v"]).command, "version");
});

test("projectStateDir: deterministic hash for same directory", () => {
  const d1 = projectStateDir("/home/user/project");
  const d2 = projectStateDir("/home/user/project");
  assert.equal(d1, d2, "same directory should produce same hash");
});

test("projectStateDir: different dirs produce different hashes", () => {
  const d1 = projectStateDir("/home/user/project-a");
  const d2 = projectStateDir("/home/user/project-b");
  assert.notEqual(d1, d2);
});

// ── readStatus ───────────────────────────────────────────────────────────────

test("readStatus: returns null quota when no state.json", () => {
  // Fresh stateDir with no files
  const r = readStatus();
  assert.equal(r.quota, null);
  assert.equal(r.harness, null);
  assert.deepEqual(r.learning, {
    rulesCount: 0,
    failuresCount: 0,
    domainNodes: 0,
    domainEdges: 0,
  });
});

test("readStatus: reads state.json correctly", () => {
  writeState();
  const r = readStatus();
  assert.ok(r.quota);
  assert.equal(r.quota!.decision, "THROTTLE");
  assert.equal(r.quota!.fiveHour, 74);
  assert.equal(r.quota!.weekly, 31);
  assert.equal(r.quota!.model, "zai-coding-plan/glm-5.1");
  assert.equal(r.quota!.isFree, false);
});

test("readStatus: reads harness from session subdir", () => {
  writeState();
  writeHarness();
  const r = readStatus();
  assert.ok(r.harness);
  assert.equal(r.harness!.name, "test-harness");
  assert.equal(r.harness!.total, 3);
  assert.equal(r.harness!.current, 2);
  assert.equal(r.harness!.active, true);
  assert.equal(r.harness!.tasks.length, 3);
  assert.equal(r.harness!.tasks[0].status, "completed");
  assert.equal(r.harness!.tasks[0].score, "PASS");
});

test("readStatus: counts learning artifacts", () => {
  writeState();
  writeRules();
  writeFailures();
  writeDomain();
  const r = readStatus();
  assert.equal(r.learning.rulesCount, 2);
  assert.equal(r.learning.failuresCount, 2);
  assert.equal(r.learning.domainNodes, 3);
  assert.equal(r.learning.domainEdges, 2);
});

// ── readRules ────────────────────────────────────────────────────────────────

test("readRules: parses rules.md into structured entries", () => {
  writeRules();
  const r = readRules();
  assert.equal(r.count, 2);
  assert.equal(r.rules[0].number, 1);
  assert.equal(r.rules[0].category, "constraint-violation");
  assert.equal(r.rules[0].date, "2026-07-06");
  assert.ok(r.rules[0].text.includes("count lines"));
  assert.ok(r.rules[0].origin.includes("CHANGELOG.md"));
  assert.equal(r.rules[1].number, 2);
  assert.equal(r.rules[1].category, "tool-misuse");
});

test("readRules: empty when no rules.md", () => {
  rmSync(join(stateDir, "rules.md"), { force: true });
  const r = readRules();
  assert.equal(r.count, 0);
  assert.equal(r.rules.length, 0);
});

// ── readDecisions ───────────────────────────────────────────────────────────

test("readDecisions: parses coach.log decision lines", () => {
  writeCoachLog();
  const r = readDecisions();
  assert.equal(r.count, 3); // 3 DECIDE lines
  // Most recent first (reverse chronological within limit)
  assert.equal(r.decisions[2].decision, "GO");
  assert.equal(r.decisions[0].decision, "THROTTLE");
  assert.ok(r.decisions[0].detail.includes("74%"));
});

test("readDecisions: respects limit", () => {
  writeCoachLog();
  const r = readDecisions(undefined, 1);
  assert.equal(r.count, 1);
  assert.equal(r.decisions[0].decision, "THROTTLE"); // most recent
});

test("readDecisions: empty when no log", () => {
  rmSync(join(stateDir, "coach.log"), { force: true });
  const r = readDecisions();
  assert.equal(r.count, 0);
});

// ── readDomainStats ─────────────────────────────────────────────────────────

test("readDomainStats: counts nodes and edges by type", () => {
  writeDomain();
  const r = readDomainStats();
  assert.equal(r.nodes, 3);
  assert.equal(r.edges, 2);
  assert.equal(r.nodeTypes["api-method"], 1);
  assert.equal(r.nodeTypes["concept"], 1);
  assert.equal(r.nodeTypes["limit"], 1);
  assert.equal(r.edgeTypes["returns"], 1);
  assert.equal(r.edgeTypes["depends-on"], 1);
});

test("readDomainStats: empty when no files", () => {
  rmSync(join(stateDir, "nodes.ndjson"), { force: true });
  rmSync(join(stateDir, "edges.ndjson"), { force: true });
  const r = readDomainStats();
  assert.equal(r.nodes, 0);
  assert.equal(r.edges, 0);
  assert.deepEqual(r.nodeTypes, {});
  assert.deepEqual(r.edgeTypes, {});
});
