// domain.ts — declarative domain knowledge base (lightweight graph store).
// Storage: append-only NDJSON (nodes.ndjson + edges.ndjson) under STATE_DIR.
// Schema matches domain-db-design.md (node/edge), sans the ladybugDB dependency.
//   - read/add/query/traverse helpers; queryDomain + traverse compose the 1-hop lookups
//     the learning loop (investigate) and generate injections need.

import { mkdirSync, appendFileSync, readFileSync, existsSync, writeFileSync, statSync } from "node:fs";
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
  // Otherwise (top-level cache dir, tests, custom UC_STATE_DIR), use stateDir/shared/.
  if (basename(dirname(stateDir)) === "projects") {
    SHARED_DIR = join(dirname(dirname(stateDir)), "shared");
  } else {
    SHARED_DIR = join(stateDir, "shared");
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

// ── Ranker: tokenizer + inverted-index cache (BM25 + priors) ───────────────
// v0.15.0 redesign (knowledge-retrieval-redesign Phase 1). Replaces substring
// `includes` matching with token-based BM25 ranking. INTENDED SEMANTIC CHANGE:
// ASCII partial-token hits ("test" ∈ "latest") are gone — no prefix matching
// either; Hangul recovers partial matching naturally via bigrams
// ("다크모드" → 다크/크모/모드). Legacy tests asserting substring semantics are
// updated in the follow-up commit — do NOT read those failures as regressions.

// Raw token stream (duplicates kept) — used for document tf counts.
// Shared by documents and queries: lowercase → split on [^a-z0-9가-힣] →
// ASCII words (len ≥ 2, kept whole) + Hangul runs → bigrams (len 1 → unigram).
function tokenizeAll(s: string): string[] {
  const lowered = (s ?? "").toLowerCase();
  const out: string[] = [];
  for (const part of lowered.split(/[^a-z0-9가-힣]+/)) {
    if (!part) continue;
    // A single part can mix ASCII and Hangul (e.g. "dark모드") — walk per-run.
    let i = 0;
    while (i < part.length) {
      if (part[i] && /[가-힣]/.test(part[i])) {
        let j = i;
        while (j < part.length && /[가-힣]/.test(part[j])) j++;
        const run = part.slice(i, j);
        if (run.length === 1) out.push(run);
        else for (let k = 0; k < run.length - 1; k++) out.push(run.slice(k, k + 2));
        i = j;
      } else {
        let j = i;
        while (j < part.length && !/[가-힣]/.test(part[j])) j++;
        const run = part.slice(i, j);
        if (run.length >= 2) out.push(run);
        i = j;
      }
    }
  }
  return out;
}

// Public document/query tokenizer (unique tokens, in order).
export function tokenize(s: string): string[] {
  return [...new Set(tokenizeAll(s))];
}

// Module-level inverted index over readNodes(). Rebuilt only when the stat
// fingerprint (mtime+size) of either nodes file changes — parsing ~2k NDJSON
// nodes per query would erase the latency win the index buys. The path is part
// of the fingerprint so switching state dirs (tests) never collides.
type RankIndex = {
  projFp: string;
  sharedFp: string;
  projCount: number;
  byToken: Map<string, number[]>; // token → node indices (postings)
  tf: Map<number, Map<string, number>>; // node index → token counts
  docLen: number[]; // total tokens per node
  nodes: DomainNode[]; // cached copies in index order
  idToIdx: Map<string, number>;
  N: number;
  avgdl: number;
};

let rankIndex: RankIndex | null = null;

function statFp(path: string): string {
  try {
    const st = statSync(path);
    return `${path}:${st.mtimeMs}:${st.size}`;
  } catch {
    return `${path}:missing:0`; // stable sentinel for a not-yet-created file
  }
}

// Cheap line count (no JSON.parse) — projCount only serves as a change
// detector in syncCacheAfterTouch; parsing the project file a second time
// would double the rebuild cost for no informational gain.
function countNdjsonLines(path: string): number {
  try {
    if (!existsSync(path)) return 0;
    return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
  } catch { return 0; }
}

function buildIndex(): RankIndex {
  // Capture stat fingerprints BEFORE parsing: if a writer appends while we
  // parse, the file is then newer than the fingerprint → the next query
  // detects the mismatch and rebuilds. (Fingerprint-after-parse would let
  // that append hide from the cache until the following change.)
  const projFp = statFp(nodesFile());
  const sharedFp = statFp(sharedNodesFile());
  const nodes = readNodes();
  const byToken = new Map<string, number[]>();
  const tf = new Map<number, Map<string, number>>();
  const docLen: number[] = [];
  const idToIdx = new Map<string, number>();
  let total = 0;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    idToIdx.set(n.id, i);
    const tokens = tokenizeAll(`${n.name} ${JSON.stringify(n.props)}`);
    const counts = new Map<string, number>();
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
    tf.set(i, counts);
    docLen.push(tokens.length);
    total += tokens.length;
    for (const t of counts.keys()) {
      const post = byToken.get(t);
      if (post) post.push(i);
      else byToken.set(t, [i]);
    }
  }
  return {
    projFp,
    sharedFp,
    projCount: countNdjsonLines(nodesFile()),
    byToken,
    tf,
    docLen,
    nodes,
    idToIdx,
    N: nodes.length,
    avgdl: nodes.length > 0 ? total / nodes.length : 0,
  };
}

