#!/usr/bin/env node
// cli.ts — opencode-usage-coach CLI entry point.
//
// Exposes quota/learning state as JSON for external consumers (Orca, web
// dashboards, shell scripts). Same spawnable-CLI pattern as codexbar.
//
// Usage:
//   usage-coach status [--json] [--dir <path>] [--aggregate]
//   usage-coach rules   [--json] [--dir <path>]
//   usage-coach decisions [--json] [--dir <path>] [--limit <n>]
//   usage-coach domain  [--json] [--dir <path>]
//   usage-coach --help
//   usage-coach --version

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// ── State directory resolution (matches tui.tsx / index.ts) ──────────────────

export function projectStateDir(dir: string): string {
  const abs = resolve(dir || ".");
  const h = createHash("sha1").update(abs).digest("hex").slice(0, 12);
  return join(homedir(), ".cache", "opencode-usage-coach", "projects", h);
}

export function resolveStateDir(dir?: string): string {
  return process.env.UC_STATE_DIR ?? projectStateDir(dir ?? process.cwd());
}

const CACHE_ROOT = join(homedir(), ".cache", "opencode-usage-coach");

// ── Types (mirror tui-logic.ts shapes; kept local to avoid import cycles) ────

type Decision = "GO" | "THROTTLE" | "STOP";

type StateFile = {
  decision: Decision;
  advice: string;
  weekly: number;
  monthly: number;
  fiveHour: number;
  model?: string;
  provider?: string;
  isFree?: boolean;
  providers?: Array<{
    id: string;
    name: string;
    fiveHour: number;
    weekly: number;
    fiveHourReset: string;
    weeklyReset: string;
    advice: string;
  }>;
  updatedAt?: string;
};

type TaskFile = {
  id: number;
  title: string;
  status: string;
  model?: string;
  revisions?: number;
  score?: string | null;
  startedAt?: string;
  subSessionId?: string;
  subStep?: number;
  lastActivity?: string;
  subElapsed?: number;
};

type HarnessFile = {
  name: string;
  total: number;
  current: number;
  active?: boolean;
  updatedAt?: string;
  tasks: TaskFile[];
  quotas?: Record<string, { weekly: number; monthly: number; fiveHour: number }>;
};

// ── Low-level file readers (all defensive — return null/empty on error) ──────

