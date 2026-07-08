// domain.ts — declarative domain knowledge base (ladybugDB graph backend).
// Storage: embedded property-graph DB (@ladybugdb/core, formerly Kuzu) under STATE_DIR.
// Schema matches domain-db-design.md (node/edge). Graph queries (Cypher) replace the old
// NDJSON full-scan: keyword match + 1-hop traversal run as indexed MATCH queries, so the DB
// stays fast as it grows (native full-text/vector available for later).
//
// All helpers are async (Cypher queries return Promises) AND timeout-guarded: every public
// op is wrapped so a slow/hung query can never block the plugin — it resolves to a safe
// fallback after UC_DOMAIN_TIMEOUT_MS (default 5s). Callers (index.ts) await them.

import { Database, Connection } from "@ladybugdb/core";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export type Relation = "returns" | "is-a" | "part-of" | "depends-on" | "contradicts" | "constraints" | "example-of" | "alias-of";
export type NodeType = "api-method" | "concept" | "limit" | "pattern" | "fact";

export type DomainNode = {
  id: string;
  type: NodeType;
  name: string;
  props: Record<string, unknown>;
  source: string;
  confidence: number;
  ts: string;
  // Worm (GC) tracking — updated on query/traverse, used by evictStale.
  lastAccessed?: string;
  accessCount?: number;
};

export type DomainEdge = {
  from: string;
  to: string;
  rel: Relation;
  note?: string;
  ts: string;
};

// Per-op timeout. A slow/hung ladybugDB query must never block the plugin — resolve to the
// op's fallback instead. Native cancellation isn't exposed, so the in-flight query keeps
// running in the background; we just stop waiting for it.
const QUERY_TIMEOUT_MS = (() => { try { const v = Number(process.env.UC_DOMAIN_TIMEOUT_MS); return Number.isFinite(v) && v > 0 ? v : 5000; } catch { return 5000; } })();

let BASE_DIR = "";
let DB_PATH = "";
// ladybugDB's shipped typings are incomplete (query() returns a union without getAll), so
// we hold the connection as `any` and rely on runtime behavior verified by tests.
let db: any = null;
let conn: any = null;
let schemaReady = false;
let migrated = false;

