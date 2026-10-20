// tsup.config.ts — server + TUI bundling
// Key point: the TUI build keeps the solid packages external (not bundled) and uses
// esbuild-plugin-solid to compile JSX at build time, so at runtime the JSX resolves to
// opencode's own solid instance (avoids a duplicate-instance conflict).
// (Same verified pattern used by opencode-subagent-statusline.)
import { solidPlugin } from "esbuild-plugin-solid";
import { defineConfig } from "tsup";
import { readFileSync, writeFileSync } from "fs";

// opencode calls ALL named exports as plugin factory functions.
// We must strip everything except `server` (and `default`) from the dist output,
// otherwise utility functions (coach, buildGapPrompt, etc.) get called with the wrong
// input and crash. The dual default export (V2 setup + .server) is emitted
// explicitly: default = the dual object (V2 host calls .setup), server = the
// V1 factory (V1 1.18.29+ calls .server()).
function stripNamedExports() {
  const path = "dist/index.js";
  let c = readFileSync(path, "utf8");
  // Replace the first `export { ... };` block (named exports) with server/default only.
  c = c.replace(
    /export \{[^}]+\};/,
    "export { UsageCoachPlugin, UsageCoachPlugin as server, dual as default };",
  );
  // Remove `export type { ... };` if present.
  c = c.replace(/export type \{[^}]+\};/g, "");
  writeFileSync(path, c);
}

export default defineConfig([
  {
    // SERVER module: bundle into a single file, no local deps.
    // "@opencode/plugin" (V2 SDK) is externalized exactly like "@opencode-ai/plugin"
    // (V1 SDK): the host provides both at runtime; bundling would duplicate them.
    entry: { index: "src/index.ts" },
    format: ["esm"],
    target: "node22",
    bundle: true,
    splitting: false,
    clean: true,
    outDir: "dist",
    external: ["@opencode-ai/plugin", "@opencode/plugin"],
    onSuccess: stripNamedExports,
  },
  {
    // CLI module: standalone entry for `usage-coach` bin. No external deps.
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node22",
    bundle: true,
    splitting: false,
    clean: false,
    outDir: "dist",
    external: [],
  },
  {
    // TUI module: solid packages external + compile JSX via solidPlugin (universal).
    entry: { tui: "src/tui.tsx" },
    format: ["esm"],
    target: "node22",
    bundle: true,
    splitting: false,
    clean: false,
    outDir: "dist",
    external: [
      "@opencode-ai/plugin",
      "@opencode-ai/plugin/tui",
      "@opencode/plugin",
      "@opentui/core",
      "@opentui/solid",
      "solid-js",
    ],
    esbuildPlugins: [
      solidPlugin({ solid: { generate: "universal", moduleName: "@opentui/solid" } }),
    ],
  },
]);
