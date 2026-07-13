// domain.ts — declarative domain knowledge base (lightweight graph store).
// Storage: append-only NDJSON (nodes.ndjson + edges.ndjson) under STATE_DIR.
// Schema matches domain-db-design.md (node/edge), sans the ladybugDB dependency.
//   - read/add/query/traverse helpers; queryDomain + traverse compose the 1-hop lookups
//     the learning loop (investigate) and generate injections need.

import { mkdirSync, appendFileSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";

export type Relation =
  | "returns" | "is-a" | "part-of" | "depends-on" | "contradicts"
  | "constraints" | "example-of" | "alias-of"
  // Graph-enhanced unknown detection (unknown-scan-design.md §13.5):
  | "related-to"   // loose association — traversed bidirectionally
  | "includes"     // inverse of part-of ("A includes B")
  | "references";  // citation/reference to a doc or external context
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
  // Hop distance from the nearest seed — only set on nodes returned by
  // traverseNeighborhood / queryDomainGraph. Never persisted (writers always
  // re-read fresh from file), so this is a transient view-layer annotation.
  distance?: number;
};

export type DomainEdge = {
  from: string;
  to: string;
  rel: Relation;
  note?: string;
  ts: string;
};

let BASE_DIR = "";
let SHARED_DIR = "";

export function initDomain(stateDir: string): void {
  BASE_DIR = stateDir;
  // SHARED_DIR: if stateDir is .../projects/<hash>/, use .../shared/ (cross-project layer).
  // Otherwise (tests, custom UC_STATE_DIR), fall back to stateDir/_shared/ for isolation.
  if (basename(dirname(stateDir)) === "projects") {
    SHARED_DIR = join(dirname(dirname(stateDir)), "shared");
  } else {
    SHARED_DIR = join(stateDir, "_shared");
  }
}

// Shared layer exports — for testing and cross-project queries.
export function getSharedDir(): string { return SHARED_DIR; }

const nodesFile = (): string => join(BASE_DIR, "nodes.ndjson");
const edgesFile = (): string => join(BASE_DIR, "edges.ndjson");
const sharedNodesFile = (): string => join(SHARED_DIR, "nodes.ndjson");
const sharedEdgesFile = (): string => join(SHARED_DIR, "edges.ndjson");

function readNdjson<T>(path: string): T[] {
  try {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as T);
  } catch { return []; }
}

// Read from BOTH layers: project-specific (BASE_DIR) + shared cross-project (SHARED_DIR).
export function readNodes(): DomainNode[] {
  return [...readNdjson<DomainNode>(nodesFile()), ...readNdjson<DomainNode>(sharedNodesFile())];
}
export function readEdges(): DomainEdge[] {
  return [...readNdjson<DomainEdge>(edgesFile()), ...readNdjson<DomainEdge>(sharedEdgesFile())];
}

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

// Batch append of edges — the multi-edge variant of addDomainEdge. Writes all
// edges in a single append (one syscall). ts is stamped if missing (callers may
// pass pre-stamped edges for replay/restore). Best-effort, never throws.
export function writeEdges(edges: DomainEdge[]): void {
  if (edges.length === 0) return;
  try {
    mkdirSync(BASE_DIR, { recursive: true });
    const now = new Date().toISOString();
    const lines = edges.map((e) => JSON.stringify({ ...e, ts: e.ts ?? now }));
    appendFileSync(edgesFile(), lines.join("\n") + "\n");
  } catch { /* */ }
}

// ── Layer-aware reads ──────────────────────────────────────────────────────
// "project" = BASE_DIR (this project only). "shared" = SHARED_DIR (cross-project).
// Public readNodes/readEdges return BOTH layers merged. Internal helpers operate
// on a single layer to avoid the duplication bug in touchNodes/evictStale (which
// read all + rewrite one layer — without layer-awareness they'd copy shared nodes
// into the project file).

function readProjectNodes(): DomainNode[] { return readNdjson<DomainNode>(nodesFile()); }
function readSharedNodes(): DomainNode[] { return readNdjson<DomainNode>(sharedNodesFile()); }

