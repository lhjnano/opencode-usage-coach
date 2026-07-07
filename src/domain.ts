// domain.ts — declarative domain knowledge base (lightweight graph store).
// Storage: append-only NDJSON (nodes.ndjson + edges.ndjson) under STATE_DIR.
// Schema matches domain-db-design.md (node/edge), sans the ladybugDB dependency.
//   - read/add/query/traverse helpers; queryDomain + traverse compose the 1-hop lookups
//     the learning loop (investigate) and generate injections need.

import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
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

// Keyword match against node name + props; include every edge touching a matched node.
export function queryDomain(keywords: string[]): { nodes: DomainNode[]; edges: DomainEdge[] } {
  const lc = keywords.map((k) => k.toLowerCase());
  const nodes = readNodes();
  const matched = nodes.filter((n) => {
    const hay = (n.name + " " + JSON.stringify(n.props)).toLowerCase();
    return lc.some((k) => k && hay.includes(k));
  });
  const ids = new Set(matched.map((n) => n.id));
  const edges = readEdges().filter((e) => ids.has(e.from) || ids.has(e.to));
  return { nodes: matched, edges };
}

// Follow edges originating at nodeId, optionally filtered by rel; returns target nodes.
export function traverse(nodeId: string, rel?: Relation): DomainNode[] {
  const byId = new Map(readNodes().map((n) => [n.id, n] as const));
  return readEdges()
    .filter((e) => e.from === nodeId && (!rel || e.rel === rel))
    .map((e) => byId.get(e.to))
    .filter((n): n is DomainNode => Boolean(n));
}