function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function readLines(path: string): string[] {
  try {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function readNdjson<T>(path: string): T[] {
  return readLines(path)
    .map((l) => {
      try {
        return JSON.parse(l) as T;
      } catch {
        return null;
      }
    })
    .filter((x): x is T => x !== null);
}

function readText(path: string): string {
  try {
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function countFileLines(path: string): number {
  return readLines(path).length;
}

// ── Harness discovery (scan session subdirs for the most recent active) ──────

function findHarness(stateDir: string): HarnessFile | null {
  // 1. Check session-scoped harnesses: <stateDir>/<sessionID>/harness.json
  let best: { file: string; mtime: number; active: boolean } | null = null;
  let entries: string[] = [];
  try {
    entries = readdirSync(stateDir);
  } catch {
    /* */
  }
  for (const d of entries) {
    const sub = join(stateDir, d);
    let isDir = false;
    try {
      isDir = statSync(sub).isDirectory();
    } catch {
      /* */
    }
    if (!isDir) continue;
    const f = join(sub, "harness.json");
    if (!existsSync(f)) continue;
    let st: { mtimeMs: number };
    try {
      st = statSync(f);
    } catch {
      continue;
    }
    let active = false;
    try {
      active = !!JSON.parse(readFileSync(f, "utf8")).active;
    } catch {
      /* */
    }
    if (
      !best ||
      (active && !best.active) ||
      (active === best.active && st.mtimeMs > best.mtime)
    ) {
      best = { file: f, mtime: st.mtimeMs, active };
    }
  }
  if (best) return readJson<HarnessFile>(best.file);
  // 2. Legacy fallback: <stateDir>/harness.json
  return readJson<HarnessFile>(join(stateDir, "harness.json"));
}

// ── Command: status ──────────────────────────────────────────────────────────

export type StatusResult = {
  directory: string;
  stateDir: string;
  quota: {
    decision: Decision;
    fiveHour: number;
    weekly: number;
    monthly: number;
    model?: string;
    provider?: string;
    isFree?: boolean;
    advice: string;
  } | null;
  providers: StateFile["providers"] | null;
  harness: {
    active: boolean;
    name: string;
    total: number;
    current: number;
    tasks: Array<{
      id: number;
      title: string;
      status: string;
      score?: string | null;
      model?: string;
      steps?: number;
    }>;
  } | null;
  learning: {
    rulesCount: number;
    failuresCount: number;
    domainNodes: number;
    domainEdges: number;
  };
  updatedAt?: string;
};

export function readStatus(dir?: string): StatusResult {
  const stateDir = resolveStateDir(dir);
  const s = readJson<StateFile>(join(stateDir, "state.json"));
  const h = findHarness(stateDir);
  const rulesCount = parseRules(readText(join(stateDir, "rules.md"))).length;
  const failuresCount = countFileLines(join(stateDir, "failures.ndjson"));
  const domainNodes = countFileLines(join(stateDir, "nodes.ndjson"));
  const domainEdges = countFileLines(join(stateDir, "edges.ndjson"));

  return {
    directory: resolve(dir ?? process.cwd()),
    stateDir,
    quota: s
      ? {
          decision: s.decision,
          fiveHour: s.fiveHour,
          weekly: s.weekly,
          monthly: s.monthly,
          model: s.model,
          provider: s.provider,
          isFree: s.isFree,
          advice: s.advice,
        }
      : null,
    providers: s?.providers ?? null,
    harness: h
      ? {
          active: h.active ?? false,
          name: h.name,
          total: h.total,
          current: h.current,
          tasks: h.tasks.map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            score: t.score ?? undefined,
            model: t.model,
            steps: t.subStep,
          })),
        }
      : null,
    learning: { rulesCount, failuresCount, domainNodes, domainEdges },
    updatedAt: s?.updatedAt,
  };
}

// ── Command: status --aggregate ──────────────────────────────────────────────

export type AggregateResult = {
  instanceCount: number;
  instances: Array<{
    directory: string;
    stateDir: string;
    decision: Decision | "unknown";
    fiveHour: number;
    weekly: number;
    model?: string;
  }>;
  aggregate: {
    maxFiveHour: number;
    maxWeekly: number;
    maxMonthly: number;
    decisions: Record<string, number>;
    activeHarnesses: number;
    totalTasks: number;
    totalRules: number;
    totalFailures: number;
    totalDomainNodes: number;
    totalDomainEdges: number;
  };
};

export function readAggregateStatus(): AggregateResult {
  const projectsDir = join(CACHE_ROOT, "projects");
  let dirs: string[] = [];
  try {
    dirs = readdirSync(projectsDir).map((d) => join(projectsDir, d));
  } catch {
    /* */
  }

  const instances: AggregateResult["instances"] = [];
  const decCount: Record<string, number> = {};
  let max5h = 0,
    maxWk = 0,
    maxMo = 0,
    activeHarnesses = 0,
    totalTasks = 0,
    totalRules = 0,
    totalFailures = 0,
    totalDomainNodes = 0,
    totalDomainEdges = 0;

  for (const d of dirs) {
    let isDir = false;
    try {
      isDir = statSync(d).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    const s = readJson<StateFile>(join(d, "state.json"));
    const decision: Decision | "unknown" = s?.decision ?? "unknown";
    const fiveHour = s?.fiveHour ?? 0;
    const weekly = s?.weekly ?? 0;

    instances.push({
      directory: d,
      stateDir: d,
      decision,
      fiveHour,
      weekly,
      model: s?.model,
    });

    decCount[decision] = (decCount[decision] ?? 0) + 1;
    max5h = Math.max(max5h, fiveHour);
    maxWk = Math.max(maxWk, weekly);
    maxMo = Math.max(maxMo, s?.monthly ?? 0);

    const h = findHarness(d);
    if (h?.active) {
      activeHarnesses++;
      totalTasks += h.tasks.length;
    }

    totalRules += parseRules(readText(join(d, "rules.md"))).length;
    totalFailures += countFileLines(join(d, "failures.ndjson"));
    totalDomainNodes += countFileLines(join(d, "nodes.ndjson"));
    totalDomainEdges += countFileLines(join(d, "edges.ndjson"));
  }

  return {
    instanceCount: instances.length,
    instances,
    aggregate: {
      maxFiveHour: max5h,
      maxWeekly: maxWk,
      maxMonthly: maxMo,
      decisions: decCount,
      activeHarnesses,
      totalTasks,
      totalRules,
      totalFailures,
      totalDomainNodes,
      totalDomainEdges,
    },
  };
}

// ── Command: rules ───────────────────────────────────────────────────────────

export type RuleEntry = {
  number: number;
  category: string;
  date: string;
  text: string;
  origin: string;
};

export function readRules(dir?: string): { count: number; rules: RuleEntry[] } {
  const stateDir = resolveStateDir(dir);
  const content = readText(join(stateDir, "rules.md"));
  const rules = parseRules(content);
  return { count: rules.length, rules };
}

function parseRules(content: string): RuleEntry[] {
  if (!content.trim()) return [];
  const blocks = content.split(/^## /m).filter((b) => b.startsWith("Rule"));
  return blocks.map((block) => {
    const headerMatch = block.match(
      /^Rule\s+(\d+)\s*\(([^,]+),\s*category:\s*([^)]+)\)/,
    );
    const number = headerMatch ? parseInt(headerMatch[1], 10) : 0;
    const date = headerMatch ? headerMatch[2].trim() : "";
    const category = headerMatch ? headerMatch[3].trim() : "";
    const body = block.slice(headerMatch?.[0]?.length ?? 0).trim();
    const originMatch = body.match(/^Origin:\s*(.+)$/m);
    const text = body
      .split("\n")
      .filter((l) => !l.startsWith("Origin:"))
      .join(" ")
      .trim();
    return {
      number,
      category,
      date,
      text,
      origin: originMatch ? originMatch[1].trim() : "",
    };
  });
}

// ── Command: decisions ───────────────────────────────────────────────────────

export type DecisionEntry = {
  ts: string;
  decision: string;
  detail: string;
};

export function readDecisions(
  dir?: string,
  limit = 20,
): { count: number; decisions: DecisionEntry[] } {
  const stateDir = resolveStateDir(dir);
  const lines = readLines(join(stateDir, "coach.log"));
  const decisions: DecisionEntry[] = [];
  // Walk backwards for the most recent N decision lines (most recent first).
  for (let i = lines.length - 1; i >= 0 && decisions.length < limit; i--) {
    const line = lines[i];
    // Match: <ISO timestamp> DECIDE <GO|THROTTLE|STOP> <detail...>
    const m = line.match(
      /^(\S+)\s+DECIDE\s+(GO|THROTTLE|STOP)\s+(.*)$/,
    );
    if (m) {
      decisions.push({
        ts: m[1],
        decision: m[2],
        detail: m[3],
      });
    }
  }
  return { count: decisions.length, decisions };
}

// ── Command: domain ──────────────────────────────────────────────────────────

type DomainNodeEntry = { type: string };
type DomainEdgeEntry = { rel: string };

export type DomainStats = {
  nodes: number;
  edges: number;
  nodeTypes: Record<string, number>;
  edgeTypes: Record<string, number>;
};

export function readDomainStats(dir?: string): DomainStats {
  const stateDir = resolveStateDir(dir);
  const nodes = readNdjson<DomainNodeEntry>(join(stateDir, "nodes.ndjson"));
  const edges = readNdjson<DomainEdgeEntry>(join(stateDir, "edges.ndjson"));

  const nodeTypes: Record<string, number> = {};
  for (const n of nodes) {
    const t = n.type ?? "unknown";
    nodeTypes[t] = (nodeTypes[t] ?? 0) + 1;
  }
  const edgeTypes: Record<string, number> = {};
  for (const e of edges) {
    const r = e.rel ?? "unknown";
    edgeTypes[r] = (edgeTypes[r] ?? 0) + 1;
  }
  return {
    nodes: nodes.length,
    edges: edges.length,
    nodeTypes,
    edgeTypes,
  };
}

// ── Human-readable formatters ────────────────────────────────────────────────

function bar(pct: number): string {
  const n = pct <= 0 ? 0 : Math.max(1, Math.min(10, Math.round(pct / 10)));
  return "\u2588".repeat(n) + "\u2591".repeat(10 - n);
}

function formatStatus(r: StatusResult): string {
  const lines: string[] = [];
  if (!r.quota) {
    lines.push("usage-coach: no state (is the plugin running?)");
    return lines.join("\n");
  }
  const q = r.quota;
  const tag = q.isFree ? "free" : q.decision;
  const model = q.model ? ` ${q.model.split("/").pop()}` : "";
  lines.push(`usage-coach [${tag}]${model}`);
  if (!q.isFree) {
    if (q.fiveHour >= 0) lines.push(` 5h ${bar(q.fiveHour)} ${q.fiveHour}%`);
    if (q.weekly >= 0) lines.push(` 1w ${bar(q.weekly)} ${q.weekly}%`);
  }
  if (q.advice) lines.push(` ${q.advice}`);
  if (r.harness?.active) {
    lines.push("");
    lines.push(`harness: ${r.harness.name} ${r.harness.current}/${r.harness.total}`);
    for (const t of r.harness.tasks) {
      const score = t.score ? ` [${t.score}]` : "";
      lines.push(`  ${t.id} [${t.status}]${score} ${t.title}`);
    }
  }
  if (r.learning.rulesCount > 0) {
    lines.push("");
    lines.push(
      `learning: ${r.learning.rulesCount} rules, ${r.learning.failuresCount} failures, ${r.learning.domainNodes} domain nodes`,
    );
  }
  return lines.join("\n");
}

function formatAggregate(r: AggregateResult): string {
  const lines: string[] = [];
  const a = r.aggregate;
  lines.push(`usage-coach aggregate — ${r.instanceCount} instances`);
  lines.push(` max 5h ${bar(a.maxFiveHour)} ${a.maxFiveHour}%`);
  lines.push(` max 1w ${bar(a.maxWeekly)} ${a.maxWeekly}%`);
  const decs = Object.entries(a.decisions)
    .map(([k, v]) => `${k}:${v}`)
    .join(" ");
  lines.push(` decisions: ${decs}`);
  lines.push(
    ` harnesses: ${a.activeHarnesses} active, ${a.totalTasks} tasks`,
  );
  lines.push(
    ` learning: ${a.totalRules} rules, ${a.totalFailures} failures, ${a.totalDomainNodes} domain nodes`,
  );
  return lines.join("\n");
}

function formatRules(r: { count: number; rules: RuleEntry[] }): string {
  if (r.count === 0) return "No rules accumulated yet.";
  const lines: string[] = [`${r.count} rules:`];
  for (const rule of r.rules) {
    lines.push(
      `  #${rule.number} (${rule.date}, ${rule.category}): ${rule.text.slice(0, 80)}${rule.text.length > 80 ? "..." : ""}`,
    );
  }
  return lines.join("\n");
}

function formatDecisions(r: {
  count: number;
  decisions: DecisionEntry[];
}): string {
  if (r.count === 0) return "No decisions logged.";
  const lines: string[] = [`${r.count} recent decisions:`];
  for (const d of r.decisions) {
    lines.push(`  ${d.ts} ${d.decision} ${d.detail}`);
  }
  return lines.join("\n");
}

function formatDomain(r: DomainStats): string {
  if (r.nodes === 0 && r.edges === 0) return "No domain knowledge stored.";
  const nt = Object.entries(r.nodeTypes)
    .map(([k, v]) => `${k}:${v}`)
    .join(" ");
  const et = Object.entries(r.edgeTypes)
    .map(([k, v]) => `${k}:${v}`)
    .join(" ");
  return [
    `domain: ${r.nodes} nodes, ${r.edges} edges`,
    ` node types: ${nt}`,
    ` edge types: ${et}`,
  ].join("\n");
}

// ── Command: setup ───────────────────────────────────────────────────────────

const GLOBAL_CONFIG_DIR = join(homedir(), ".config", "opencode-usage-coach");
const OPENCODE_AGENTS_DIR = join(homedir(), ".config", "opencode", "agents");
const OPENCODE_TUI_CONFIG = join(homedir(), ".config", "opencode", "tui.json");
const DEFAULT_HARNESS_CONFIG = {
  generator: "opencode/deepseek-v4-flash-free",
  grader: "opencode/mimo-v2.5-free",
  provider: "",
  lighterModel: "",
  maxSteps: 30,
};

export type SetupResult = {
  harnessConfig: { action: "created" | "exists"; path: string };
  codexbar: { found: boolean; version: string };
  agentFile: { action: "copied" | "exists" | "source-not-found"; path: string };
  tuiConfig: { action: "configured" | "exists" | "not-found" | "write-error"; path: string };
};

export type SetupOptions = {
  configDir?: string;
  agentsDir?: string;
  agentSourceFile?: string;
  tuiConfigPath?: string;
  scriptDir?: string; // for testing — overrides import.meta.url resolution
};

export function resolveAgentSourceFile(): string {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  return join(scriptDir, "..", "agents", "usage-coach-harness.md");
}

/**
 * Resolve the absolute path to dist/tui.js.
 * Uses import.meta.url (sibling of cli.js in dist/) so it works regardless
 * of whether the package was installed globally via npm or via opencode's
 * Bun cache. The optional scriptDir parameter is for test injection.
 */
export function resolveTuiPath(scriptDir?: string): string {
  const dir = scriptDir ?? dirname(fileURLToPath(import.meta.url));
  return join(dir, "tui.js");
}

/**
 * Non-destructively merge the TUI plugin path into tui.json.
 * Preserves existing plugins, schema, and any other keys.
 * Returns "exists" if the path is already present.
 */
export function configureTui(
  tuiPath: string,
  tuiConfigPath: string,
): { action: "configured" | "exists" | "not-found" | "write-error"; path: string } {
  if (!existsSync(tuiPath)) {
    return { action: "not-found", path: tuiPath };
  }

  let config: Record<string, unknown> = {};
  if (existsSync(tuiConfigPath)) {
    try {
      config = JSON.parse(readFileSync(tuiConfigPath, "utf8"));
    } catch {
      // corrupt JSON — start fresh
      config = {};
    }
  }

  const plugins = Array.isArray(config["plugin"]) ? (config["plugin"] as string[]) : [];
  if (plugins.includes(tuiPath)) {
    return { action: "exists", path: tuiConfigPath };
  }

  // Remove any stale opencode-usage-coach references (subpath or old path)
  const filtered = plugins.filter(
    (p) => !p.includes("opencode-usage-coach"),
  );
  filtered.push(tuiPath);
  config["plugin"] = filtered;

  // Ensure schema is preserved
  if (!config["$schema"]) {
    config["$schema"] = "https://opencode.ai/tui.json";
  }

  try {
    mkdirSync(dirname(tuiConfigPath), { recursive: true });
    writeFileSync(tuiConfigPath, JSON.stringify(config, null, 2) + "\n");
    return { action: "configured", path: tuiConfigPath };
  } catch {
    return { action: "write-error", path: tuiConfigPath };
  }
}

function detectCodexbar(): { found: boolean; version: string } {
  try {
    const r = spawnSync("codexbar", ["--version"], { timeout: 5000 });
    if (r.status === 0 || (r.stdout && r.stdout.toString().trim().length > 0)) {
      return { found: true, version: (r.stdout?.toString().trim() ?? "") || "unknown" };
    }
    return { found: false, version: "" };
  } catch {
    return { found: false, version: "" };
  }
}

export function doSetup(opts: SetupOptions = {}): SetupResult {
  const configDir = opts.configDir ?? GLOBAL_CONFIG_DIR;
  const agentsDir = opts.agentsDir ?? OPENCODE_AGENTS_DIR;
  const agentSource = opts.agentSourceFile ?? resolveAgentSourceFile();
  const tuiConfigPath = opts.tuiConfigPath ?? OPENCODE_TUI_CONFIG;

  const configPath = join(configDir, "harness.config.json");

  // 1. Config creation
  let configAction: "created" | "exists";
  if (existsSync(configPath)) {
    configAction = "exists";
  } else {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify(DEFAULT_HARNESS_CONFIG, null, 2) + "\n",
    );
    configAction = "created";
  }

  // 2. Codexbar detection
  const codexbar = detectCodexbar();

  // 3. Agent file copy
  const agentDestPath = join(agentsDir, "usage-coach-harness.md");
  let agentAction: "copied" | "exists" | "source-not-found";
  if (!existsSync(agentSource)) {
    agentAction = "source-not-found";
  } else if (existsSync(agentDestPath)) {
    agentAction = "exists";
  } else {
    mkdirSync(agentsDir, { recursive: true });
    copyFileSync(agentSource, agentDestPath);
    agentAction = "copied";
  }

  // 4. TUI config — auto-resolve and write absolute path to tui.json
  const tuiPath = resolveTuiPath(opts.scriptDir);
  const tuiResult = configureTui(tuiPath, tuiConfigPath);

  return {
    harnessConfig: { action: configAction, path: configPath },
    codexbar,
    agentFile: { action: agentAction, path: agentDestPath },
    tuiConfig: tuiResult,
  };
}

function formatSetup(r: SetupResult): string {
  const lines: string[] = ["usage-coach setup", ""];

  // Config
  const configCheck = r.harnessConfig.action === "created" ? "\u2705" : "\u2705";
  lines.push(
    `  ${configCheck} harness.config.json ${r.harnessConfig.action === "created" ? "created" : "already exists"}`,
  );
  lines.push(`     ${r.harnessConfig.path}`);
  if (r.harnessConfig.action === "created") {
    lines.push(
      `     generator: ${DEFAULT_HARNESS_CONFIG.generator} (edit or use /coach-config)`,
    );
  }

  // Codexbar
  if (r.codexbar.found) {
    lines.push("");
    lines.push(`  \u2705 codexbar found`);
    lines.push(`     ${r.codexbar.version}`);
  } else {
    lines.push("");
    lines.push(`  \u26a0\ufe0f  codexbar not found`);
    lines.push(`     Plugin runs in GO-only mode (no quota sensing)`);
  }

  // Agent file
  lines.push("");
  if (r.agentFile.action === "copied") {
    lines.push(`  \u2705 Agent file copied`);
    lines.push(`     ${r.agentFile.path}`);
  } else if (r.agentFile.action === "exists") {
    lines.push(`  \u2705 Agent file already exists`);
    lines.push(`     ${r.agentFile.path}`);
  } else {
    lines.push(`  \u26a0\ufe0f  Agent source not found`);
    lines.push(`     Expected: ${r.agentFile.path}`);
  }

  // TUI config
  lines.push("");
  if (r.tuiConfig.action === "configured") {
    lines.push(`  \u2705 TUI plugin configured`);
    lines.push(`     ${r.tuiConfig.path}`);
  } else if (r.tuiConfig.action === "exists") {
    lines.push(`  \u2705 TUI plugin already configured`);
    lines.push(`     ${r.tuiConfig.path}`);
  } else if (r.tuiConfig.action === "not-found") {
    lines.push(`  \u26a0\ufe0f  TUI plugin (dist/tui.js) not found`);
    lines.push(`     Run: npm install -g opencode-usage-coach`);
  } else {
    lines.push(`  \u26a0\ufe0f  Could not write TUI config`);
    lines.push(`     Manually add to ${r.tuiConfig.path}`);
  }

  lines.push("");
  lines.push("Setup complete. Restart opencode to apply changes.");
  return lines.join("\n");
}

// ── Arg parsing + dispatch ───────────────────────────────────────────────────

export type ParsedArgs = {
  command: string;
  json: boolean;
  dir?: string;
  aggregate: boolean;
  limit: number;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // strip node + script path
  let command = "status";
  let json = false;
  let dir: string | undefined;
  let aggregate = false;
  let limit = 20;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json" || a === "-j") json = true;
    else if (a === "--aggregate" || a === "-a") aggregate = true;
    else if (a === "--dir" || a === "-d") {
      dir = args[++i];
    } else if (a === "--limit" || a === "-l") {
      limit = parseInt(args[++i], 10) || 20;
    } else if (a === "--help" || a === "-h") {
      command = "help";
    } else if (a === "--version" || a === "-v") {
      command = "version";
    } else if (!a.startsWith("-")) {
      command = a;
    }
  }
  return { command, json, dir, aggregate, limit };
}