export function initDomain(stateDir: string): void {
  BASE_DIR = stateDir;
  DB_PATH = join(BASE_DIR, "domain.ladybug");
  // Connection is created lazily on first query (ready()). Re-init resets state.
  db = null;
  conn = null;
  schemaReady = false;
  migrated = false;
}

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Escape a value for safe embedding inside a Cypher single-quoted string literal.
function esc(s: unknown): string {
  return String(s ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// Race an op against a timeout; on timeout resolve to `fallback` (never reject). The op
// keeps running in the background — we just stop blocking the caller on it.
function timed<T>(op: () => Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), QUERY_TIMEOUT_MS); });
  return Promise.race([op().catch(() => fallback), timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

// Decode a Cypher result row into a DomainNode (props is stored as a JSON string).
function parseNode(r: any): DomainNode {
  let props: Record<string, unknown> = {};
  try { if (r.props) props = JSON.parse(r.props); } catch { /* malformed — leave empty */ }
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    props,
    source: r.source ?? "",
    confidence: r.confidence ?? 0,
    ts: r.ts,
    lastAccessed: r.lastAccessed || undefined,
    accessCount: r.accessCount ?? undefined,
  };
}

const NODE_COLS = "n.id AS id, n.type AS type, n.name AS name, n.props AS props, n.source AS source, n.confidence AS confidence, n.ts AS ts, n.lastAccessed AS lastAccessed, n.accessCount AS accessCount";

// Lazy init: open the DB (creates the file on first write) and ensure the schema exists.
async function ready(): Promise<any> {
  if (!conn) {
    db = new Database(DB_PATH);
    conn = new Connection(db);
  }
  if (!schemaReady) {
    // CREATE TABLE errors when the table already exists (reopening an existing DB) — ignore.
    try { await conn.query("CREATE NODE TABLE DomainNode(id STRING, type STRING, name STRING, props STRING, source STRING, confidence DOUBLE, lastAccessed STRING, accessCount INT64 DEFAULT 0, ts STRING, PRIMARY KEY(id))"); } catch { /* exists */ }
    try { await conn.query("CREATE REL TABLE Related(FROM DomainNode TO DomainNode, rel STRING, note STRING, ts STRING)"); } catch { /* exists */ }
    schemaReady = true;
  }
  // One-time import of legacy NDJSON data if a previous version left nodes/edges files.
  if (!migrated) { migrated = true; await migrateFromNdjson(); }
  return conn;
}

// Best-effort: if nodes.ndjson/edges.ndjson exist (pre-ladybugDB versions), import them once.
async function migrateFromNdjson(): Promise<void> {
  if (!conn) return;
  const nf = join(BASE_DIR, "nodes.ndjson");
  const ef = join(BASE_DIR, "edges.ndjson");
  if (!existsSync(nf)) return;
  try {
    const existing = await conn.query("MATCH (n:DomainNode) RETURN count(n) AS c");
    const cnt = (await existing.getAll())[0]?.c ?? 0;
    if (cnt > 0) return; // already has data — don't double-import
    const readNdjson = (p: string): any[] => { try { return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
    for (const n of readNdjson(nf)) {
      await conn.query(`CREATE (n:DomainNode {id:'${esc(n.id)}',type:'${esc(n.type)}',name:'${esc(n.name)}',props:'${esc(JSON.stringify(n.props ?? {}))}',source:'${esc(n.source ?? "")}',confidence:${Number(n.confidence ?? 0)},ts:'${esc(n.ts ?? "")}',lastAccessed:'${esc(n.lastAccessed ?? "")}',accessCount:${Number(n.accessCount ?? 0)}})`);
    }
    if (existsSync(ef)) {
      for (const e of readNdjson(ef)) {
        await conn.query(`MATCH (a:DomainNode {id:'${esc(e.from)}'}), (b:DomainNode {id:'${esc(e.to)}'}) CREATE (a)-[:Related {rel:'${esc(e.rel)}',note:'${esc(e.note ?? "")}',ts:'${esc(e.ts ?? "")}'}]->(b)`);
      }
    }
  } catch { /* migration is best-effort */ }
}

export function readNodes(): Promise<DomainNode[]> { return timed(_readNodes, []); }
async function _readNodes(): Promise<DomainNode[]> {
  const c = await ready();
  const r = await c.query(`MATCH (n:DomainNode) RETURN ${NODE_COLS}`);
  return (await r.getAll()).map(parseNode);
}

export function readEdges(): Promise<DomainEdge[]> { return timed(_readEdges, []); }
async function _readEdges(): Promise<DomainEdge[]> {
  const c = await ready();
  const r = await c.query("MATCH (a:DomainNode)-[r:Related]->(b:DomainNode) RETURN a.id AS from, b.id AS to, r.rel AS rel, r.note AS note, r.ts AS ts");
  return (await r.getAll()) as DomainEdge[];
}

export function addDomainNode(node: Omit<DomainNode, "id" | "ts">): Promise<string> { return timed(() => _addDomainNode(node), ""); }
async function _addDomainNode(node: Omit<DomainNode, "id" | "ts">): Promise<string> {
  const c = await ready();
  const id = uid("node");
  const now = new Date().toISOString();
  await c.query(`CREATE (n:DomainNode {id:'${esc(id)}',type:'${esc(node.type)}',name:'${esc(node.name)}',props:'${esc(JSON.stringify(node.props ?? {}))}',source:'${esc(node.source ?? "")}',confidence:${Number(node.confidence ?? 0)},ts:'${esc(now)}',lastAccessed:'',accessCount:0})`);
  return id;
}

export function addDomainEdge(edge: Omit<DomainEdge, "ts">): Promise<void> { return timed(() => _addDomainEdge(edge), undefined); }
async function _addDomainEdge(edge: Omit<DomainEdge, "ts">): Promise<void> {
  const c = await ready();
  const now = new Date().toISOString();
  await c.query(`MATCH (a:DomainNode {id:'${esc(edge.from)}'}), (b:DomainNode {id:'${esc(edge.to)}'}) CREATE (a)-[:Related {rel:'${esc(edge.rel)}',note:'${esc(edge.note ?? "")}',ts:'${esc(now)}'}]->(b)`);
}

// Keyword match against node name + props (case-insensitive); include every edge touching a
// matched node. Uses indexed MATCH (no full-scan) and touches matched nodes for the worm.
export function queryDomain(keywords: string[]): Promise<{ nodes: DomainNode[]; edges: DomainEdge[] }> {
  return timed(() => _queryDomain(keywords), { nodes: [], edges: [] });
}
async function _queryDomain(keywords: string[]): Promise<{ nodes: DomainNode[]; edges: DomainEdge[] }> {
  const lc = keywords.map((k) => k.toLowerCase()).filter(Boolean);
  if (lc.length === 0) return { nodes: [], edges: [] };
  const c = await ready();
  const conds = lc.map((kw) => `(lower(n.name) CONTAINS '${esc(kw)}' OR lower(n.props) CONTAINS '${esc(kw)}')`).join(" OR ");
  const r = await c.query(`MATCH (n:DomainNode) WHERE ${conds} RETURN ${NODE_COLS}`);
  const matched: DomainNode[] = (await r.getAll()).map(parseNode);
  if (matched.length) await _touchNodes(new Set(matched.map((n) => n.id)));
  let edges: DomainEdge[] = [];
  if (matched.length) {
    const ids = matched.map((n) => `'${esc(n.id)}'`).join(",");
    const er = await c.query(`MATCH (a:DomainNode)-[r:Related]->(b:DomainNode) WHERE a.id IN [${ids}] OR b.id IN [${ids}] RETURN a.id AS from, b.id AS to, r.rel AS rel, r.note AS note, r.ts AS ts`);
    edges = (await er.getAll()) as DomainEdge[];
  }
  return { nodes: matched, edges };
}

// Follow edges originating at nodeId, optionally filtered by rel; returns target nodes.
export function traverse(nodeId: string, rel?: Relation): Promise<DomainNode[]> { return timed(() => _traverse(nodeId, rel), []); }
async function _traverse(nodeId: string, rel?: Relation): Promise<DomainNode[]> {
  const c = await ready();
  const cond = rel ? ` AND r.rel = '${esc(rel)}'` : "";
  const r = await c.query(`MATCH (a:DomainNode {id:'${esc(nodeId)}'})-[r:Related]->(b:DomainNode) WHERE true${cond} RETURN b.id AS id, b.type AS type, b.name AS name, b.props AS props, b.source AS source, b.confidence AS confidence, b.ts AS ts, b.lastAccessed AS lastAccessed, b.accessCount AS accessCount`);
  return (await r.getAll()).map(parseNode);
}

// Worm — update lastAccessed + accessCount for the given node ids (single SET query).
export function touchNodes(ids: Set<string>): Promise<void> { return timed(() => _touchNodes(ids), undefined); }
async function _touchNodes(ids: Set<string>): Promise<void> {
  if (ids.size === 0) return;
  const c = await ready();
  const now = new Date().toISOString();
  const idList = [...ids].map((id) => `'${esc(id)}'`).join(",");
  await c.query(`MATCH (n:DomainNode) WHERE n.id IN [${idList}] SET n.lastAccessed = '${esc(now)}', n.accessCount = COALESCE(n.accessCount, 0) + 1`);
}

// Worm (GC): drop nodes not accessed within maxAgeDays, then cap the count at maxNodes
// (keeping the most-recently-accessed). Decision in JS (date compare), delete via DETACH DELETE
// (also removes orphaned edges). Safe to call frequently — no-op when nothing is stale.
export function evictStale(maxAgeDays = 30, maxNodes = 100000): Promise<{ removed: number; kept: number }> {
  return timed(() => _evictStale(maxAgeDays, maxNodes), { removed: 0, kept: 0 });
}
async function _evictStale(maxAgeDays: number, maxNodes: number): Promise<{ removed: number; kept: number }> {
  const c = await ready();
  const all = await _readNodes();
  if (all.length === 0) return { removed: 0, kept: 0 };
  const now = Date.now();
  const ageMs = maxAgeDays * 86_400_000;
  const lastTs = (n: DomainNode) => {
    const la = n.lastAccessed ? new Date(n.lastAccessed).getTime() : 0;
    return la || new Date(n.ts).getTime();
  };
  let kept = all.filter((n) => now - lastTs(n) < ageMs);
  if (kept.length > maxNodes) {
    kept.sort((a, b) => lastTs(b) - lastTs(a));
    kept = kept.slice(0, maxNodes);
  }
  const keepIds = new Set(kept.map((n) => n.id));
  const toRemove = all.filter((n) => !keepIds.has(n.id));
  for (const n of toRemove) {
    await c.query(`MATCH (n:DomainNode {id:'${esc(n.id)}'}) DETACH DELETE n`);
  }
  return { removed: toRemove.length, kept: kept.length };
}

export function saveInvestigationResult(keywords: string[], result: string, source?: string): Promise<string> {
  return timed(() => _saveInvestigationResult(keywords, result, source), "");
}
async function _saveInvestigationResult(keywords: string[], result: string, source?: string): Promise<string> {
  return _addDomainNode({
    type: "fact",
    name: keywords.join(" "),
    props: { result },
    source: source || "investigation",
    confidence: 0.7,
  });
}
