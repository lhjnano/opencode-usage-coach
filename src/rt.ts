// rt.ts — version-agnostic runtime facade.
// V1 adapter implements SessionOps over the V1 client (`input.client.session.*`).
// V2 adapter implements it over the plugin context (`ctx.session.*`).

export type SubSessionHandle = { id: string };

export interface SessionOps {
  /** Create a sub-session. Returns its id. */
  create(directory: string, title: string): Promise<string>;
  /** Send the prompt text with an explicit model. Resolves with the FULL response object
   *  (V1: the prompt() response; V2: resolved completion — adapter decides mechanics). */
  prompt(id: string, providerID: string, modelID: string, text: string): Promise<any>;
  /** Fetch messages for step counting. Returns array of message objects (role/ts fields
   *  probed defensively by callers). */
  messages(id: string): Promise<any[]>;
  /** Abort/interrupt a session. */
  abort(id: string): Promise<void>;
  /** Delete/remove a session (best-effort). */
  delete(id: string): Promise<void>;
  /** Read session info (agent/model detection). Returns info object or null. */
  get(id: string): Promise<any | null>;
  /** Optional: summarize a session (V1 only; V2 adapter may omit). */
  summarize?(id: string): Promise<any>;
  /** Optional: one-shot text generation without a session (V2 ctx.generate.text; V1 may omit). */
  generateText?(model: string, prompt: string): Promise<string>;
}

export type Runtime = {
  directory: string;
  session: SessionOps;
};

export type CallCtx = { sessionID?: string; directory?: string; signal?: AbortSignal };
