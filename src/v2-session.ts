// v2-session.ts — SessionOps over the OpenCode V2 plugin context (`ctx`).
// The V2 SDK exposes session ops directly on the plugin context as
// `ctx.session.<method>({ sessionID, ... })` — flat args, no V1-style
// path/body/query wrapping and no `{ data }` envelope. The big semantic
// difference: `ctx.session.prompt()` only ADMITS the message into the session
// inbox; completion is observed via `ctx.session.wait()` resolving once the
// session goes idle. This adapter restores the V1 facade contract (prompt
// resolves with the FULL completion response) by sequencing
// switchModel → prompt → wait → context and reshaping the LAST assistant
// message into `{ data: { parts } }` so runModel's extractor
// (`resp?.data?.parts ?? resp?.parts`) keeps working unchanged.
// All response fields are probed defensively (`?.` / `??`) — see V2Ctx below.
import type { SessionOps } from "./rt.js";

/** The V2 plugin context. Kept as `any` on purpose: this adapter is written
 *  defensively against the documented V2 wire shapes instead of being pinned
 *  to a possibly-stale SDK type. Tighten when @opencode/plugin types are
 *  installed. */
export type V2Ctx = any;

/** Extract display text from a message that carries no `parts` array:
 *  probe the common text fields V2 hosts are known to populate. */
function extractText(m: any): string {
  return String(m?.text ?? m?.info?.text ?? m?.content ?? m?.info?.content ?? m?.data?.text ?? "");
}

export function makeV2SessionOps(ctx: V2Ctx): SessionOps {
  return {
    async create(directory: string, title: string): Promise<string> {
      // `directory` is intentionally unused: V2 create has no directory query —
      // V2 sessions bind to the plugin/server location. The parameter stays in
      // the signature to honor the SessionOps contract shared with V1.
      const s: any = await ctx.session.create({ title });
      const id = s?.id ?? s?.data?.id;
      if (!id) throw new Error(`session.create returned no id (response: ${JSON.stringify(s?.data ?? s).slice(0, 200)})`);
      return id;
    },
    async prompt(id: string, providerID: string, modelID: string, text: string): Promise<any> {
      // V1 contract: resolve with the FULL completion response. V2's prompt()
      // is admission-only, so: select the model, admit the message, wait for
      // the session to go idle (= completion), then read the transcript and
      // reshape the LAST assistant message into the V1 response shape.
      // Any rejection here propagates to the caller (runModel handles it).
      await ctx.session.switchModel({ sessionID: id, model: { providerID, id: modelID } });
      await ctx.session.prompt({ sessionID: id, text });
      await ctx.session.wait({ sessionID: id });
      const msgs: any = await ctx.session.context({ sessionID: id });
      const list: any[] = Array.isArray(msgs) ? msgs.slice()
        : Array.isArray(msgs?.data) ? msgs.data.slice()
        : [];
      // Find the LAST assistant message — iterate from the end.
      for (let i = list.length - 1; i >= 0; i--) {
        const m: any = list[i];
        const role = m?.role ?? m?.info?.role;
        if (role !== "assistant") continue;
        const parts = m?.parts ?? m?.info?.parts;
        if (Array.isArray(parts)) return { data: { parts } };
        // No parts array — synthesize a single text part from common fields.
        return { data: { parts: [{ type: "text", text: extractText(m) }] } };
      }
      // No assistant message observed — empty completion, V1-shaped.
      return { data: { parts: [] } };
    },
    async messages(id: string): Promise<any[]> {
      const msgs: any = await ctx.session.context({ sessionID: id });
      if (Array.isArray(msgs)) return msgs.slice(); // readonly → mutable copy
      if (Array.isArray(msgs?.data)) return msgs.data.slice();
      return [];
    },
    async abort(id: string): Promise<void> {
      try { await ctx.session.interrupt({ sessionID: id, continue: false }); } catch { /* */ }
    },
    async delete(id: string): Promise<void> {
      try { await ctx.session.remove({ sessionID: id }); } catch { /* */ }
    },
    async get(id: string): Promise<any | null> {
      const s: any = await ctx.session.get({ sessionID: id });
      return s?.data ?? s ?? null;
    },
    // `summarize` is intentionally omitted — not in the V2 session domain.
    async generateText(model: string, prompt: string): Promise<string> {
      const slash = model.indexOf("/");
      const providerID = slash >= 0 ? model.slice(0, slash) : model;
      const id = slash >= 0 ? model.slice(slash + 1) : "";
      const r: any = await ctx.generate.text({ model: { providerID, id }, prompt });
      return r?.text ?? r?.data?.text ?? "";
    },
  };
}
