// cli-setup.test.ts — tests for the `setup` CLI command (src/cli.ts).
// Uses node:test + node:assert. Paths are overridden to isolated temp dirs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { doSetup, parseArgs, resolveAgentSourceFile } from "../src/cli.js";

// ── Shared fixtures ───────────────────────────────────────────────────────────

let tempRoot: string;
let configDir: string;
let agentsDir: string;
let agentSourceDir: string;
let agentSourceFile: string;

function makeTempRoot() {
  tempRoot = mkdtempSync(join(tmpdir(), "uc-setup-"));
  configDir = join(tempRoot, "config");
  agentsDir = join(tempRoot, "agents");
  agentSourceDir = join(tempRoot, "agent-src");
  agentSourceFile = join(agentSourceDir, "usage-coach-harness.md");
  mkdirSync(agentSourceDir, { recursive: true });
  // Write a dummy agent source file so copy tests have something to copy
  writeFileSync(agentSourceFile, "# usage-coach-harness agent\n");
}

function cleanupTempRoot() {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

// ── Tests: config creation ───────────────────────────────────────────────────

test("doSetup: creates harness.config.json when not present", () => {
  makeTempRoot();
  try {
    const r = doSetup({ configDir, agentsDir, agentSourceFile });
    assert.equal(r.harnessConfig.action, "created");
    assert.ok(existsSync(r.harnessConfig.path));

    const written = JSON.parse(readFileSync(r.harnessConfig.path, "utf8"));
    assert.equal(written.generator, "opencode/deepseek-v4-flash-free");
    assert.equal(written.grader, "opencode/mimo-v2.5-free");
    assert.equal(written.provider, "");
    assert.equal(written.lighterModel, "");
  } finally {
    cleanupTempRoot();
  }
});

test("doSetup: skips config when already exists", () => {
  makeTempRoot();
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "harness.config.json"),
      '{"generator":"custom","grader":"custom","provider":"","lighterModel":""}',
    );

    const r = doSetup({ configDir, agentsDir, agentSourceFile });
    assert.equal(r.harnessConfig.action, "exists");

    // Verify it was NOT overwritten
    const content = JSON.parse(readFileSync(r.harnessConfig.path, "utf8"));
    assert.equal(content.generator, "custom");
  } finally {
    cleanupTempRoot();
  }
});

// ── Tests: agent file copy ───────────────────────────────────────────────────

test("doSetup: copies agent file when destination doesn't exist", () => {
  makeTempRoot();
  try {
    const r = doSetup({ configDir, agentsDir, agentSourceFile });
    assert.equal(r.agentFile.action, "copied");
    assert.ok(existsSync(r.agentFile.path));

    const copied = readFileSync(r.agentFile.path, "utf8");
    const original = readFileSync(agentSourceFile, "utf8");
    assert.equal(copied, original);
  } finally {
    cleanupTempRoot();
  }
});

test("doSetup: skips agent file when destination already exists", () => {
  makeTempRoot();
  try {
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "usage-coach-harness.md"),
      "# existing agent file\n",
    );

    const r = doSetup({ configDir, agentsDir, agentSourceFile });
    assert.equal(r.agentFile.action, "exists");

    const content = readFileSync(r.agentFile.path, "utf8");
    assert.equal(content, "# existing agent file\n");
  } finally {
    cleanupTempRoot();
  }
});

test("doSetup: reports source-not-found when agent source missing", () => {
  makeTempRoot();
  try {
    const r = doSetup({
      configDir,
      agentsDir,
      agentSourceFile: join(tempRoot, "nonexistent.md"),
    });
    assert.equal(r.agentFile.action, "source-not-found");
    assert.ok(!existsSync(r.agentFile.path));
  } finally {
    cleanupTempRoot();
  }
});

// ── Tests: codexbar detection ─────────────────────────────────────────────────

test("doSetup: codexbar field is present in result", () => {
  makeTempRoot();
  try {
    const r = doSetup({ configDir, agentsDir, agentSourceFile });
    assert.ok(typeof r.codexbar.found === "boolean");
    assert.ok(typeof r.codexbar.version === "string");
  } finally {
    cleanupTempRoot();
  }
});

test("doSetup: creates config dir if it doesn't exist yet", () => {
  makeTempRoot();
  try {
    // configDir doesn't exist yet — doSetup should mkdir -p
    assert.ok(!existsSync(configDir));
    doSetup({ configDir, agentsDir, agentSourceFile });
    assert.ok(existsSync(configDir));
    assert.ok(existsSync(join(configDir, "harness.config.json")));
  } finally {
    cleanupTempRoot();
  }
});

test("doSetup: creates agents dir if it doesn't exist yet", () => {
  makeTempRoot();
  try {
    // agentsDir doesn't exist yet — doSetup should mkdir -p before copy
    assert.ok(!existsSync(agentsDir));
    doSetup({ configDir, agentsDir, agentSourceFile });
    assert.ok(existsSync(agentsDir));
    assert.ok(existsSync(join(agentsDir, "usage-coach-harness.md")));
  } finally {
    cleanupTempRoot();
  }
});

// ── Tests: full result structure ─────────────────────────────────────────────

test("doSetup: returns complete SetupResult structure", () => {
  makeTempRoot();
  try {
    const r = doSetup({ configDir, agentsDir, agentSourceFile });

    assert.ok(r.harnessConfig);
    assert.ok(["created", "exists"].includes(r.harnessConfig.action));
    assert.ok(typeof r.harnessConfig.path === "string");

    assert.ok(r.codexbar);
    assert.ok(typeof r.codexbar.found === "boolean");

    assert.ok(r.agentFile);
    assert.ok(["copied", "exists", "source-not-found"].includes(r.agentFile.action));
    assert.ok(typeof r.agentFile.path === "string");
  } finally {
    cleanupTempRoot();
  }
});

// ── Tests: parseArgs routing for setup ────────────────────────────────────────

test("parseArgs: setup command routing", () => {
  const a = parseArgs(["node", "cli.js", "setup"]);
  assert.equal(a.command, "setup");
});

test("parseArgs: setup --json", () => {
  const a = parseArgs(["node", "cli.js", "setup", "--json"]);
  assert.equal(a.command, "setup");
  assert.equal(a.json, true);
});

// ── Tests: idempotency ────────────────────────────────────────────────────────

test("doSetup: running twice is idempotent (second run reports exists)", () => {
  makeTempRoot();
  try {
    const r1 = doSetup({ configDir, agentsDir, agentSourceFile });
    assert.equal(r1.harnessConfig.action, "created");
    assert.equal(r1.agentFile.action, "copied");

    const r2 = doSetup({ configDir, agentsDir, agentSourceFile });
    assert.equal(r2.harnessConfig.action, "exists");
    assert.equal(r2.agentFile.action, "exists");
  } finally {
    cleanupTempRoot();
  }
});

// ── Tests: resolveAgentSourceFile ─────────────────────────────────────────────

test("resolveAgentSourceFile: returns a path ending with agents/usage-coach-harness.md", () => {
  const p = resolveAgentSourceFile();
  assert.ok(p.endsWith(join("agents", "usage-coach-harness.md")), `got: ${p}`);
});