function ensureIndex(): RankIndex | null {
  const projFp = statFp(nodesFile());
  const sharedFp = statFp(sharedNodesFile());
  // Fingerprint mismatch = new content (local add, external writer, eviction
  // rewrite) → rebuild from a fresh readNodes(). Touch-only rewrites are handled
  // separately in syncCacheAfterTouch so they don't trigger a rebuild.
  if (rankIndex && rankIndex.projFp === projFp && rankIndex.sharedFp === sharedFp) return rankIndex;
  rankIndex = buildIndex();
  return rankIndex;
}

// After touchNodes rewrites the project file, keep the cached index consistent
// WITHOUT a rebuild: sync accessCount/lastAccessed into cached copies (ids
// present in the cache only) and refresh the project fingerprint. If the node
// count changed since the index was built (external append/removal raced in),
// drop the cache so the next query rebuilds from disk. Never mutates shared-fp —
// external shared-layer writers are still detected on the next query.
function syncCacheAfterTouch(fresh: DomainNode[]): void {
  if (!rankIndex) return;
  if (fresh.length !== rankIndex.projCount) {
    rankIndex = null;
    return;
  }
  for (const n of fresh) {
    const idx = rankIndex.idToIdx.get(n.id);
    if (idx === undefined) continue;
    const cached = rankIndex.nodes[idx];
    if (cached) {
      cached.lastAccessed = n.lastAccessed;
      cached.accessCount = n.accessCount;
    }
  }
  rankIndex.projFp = statFp(nodesFile());
}

