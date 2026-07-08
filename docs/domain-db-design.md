# Domain Knowledge Base — Structure Design

> Purpose: Accumulate declarative knowledge ("what something is") to structurally compensate for the LLM weakness of "jumping to conclusions by guessing." Paired with the learning loop (procedural: "how"), so that the more the harness runs, the more accurate its evidence-based judgments become.

---

## Requirements (identified in this session)

1. **Persist investigation results** — Once a piece of domain knowledge is investigated, store it so it doesn't need to be investigated again.
2. **Connected form** — Concepts are not simple key-value pairs but connected by relationships (A returns B, C is part of D, E contradicts F).
3. **Look up before judging** — Before generate/investigate guesses, check the DB first and reuse if it exists.
4. **If unknown, investigate then store** — If not in the DB, investigate via webfetch/docs and add the result to the DB.
5. **Accumulation = irreproducibility** — This instance's DB is the craft. A new copy starts with an empty DB.

---

## Storage format: ladybugDB (graph DB)

A graph DB optimized for node-edge queries. "What does session.prompt return?" → Start from a node, follow relationships, and reach the answer.

**Why a graph DB**: Domain knowledge is inherently connected. "A returns B," "C contradicts D," "E is an example of F" — these relationships are expressed more naturally as a graph than as key-value or tables. Queries like "everything related to this concept" are resolved in a single traversal.

---

## Schema (ladybugDB node/edge)

### Node
```
{
  id: "node_001",
  type: "api-method" | "concept" | "limit" | "pattern" | "fact",
  name: "session.prompt",
  props: {
    returns: "AssistantMessage",
    blocking: true,
    sdk: "opencode"
  },
  source: "https://opencode.ai/docs/sdk",
  confidence: 0.95,
  ts: "2026-07-07T..."
}
```

**Node types**:
- `api-method` — function/method (session.prompt, session.create)
- `concept` — concept (tool execution timeout, sub-session)
- `limit` — constraint (not configurable, approximate range)
- `pattern` — recurring phenomenon (status does not track sub-sessions)
- `fact` — simple fact

### Edge (relationship)
```
{
  from: "node_001",
  to: "node_AssistantMessage",
  rel: "returns",
  note: "blocks until sub-session completes",
  ts: "..."
}
```

**Relationship types (rel)**:
| rel | meaning | example |
|-----|---------|---------|
| `returns` | A returns B | session.prompt → AssistantMessage |
| `is-a` | A is a kind of B | AssistantMessage → Message |
| `part-of` | A is part of B | parts → Message |
| `depends-on` | A depends on B | runModel → session.prompt |
| `contradicts` | A contradicts B | status() ↔ events |
| `constraints` | A constrains B | tool timeout → runModel |
| `example-of` | A is an example of B | "session.prompt blocks" → "synchronous API" |
| `alias-of` | A is an alias of B | sid ↔ sessionID |

---

## Query patterns (ladybugDB)

### Start from a keyword
```
query("session.prompt")
  → match "session.prompt" in node name
  → traverse rel="returns" edge from that node → AssistantMessage node
  → "session.prompt returns AssistantMessage" (1-hop)
```

### Relationship expansion
```
query("session.status")
  → node found, props.official=false
  → traverse rel="contradicts" → session.idle (events)
  → "status() is not official; flow is via events" (learned via contradiction relationship)
```

### Multi-hop query (later)
```
query("runModel")
  → depends-on → session.prompt → returns → AssistantMessage
  → constraints → tool timeout
  → "runModel depends on session.prompt and is constrained by the tool timeout" (2-hop)
```

---

## Integration points

### Learning loop Stage 2 (investigate) extension
Before root cause analysis, investigate first **looks up the domain DB**:
```
investigate(failure):
  1. extract keywords from failure (e.g., "session.status", "timeout")
  2. query ladybugDB → traverse related nodes + relationships
  3. if found → inject that knowledge into the prompt
     ("Already known: session.status is not an official method. Flow is via events (session.idle)...")
  4. if not found → generate investigates (webfetch/docs) → add result to ladybugDB as node+edge
```

### generate extension (alongside rules.md)
Inject rules.md (procedural) and **related ladybugDB nodes** (declarative) together into the generate prompt:
```
Lessons (procedural, from rules.md): ...
Known facts (declarative, from domain DB):
  - session.prompt() blocks until sub-session completes, returns AssistantMessage
  - session.status() is NOT a documented SDK method; status flows via events (session.idle)
  - tool execution timeout ~60-120s, not configurable
```

---

## Implementation order

1. **ladybugDB setup** — Add dependency, DB file location (`~/.cache/opencode-usage-coach/.../domain.ladybug` or config), initialization.
2. **Domain DB helpers** — `queryDomain(keywords)`, `addDomainNode(node)`, `addDomainEdge(edge)`, `traverse(nodeId, rel)`.
3. **investigate integration** — Query ladybugDB before root cause analysis, inject results.
4. **generate integration** — Inject domain nodes alongside rules.md.
5. **Store after investigation** — Add investigate/webfetch results via addDomainNode + addDomainEdge.
6. **TUI/validation** — Display domain DB node/edge counts, measure lookup effectiveness.

---

## Extensions to consider (later)

- **Semantic search**: When node count reaches 500+, add an embedding index to augment keyword matching.
- **Confidence weighting**: Exclude low-confidence nodes (0.5 or below) from injection, or mark them as "estimated."
- **Source tracking**: Trace back via source (URL/debugging date), refresh expired knowledge.
- **Worm (GC/eviction)**: Periodically remove or evict nodes that haven't been accessed in a long time, or when the DB hits a size limit. Each node tracks `lastAccessed` (updated on query/traverse). The worm cleans up stale/outdated knowledge so the DB doesn't grow unbounded with forgotten or invalid facts. Triggers: time-based (e.g. 30 days unused) or size-based (e.g. max 1000 nodes → evict oldest-accessed). Implementation: a `wormDomain(maxAgeDays?, maxNodes?)` function that compacts nodes.ndjson (and cascades edge cleanup for orphaned edges).

Start with ladybugDB now — graph queries best fit the essence of domain knowledge (connections).