const HELP = `usage-coach — quota intelligence CLI for opencode

Commands:
  status          Show quota + harness + learning state (default)
  rules           List accumulated learning rules
  decisions       Show recent GO/THROTTLE/STOP decision history
  domain          Show domain knowledge graph stats
  setup           Auto-generate harness.config.json, detect codexbar, copy agent file

Flags:
  --json, -j      Output as JSON (default: human-readable)
  --dir <path>    Project directory to query (default: cwd)
  --aggregate, -a Scan all project instances (status only)
  --limit <n>     Number of decisions to show (default: 20)
  --help, -h      Show this help
  --version, -v   Show version

Examples:
  usage-coach status --json
  usage-coach status --aggregate --json
  usage-coach rules --json --dir /path/to/project`;

function getVersion(): string {
  try {
    const pkgPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "package.json",
    );
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function main(): void {
  const args = parseArgs(process.argv);

  switch (args.command) {
    case "help": {
      console.log(HELP);
      break;
    }
    case "version": {
      console.log(getVersion());
      break;
    }
    case "status": {
      if (args.aggregate) {
        const r = readAggregateStatus();
        console.log(args.json ? JSON.stringify(r, null, 2) : formatAggregate(r));
      } else {
        const r = readStatus(args.dir);
        console.log(args.json ? JSON.stringify(r, null, 2) : formatStatus(r));
      }
      break;
    }
    case "rules": {
      const r = readRules(args.dir);
      console.log(args.json ? JSON.stringify(r, null, 2) : formatRules(r));
      break;
    }
    case "decisions": {
      const r = readDecisions(args.dir, args.limit);
      console.log(
        args.json ? JSON.stringify(r, null, 2) : formatDecisions(r),
      );
      break;
    }
    case "domain": {
      const r = readDomainStats(args.dir);
      console.log(args.json ? JSON.stringify(r, null, 2) : formatDomain(r));
      break;
    }
    case "setup": {
      const r = doSetup();
      console.log(args.json ? JSON.stringify(r, null, 2) : formatSetup(r));
      break;
    }
    default: {
      console.error(`Unknown command: ${args.command}\n\n${HELP}`);
      process.exit(1);
    }
  }
}

// Run only when executed directly (not when imported by tests).
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("cli.js") ||
    process.argv[1].endsWith("cli.ts") ||
    process.argv[1].endsWith("usage-coach"));

if (isDirectRun) {
  main();
}