function envWeight(name: string, fallback: number): number {
  const v = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(v) ? v : fallback;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const safeTs = (s: string | undefined): number => {
  const t = s ? new Date(s).getTime() : NaN;
  return Number.isFinite(t) ? t : 0;
};

// Keyword search over the domain DB: query tokens → posting-list union →
// BM25 (k1=1.2, b=0.75, normalized by the best bm25 in the result set) plus
// priors: α·confidence + β·recency + γ·log-access. Ties broken by ts desc.
// opts.maxNodes caps the result (default 20 here; the injection call sites in
// index.ts apply their own, smaller cap) — without a cap a mature mesh DB dumps
// hundreds of nodes into every generate prompt, burying the actual task.
// Edge logic (all edges touching a kept node, internal-first, capped) unchanged.
export function queryDomain(
  keywords: string[],
  opts: { maxNodes?: number; maxEdges?: number } = {},
): { nodes: DomainNode[]; edges: DomainEdge[] } {
  const maxNodes = Math.max(1, Math.round(opts.maxNodes ?? 20) || 20);
  const maxEdges = Math.max(1, Math.round(opts.maxEdges ?? 60) || 60);
  const idx = ensureIndex();
  // Guard: empty DB or zero avgdl → no candidates, no NaN divisions.
  if (!idx || idx.N === 0 || !(idx.avgdl > 0)) return { nodes: [], edges: [] };
  const qTokens = [...new Set(keywords.flatMap((k) => tokenize(k)))];
  // Guard: query tokenized to nothing (empty/whitespace/punctuation input).
  if (qTokens.length === 0) return { nodes: [], edges: [] };

  const cand = new Set<number>();
  for (const t of qTokens) for (const i of idx.byToken.get(t) ?? []) cand.add(i);
  if (cand.size === 0) return { nodes: [], edges: [] };

  // 예시값, 튜닝 필요 — env overrides: UC_RANK_ALPHA / UC_RANK_BETA / UC_RANK_GAMMA.
  const alpha = envWeight("UC_RANK_ALPHA", 0.3);
  const beta = envWeight("UC_RANK_BETA", 0.2);
  const gamma = envWeight("UC_RANK_GAMMA", 0.1);
  const k1 = 1.2;
  const b = 0.75;
  const now = Date.now();
  const idfCache = new Map<string, number>();
  const raw: { i: number; bm25: number }[] = [];
  let maxBm25 = 0;
  for (const i of cand) {
    const dl = idx.docLen[i] ?? 0;
    const counts = idx.tf.get(i) ?? new Map<string, number>();
    let s = 0;
    for (const t of qTokens) {
      const f = counts.get(t);
      if (!f) continue;
      let idf = idfCache.get(t);
      if (idf === undefined) {
        const df = (idx.byToken.get(t) ?? []).length;
        idf = Math.log(1 + (idx.N - df + 0.5) / (df + 0.5));
        idfCache.set(t, idf);
      }
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * dl) / idx.avgdl)));
    }
    raw.push({ i, bm25: s });
    if (s > maxBm25) maxBm25 = s;
  }
  const scored = raw
    .map(({ i, bm25 }) => {
      const n = idx.nodes[i];
      if (!n) return null;
      // Guard: maxBm25 should be > 0 for any non-empty candidate set (idf > 0
      // always), but normalize defensively so NaN can never leak into sort.
      const norm = maxBm25 > 0 ? bm25 / maxBm25 : 0;
      const conf = clamp01(typeof n.confidence === "number" && Number.isFinite(n.confidence) ? n.confidence : 0);
      // ageDays from lastAccessed ?? ts (worm-fresh nodes rank higher).
      const ageDays = Math.max(0, (now - safeTs(n.lastAccessed ?? n.ts)) / 86_400_000);
      const recency = 1 / (1 + ageDays / 30);
      const ac = typeof n.accessCount === "number" && Number.isFinite(n.accessCount) && n.accessCount > 0 ? n.accessCount : 0;
      const access = Math.min(Math.log10(1 + ac), 1);
      return { n, score: norm + alpha * conf + beta * recency + gamma * access };
    })
    .filter((x): x is { n: DomainNode; score: number } => x !== null);
  scored.sort((a, b) => b.score - a.score || safeTs(b.n.ts) - safeTs(a.n.ts));
  // Shallow copies — the cached objects must never be handed out for callers to
  // mutate in place (the cache would silently diverge from disk).
  const kept = scored.slice(0, maxNodes).map(({ n }) => ({ ...n }));
  // Track access for the worm — lastAccessed/accessCount drive eviction.
  if (kept.length) touchNodes(new Set(kept.map((n) => n.id)));
  const ids = new Set(kept.map((n) => n.id));
  // Edges touching kept nodes; internal edges (both endpoints kept) ranked first,
  // capped at maxEdges so hub-heavy meshes don't flood the prompt. (Unchanged.)
  const edges = readEdges()
    .filter((e) => ids.has(e.from) || ids.has(e.to))
    .sort((a, b) =>
      Number(ids.has(b.from) && ids.has(b.to)) - Number(ids.has(a.from) && ids.has(a.to)))
    .slice(0, maxEdges);
  return { nodes: kept, edges };
}

// Injection provenance log — the seed of the reward-closed-loop work. Appends
// one record per queryDomain injection call, INCLUDING misses (nodeIds: []) so
// recall has a denominator. Best-effort: logging must never break a query.
export function logDomainInjection(keywords: string[], nodeIds: string[]): void {
  try {
    mkdirSync(SHARED_DIR, { recursive: true });
    appendFileSync(
      join(SHARED_DIR, "injections.ndjson"),
      JSON.stringify({ ts: new Date().toISOString(), keywords, nodeIds }) + "\n",
    );
  } catch { /* best-effort */ }
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
    if (changed) {
      writeNodes(nodes);
      // Keep the rank-index cache consistent without a rebuild — a touch-only
      // rewrite (accessCount/lastAccessed, ts/count unchanged) must not look
      // like new content on the next query.
      syncCacheAfterTouch(nodes);
    }
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
  opts: { maxNodes?: number; maxEdges?: number } = {},
): { nodes: DomainNode[]; edges: DomainEdge[] } {
  // queryDomain touches the seed nodes (worm GC) — kept for behavior parity.
  const seed = queryDomain(keywords, opts);
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
