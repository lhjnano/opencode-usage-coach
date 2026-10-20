// v2.ts — the OpenCode V2 plugin adapter.
//
// Wraps the SAME shared machinery the V1 adapter (index.ts) uses:
//   - quota state machine  (quota.ts)          — SENSE → DECIDE cycle
//   - tool definitions     (tool-defs.ts)      — the 16 harness tools
//   - SessionOps facade    (v2-session.ts)     — ctx.session.* → SessionOps
//   - agent resolution     (index.ts)          — resolveAgent/isHarnessAgent
// and adapts it to the V2 plugin surface (`Plugin.define`, tool.transform,
// tool.hook, session.hook, event.subscribe). Differences from V1 wiring:
//   - tools: JSON Schema passed DIRECTLY (no schema-convert/zod), flat names,
//     execute returns V2's `{ content }` result shape;
//   - gating: "execute.before" tool hook instead of the V1 hook map entry —
//     same agent-mode restriction, same quota STOP throw, same messages;
//   - coaching injection: session "context"/"compaction"/"title" hooks push
//     `{ type: "text", text }` system parts (V1 pushed plain strings);
//   - events: ctx.event.subscribe() async-iterable (V1: the event hook map).
//
// Import-cycle note: this module imports helpers from index.ts, and index.ts
// imports buildV2Setup() from here. That cycle is safe in BOTH entry orders:
// everything v2.ts uses from index.ts is consumed inside function bodies, and
// buildV2Setup is a hoisted function declaration, so index.ts's module-level
// `dual` construction can call it even while v2.ts is still loading.
import { Plugin } from "@opencode/plugin";
import { createQuotaMachine, type QuotaMachine } from "./quota.js";
import { buildToolDefs, type ToolHost } from "./tool-defs.js";
import { makeV2SessionOps } from "./v2-session.js";
import type { Runtime } from "./rt.js";
import { initDomain, evictStale, evictSharedStale, sweepDeadEdges } from "./domain.js";
import {
  PLUGIN_NAME, HARNESS_AGENTS, WORM_MAX_AGE_DAYS, WORM_MAX_NODES,
  SHARED_WORM_MAX_AGE_DAYS, SHARED_WORM_MAX_NODES,
  STATE_DIR, setStateDir, readHarnessCfg, resolveAgent, isHarnessAgent, log,
} from "./index.js";

// Harness tools gated by agent mode + quota STOP (verbatim from the V1 adapter).
const HARNESS_TOOLS = ["unknown_scan", "question", "generate", "generate_batch", "grade", "grade_batch", "investigate", "verify_diagnosis", "generalize", "harness_start", "task_update", "harness_done", "record_failure", "reverse_interview"];

/** The V2 setup, as a hoisted function DECLARATION (exported directly). index.ts
 *  references this binding at module scope for its `dual` default export without
 *  calling it — safe under the index ↔ v2 import cycle in either order (a `const`
 *  arrow or a factory CALL would hit v2.ts's unevaluated module scope / TDZ when
 *  index.ts is evaluated first). `injected.quota` lets tests drive the gating
 *  paths deterministically (STOP / agent restriction) without codexbar. */
