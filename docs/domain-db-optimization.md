# Domain Knowledge Base — ladybugDB Optimization

> Companion to `domain-db-design.md`. Documents the migration from NDJSON full-scan
> storage to an embedded property-graph DB (@ladybugdb/core), the performance rationale,
> and remaining optimization headroom.
>
> Status: shipped in v0.6.0. Last updated: 2026-07-08.

---

## 1. Why migrate off NDJSON

The original implementation (`sans the ladybugDB dependency`) stored nodes/edges as
append-only `nodes.ndjson` + `edges.ndjson`. Every `queryDomain` call:

1. `readFileSync` of the **entire** nodes file, then
2. a per-node string `.includes()` check (keyword match).

That is **O(n) file I/O + O(n) string matching per query**. The worm GC cap
(`UC_WORM_MAX_NODES`, default 100000) means the DB can grow to 100k nodes — at which
point each `generate`/`investigate` lookup re-reads 100k lines on the hot path.

Domain knowledge is inherently **connected** ("A returns B", "C contradicts D"). A flat
NDJSON list cannot express or traverse those relationships efficiently; it can only
filter. This is exactly the workload a graph database is built for.

## 2. Why @ladybugdb/core

`@ladybugdb/core` (Node.js bindings) is the **KuzuDB successor** — Kuzu was archived after
Apple acquired its core team. LadybugDB carries the project forward with active development.

| Property | Why it fits this plugin |
|---|---|
| Embedded / in-process | No server, no network hop — runs inside the opencode plugin process. Zero added latency for an LLM tool call. |
| Property graph + Cypher | Relationships are first-class. `MATCH (a)-[r]->(b)` replaces hand-rolled edge filtering. |
| Columnar storage | Compresses well, scans fast for analytics on connected data. |
| Native full-text + vector | Built-in extensions for keyword/semantic search (headroom for later). |
| MIT, embedded, serverless | Matches the plugin's "never break opencode, no external deps" philosophy. |

Two VLDB papers (Kuzu) back the design: factorized joins, the Accumulate-Semijoin-Probe
join, and a strongly-typed Cypher.

## 3. Schema

```cypher
CREATE NODE TABLE DomainNode(
  id STRING,
  type STRING,            -- api-method | concept | limit | pattern | fact
  name STRING,
  props STRING,           -- JSON-encoded (flexible properties)
  source STRING,
  confidence DOUBLE,
  lastAccessed STRING,    -- worm (GC) tracking
  accessCount INT64 DEFAULT 0,
  ts STRING,
  PRIMARY KEY (id)
);

CREATE REL TABLE Related(
  FROM DomainNode TO DomainNode,
  rel STRING,             -- returns | is-a | part-of | depends-on | contradicts | constraints | example-of | alias-of
  note STRING,
  ts STRING
);
```

The single `Related` REL table permits **any node to connect to any node** with any
relationship type — a full mesh (see §6).

## 4. Performance rationale (from public benchmarks)

Source: LadybugDB blog — ["Ladybug Flying Solo"](https://blog.ladybugdb.com/post/ladybug-flying-solo/)
(2026-07-01, benchmarks category). Raw data:
[gist](https://gist.github.com/adsharma/b1815293b194533525c53d1dd93413c6).

| Workload | Result | Relevance to us |
|---|---|---|
| `MATCH ()-[r:Owns]->() RETURN COUNT(*)` | **13× faster** than Kuzu | Relationship counting — our `traverse`/edge queries |
| `MATCH (a)-[r]->(b) RETURN a, b` (zero-copy Arrow) | **50–60× faster** | Multi-hop relationship scans |
| Write throughput (group commit) | **6,000 tx/sec** (vs Kuzu 125) | `investigate`/`generate` storing new facts |
| Scale | 10 GB compressed DB queryable in 8 GB RAM | Far beyond anything this plugin will reach |

**The key fit:** this plugin's domain DB is **relationship-centric** — the value is the
graph of `returns`/`depends-on`/`contradicts` edges, not the node list. That is precisely
the workload LadybugDB optimized hardest (13–60× on REL tables).

## 5. Honest limitations

1. **Some queries are still faster on archived Kuzu** (build-environment differences; PGO
   recoverable but not shipped). Not relevant at our scale.
2. **`CONTAINS` keyword matching does not use an index** by default — `queryDomain`'s
   `WHERE lower(n.name) CONTAINS 'kw'` is a scan. Real index acceleration requires the
   [full-text search extension](https://docs.ladybugdb.com/extensions/full-text-search)
   (headroom, §8). At our current scale (hundreds–thousands of nodes) the scan is still
   sub-millisecond and bounded by the timeout guard.
3. **For very small DBs** (tens of nodes) native call overhead can exceed NDJSON direct
   read. The crossover point was not measured; the worm GC and the timeout guard make this
   a non-issue in practice.

## 6. Mesh support

The schema allows a complete mesh:
- any node → any node (multi-outgoing / multi-incoming)
- multiple relationships between the same pair (different `rel`)
- cycles (`A→B→C→A`) and self-reference (`A→A`)
- bidirectional via two directed edges

`traverse(nodeId, rel?)` follows 1-hop today. Deeper mesh analysis is available through
LadybugDB's built-in graph-algorithm extensions (WCC/SCC for clustering, PageRank for
centrality, shortest-path) — see §8.

## 7. Safety: every op is timeout-guarded

A slow or hung native query must never block the plugin. All public helpers
(`readNodes`, `queryDomain`, `traverse`, `addDomainNode`, `evictStale`, …) are wrapped in a
`timed()` racer that resolves to a **safe fallback** after `UC_DOMAIN_TIMEOUT_MS`
(default 5000 ms). The in-flight query keeps running in the background; we just stop
blocking the caller. Errors also resolve to the fallback — the domain DB can never throw
into the plugin.

## 8. Migration & headroom

**Automatic migration:** on first open, if legacy `nodes.ndjson`/`edges.ndjson` exist and
the graph is empty, they are imported once (best-effort). No manual step.

**Optimization headroom (not yet done):**
- **Full-text index** on `name`/`props` → indexed keyword search (replaces `CONTAINS` scan).
- **N-hop traverse** (`MATCH (a)-[:Related*1..N]->(b)`) → chained relationship reasoning.
- **Graph algorithms** (WCC/PageRank/shortest-path) → mesh clustering & centrality for
  coaching ("which concepts are most referenced").
- **Vector index** → semantic similarity for domain lookup beyond keywords.

## 9. Configuration

| Env | Default | Meaning |
|---|---|---|
| `UC_WORM_MAX_AGE_DAYS` | 180 (~6 mo) | drop nodes not accessed in N days |
| `UC_WORM_MAX_NODES` | 100000 | cap node count, evict oldest-accessed beyond it |
| `UC_DOMAIN_TIMEOUT_MS` | 5000 | per-op query timeout → safe fallback |

The DB file lives at `<STATE_DIR>/domain.ladybug` (per-project state directory).
