// tsup.config.ts — server + TUI bundling
// Key point: the TUI build keeps the solid packages external (not bundled) and uses
// esbuild-plugin-solid to compile JSX at build time, so at runtime the JSX resolves to
// opencode's own solid instance (avoids a duplicate-instance conflict).
// (Same verified pattern used by opencode-subagent-statusline.)
import { solidPlugin } from "esbuild-plugin-solid";
import { defineConfig } from "tsup";

export default defineConfig([
  {
    // SERVER module: bundle into a single file, no local deps.
    entry: { index: "src/index.ts" },
    format: ["esm"],
    target: "node22",
    bundle: true,
    splitting: false,
    clean: true,
    outDir: "dist",
    external: ["@opencode-ai/plugin"],
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
      "@opentui/core",
      "@opentui/solid",
      "solid-js",
    ],
    esbuildPlugins: [
      solidPlugin({ solid: { generate: "universal", moduleName: "@opentui/solid" } }),
    ],
  },
]);
