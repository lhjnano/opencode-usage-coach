// v1-session.ts — SessionOps over the OpenCode V1 plugin client.
// The V1 SDK client exposes session ops as `client.session.<method>({ path, body, query })`
// and wraps responses in `{ data: ... }`. This adapter normalizes those shapes so the
// plugin core (src/index.ts) only ever talks to the version-agnostic SessionOps
// facade from rt.ts — the V2 migration swaps this factory, not the call sites.
import type { SessionOps } from "./rt.js";

export function makeV1SessionOps(client: any): SessionOps {
  return {
    async create(directory: string, title: string): Promise<string> {
      const s: any = await client.session.create({ body: { title }, query: { directory } });
      const id = s?.data?.info?.id ?? s?.data?.id ?? s?.id;
      if (!id) throw new Error(`session.create returned no id (response: ${JSON.stringify(s?.data ?? s).slice(0, 200)})`);
      return id;
    },
    async prompt(id: string, providerID: string, modelID: string, text: string): Promise<any> {
      return client.session.prompt({
        path: { id },
        body: { model: { providerID, modelID }, parts: [{ type: "text", text }] },
      });
    },
    async messages(id: string): Promise<any[]> {
      const msgs: any = await client.session.messages?.({ path: { id } });
      return Array.isArray(msgs?.data) ? msgs.data : Array.isArray(msgs) ? msgs : [];
    },
    async abort(id: string): Promise<void> {
      try { await client.session.abort?.({ path: { id } }); } catch { /* */ }
    },
    async delete(id: string): Promise<void> {
      try { await client.session.delete?.({ path: { id } }); } catch { /* */ }
    },
    async get(id: string): Promise<any | null> {
      const s: any = await client.session.get({ path: { id } });
      return s?.data?.info ?? s?.data ?? s?.info ?? s ?? null;
    },
    async summarize(id: string): Promise<any> {
      return client.session.summarize?.({ path: { id } });
    },
  };
}
