#!/usr/bin/env node
// migrate-v016.mjs — v0.16.0 shared-domain-graph migration (phase2-brief Task C.1)
//
// Usage:
//   node scripts/migrate-v016.mjs [--state-dir <dir>] [--dry-run] [--purge-auto]
//
//   --state-dir <dir>  Root state dir containing shared/. Default: ~/.cache/opencode-usage-coach
//   --dry-run          Compute and print stats only. A backup is STILL taken (spec).
//   --purge-auto       Additionally remove every edge with rel==='related-to' whose
//                      note starts with 'auto:' (phase2-brief 스캔 반영 결정 6).
//
// Safety design (phase2-brief 스캔 반영 결정 6):
//   - Backup ALWAYS runs, before any decision is made (dry-run included).
//   - Tolerant line-by-line parsing is implemented HERE on purpose: domain.ts
//     readNdjson() returns [] for the whole file if ANY line fails JSON.parse
//     (all-or-nothing), which would make a sweep see an empty "before" set.
//     This script skips bad lines and reports a per-file badLine count instead.
//   - Ghost definition: an edge survives only if BOTH endpoints resolve in the
//     UNION of shared + all projects/*/nodes.ndjson ids. This mirrors
//     src/domain.ts sweepDeadEdges() (which unions readNodes() = project+shared).
//     Deliberately NOT a per-layer check: autoLinkKeywords appends cross-layer
//     edges into sharedEdgesFile, so strict per-layer validation would delete
//     healthy edges (스캔 반영 결정 1). The tiny union∧ logic is duplicated here
//     instead of importing domain.ts because this script must run under plain
//     `node` (.mjs) — domain.ts is TypeScript; keep this in sync with it.
//   - The shared edge file is rewritten only when its edge set actually shrank
//     (same rewrite-safety rule as sweepDeadEdges). Project-layer edge files are
//     NOT touched by this script; the in-process sweepDeadEdges hook (session
//     idle) covers them, and auto edges only ever live in shared/.
//   - Empty kept-set still rewrites (writes an empty file) so a full purge sticks.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
function argValue(name) {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
const hasFlag = (name) => argv.includes(name);
const DRY = hasFlag("--dry-run");
const PURGE_AUTO = hasFlag("--purge-auto");
const stateDir = path.resolve(argValue("--state-dir") ?? path.join(os.homedir(), ".cache", "opencode-usage-coach"));

const sharedDir = path.join(stateDir, "shared");
const projectsDir = path.join(stateDir, "projects");
const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "") + "-" + new Date().toTimeString().slice(0, 5).replaceAll(":", "");
const BAK_SUFFIX = `.bak-${stamp}`;

if (!fs.existsSync(sharedDir)) {
  console.error(`ERROR: shared dir not found: ${sharedDir}`);
  console.error(`(pass --state-dir <dir> to point at the state root that contains shared/)`);
  process.exit(1);
}

// ---- tolerant line parsing (do NOT replace with domain.ts readNdjson) --------
// Per line: try JSON.parse; on failure skip and count. Never throws, never
// discards the whole file the way domain.ts readNdjson does.
function parseNdjsonTolerant(file) {
  const out = { items: [], badLines: 0, totalLines: 0 };
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { ...out, missing: true };
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    out.totalLines++;
    try {
      out.items.push(JSON.parse(line));
    } catch {
      out.badLines++;
    }
  }
  return out;
}

// ---- backup (always, incl. dry-run) -----------------------------------------
function backupShared() {
  const made = [];
  for (const name of fs.readdirSync(sharedDir)) {
    if (!name.endsWith(".ndjson")) continue;
    const src = path.join(sharedDir, name);
    if (!fs.statSync(src).isFile()) continue;
    let dst = path.join(sharedDir, name + BAK_SUFFIX);
    let n = 1;
    while (fs.existsSync(dst)) dst = path.join(sharedDir, `${name}${BAK_SUFFIX}-${n++}`);
    fs.copyFileSync(src, dst);
    made.push(dst);
  }
  return made;
}

// ---- main --------------------------------------------------------------------
const backups = backupShared();

