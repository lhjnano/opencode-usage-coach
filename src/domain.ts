// domain.ts — declarative domain knowledge base (lightweight graph store).
// Storage: append-only NDJSON (nodes.ndjson + edges.ndjson) under STATE_DIR.
// Schema matches domain-db-design.md (node/edge), sans the ladybugDB dependency.
//   - read/add/query/traverse helpers; queryDomain + traverse compose the 1-hop lookups
//     the learning loop (investigate) and generate injections need.

import { mkdirSync, appendFileSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

let BASE_DIR = "";

export function initDomain(stateDir: string): void { BASE_DIR = stateDir; }

const nodesFile = (): string => join(BASE_DIR, "nodes.ndjson");
const edgesFile = (): string => join(BASE_DIR, "edges.ndjson");

function readNdjson<T>(path: string): T[] {
  try {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as T);
  } catch { return []; }
}

export function readNodes(): DomainNode[] { return readNdjson<DomainNode>(nodesFile()); }
export function readEdges(): DomainEdge[] { return readNdjson<DomainEdge>(edgesFile()); }

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function addDomainNode(node: Omit<DomainNode, "id" | "ts">): string {
  const full: DomainNode = { ...node, id: uid("node"), ts: new Date().toISOString() };
  try { mkdirSync(BASE_DIR, { recursive: true }); appendFileSync(nodesFile(), JSON.stringify(full) + "\n"); } catch { /* */ }
  return full.id;
}

export function addDomainEdge(edge: Omit<DomainEdge, "ts">): void {
  const full: DomainEdge = { ...edge, ts: new Date().toISOString() };
  try { mkdirSync(BASE_DIR, { recursive: true }); appendFileSync(edgesFile(), JSON.stringify(full) + "\n"); } catch { /* */ }
}

// Rewrite the whole nodes file (used by touch + eviction). Best-effort, never throws.
// Append-only is the happy path; these are the only places that rewrite, and they run rarely.
function writeNodes(nodes: DomainNode[]): void {
  try { mkdirSync(BASE_DIR, { recursive: true }); const lines = nodes.map((n) => JSON.stringify(n)); writeFileSync(nodesFile(), lines.length ? lines.join("\n") + "\n" : ""); } catch { /* */ }
}

// Keyword match against node name + props; include every edge touching a matched node.
export function queryDomain(keywords: string[]): { nodes: DomainNode[]; edges: DomainEdge[] } {
  const lc = keywords.map((k) => k.toLowerCase());
  const nodes = readNodes();
  const matched = nodes.filter((n) => {
    const hay = (n.name + " " + JSON.stringify(n.props)).toLowerCase();
    return lc.some((k) => k && hay.includes(k));
  });
  // Track access for the worm — lastAccessed/accessCount drive eviction.
  if (matched.length) touchNodes(new Set(matched.map((n) => n.id)));
  const ids = new Set(matched.map((n) => n.id));
  const edges = readEdges().filter((e) => ids.has(e.from) || ids.has(e.to));
  return { nodes: matched, edges };
}

// Worm — update lastAccessed + accessCount for the given node ids (rewrite). Low-frequency:
// only the matched subset changes, and only when something matched.
export function touchNodes(ids: Set<string>): void {
  if (ids.size === 0) return;
  try {
    const nodes = readNodes();
    let changed = false;
    const now = new Date().toISOString();
    for (const n of nodes) {
      if (ids.has(n.id)) {
        n.lastAccessed = now;
        n.accessCount = (n.accessCount ?? 0) + 1;
        changed = true;
      }
    }
    if (changed) writeNodes(nodes);
  } catch { /* */ }
}

// Worm (GC): drop nodes not accessed within maxAgeDays, then cap the count at maxNodes
// (keeping the most-recently-accessed). Nodes fall back to `ts` when never queried.
// Returns how many were removed. Safe to call frequently — no-op when nothing is stale.
export function evictStale(maxAgeDays = 30, maxNodes = 1000): { removed: number; kept: number } {
  try {
    const nodes = readNodes();
    if (nodes.length === 0) return { removed: 0, kept: 0 };
    const now = Date.now();
    const ageMs = maxAgeDays * 86_400_000;
    const lastTs = (n: DomainNode) => new Date(n.lastAccessed ?? n.ts).getTime();
    // time-based: drop anything older than maxAgeDays.
    let kept = nodes.filter((n) => now - lastTs(n) < ageMs);
    // size-based: keep the most-recently-accessed when over the cap.
    if (kept.length > maxNodes) {
      kept.sort((a, b) => lastTs(b) - lastTs(a));
      kept = kept.slice(0, maxNodes);
    }
    const removed = nodes.length - kept.length;
    if (removed > 0) writeNodes(kept);
    return { removed, kept: kept.length };
  } catch { return { removed: 0, kept: 0 }; }
}

// Follow edges originating at nodeId, optionally filtered by rel; returns target nodes.
export function traverse(nodeId: string, rel?: Relation): DomainNode[] {
  const byId = new Map(readNodes().map((n) => [n.id, n] as const));
  return readEdges()
    .filter((e) => e.from === nodeId && (!rel || e.rel === rel))
    .map((e) => byId.get(e.to))
    .filter((n): n is DomainNode => Boolean(n));
}

export function saveInvestigationResult(keywords: string[], result: string, source?: string): string {
  try {
    return addDomainNode({
      type: "fact",
      name: keywords.join(" "),
      props: { result },
      source: source || "investigation",
      confidence: 0.7,
    });
  } catch {
    return "";
  }
}
