// grade-checks.ts — deterministic verification checks for grade()/grade_batch().
// Replaces the grader-model round-trip for mechanical tasks: the orchestrator
// states what a correct result must look like (files that must exist, grep
// patterns, line budgets) and the harness verifies it locally in milliseconds.
// Model grading stays the right tool for judgment calls; checks are for the
// "can be proven by inspection" class — conversions, extractions, scaffolds.

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, relative, resolve } from "path";

export type GradeCheckType = "file-exists" | "grep" | "grep-absent" | "line-count";

export type GradeCheck =
  | { type: "file-exists"; path: string }
  | { type: "grep"; pattern: string; path?: string; minCount?: number }
  | { type: "grep-absent"; pattern: string; path?: string }
  | { type: "line-count"; path: string; min?: number; max?: number };

export type CheckResult = { check: GradeCheck; pass: boolean; detail: string };

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage", ".venv", "__pycache__", ".cache",
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_WALK_FILES = 2000;
const MAX_WALK_DEPTH = 8;
const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".c", ".h", ".cpp",
  ".sh", ".md", ".json", ".yaml", ".yml", ".toml", ".txt", ".html", ".css", ".sql",
]);

function listTextFiles(root: string, out: string[] = [], depth = 0): string[] {
  if (depth > MAX_WALK_DEPTH || out.length >= MAX_WALK_FILES) return out;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    const p = join(root, e.name);
    if (e.isDirectory()) listTextFiles(p, out, depth + 1);
    else if (e.isFile()) {
      const dot = e.name.lastIndexOf(".");
      const ext = dot >= 0 ? e.name.slice(dot).toLowerCase() : "";
      if (TEXT_EXT.has(ext)) out.push(p);
      if (out.length >= MAX_WALK_FILES) break;
    }
  }
  return out;
}

function countMatches(re: RegExp, text: string): number {
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const m = text.match(new RegExp(re.source, flags));
  return m ? m.length : 0;
}

function grepTargets(root: string, path?: string): string[] {
  const target = resolve(root, path ?? ".");
  if (!existsSync(target)) return [];
  const st = statSync(target);
  if (st.isFile()) return [target];
  return listTextFiles(target);
}

export function evalChecks(root: string, checks: GradeCheck[]): { pass: boolean; results: CheckResult[] } {
  const results: CheckResult[] = [];
  for (const c of checks) {
    if (c.type === "file-exists") {
      const full = resolve(root, c.path);
      const ok = existsSync(full);
      results.push({ check: c, pass: ok, detail: `${c.path}: ${ok ? "exists" : "MISSING"}` });
    } else if (c.type === "grep" || c.type === "grep-absent") {
      let re: RegExp;
      try {
        re = new RegExp(c.pattern);
      } catch (e: any) {
        results.push({ check: c, pass: false, detail: `invalid regex ${JSON.stringify(c.pattern)}: ${String(e?.message ?? e).slice(0, 80)}` });
        continue;
      }
      const targets = grepTargets(root, c.path);
      let total = 0;
      const hits: string[] = [];
      for (const t of targets) {
        let text: string;
        try {
          if (statSync(t).size > MAX_FILE_BYTES) continue;
          text = readFileSync(t, "utf8");
        } catch { continue; }
        const n = countMatches(re, text);
        if (n > 0) {
          total += n;
          if (hits.length < 5) hits.push(`${relative(root, t)}:${n}`);
        }
      }
      if (targets.length === 0) {
        results.push({ check: c, pass: false, detail: `path ${c.path ?? "."}: no scan targets found` });
      } else if (c.type === "grep") {
        const min = c.minCount ?? 1;
        results.push({ check: c, pass: total >= min, detail: `pattern ${JSON.stringify(c.pattern)}: ${total} match(es), need >= ${min}${hits.length ? " — e.g. " + hits.join(", ") : ""}` });
      } else {
        results.push({ check: c, pass: total === 0, detail: `pattern ${JSON.stringify(c.pattern)}: ${total} match(es), need 0${hits.length ? " — e.g. " + hits.join(", ") : ""}` });
      }
    } else if (c.type === "line-count") {
      const full = resolve(root, c.path);
      if (!existsSync(full) || !statSync(full).isFile()) {
        results.push({ check: c, pass: false, detail: `${c.path}: MISSING` });
        continue;
      }
      let n: number;
      try {
        n = readFileSync(full, "utf8").split("\n").filter((l) => l.trim()).length;
      } catch {
        results.push({ check: c, pass: false, detail: `${c.path}: unreadable` });
        continue;
      }
      const minOk = c.min === undefined || n >= c.min;
      const maxOk = c.max === undefined || n <= c.max;
      results.push({ check: c, pass: minOk && maxOk, detail: `${c.path}: ${n} non-empty lines (min ${c.min ?? "-"}, max ${c.max ?? "-"})` });
    } else {
      results.push({ check: c, pass: false, detail: `unknown check type: ${(c as any).type}` });
    }
  }
  return { pass: results.length > 0 && results.every((r) => r.pass), results };
}

export function formatCheckReport(r: { pass: boolean; results: CheckResult[] }): string {
  return r.results.map((x) => `${x.pass ? "PASS" : "FAIL"} [${x.check.type}] ${x.detail}`).join("\n");
}
