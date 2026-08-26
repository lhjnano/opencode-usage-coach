#!/usr/bin/env node

// src/cli.ts
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
  copyFileSync
} from "fs";
import { createHash } from "crypto";
import { homedir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
function projectStateDir(dir) {
  const abs = resolve(dir || ".");
  const h = createHash("sha1").update(abs).digest("hex").slice(0, 12);
  return join(homedir(), ".cache", "opencode-usage-coach", "projects", h);
}
function resolveStateDir(dir) {
  return process.env.UC_STATE_DIR ?? projectStateDir(dir ?? process.cwd());
}
var CACHE_ROOT = join(homedir(), ".cache", "opencode-usage-coach");
function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
function readLines(path) {
  try {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
function readNdjson(path) {
  return readLines(path).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter((x) => x !== null);
}
function readText(path) {
  try {
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
function countFileLines(path) {
  return readLines(path).length;
}
function findHarness(stateDir) {
  let best = null;
  let entries = [];
  try {
    entries = readdirSync(stateDir);
  } catch {
  }
  for (const d of entries) {
    const sub = join(stateDir, d);
    let isDir = false;
    try {
      isDir = statSync(sub).isDirectory();
    } catch {
    }
    if (!isDir) continue;
    const f = join(sub, "harness.json");
    if (!existsSync(f)) continue;
    let st;
    try {
      st = statSync(f);
    } catch {
      continue;
    }
    let active = false;
    try {
      active = !!JSON.parse(readFileSync(f, "utf8")).active;
    } catch {
    }
    if (!best || active && !best.active || active === best.active && st.mtimeMs > best.mtime) {
      best = { file: f, mtime: st.mtimeMs, active };
    }
  }
  if (best) return readJson(best.file);
  return readJson(join(stateDir, "harness.json"));
}
function readStatus(dir) {
  const stateDir = resolveStateDir(dir);
  const s = readJson(join(stateDir, "state.json"));
  const h = findHarness(stateDir);
  const rulesCount = parseRules(readText(join(stateDir, "rules.md"))).length;
  const failuresCount = countFileLines(join(stateDir, "failures.ndjson"));
  const domainNodes = countFileLines(join(stateDir, "nodes.ndjson"));
  const domainEdges = countFileLines(join(stateDir, "edges.ndjson"));
  return {
    directory: resolve(dir ?? process.cwd()),
    stateDir,
    quota: s ? {
      decision: s.decision,
      fiveHour: s.fiveHour,
      weekly: s.weekly,
      monthly: s.monthly,
      model: s.model,
      provider: s.provider,
      isFree: s.isFree,
      advice: s.advice
    } : null,
    providers: s?.providers ?? null,
    harness: h ? {
      active: h.active ?? false,
      name: h.name,
      total: h.total,
      current: h.current,
      tasks: h.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        score: t.score ?? void 0,
        model: t.model,
        steps: t.subStep
      }))
    } : null,
    learning: { rulesCount, failuresCount, domainNodes, domainEdges },
    updatedAt: s?.updatedAt
  };
}
function readAggregateStatus() {
  const projectsDir = join(CACHE_ROOT, "projects");
  let dirs = [];
  try {
    dirs = readdirSync(projectsDir).map((d) => join(projectsDir, d));
  } catch {
  }
  const instances = [];
  const decCount = {};
  let max5h = 0, maxWk = 0, maxMo = 0, activeHarnesses = 0, totalTasks = 0, totalRules = 0, totalFailures = 0, totalDomainNodes = 0, totalDomainEdges = 0;
  for (const d of dirs) {
    let isDir;
    try {
      isDir = statSync(d).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const s = readJson(join(d, "state.json"));
    const decision = s?.decision ?? "unknown";
    const fiveHour = s?.fiveHour ?? 0;
    const weekly = s?.weekly ?? 0;
    instances.push({
      directory: d,
      stateDir: d,
      decision,
      fiveHour,
      weekly,
      model: s?.model
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
      totalDomainEdges
    }
  };
}
function readRules(dir) {
  const stateDir = resolveStateDir(dir);
  const content = readText(join(stateDir, "rules.md"));
  const rules = parseRules(content);
  return { count: rules.length, rules };
}
function parseRules(content) {
  if (!content.trim()) return [];
  const blocks = content.split(/^## /m).filter((b) => b.startsWith("Rule"));
  return blocks.map((block) => {
    const headerMatch = block.match(
      /^Rule\s+(\d+)\s*\(([^,]+),\s*category:\s*([^)]+)\)/
    );
    const number = headerMatch ? parseInt(headerMatch[1], 10) : 0;
    const date = headerMatch ? headerMatch[2].trim() : "";
    const category = headerMatch ? headerMatch[3].trim() : "";
    const body = block.slice(headerMatch?.[0]?.length ?? 0).trim();
    const originMatch = body.match(/^Origin:\s*(.+)$/m);
    const text = body.split("\n").filter((l) => !l.startsWith("Origin:")).join(" ").trim();
    return {
      number,
      category,
      date,
      text,
      origin: originMatch ? originMatch[1].trim() : ""
    };
  });
}
function readDecisions(dir, limit = 20) {
  const stateDir = resolveStateDir(dir);
  const lines = readLines(join(stateDir, "coach.log"));
  const decisions = [];
  for (let i = lines.length - 1; i >= 0 && decisions.length < limit; i--) {
    const line = lines[i];
    const m = line.match(
      /^(\S+)\s+DECIDE\s+(GO|THROTTLE|STOP)\s+(.*)$/
    );
    if (m) {
      decisions.push({
        ts: m[1],
        decision: m[2],
        detail: m[3]
      });
    }
  }
  return { count: decisions.length, decisions };
}
function readDomainStats(dir) {
  const stateDir = resolveStateDir(dir);
  const nodes = readNdjson(join(stateDir, "nodes.ndjson"));
  const edges = readNdjson(join(stateDir, "edges.ndjson"));
  const nodeTypes = {};
  for (const n of nodes) {
    const t = n.type ?? "unknown";
    nodeTypes[t] = (nodeTypes[t] ?? 0) + 1;
  }
  const edgeTypes = {};
  for (const e of edges) {
    const r = e.rel ?? "unknown";
    edgeTypes[r] = (edgeTypes[r] ?? 0) + 1;
  }
  return {
    nodes: nodes.length,
    edges: edges.length,
    nodeTypes,
    edgeTypes
  };
}
function bar(pct) {
  const n = pct <= 0 ? 0 : Math.max(1, Math.min(10, Math.round(pct / 10)));
  return "\u2588".repeat(n) + "\u2591".repeat(10 - n);
}
function formatStatus(r) {
  const lines = [];
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
      `learning: ${r.learning.rulesCount} rules, ${r.learning.failuresCount} failures, ${r.learning.domainNodes} domain nodes`
    );
  }
  return lines.join("\n");
}
function formatAggregate(r) {
  const lines = [];
  const a = r.aggregate;
  lines.push(`usage-coach aggregate \u2014 ${r.instanceCount} instances`);
  lines.push(` max 5h ${bar(a.maxFiveHour)} ${a.maxFiveHour}%`);
  lines.push(` max 1w ${bar(a.maxWeekly)} ${a.maxWeekly}%`);
  const decs = Object.entries(a.decisions).map(([k, v]) => `${k}:${v}`).join(" ");
  lines.push(` decisions: ${decs}`);
  lines.push(
    ` harnesses: ${a.activeHarnesses} active, ${a.totalTasks} tasks`
  );
  lines.push(
    ` learning: ${a.totalRules} rules, ${a.totalFailures} failures, ${a.totalDomainNodes} domain nodes`
  );
  return lines.join("\n");
}
function formatRules(r) {
  if (r.count === 0) return "No rules accumulated yet.";
  const lines = [`${r.count} rules:`];
  for (const rule of r.rules) {
    lines.push(
      `  #${rule.number} (${rule.date}, ${rule.category}): ${rule.text.slice(0, 80)}${rule.text.length > 80 ? "..." : ""}`
    );
  }
  return lines.join("\n");
}
function formatDecisions(r) {
  if (r.count === 0) return "No decisions logged.";
  const lines = [`${r.count} recent decisions:`];
  for (const d of r.decisions) {
    lines.push(`  ${d.ts} ${d.decision} ${d.detail}`);
  }
  return lines.join("\n");
}
function formatDomain(r) {
  if (r.nodes === 0 && r.edges === 0) return "No domain knowledge stored.";
  const nt = Object.entries(r.nodeTypes).map(([k, v]) => `${k}:${v}`).join(" ");
  const et = Object.entries(r.edgeTypes).map(([k, v]) => `${k}:${v}`).join(" ");
  return [
    `domain: ${r.nodes} nodes, ${r.edges} edges`,
    ` node types: ${nt}`,
    ` edge types: ${et}`
  ].join("\n");
}
var GLOBAL_CONFIG_DIR = join(homedir(), ".config", "opencode-usage-coach");
var OPENCODE_AGENTS_DIR = join(homedir(), ".config", "opencode", "agents");
var OPENCODE_TUI_CONFIG = join(homedir(), ".config", "opencode", "tui.json");
var DEFAULT_HARNESS_CONFIG = {
  generator: "opencode/deepseek-v4-flash-free",
  grader: "opencode/mimo-v2.5-free",
  provider: "",
  lighterModel: "",
  maxSteps: 30
};
function resolveAgentSourceFile() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  return join(scriptDir, "..", "agents", "usage-coach-harness.md");
}
function resolveTuiPath(scriptDir) {
  const dir = scriptDir ?? dirname(fileURLToPath(import.meta.url));
  return join(dir, "tui.js");
}
function configureTui(tuiPath, tuiConfigPath) {
  if (!existsSync(tuiPath)) {
    return { action: "not-found", path: tuiPath };
  }
  let config = {};
  if (existsSync(tuiConfigPath)) {
    try {
      config = JSON.parse(readFileSync(tuiConfigPath, "utf8"));
    } catch {
      config = {};
    }
  }
  const plugins = Array.isArray(config["plugin"]) ? config["plugin"] : [];
  if (plugins.includes(tuiPath)) {
    return { action: "exists", path: tuiConfigPath };
  }
  const filtered = plugins.filter(
    (p) => !p.includes("opencode-usage-coach")
  );
  filtered.push(tuiPath);
  config["plugin"] = filtered;
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
function detectCodexbar() {
  try {
    const r = spawnSync("codexbar", ["--version"], { timeout: 5e3 });
    if (r.status === 0 || r.stdout && r.stdout.toString().trim().length > 0) {
      return { found: true, version: (r.stdout?.toString().trim() ?? "") || "unknown" };
    }
    return { found: false, version: "" };
  } catch {
    return { found: false, version: "" };
  }
}
function doSetup(opts = {}) {
  const configDir = opts.configDir ?? GLOBAL_CONFIG_DIR;
  const agentsDir = opts.agentsDir ?? OPENCODE_AGENTS_DIR;
  const agentSource = opts.agentSourceFile ?? resolveAgentSourceFile();
  const tuiConfigPath = opts.tuiConfigPath ?? OPENCODE_TUI_CONFIG;
  const configPath = join(configDir, "harness.config.json");
  let configAction;
  if (existsSync(configPath)) {
    configAction = "exists";
  } else {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify(DEFAULT_HARNESS_CONFIG, null, 2) + "\n"
    );
    configAction = "created";
  }
  const codexbar = detectCodexbar();
  const agentDestPath = join(agentsDir, "usage-coach-harness.md");
  let agentAction;
  if (!existsSync(agentSource)) {
    agentAction = "source-not-found";
  } else if (existsSync(agentDestPath)) {
    agentAction = "exists";
  } else {
    mkdirSync(agentsDir, { recursive: true });
    copyFileSync(agentSource, agentDestPath);
    agentAction = "copied";
  }
  const tuiPath = resolveTuiPath(opts.scriptDir);
  const tuiResult = configureTui(tuiPath, tuiConfigPath);
  return {
    harnessConfig: { action: configAction, path: configPath },
    codexbar,
    agentFile: { action: agentAction, path: agentDestPath },
    tuiConfig: tuiResult
  };
}
function formatSetup(r) {
  const lines = ["usage-coach setup", ""];
  const configCheck = r.harnessConfig.action === "created" ? "\u2705" : "\u2705";
  lines.push(
    `  ${configCheck} harness.config.json ${r.harnessConfig.action === "created" ? "created" : "already exists"}`
  );
  lines.push(`     ${r.harnessConfig.path}`);
  if (r.harnessConfig.action === "created") {
    lines.push(
      `     generator: ${DEFAULT_HARNESS_CONFIG.generator} (edit or use /coach-config)`
    );
  }
  if (r.codexbar.found) {
    lines.push("");
    lines.push(`  \u2705 codexbar found`);
    lines.push(`     ${r.codexbar.version}`);
  } else {
    lines.push("");
    lines.push(`  \u26A0\uFE0F  codexbar not found`);
    lines.push(`     Plugin runs in GO-only mode (no quota sensing)`);
  }
  lines.push("");
  if (r.agentFile.action === "copied") {
    lines.push(`  \u2705 Agent file copied`);
    lines.push(`     ${r.agentFile.path}`);
  } else if (r.agentFile.action === "exists") {
    lines.push(`  \u2705 Agent file already exists`);
    lines.push(`     ${r.agentFile.path}`);
  } else {
    lines.push(`  \u26A0\uFE0F  Agent source not found`);
    lines.push(`     Expected: ${r.agentFile.path}`);
  }
  lines.push("");
  if (r.tuiConfig.action === "configured") {
    lines.push(`  \u2705 TUI plugin configured`);
    lines.push(`     ${r.tuiConfig.path}`);
  } else if (r.tuiConfig.action === "exists") {
    lines.push(`  \u2705 TUI plugin already configured`);
    lines.push(`     ${r.tuiConfig.path}`);
  } else if (r.tuiConfig.action === "not-found") {
    lines.push(`  \u26A0\uFE0F  TUI plugin (dist/tui.js) not found`);
    lines.push(`     Run: npm install -g opencode-usage-coach`);
  } else {
    lines.push(`  \u26A0\uFE0F  Could not write TUI config`);
    lines.push(`     Manually add to ${r.tuiConfig.path}`);
  }
  lines.push("");
  lines.push("Setup complete. Restart opencode to apply changes.");
  return lines.join("\n");
}
function parseArgs(argv) {
  const args = argv.slice(2);
  let command = "status";
  let json = false;
  let dir;
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
var HELP = `usage-coach \u2014 quota intelligence CLI for opencode

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
function getVersion() {
  try {
    const pkgPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "package.json"
    );
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
function main() {
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
        args.json ? JSON.stringify(r, null, 2) : formatDecisions(r)
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
      console.error(`Unknown command: ${args.command}

${HELP}`);
      process.exit(1);
    }
  }
}
var isDirectRun = process.argv[1] && (process.argv[1].endsWith("cli.js") || process.argv[1].endsWith("cli.ts") || process.argv[1].endsWith("usage-coach"));
if (isDirectRun) {
  main();
}
export {
  configureTui,
  doSetup,
  parseArgs,
  projectStateDir,
  readAggregateStatus,
  readDecisions,
  readDomainStats,
  readRules,
  readStatus,
  resolveAgentSourceFile,
  resolveStateDir,
  resolveTuiPath
};