export async function v2Setup(ctx: any, injected?: { quota?: QuotaMachine }): Promise<() => void> {
  // Same init sequence as the V1 UsageCoachPlugin start: per-directory state
  // isolation + domain DB, then harness cfg (logging/warmup only).
  setStateDir(ctx.location.directory);
  initDomain(STATE_DIR);
  const cfg0 = readHarnessCfg(ctx.location.directory);
  if (cfg0.domainAutoLink !== undefined) process.env.UC_AUTOLINK = cfg0.domainAutoLink ? "1" : "0";

  const rt: Runtime = { directory: ctx.location.directory, session: makeV2SessionOps(ctx) };
  let currentAgent = "";
  const quota = injected?.quota ?? createQuotaMachine({
    directory: rt.directory,
    provider: process.env.UC_PROVIDER ?? cfg0.provider ?? "",
    lighter: process.env.UC_LIGHTER_MODEL ?? cfg0.lighterModel ?? "a lighter model",
    getAgent: () => currentAgent,
  });
  const host: ToolHost = { rt, current: quota.current, refresh: quota.refresh };

  // (1) Tools — same 16 defs, JSON Schema direct (no converter), V2 {content} return.
  // No tool namespace: the flat names (generate, grade, ...) are part of the
  // injected harness protocol text.
  await ctx.tool.transform((editor: any) => {
    for (const def of buildToolDefs()) {
      editor.add({
        name: def.name,
        description: def.description,
        input: def.schema,
        execute: async (input: any, context: any) => ({
          content: await def.execute(input, { sessionID: context?.sessionID, directory: rt.directory, signal: context?.signal }, host),
        }),
      });
    }
  });

  // (2) tool execute.before — replicates the V1 gating EXACTLY: agent/model
  // resolution on every call, harness-tool list + agent-mode restriction
  // (same error message shape), quota STOP throw (same message shape).
  // V2 event shape: single mutable event with .tool/.sessionID/.input.
  await ctx.tool.hook("execute.before", async (event: any) => {
    const sessionID = event?.sessionID ?? (event as any).sessionID;
    const info = await resolveAgent(rt.session, sessionID);
    currentAgent = info.agent;
    quota.setModel(info.model, info.provider);
    quota.refresh(); // picks up model changes immediately

    if (!HARNESS_TOOLS.includes(event?.tool)) return; // only harness tools are gated below
    if (!isHarnessAgent(info.agent)) {
      throw new Error(`[${PLUGIN_NAME}] '${event.tool}' is restricted to agent mode ${JSON.stringify(HARNESS_AGENTS)} (current: ${JSON.stringify(info.agent || "unknown")}). Switch to that agent mode to use it.`);
    }
    // (2) quota gate: STOP blocks quota-consuming harness tools.
    let decision: string;
    try { decision = quota.current().decision; } catch { decision = "GO"; } // safe default
    if (decision === "STOP") {
      throw new Error(`[${PLUGIN_NAME}] blocked: quota limit exceeded. ${quota.current().advice}`);
    }
  });

  // (3) Session context hook — replicates the V1 coaching injection EXACTLY
  // (same instruction strings). V2 `system` is a content-item array, so the
  // instruction is pushed as { type: "text", text }. The SAME hook body is
  // registered on "context" AND "compaction" AND "title" (V1's
  // system.transform applied broadly; agent-guard semantics kept — title has
  // no agent field, resolveAgent still works via sessionID).
  const sessionCoaching = async (event: any) => {
    try {
      const sessionID = event?.sessionID;
      if (sessionID) {
        const info = await resolveAgent(rt.session, sessionID);
        quota.setModel(info.model, info.provider);
        quota.refresh(); // picks up model changes immediately
        if (!isHarnessAgent(info.agent)) return; // not harness mode — don't inject
      }
      const c = quota.current();
      let instruction = "";
      if (c.decision === "STOP") instruction = `[${PLUGIN_NAME}] QUOTA limit exceeded. ${c.advice} Stop making further tool calls, finish the in-progress work, then report the quota status to the user.`;
      else if (c.decision === "THROTTLE") instruction = `[${PLUGIN_NAME}] ${c.advice} Hold off on long/heavy tasks.`;
      else if (c.weekly >= 0 || c.fiveHour >= 0) {
        const parts: string[] = [];
        if (c.weekly >= 0) parts.push(`weekly ${c.weekly}%`);
        if (c.fiveHour >= 0) parts.push(`5h ${c.fiveHour}%`);
        if (c.monthly >= 0) parts.push(`monthly ${c.monthly}%`);
        instruction = `[${PLUGIN_NAME}] quota ok — ${parts.join(" · ")}.`;
      }
      if (instruction) event.system.push({ type: "text", text: instruction });
    } catch (e) { log(`system.transform err: ${String(e)}`); }
  };
  await ctx.session.hook("context", sessionCoaching);
  await ctx.session.hook("compaction", sessionCoaching);
  await ctx.session.hook("title", sessionCoaching);

  // (4) Events — replicates the V1 event handler: session.created/session.idle
  // → quota refresh; session.idle → worm GC (evictStale/evictSharedStale/
  // sweepDeadEdges with the same guards + logs). `await subscribe(...)` unwraps
  // a Promise-returning host (the SDK type returns the AsyncIterable directly).
  const controller = new AbortController();
  void (async () => {
    try {
      const stream = await ctx.event.subscribe({ signal: controller.signal });
      for await (const ev of stream) {
        try {
          const type = (ev as any)?.type;
          if (type === "session.created" || type === "session.idle") quota.refresh();
          if (type === "session.idle") { try { const r = evictStale(WORM_MAX_AGE_DAYS, WORM_MAX_NODES); if (r.removed) log(`evictStale: removed ${r.removed}, kept ${r.kept} (maxAge=${WORM_MAX_AGE_DAYS}d, maxNodes=${WORM_MAX_NODES})`); } catch (e) { log(`evictStale err: ${String(e)}`); } try { const sh = evictSharedStale(SHARED_WORM_MAX_AGE_DAYS, SHARED_WORM_MAX_NODES); if (sh.removed) log(`evictSharedStale: removed ${sh.removed}, kept ${sh.kept} (maxAge=${SHARED_WORM_MAX_AGE_DAYS}d, maxNodes=${SHARED_WORM_MAX_NODES})`); } catch (e) { log(`evictSharedStale err: ${String(e)}`); } try { const s = sweepDeadEdges(); log(`sweepDeadEdges: removed ${s.removed}, kept ${s.kept}`); } catch (e) { log(`sweepDeadEdges err: ${String(e)}`); } }
        }
        catch (e) { log(`event err: ${String(e)}`); }
      }
    } catch { /* aborted (or subscribe failed) — shut down quietly */ }
  })();

  quota.refresh(); // initial
  return () => controller.abort();
}

/** Build a setup function with dependencies injected (tests). Without injection
 *  this returns v2Setup itself — exactly what V2Plugin and index.ts's dual
 *  default export use. */
export function buildV2Setup(injected?: { quota?: QuotaMachine }) {
  if (!injected) return v2Setup;
  return async (ctx: any) => v2Setup(ctx, injected);
}

// The canonical V2 plugin ({ id, setup } — Plugin.define returns it as-is).
// Shape-identical to index.ts's dual default export.
export const V2Plugin = Plugin.define({
  id: "opencode-usage-coach",
  setup: v2Setup,
});
