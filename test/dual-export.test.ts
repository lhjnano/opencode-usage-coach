// dual-export.test.ts — the dual host entry (default export of src/index.ts):
//   default = { id, setup (V2), server (V1 factory) }
// plus BUILD assertions on dist/index.js (skipped when the dist has not been
// built yet — `npm run build` before `npm test` exercises them).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import dual, { UsageCoachPlugin } from "../src/index.js";
import { V2Plugin } from "../src/v2.js";

// ── src-level dual export shape ──────────────────────────────────────────────

test("dual default export: .server === UsageCoachPlugin (named V1 factory), typeof .setup === 'function', .id === 'opencode-usage-coach'", () => {
  assert.equal(dual.server, UsageCoachPlugin, "dual.server is the V1 plugin factory");
  assert.equal(typeof dual.setup, "function", "dual.setup is the V2 setup function");
  assert.equal(dual.id, "opencode-usage-coach", "dual.id is the V2 plugin id");
  assert.equal(typeof UsageCoachPlugin, "function", "V1 factory still exported by name");
  // The V2 setup is the SAME function v2.ts exports (single implementation).
  assert.equal(dual.setup, V2Plugin.setup);
});

// ── dist build assertions (skip if dist/index.js is absent) ──────────────────

const distPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const haveDist = existsSync(distPath);

test("dist/index.js: named `server` export + `dual as default` (stripNamedExports output)", { skip: !haveDist }, () => {
  const c = readFileSync(distPath, "utf8");
  // The strip replacement ran and produced exactly the dual export surface
  // (named V1 factory for pre-1.18.29 hosts + server + callable-object default).
  assert.ok(
    c.includes("export { UsageCoachPlugin, UsageCoachPlugin as server, dual as default };"),
    "dist exports named V1 factory + server + default=dual",
  );
  assert.ok(!/export \{ (coach|buildGapPrompt|parseFileList)/.test(c), "utility named exports were stripped");
});

test("dist/index.js: the dual object carries both server (V1) and setup (V2)", { skip: !haveDist }, () => {
  const c = readFileSync(distPath, "utf8");
  // The dual object literal is reachable in the bundle...
  assert.ok(/const dual\s*=|var dual\s*=/.test(c), "dual identifier exists in the bundle");
  assert.ok(/server:\s*UsageCoachPlugin/.test(c), "dual object literal includes server: UsageCoachPlugin");
  assert.ok(/setup:\s*v2Setup/.test(c), "dual object literal includes setup: v2Setup (V2 path)");
  // ...and the V2 SDK stays external like the V1 SDK.
  assert.ok(/from\s+"@opencode\/plugin"/.test(c), "@opencode/plugin import externalized in dist");
  assert.ok(/from\s+"@opencode-ai\/plugin"/.test(c), "@opencode-ai/plugin import still externalized");
});

test("dist/index.js runtime import: server is the V1 factory, default is the dual object", { skip: !haveDist }, async () => {
  const mod: any = await import(distPath);
  assert.equal(typeof mod.server, "function", "named export server === V1 factory");
  assert.equal(typeof mod.default?.setup, "function", "default.setup === V2 setup");
  assert.equal(typeof mod.default?.server, "function", "default.server === V1 factory");
  assert.equal(mod.default?.id, "opencode-usage-coach", "default.id === plugin id");
  assert.equal(mod.default.server, mod.server, "default.server IS the named server export");
});