// Rewrite the whole nodes file (used by touch + eviction). Best-effort, never throws.
// Append-only is the happy path; these are the only places that rewrite, and they run rarely.
function writeNodes(nodes: DomainNode[]): void {
  try { mkdirSync(BASE_DIR, { recursive: true }); const lines = nodes.map((n) => JSON.stringify(n)); writeFileSync(nodesFile(), lines.length ? lines.join("\n") + "\n" : ""); } catch { /* */ }
}
function writeSharedNodes(nodes: DomainNode[]): void {
  try { mkdirSync(SHARED_DIR, { recursive: true }); const lines = nodes.map((n) => JSON.stringify(n)); writeFileSync(sharedNodesFile(), lines.length ? lines.join("\n") + "\n" : ""); } catch { /* */ }
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
// IMPORTANT: Only touches project-layer (BASE_DIR) nodes — shared-layer nodes are
// read-only (no access tracking) to avoid the cross-layer duplication bug.
export function touchNodes(ids: Set<string>): void {
  if (ids.size === 0) return;
  try {
    const nodes = readProjectNodes();
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
// IMPORTANT: Only evicts from the project layer (BASE_DIR). Shared-layer eviction is
// handled separately to avoid cross-layer contamination.
export function evictStale(maxAgeDays = 30, maxNodes = 1000): { removed: number; kept: number } {
  try {
    const nodes = readProjectNodes();
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

/** Evict stale nodes from the shared cross-project layer. Same algorithm as
 *  evictStale but operates on SHARED_DIR only. Call this periodically to prevent
 *  the shared layer from growing unbounded. */
export function evictSharedStale(maxAgeDays = 60, maxNodes = 2000): { removed: number; kept: number } {
  try {
    const nodes = readSharedNodes();
    if (nodes.length === 0) return { removed: 0, kept: 0 };
    const now = Date.now();
    const ageMs = maxAgeDays * 86_400_000;
    const lastTs = (n: DomainNode) => new Date(n.lastAccessed ?? n.ts).getTime();
    let kept = nodes.filter((n) => now - lastTs(n) < ageMs);
    if (kept.length > maxNodes) {
      kept.sort((a, b) => lastTs(b) - lastTs(a));
      kept = kept.slice(0, maxNodes);
    }
    const removed = nodes.length - kept.length;
    if (removed > 0) writeSharedNodes(kept);
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

// Multi-hop BFS neighborhood expansion (unknown-scan-design.md §13.3).
// Starts from seedNodeIds and walks edges BIDIRECTIONALLY (both from→to and
// to→from, regardless of rel) up to maxDepth hops. Pure read — no side effects,
// does not touch the worm GC. Each returned node carries `distance` (hops from
// the nearest seed; 0 = seed itself).
//
// Guards against graph explosion: (1) maxDepth caps depth, (2) a visited Set
// breaks cycles, (3) maxNodes (default 60) caps total nodes returned.
export function traverseNeighborhood(
  seedNodeIds: string[],
  maxDepth = 2,
  opts: { maxNodes?: number } = {},
): { nodes: DomainNode[]; edges: DomainEdge[] } {
  const maxNodes = opts.maxNodes ?? 60;
  const allNodes = readNodes();
  const allEdges = readEdges();
  const byId = new Map(allNodes.map((n) => [n.id, n] as const));

  // Seeds that actually exist in the DB (ignore unknown ids defensively).
  const seeds = seedNodeIds.filter((id) => byId.has(id));
  if (seeds.length === 0) return { nodes: [], edges: [] };

  // Bidirectional adjacency: every edge links both endpoints to each other.
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    const s = adj.get(a) ?? new Set<string>();
    s.add(b);
    adj.set(a, s);
  };
  for (const e of allEdges) {
    link(e.from, e.to);
    link(e.to, e.from);
  }

  // BFS — distance from the nearest seed.
  const distance = new Map<string, number>();
  const visited = new Set<string>();
  const frontier: string[] = [];
  for (const s of seeds) {
    if (visited.has(s)) continue;
    visited.add(s);
    distance.set(s, 0);
    frontier.push(s);
    if (visited.size >= maxNodes) break;
  }
  while (frontier.length > 0) {
    if (visited.size >= maxNodes) break;
    const cur = frontier.shift() as string;
    const d = distance.get(cur) ?? 0;
    if (d >= maxDepth) continue; // don't expand past maxDepth
    for (const nxt of adj.get(cur) ?? []) {
      if (visited.has(nxt)) continue;
      visited.add(nxt);
      distance.set(nxt, d + 1);
      frontier.push(nxt);
      if (visited.size >= maxNodes) break;
    }
  }

  // Collect visited nodes (copies stamped with distance) + edges between them.
  const nodes: DomainNode[] = [];
  for (const id of visited) {
    const n = byId.get(id);
    if (n) nodes.push({ ...n, distance: distance.get(id) ?? 0 });
  }
  const edges = allEdges.filter((e) => visited.has(e.from) && visited.has(e.to));
  return { nodes, edges };
}

// Keyword-match seeds via the existing queryDomain, then BFS-expand to neighbors.
// Drop-in superset of queryDomain: maxDepth=0 (or no seed hits) returns exactly
// what queryDomain would (compatibility). maxDepth≥1 adds edge-traversed nodes.
export function queryDomainGraph(
  keywords: string[],
  maxDepth = 2,
  opts: { maxNodes?: number } = {},
): { nodes: DomainNode[]; edges: DomainEdge[] } {
  // queryDomain touches the seed nodes (worm GC) — kept for behavior parity.
  const seed = queryDomain(keywords);
  const seedIds = seed.nodes.map((n) => n.id);
  if (maxDepth <= 0 || seedIds.length === 0) {
    return { nodes: seed.nodes, edges: seed.edges };
  }
  const graph = traverseNeighborhood(seedIds, maxDepth, opts);
  // Record access for the recovered neighborhood beyond the seeds, so eviction
  // keeps recently-useful associated knowledge. (queryDomain already touched seeds.)
  const seedSet = new Set(seedIds);
  const neighborIds = graph.nodes.filter((n) => !seedSet.has(n.id)).map((n) => n.id);
  if (neighborIds.length > 0) touchNodes(new Set(neighborIds));
  return { nodes: graph.nodes, edges: graph.edges };
}

export function saveInvestigationResult(keywords: string[], result: string, source?: string, confidence = 0.7): string {
  try {
    // Write to SHARED layer — investigation findings are cross-project knowledge.
    const nodeId = uid("node");
    const full: DomainNode = {
      id: nodeId,
      type: "fact",
      name: keywords.join(" "),
      props: { result, keywords: [...new Set(keywords)] },
      source: source || "investigation",
      confidence,
      ts: new Date().toISOString(),
    };
    try { mkdirSync(SHARED_DIR, { recursive: true }); appendFileSync(sharedNodesFile(), JSON.stringify(full) + "\n"); } catch { /* */ }

    // Auto-link: find existing nodes (both layers) with overlapping keywords.
    // Creates related-to edges that form the knowledge mesh automatically.
    autoLinkKeywords(nodeId, keywords);

    return nodeId;
  } catch {
    return "";
  }
}

/** Auto-form mesh edges: find nodes whose keywords overlap with ours by >= minOverlap,
 *  and create related-to edges. Caps at maxLinks to avoid hub explosion. */
function autoLinkKeywords(nodeId: string, keywords: string[], minOverlap = 2, maxLinks = 8): void {
  if (keywords.length < minOverlap) return;
  try {
    const candidates = queryDomain(keywords);
    let linked = 0;
    for (const node of candidates.nodes) {
      if (node.id === nodeId) continue;
      // Extract this node's keywords from props or name.
      const nodeKw: string[] = Array.isArray((node.props as any)?.keywords)
        ? (node.props as any).keywords
        : (node.name || "").toLowerCase().split(/[^a-z0-9_-]+/).filter((w: string) => w.length >= 3);
      // Count exact keyword matches.
      const overlap = keywords.filter((k) => nodeKw.includes(k));
      if (overlap.length >= minOverlap) {
        const edge: DomainEdge = {
          from: nodeId, to: node.id, rel: "related-to",
          note: `auto: ${overlap.length} shared (${overlap.slice(0, 5).join(",")})`,
          ts: new Date().toISOString(),
        };
        try { mkdirSync(SHARED_DIR, { recursive: true }); appendFileSync(sharedEdgesFile(), JSON.stringify(edge) + "\n"); } catch { /* */ }
        linked++;
        if (linked >= maxLinks) break;
      }
    }
  } catch { /* */ }
}
