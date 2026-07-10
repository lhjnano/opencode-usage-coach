#!/usr/bin/env node
// Reads coverage/coverage-summary.json and writes coverage-badge.json
// (shields.io endpoint format) — no external service required.
import { readFileSync, writeFileSync } from "node:fs";

try {
  const summary = JSON.parse(readFileSync("coverage/coverage-summary.json", "utf8"));
  const pct = Math.round(summary.total.lines.pct);
  const color = pct >= 80 ? "brightgreen" : pct >= 50 ? "yellow" : pct >= 30 ? "orange" : "red";
  const badge = {
    schemaVersion: 1,
    label: "coverage",
    message: `${pct}%`,
    color,
  };
  writeFileSync("coverage-badge.json", JSON.stringify(badge, null, 2) + "\n");
  console.log(`coverage-badge.json written: ${pct}% (${color})`);
} catch (e) {
  console.error("Failed to generate coverage badge:", e.message);
  process.exit(1);
}