const sharedNodes = parseNdjsonTolerant(path.join(sharedDir, "nodes.ndjson"));
const sharedEdges = parseNdjsonTolerant(path.join(sharedDir, "edges.ndjson"));

// Node id union: shared layer + EVERY project layer (superset of the active
// project). A superset union can only keep more edges alive — the conservative
// direction for a destructive sweep.
const unionIds = new Set();
for (const n of sharedNodes.items) if (n && typeof n.id === "string") unionIds.add(n.id);
let projectNodeFiles = 0;
if (fs.existsSync(projectsDir)) {
  for (const d of fs.readdirSync(projectsDir)) {
    const f = path.join(projectsDir, d, "nodes.ndjson");
    if (!fs.existsSync(f)) continue;
    projectNodeFiles++;
    for (const n of parseNdjsonTolerant(f).items) if (n && typeof n.id === "string") unionIds.add(n.id);
  }
}

const isGhost = (e) => !(unionIds.has(e.from) && unionIds.has(e.to));
const isAuto = (e) => e.rel === "related-to" && typeof e.note === "string" && e.note.startsWith("auto:");

const edges = sharedEdges.items;
const ghosts = edges.filter(isGhost);
const autos = edges.filter(isAuto);
const overlap = edges.filter((e) => isGhost(e) && isAuto(e)).length;
const kept = edges.filter((e) => !isGhost(e) && !isAuto(e));

console.log("=== migrate-v016 ===");
console.log(`state-dir : ${stateDir}`);
console.log(`mode      : ${DRY ? "DRY-RUN (no changes applied)" : "APPLY"}${PURGE_AUTO ? " + purge-auto" : ""}`);
console.log(`backup    : ${backups.length} file(s)`);
for (const b of backups) console.log(`            ${b}`);

console.log("\n-- before --");
console.log(`shared nodes        : ${sharedNodes.items.length}${sharedNodes.missing ? " (file missing)" : ""}  badLines=${sharedNodes.badLines}`);
console.log(`shared edges        : ${edges.length}${sharedEdges.missing ? " (file missing)" : ""}  badLines=${sharedEdges.badLines}`);
console.log(`project node files  : ${projectNodeFiles} (union ids only)`);
console.log(`node id union       : ${unionIds.size}`);
console.log(`auto edges (note~auto:) : ${autos.length}`);
console.log(`ghost edges (union)     : ${ghosts.length}   (ghost∩auto overlap: ${overlap})`);

if (sharedEdges.badLines > 0) {
  console.log(`\nWARNING: ${sharedEdges.badLines} unparseable line(s) in shared/edges.ndjson were skipped.`);
  console.log(`They are NOT part of the kept set — they will be DROPPED if this run applies.`);
}

let applied = false;
if (!DRY) {
  const edgesFile = path.join(sharedDir, "edges.ndjson");
  if (kept.length !== edges.length) {
    // Rewrite-safety parity with domain.ts sweepDeadEdges: write only when the
    // set shrank. Empty kept set is a legitimate outcome (full purge) and IS
    // written so the removal sticks.
    fs.writeFileSync(edgesFile, kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""));
    applied = true;
    console.log("\n-- after (applied) --");
    console.log(`shared edges        : ${edges.length} -> ${kept.length}`);
    console.log(`removed ghost       : ${ghosts.length}`);
    console.log(`removed auto        : ${autos.length - overlap}`);
    console.log(`removed both        : ${overlap}`);
    console.log(`total removed       : ${edges.length - kept.length}`);
  } else {
    console.log("\n-- after --");
    console.log("nothing to remove; shared/edges.ndjson left untouched");
  }
} else {
  console.log("\n-- after (projected, not applied) --");
  console.log(`shared edges        : ${edges.length} -> ${kept.length}`);
  console.log(`would remove ghost  : ${ghosts.length}`);
  console.log(`would remove auto   : ${autos.length - overlap}`);
  console.log(`would remove both   : ${overlap}`);
  console.log(`total would remove  : ${edges.length - kept.length}`);
}

console.log(`\nbackup still on disk regardless of mode: shared/*.ndjson${BAK_SUFFIX}`);
process.exit(applied ? 0 : 0);
