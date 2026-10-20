// src/index.ts
import { mkdirSync as mkdirSync4, writeFileSync as writeFileSync2, appendFileSync as appendFileSync4, readFileSync as readFileSync3, existsSync as existsSync3 } from "fs";
import { createHash } from "crypto";
import { homedir as homedir2 } from "os";
import { join as join4, resolve as resolve2, dirname as dirname2 } from "path";
import { tool } from "@opencode-ai/plugin";

// src/domain.ts
import { mkdirSync, appendFileSync, readFileSync, existsSync, writeFileSync, statSync } from "fs";
import { join, dirname, basename } from "path";
var BASE_DIR = "";
var SHARED_DIR = "";
function initDomain(stateDir) {
  BASE_DIR = stateDir;
  if (basename(dirname(stateDir)) === "projects") {
    SHARED_DIR = join(dirname(dirname(stateDir)), "shared");
  } else {
    SHARED_DIR = join(stateDir, "shared");
  }
}
var nodesFile = () => join(BASE_DIR, "nodes.ndjson");
var edgesFile = () => join(BASE_DIR, "edges.ndjson");
var sharedNodesFile = () => join(SHARED_DIR, "nodes.ndjson");
var sharedEdgesFile = () => join(SHARED_DIR, "edges.ndjson");
function readNdjson(path) {
  try {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
function readNodes() {
  return [...readNdjson(nodesFile()), ...readNdjson(sharedNodesFile())];
}
function readEdges() {
  return [...readNdjson(edgesFile()), ...readNdjson(sharedEdgesFile())];
}
function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function addDomainEdge(edge) {
  const full = { ...edge, ts: (/* @__PURE__ */ new Date()).toISOString() };
  try {
    mkdirSync(BASE_DIR, { recursive: true });
    appendFileSync(edgesFile(), JSON.stringify(full) + "\n");
  } catch {
  }
}
function readProjectNodes() {
  return readNdjson(nodesFile());
}
function readSharedNodes() {
  return readNdjson(sharedNodesFile());
}
function writeNodes(nodes) {
  try {
    mkdirSync(BASE_DIR, { recursive: true });
    const lines = nodes.map((n) => JSON.stringify(n));
    writeFileSync(nodesFile(), lines.length ? lines.join("\n") + "\n" : "");
  } catch {
  }
}
function writeSharedNodes(nodes) {
  try {
    mkdirSync(SHARED_DIR, { recursive: true });
    const lines = nodes.map((n) => JSON.stringify(n));
    writeFileSync(sharedNodesFile(), lines.length ? lines.join("\n") + "\n" : "");
  } catch {
  }
}
function writeProjectEdges(edges) {
  try {
    mkdirSync(BASE_DIR, { recursive: true });
    const lines = edges.map((e) => JSON.stringify(e));
    writeFileSync(edgesFile(), lines.length ? lines.join("\n") + "\n" : "");
  } catch {
  }
}
function writeSharedEdges(edges) {
  try {
    mkdirSync(SHARED_DIR, { recursive: true });
    const lines = edges.map((e) => JSON.stringify(e));
    writeFileSync(sharedEdgesFile(), lines.length ? lines.join("\n") + "\n" : "");
  } catch {
  }
}
function tokenizeAll(s) {
  const lowered = (s ?? "").toLowerCase();
  const out = [];
  for (const part of lowered.split(/[^a-z0-9가-힣]+/)) {
    if (!part) continue;
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
function tokenize(s) {
  return [...new Set(tokenizeAll(s))];
}
var rankIndex = null;
function statFp(path) {
  try {
    const st = statSync(path);
    return `${path}:${st.mtimeMs}:${st.size}`;
  } catch {
    return `${path}:missing:0`;
  }
}
function countNdjsonLines(path) {
  try {
    if (!existsSync(path)) return 0;
    return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}
function buildIndex() {
  const projFp = statFp(nodesFile());
  const sharedFp = statFp(sharedNodesFile());
  const nodes = readNodes();
  const byToken = /* @__PURE__ */ new Map();
  const tf = /* @__PURE__ */ new Map();
  const docLen = [];
  const idToIdx = /* @__PURE__ */ new Map();
  let total = 0;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    idToIdx.set(n.id, i);
    const tokens = tokenizeAll(`${n.name} ${JSON.stringify(n.props)}`);
    const counts = /* @__PURE__ */ new Map();
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
    avgdl: nodes.length > 0 ? total / nodes.length : 0
  };
}
function ensureIndex() {
  const projFp = statFp(nodesFile());
  const sharedFp = statFp(sharedNodesFile());
  if (rankIndex && rankIndex.projFp === projFp && rankIndex.sharedFp === sharedFp) return rankIndex;
  rankIndex = buildIndex();
  return rankIndex;
}
function syncCacheAfterTouch(fresh) {
  if (!rankIndex) return;
  if (fresh.length !== rankIndex.projCount) {
    rankIndex = null;
    return;
  }
  for (const n of fresh) {
    const idx = rankIndex.idToIdx.get(n.id);
    if (idx === void 0) continue;
    const cached = rankIndex.nodes[idx];
    if (cached) {
      cached.lastAccessed = n.lastAccessed;
      cached.accessCount = n.accessCount;
    }
  }
  rankIndex.projFp = statFp(nodesFile());
}
function envWeight(name, fallback) {
  const v = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(v) ? v : fallback;
}
var clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
var safeTs = (s) => {
  const t = s ? new Date(s).getTime() : NaN;
  return Number.isFinite(t) ? t : 0;
};
function queryDomain(keywords, opts = {}) {
  const maxNodes = Math.max(1, Math.round(opts.maxNodes ?? 20) || 20);
  const maxEdges = Math.max(1, Math.round(opts.maxEdges ?? 60) || 60);
  const idx = ensureIndex();
  if (!idx || idx.N === 0 || !(idx.avgdl > 0)) return { nodes: [], edges: [] };
  const qTokens = [...new Set(keywords.flatMap((k) => tokenize(k)))];
  if (qTokens.length === 0) return { nodes: [], edges: [] };
  const cand = /* @__PURE__ */ new Set();
  for (const t of qTokens) for (const i of idx.byToken.get(t) ?? []) cand.add(i);
  if (cand.size === 0) return { nodes: [], edges: [] };
  const alpha = envWeight("UC_RANK_ALPHA", 0.3);
  const beta = envWeight("UC_RANK_BETA", 0.2);
  const gamma = envWeight("UC_RANK_GAMMA", 0.1);
  const k1 = 1.2;
  const b = 0.75;
  const now = Date.now();
  const idfCache = /* @__PURE__ */ new Map();
  const raw = [];
  let maxBm25 = 0;
  for (const i of cand) {
    const dl = idx.docLen[i] ?? 0;
    const counts = idx.tf.get(i) ?? /* @__PURE__ */ new Map();
    let s = 0;
    for (const t of qTokens) {
      const f = counts.get(t);
      if (!f) continue;
      let idf = idfCache.get(t);
      if (idf === void 0) {
        const df = (idx.byToken.get(t) ?? []).length;
        idf = Math.log(1 + (idx.N - df + 0.5) / (df + 0.5));
        idfCache.set(t, idf);
      }
      s += idf * (f * (k1 + 1) / (f + k1 * (1 - b + b * dl / idx.avgdl)));
    }
    raw.push({ i, bm25: s });
    if (s > maxBm25) maxBm25 = s;
  }
  const scored = raw.map(({ i, bm25 }) => {
    const n = idx.nodes[i];
    if (!n) return null;
    const norm = maxBm25 > 0 ? bm25 / maxBm25 : 0;
    const conf = clamp01(typeof n.confidence === "number" && Number.isFinite(n.confidence) ? n.confidence : 0);
    const ageDays = Math.max(0, (now - safeTs(n.lastAccessed ?? n.ts)) / 864e5);
    const recency = 1 / (1 + ageDays / 30);
    const ac = typeof n.accessCount === "number" && Number.isFinite(n.accessCount) && n.accessCount > 0 ? n.accessCount : 0;
    const access = Math.min(Math.log10(1 + ac), 1);
    return { n, score: norm + alpha * conf + beta * recency + gamma * access };
  }).filter((x) => x !== null);
  scored.sort((a, b2) => b2.score - a.score || safeTs(b2.n.ts) - safeTs(a.n.ts));
  const kept = scored.slice(0, maxNodes).map(({ n }) => ({ ...n }));
  if (kept.length) touchNodes(new Set(kept.map((n) => n.id)));
  const ids = new Set(kept.map((n) => n.id));
  const edges = readEdges().filter((e) => ids.has(e.from) || ids.has(e.to)).sort((a, b2) => Number(ids.has(b2.from) && ids.has(b2.to)) - Number(ids.has(a.from) && ids.has(a.to))).slice(0, maxEdges);
  return { nodes: kept, edges };
}
function logDomainInjection(keywords, nodeIds) {
  try {
    mkdirSync(SHARED_DIR, { recursive: true });
    appendFileSync(
      join(SHARED_DIR, "injections.ndjson"),
      JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), keywords, nodeIds }) + "\n"
    );
  } catch {
  }
}
function readNdjsonTolerant(path) {
  try {
    if (!existsSync(path)) return [];
    const out = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
      }
    }
    return out;
  } catch {
    return [];
  }
}
function applyReward(outcome, note) {
  try {
    const injectionsPath = join(SHARED_DIR, "injections.ndjson");
    const rewardsPath = join(SHARED_DIR, "rewards.ndjson");
    const delta = envWeight("UC_REWARD_DELTA", 0.05);
    const claimed = /* @__PURE__ */ new Set();
    for (const r of readNdjsonTolerant(rewardsPath)) {
      for (const ts of Array.isArray(r.claimedInjectionTs) ? r.claimedInjectionTs : []) claimed.add(ts);
    }
    const drained = [];
    const nodeIds = [];
    const seen = /* @__PURE__ */ new Set();
    for (const inj of readNdjsonTolerant(injectionsPath)) {
      const ts = typeof inj.ts === "string" ? inj.ts : "";
      if (!ts || claimed.has(ts)) continue;
      drained.push(ts);
      for (const id of Array.isArray(inj.nodeIds) ? inj.nodeIds : []) {
        if (id && !seen.has(id)) {
          seen.add(id);
          nodeIds.push(id);
        }
      }
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    let applied = 0;
    if (nodeIds.length > 0) {
      const bump = (nodes) => {
        let changed = 0;
        let matchCount = 0;
        for (const n of nodes) {
          if (!seen.has(n.id)) continue;
          matchCount++;
          const cur = clamp01(typeof n.confidence === "number" && Number.isFinite(n.confidence) ? n.confidence : 0);
          const next = clamp01(cur + (outcome === "pass" ? delta : -delta));
          if (next !== cur) {
            n.confidence = next;
            changed++;
          }
          n.lastAccessed = now;
        }
        return { matchCount, changed };
      };
      const proj = readProjectNodes();
      const projMatched = bump(proj).matchCount;
      const shared = readSharedNodes();
      const sharedMatched = bump(shared).matchCount;
      applied = projMatched + sharedMatched;
      if (projMatched > 0) writeNodes(proj);
      if (sharedMatched > 0) writeSharedNodes(shared);
    }
    if (drained.length > 0 || applied > 0) {
      try {
        mkdirSync(SHARED_DIR, { recursive: true });
        appendFileSync(
          rewardsPath,
          JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), outcome, nodeIds, delta, note, claimedInjectionTs: drained }) + "\n"
        );
      } catch {
      }
    }
    return { applied };
  } catch {
    return { applied: 0 };
  }
}
function touchNodes(ids) {
  if (ids.size === 0) return;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  try {
    const nodes = readProjectNodes();
    let changed = false;
    for (const n of nodes) {
      if (ids.has(n.id)) {
        n.lastAccessed = now;
        n.accessCount = (n.accessCount ?? 0) + 1;
        changed = true;
      }
    }
    if (changed) {
      writeNodes(nodes);
      syncCacheAfterTouch(nodes);
    }
  } catch {
  }
  try {
    const shared = readSharedNodes();
    let changed = false;
    for (const n of shared) {
      if (ids.has(n.id)) {
        n.lastAccessed = now;
        n.accessCount = (n.accessCount ?? 0) + 1;
        changed = true;
      }
    }
    if (changed) writeSharedNodes(shared);
  } catch {
  }
}
function evictStale(maxAgeDays = 30, maxNodes = 1e3) {
  try {
    const nodes = readProjectNodes();
    if (nodes.length === 0) return { removed: 0, kept: 0 };
    const now = Date.now();
    const ageMs = maxAgeDays * 864e5;
    const lastTs = (n) => new Date(n.lastAccessed ?? n.ts).getTime();
    let kept = nodes.filter((n) => now - lastTs(n) < ageMs);
    if (kept.length > maxNodes) {
      kept.sort((a, b) => lastTs(b) - lastTs(a));
      kept = kept.slice(0, maxNodes);
    }
    const removed = nodes.length - kept.length;
    if (removed > 0) writeNodes(kept);
    return { removed, kept: kept.length };
  } catch {
    return { removed: 0, kept: 0 };
  }
}
function evictSharedStale(maxAgeDays = 60, maxNodes = 2e3) {
  try {
    const nodes = readSharedNodes();
    if (nodes.length === 0) return { removed: 0, kept: 0 };
    const now = Date.now();
    const ageMs = maxAgeDays * 864e5;
    const lastTs = (n) => new Date(n.lastAccessed ?? n.ts).getTime();
    let kept = nodes.filter((n) => now - lastTs(n) < ageMs);
    if (kept.length > maxNodes) {
      kept.sort((a, b) => lastTs(b) - lastTs(a));
      kept = kept.slice(0, maxNodes);
    }
    const removed = nodes.length - kept.length;
    if (removed > 0) writeSharedNodes(kept);
    return { removed, kept: kept.length };
  } catch {
    return { removed: 0, kept: 0 };
  }
}
function sweepDeadEdges() {
  try {
    const ids = new Set(readNodes().map((n) => n.id));
    const alive = (e) => ids.has(e.from) && ids.has(e.to);
    const projEdges = readNdjson(edgesFile());
    const sharedEdges = readNdjson(sharedEdgesFile());
    const projKept = projEdges.filter(alive);
    const sharedKept = sharedEdges.filter(alive);
    const removed = projEdges.length - projKept.length + (sharedEdges.length - sharedKept.length);
    if (removed > 0) {
      if (projKept.length !== projEdges.length) writeProjectEdges(projKept);
      if (sharedKept.length !== sharedEdges.length) writeSharedEdges(sharedKept);
    }
    return { removed, kept: projKept.length + sharedKept.length };
  } catch {
    return { removed: 0, kept: 0 };
  }
}
function traverseNeighborhood(seedNodeIds, maxDepth = 2, opts = {}) {
  const maxNodes = opts.maxNodes ?? 60;
  const fanoutCap = Math.max(1, Math.round(envWeight("UC_FANOUT_CAP", 12)));
  const allNodes = readNodes();
  const allEdges = readEdges();
  const byId = new Map(allNodes.map((n) => [n.id, n]));
  const seeds = seedNodeIds.filter((id) => byId.has(id));
  if (seeds.length === 0) return { nodes: [], edges: [] };
  const adj = /* @__PURE__ */ new Map();
  const link = (a, b) => {
    const s = adj.get(a) ?? /* @__PURE__ */ new Set();
    s.add(b);
    adj.set(a, s);
  };
  for (const e of allEdges) {
    link(e.from, e.to);
    link(e.to, e.from);
  }
  const distance = /* @__PURE__ */ new Map();
  const visited = /* @__PURE__ */ new Set();
  const frontier = [];
  for (const s of seeds) {
    if (visited.has(s)) continue;
    visited.add(s);
    distance.set(s, 0);
    frontier.push(s);
    if (visited.size >= maxNodes) break;
  }
  while (frontier.length > 0) {
    if (visited.size >= maxNodes) break;
    const cur = frontier.shift();
    const d = distance.get(cur) ?? 0;
    if (d >= maxDepth) continue;
    const nbrs = [...adj.get(cur) ?? []].sort((a, b) => {
      const ta = byId.get(a);
      const tb = byId.get(b);
      return (tb ? safeTs(tb.ts) : -1) - (ta ? safeTs(ta.ts) : -1) || (a < b ? -1 : a > b ? 1 : 0);
    }).slice(0, fanoutCap);
    for (const nxt of nbrs) {
      if (visited.has(nxt)) continue;
      visited.add(nxt);
      distance.set(nxt, d + 1);
      frontier.push(nxt);
      if (visited.size >= maxNodes) break;
    }
  }
  const nodes = [];
  for (const id of visited) {
    const n = byId.get(id);
    if (n) nodes.push({ ...n, distance: distance.get(id) ?? 0 });
  }
  const edges = allEdges.filter((e) => visited.has(e.from) && visited.has(e.to));
  return { nodes, edges };
}
function queryDomainGraph(keywords, maxDepth = 2, opts = {}) {
  const seed = queryDomain(keywords, opts);
  const seedIds = seed.nodes.map((n) => n.id);
  if (maxDepth <= 0 || seedIds.length === 0) {
    return { nodes: seed.nodes, edges: seed.edges };
  }
  const graph = traverseNeighborhood(seedIds, maxDepth, opts);
  const seedSet = new Set(seedIds);
  const neighborIds = graph.nodes.filter((n) => !seedSet.has(n.id)).map((n) => n.id);
  if (neighborIds.length > 0) touchNodes(new Set(neighborIds));
  return { nodes: graph.nodes, edges: graph.edges };
}
function saveInvestigationResult(keywords, result, source, confidence = 0.7) {
  try {
    const nodeId = uid("node");
    const full = {
      id: nodeId,
      type: "fact",
      name: keywords.join(" "),
      props: { result, keywords: [...new Set(keywords)] },
      source: source || "investigation",
      confidence,
      ts: (/* @__PURE__ */ new Date()).toISOString()
    };
    try {
      mkdirSync(SHARED_DIR, { recursive: true });
      appendFileSync(sharedNodesFile(), JSON.stringify(full) + "\n");
    } catch {
    }
    autoLinkKeywords(nodeId, keywords);
    return nodeId;
  } catch {
    return "";
  }
}
function autoLinkKeywords(nodeId, keywords, minOverlap = 2, maxLinks = 8) {
  const gate = (process.env.UC_AUTOLINK ?? "").toLowerCase();
  if (gate !== "1" && gate !== "true") return;
  if (keywords.length < minOverlap) return;
  try {
    const candidates = queryDomain(keywords);
    let linked = 0;
    for (const node of candidates.nodes) {
      if (node.id === nodeId) continue;
      const nodeKw = Array.isArray(node.props?.keywords) ? node.props.keywords : (node.name || "").toLowerCase().split(/[^a-z0-9_-]+/).filter((w) => w.length >= 3);
      const overlap = keywords.filter((k) => nodeKw.includes(k));
      if (overlap.length >= minOverlap) {
        const edge = {
          from: nodeId,
          to: node.id,
          rel: "related-to",
          note: `auto: ${overlap.length} shared (${overlap.slice(0, 5).join(",")})`,
          ts: (/* @__PURE__ */ new Date()).toISOString()
        };
        try {
          mkdirSync(SHARED_DIR, { recursive: true });
          appendFileSync(sharedEdgesFile(), JSON.stringify(edge) + "\n");
        } catch {
        }
        linked++;
        if (linked >= maxLinks) break;
      }
    }
  } catch {
  }
}

// src/v1-session.ts
function makeV1SessionOps(client) {
  return {
    async create(directory, title) {
      const s = await client.session.create({ body: { title }, query: { directory } });
      const id = s?.data?.info?.id ?? s?.data?.id ?? s?.id;
      if (!id) throw new Error(`session.create returned no id (response: ${JSON.stringify(s?.data ?? s).slice(0, 200)})`);
      return id;
    },
    async prompt(id, providerID, modelID, text) {
      return client.session.prompt({
        path: { id },
        body: { model: { providerID, modelID }, parts: [{ type: "text", text }] }
      });
    },
    async messages(id) {
      const msgs = await client.session.messages?.({ path: { id } });
      return Array.isArray(msgs?.data) ? msgs.data : Array.isArray(msgs) ? msgs : [];
    },
    async abort(id) {
      try {
        await client.session.abort?.({ path: { id } });
      } catch {
      }
    },
    async delete(id) {
      try {
        await client.session.delete?.({ path: { id } });
      } catch {
      }
    },
    async get(id) {
      const s = await client.session.get({ path: { id } });
      return s?.data?.info ?? s?.data ?? s?.info ?? s ?? null;
    },
    async summarize(id) {
      return client.session.summarize?.({ path: { id } });
    }
  };
}

// src/schema-convert.ts
function isSchemaNode(v) {
  return !!v && typeof v === "object" && !Array.isArray(v) && typeof v.type === "string";
}
function unsupported(toolName, node) {
  throw new Error(`schema-convert: unsupported node for ${toolName}: ${JSON.stringify(node)}`);
}
function describe(node, raw) {
  return raw && typeof raw.description === "string" ? node.describe(raw.description) : node;
}
function convertNode(toolName, node, S) {
  if (!node || typeof node !== "object" || Array.isArray(node)) unsupported(toolName, node);
  if (node.type === "object" && isSchemaNode(node.additionalProperties) && !node.properties) {
    return S.record(S.string(), describe(convertNode(toolName, node.additionalProperties, S), node.additionalProperties));
  }
  if (Array.isArray(node.enum)) {
    if (!node.enum.every((v) => typeof v === "string")) unsupported(toolName, node);
    return S.enum(node.enum);
  }
  switch (node.type) {
    case "string":
      return S.string();
    case "number":
      return S.number();
    case "boolean":
      return S.boolean();
    case "array": {
      if (!isSchemaNode(node.items)) unsupported(toolName, node);
      return S.array(describe(convertNode(toolName, node.items, S), node.items));
    }
    case "object": {
      const props = {};
      const required = new Set(Array.isArray(node.required) ? node.required : []);
      for (const [name, raw] of Object.entries(node.properties ?? {})) {
        if (!isSchemaNode(raw)) unsupported(toolName, raw);
        let converted = convertNode(toolName, raw, S);
        converted = describe(converted, raw);
        if (!required.has(name)) converted = converted.optional();
        props[name] = converted;
      }
      return S.object(props);
    }
    default:
      unsupported(toolName, node);
  }
}
function convertSchema(toolName, schema, S) {
  if (!schema || typeof schema !== "object" || schema.type !== "object") {
    throw new Error(
      `schema-convert: top-level schema must be an object for ${toolName}: got ${JSON.stringify(schema?.type ?? schema)}`
    );
  }
  return convertNode(toolName, schema, S);
}

// src/tool-defs.ts
import { mkdirSync as mkdirSync3, appendFileSync as appendFileSync3 } from "fs";
import { spawnSync } from "child_process";

// src/tool-schemas.ts
var TOOL_NAMES = [
  "harness_start",
  "unknown_scan",
  "question",
  "task_update",
  "harness_done",
  "record_failure",
  "investigate",
  "verify_diagnosis",
  "generalize",
  "generate",
  "generate_batch",
  "grade",
  "grade_batch",
  "reverse_interview",
  "coach_config",
  "coach_analyze"
];
var CHECK_TYPE_ENUM = ["file-exists", "grep", "grep-absent", "line-count"];
var TOOL_SCHEMAS = {
  harness_start: {
    description: "Start the harness: register the total task count on the panel. Call once when the harness loop begins. IMPORTANT: each generate/generate_batch sub-session is step-limited (default 30). If any task seems too large, split it into smaller subtasks BEFORE starting \u2014 oversized tasks will timeout.",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Harness name (shown on the TUI panel)." },
        total: { type: "number", description: "Total number of tasks in this harness run." }
      },
      required: ["name", "total"],
      additionalProperties: false
    }
  },
  unknown_scan: {
    description: "Pre-flight gap analysis: call AFTER harness_start, BEFORE generate. Scans the codebase against the user's request to find blind spots (unknown unknowns) that could waste 30+ steps if discovered late. Returns identified unknowns + task split suggestions + user confirmation questions. Writes results to harness.json for TUI display.",
    schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The user's original request (the full prompt that triggered the harness)."
        },
        tasks: {
          type: "array",
          description: "Tasks registered via harness_start (id + title). If omitted, a single task derived from the prompt is assumed.",
          items: {
            type: "object",
            properties: {
              id: { type: "number", description: "Task ID." },
              title: { type: "string", description: "Task title." }
            },
            required: ["id", "title"],
            additionalProperties: false
          }
        },
        skip_scan: {
          type: "boolean",
          description: "true: skip codebase scan and do prompt analysis only (default false; auto-skips for dirs with <5 files)."
        }
      },
      required: ["prompt"],
      additionalProperties: false
    }
  },
  question: {
    description: "Present unknown_scan questions to the user. REQUIRED after unknown_scan finds questions \u2014 call BEFORE generate. First call (no answers) returns the questions formatted for presentation. Present them to the user, then call again with their answers.",
    schema: {
      type: "object",
      properties: {
        answers: {
          type: "object",
          description: `User's answers keyed by question ID (e.g. {"Q1": "yes", "Q2": "node"}). Omit on first call to get the questions.`,
          additionalProperties: { type: "string" }
        }
      },
      required: [],
      additionalProperties: false
    }
  },
  task_update: {
    description: "Update a harness task's status on the panel. Call whenever a task transitions to generating/grading/revising/completed/failed.",
    schema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Task ID." },
        title: { type: "string", description: "Task title." },
        status: {
          type: "string",
          description: "pending | generating | grading | revising | completed | failed | timed_out"
        },
        revisions: { type: "number", description: "Revision count so far." },
        score: { type: "string", description: "PASS | FAIL" },
        model: { type: "string", description: "Model used for this task." }
      },
      required: ["id", "title", "status"],
      additionalProperties: false
    }
  },
  harness_done: {
    description: "Mark the harness as complete \u2014 call when the loop ends.",
    schema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    }
  },
  record_failure: {
    description: "Stage 1 (RECORD) of the learning loop. Append a failure record to failures.ndjson for later root-cause analysis.",
    schema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task description." },
        prompt: { type: "string", description: "The generation prompt that produced the failing output." },
        gradeResult: { type: "string", description: "The grader's verdict/output." },
        model: { type: "string", description: "Model used." },
        revisions: { type: "number", description: "Revision count so far." }
      },
      required: ["task", "prompt", "gradeResult"],
      additionalProperties: false
    }
  },
  investigate: {
    description: "Stage 2 (INVESTIGATE) of the learning loop. Run the generator to analyze the ROOT CAUSE of a failure (not just the symptom).",
    schema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task description." },
        prompt: { type: "string", description: "The generation prompt that produced the failing output." },
        gradeResult: { type: "string", description: "The grader's verdict/output." },
        model: { type: "string", description: "Model used." }
      },
      required: ["task", "prompt", "gradeResult"],
      additionalProperties: false
    }
  },
  verify_diagnosis: {
    description: "Stage 3 (VERIFY) of the learning loop. Run the grader to check whether a diagnosis is CORRECT and ACTIONABLE (leads to a useful rule). Returns PASS/FAIL + a [usage-coach NEXT] directive.",
    schema: {
      type: "object",
      properties: {
        diagnosis: { type: "string", description: "Root-cause diagnosis to verify." },
        task: { type: "string", description: "Task description." },
        gradeResult: { type: "string", description: "The grader's verdict/output." }
      },
      required: ["diagnosis", "task", "gradeResult"],
      additionalProperties: false
    }
  },
  generalize: {
    description: "Stage 4 (GENERALIZE) of the learning loop. Run the generator to turn a verified root cause into a reusable rule and append it to rules.md, so the next generate call includes it. Returns the rule text and a [usage-coach NEXT] directive.",
    schema: {
      type: "object",
      properties: {
        diagnosis: { type: "string", description: "Verified root-cause diagnosis." },
        task: { type: "string", description: "Task description." }
      },
      required: ["diagnosis", "task"],
      additionalProperties: false
    }
  },
  generate: {
    description: "Run the GENERATOR model on a prompt. Quota-aware: on THROTTLE, auto-switches to lighterModel if configured. Returns the model's text response. Step-limited: aborts after max_steps (default 30) to prevent runaway tasks.",
    schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The generation prompt for the sub-session." },
        max_steps: {
          type: "number",
          description: "Maximum sub-session steps before timeout (default 30). Increase for complex tasks, decrease to fail fast on scope creep."
        }
      },
      required: ["prompt"],
      additionalProperties: false
    }
  },
  generate_batch: {
    description: "Run the GENERATOR model on MULTIPLE tasks. Quota-aware: GO = full parallel; THROTTLE = lighter model + concurrency capped at 2; STOP = refused. Use for INDEPENDENT tasks. Step-limited: each sub-session aborts after max_steps (default 30). Resilient: failed tasks are retried sequentially (once); if retry also fails, re-run them individually with generate(). Each task may declare files it will modify via `files: string[]` \u2014 overlapping files across tasks force sequential execution (limit=1).",
    schema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          description: "One entry per task to generate. All run in parallel (quota-aware; overlapping files force sequential execution).",
          items: {
            type: "object",
            properties: {
              id: { type: "number", description: "Task ID (must match the task_update ID)." },
              prompt: { type: "string", description: "The generation prompt for this task." },
              files: {
                type: "array",
                description: "Files this task will MODIFY. Required when tasks might touch the same files \u2014 overlapping files force sequential execution.",
                items: { type: "string", description: "Relative file path." }
              }
            },
            required: ["id", "prompt"],
            additionalProperties: false
          }
        },
        max_steps: {
          type: "number",
          description: "Maximum sub-session steps per task before timeout (default 30)."
        }
      },
      required: ["tasks"],
      additionalProperties: false
    }
  },
  grade: {
    description: "Run the GRADER model on a prompt. Returns PASS/FAIL on the first line + a [usage-coach NEXT] directive. Falls back to generator if grader quota is out. For MECHANICAL tasks (conversions, extraction, scaffolds), pass `checks` instead \u2014 deterministic file/grep verification runs locally in milliseconds and the grader model is skipped entirely.",
    schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "What is being graded (context for the verdict; shown in the result)."
        },
        checks: {
          type: "array",
          description: "Deterministic checks \u2014 when present, ALL are evaluated locally and the verdict is computed without a model call. Use for mechanical verifications; keep model grading for judgment calls.",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: CHECK_TYPE_ENUM, description: "Check type." },
              path: {
                type: "string",
                description: "Relative path (file for file-exists/line-count; file OR dir for grep, default '.' = recursive scan skipping node_modules/.git/dist)."
              },
              pattern: { type: "string", description: "Regex for grep / grep-absent." },
              minCount: { type: "number", description: "grep: minimum total matches (default 1)." },
              min: { type: "number", description: "line-count: minimum non-empty lines." },
              max: { type: "number", description: "line-count: maximum non-empty lines." }
            },
            required: ["type"],
            additionalProperties: false
          }
        }
      },
      required: ["prompt"],
      additionalProperties: false
    }
  },
  grade_batch: {
    description: "Run the GRADER model on MULTIPLE tasks IN PARALLEL. Quota-aware: GO = full parallel; THROTTLE = concurrency capped at 2; STOP = refused. Use after generate_batch returns results for all INDEPENDENT tasks \u2014 grade them all at once instead of one-by-one. Each result includes a per-task PASS/FAIL verdict + NEXT directive. Resilient: failed grades are retried sequentially (once).",
    schema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          description: "One entry per task to grade. All run in parallel on GO.",
          items: {
            type: "object",
            properties: {
              id: { type: "number", description: "Task ID (must match the task_update ID)." },
              prompt: { type: "string", description: "The grading prompt for this task (same format as grade())." },
              checks: {
                type: "array",
                description: "Deterministic checks \u2014 when present, the model call is skipped (see grade()).",
                items: {
                  type: "object",
                  properties: {
                    type: { type: "string", enum: CHECK_TYPE_ENUM, description: "Check type." },
                    path: { type: "string", description: "Relative path." },
                    pattern: { type: "string", description: "Regex for grep / grep-absent." },
                    minCount: { type: "number", description: "grep: minimum total matches." },
                    min: { type: "number", description: "line-count: minimum non-empty lines." },
                    max: { type: "number", description: "line-count: maximum non-empty lines." }
                  },
                  required: ["type"],
                  additionalProperties: false
                }
              }
            },
            required: ["id", "prompt"],
            additionalProperties: false
          }
        }
      },
      required: ["tasks"],
      additionalProperties: false
    }
  },
  reverse_interview: {
    description: "Reverse interview: identify ambiguities in the task and ask the user one question at a time, highest design-impact first. Call WITHOUT answer to start or get the next question. Call WITH answer to record the user's response and advance. Returns the next question or a completion summary. ALWAYS present the question to the user verbatim \u2014 do NOT answer it yourself.",
    schema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The current task description (what the user asked for)." },
        context: {
          type: "string",
          description: "Additional context from unknown_scan, codebase exploration, or prior turns. Injected into the question-generation prompt for better prioritization."
        },
        answer: {
          type: "string",
          description: "The user's response to the previous question. Omit on the first call (or when there is no answer to record)."
        },
        force_complete: {
          type: "boolean",
          description: "Force-complete the interview now, returning a summary of the recorded answers."
        }
      },
      required: ["task"],
      additionalProperties: false
    }
  },
  coach_config: {
    description: 'View or update harness model configuration (generator, grader, lighterModel, provider, maxSteps, domainMaxNodes). Call with no args to view current config. Pass any combination of fields to update. Example: coach_config({ generator: "anthropic/claude-sonnet-4-20250514", grader: "opencode/mimo-v2.5-free", maxSteps: 15 })',
    schema: {
      type: "object",
      properties: {
        generator: { type: "string", description: "Generator model (provider/model id)." },
        grader: { type: "string", description: "Grader model (provider/model id)." },
        lighterModel: { type: "string", description: "Fallback model switched to under throttle." },
        provider: { type: "string", description: "Provider used for generate/grade sub-sessions." },
        maxSteps: {
          type: "number",
          description: "Max steps per generate/grade sub-session (default 30). Lower = faster but may timeout on complex tasks."
        },
        domainMaxNodes: {
          type: "number",
          description: "Max domain DB nodes injected into a generate prompt (default 12). Lower keeps prompts small; 0 or unset uses the default."
        }
      },
      required: [],
      additionalProperties: false
    }
  },
  coach_analyze: {
    description: "Analyze knowledge injection effectiveness \u2014 compares grade PASS rates for tasks WITH injected knowledge (rules, impl-notes, domain DB, scan findings) vs WITHOUT. Run after 20+ harness tasks to see if accumulated knowledge actually helps.",
    schema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    }
  }
};

// src/web-search.ts
import { appendFileSync as appendFileSync2, mkdirSync as mkdirSync2 } from "fs";
import { join as join2 } from "path";
import { homedir } from "os";
var WS_LOG_FILE = process.env.UC_STATE_DIR ? join2(process.env.UC_STATE_DIR, "web-search.log") : join2(homedir(), ".cache", "opencode-usage-coach", "web-search.log");
function wsLog(msg) {
  try {
    mkdirSync2(join2(WS_LOG_FILE, ".."), { recursive: true });
    appendFileSync2(WS_LOG_FILE, `${(/* @__PURE__ */ new Date()).toISOString()} ${msg}
`);
  } catch {
  }
}
var FRAMEWORK_DOCS = {
  "react": { name: "React", docs: "https://react.dev", githubOrg: "facebook" },
  "solid-js": { name: "Solid.js", docs: "https://solidjs.com", githubOrg: "solidjs" },
  "vue": { name: "Vue", docs: "https://vuejs.org", githubOrg: "vuejs" },
  "svelte": { name: "Svelte", docs: "https://svelte.dev", githubOrg: "sveltejs" },
  "express": { name: "Express", docs: "https://expressjs.com", githubOrg: "expressjs" },
  "fastify": { name: "Fastify", docs: "https://fastify.dev", githubOrg: "fastify" },
  "hono": { name: "Hono", docs: "https://hono.dev", githubOrg: "honojs" },
  "vitest": { name: "Vitest", docs: "https://vitest.dev", githubOrg: "vitest-dev" },
  "jest": { name: "Jest", docs: "https://jestjs.io", githubOrg: "jestjs" },
  "tsup": { name: "tsup", docs: "https://tsup.egoist.dev", githubOrg: "egoist" },
  "eslint": { name: "ESLint", docs: "https://eslint.org", githubOrg: "eslint" },
  "cloudflare": { name: "Cloudflare", docs: "https://developers.cloudflare.com", githubOrg: "cloudflare" }
};
var DEFAULT_TIMEOUT_MS = 8e3;
var TARGET_RESULT_COUNT = 5;
var GH_QUERY_MAX = 256;
function ghToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
}
function ghHeaders() {
  const headers = {
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "opencode-usage-coach"
  };
  const token = ghToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}
function errMessage(e) {
  return e instanceof Error ? e.message : String(e);
}
function truncate(input, max) {
  const text = (input ?? "").replace(/[\r\n]+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
function sanitizeQuery(raw) {
  return raw.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ").replace(/https?:\/\/\S+/g, " ").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\b(NOT|AND|OR)\b/gi, " ").replace(/\s+/g, " ").trim().slice(0, GH_QUERY_MAX);
}
function effectiveFrameworks(frameworks, keyDeps) {
  const set = new Set((frameworks || []).filter(Boolean));
  if (keyDeps) {
    for (const dep of keyDeps) {
      if (dep === "wrangler" || dep.startsWith("@cloudflare/")) set.add("cloudflare");
    }
  }
  return [...set];
}
async function ghFetch(url, signal) {
  const res = await fetch(url, { headers: ghHeaders(), signal });
  if (!res.ok) {
    let ghError = null;
    let ghErrorText = "";
    try {
      ghErrorText = await res.text();
      ghError = JSON.parse(ghErrorText);
    } catch {
    }
    const tag = res.status === 403 || res.status === 429 ? " (rate limit)" : res.status === 422 ? " (validation failed)" : "";
    const errs = ghError?.errors;
    const errMsg = ghError?.message ?? ghErrorText.slice(0, 300);
    const detail = errs ? errs.map((e) => typeof e === "string" ? e : `${e?.field ?? "?"}: ${e?.message ?? e?.code ?? JSON.stringify(e)}`).join("; ") : "";
    wsLog(JSON.stringify({
      level: "error",
      module: "web-search",
      event: "gh-fetch-error",
      status: res.status,
      tag,
      url,
      ghMessage: errMsg,
      ghErrors: detail,
      rateLimitRemaining: res.headers.get("x-ratelimit-remaining"),
      rateLimitReset: res.headers.get("x-ratelimit-reset")
    }));
    throw new Error(`HTTP ${res.status}${tag}: ${errMsg}${detail ? ` | ${detail}` : ""}`);
  }
  return await res.json();
}
function pushResult(results, seen, r) {
  if (r.url && !seen.has(r.url)) {
    seen.add(r.url);
    results.push(r);
  }
}
async function tier1OfficialDocs(query, fws, results, docRefs, seen, signal) {
  const errors = [];
  for (const fw of fws) {
    const entry = FRAMEWORK_DOCS[fw];
    if (entry) docRefs.push({ name: entry.name, url: entry.docs });
  }
  if (!query) return errors;
  const cleanQuery = sanitizeQuery(query);
  if (!cleanQuery) return errors;
  for (const fw of fws) {
    if (signal.aborted || results.length >= TARGET_RESULT_COUNT) break;
    const entry = FRAMEWORK_DOCS[fw];
    if (!entry?.githubOrg) continue;
    try {
      const orgPart = ` org:${entry.githubOrg}`;
      const truncated = cleanQuery.slice(0, GH_QUERY_MAX - orgPart.length);
      const fullQ = `${truncated}${orgPart}`;
      const url = `https://api.github.com/search/issues?q=${encodeURIComponent(fullQ)}&per_page=3`;
      const data = await ghFetch(url, signal);
      for (const item of data.items ?? []) {
        pushResult(results, seen, {
          tier: "official-docs",
          title: item.title,
          url: item.html_url,
          snippet: truncate(item.body, 200)
        });
      }
    } catch (e) {
      const m = errMessage(e);
      wsLog(`[web-search] tier1 ${fw}: ${m}`);
      errors.push(`tier1:${fw}:${m.slice(0, 80)}`);
    }
  }
  return errors;
}
async function tier2GitHubIssues(query, results, seen, signal) {
  const errors = [];
  try {
    const q = sanitizeQuery(query);
    if (!q) return errors;
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=5`;
    const data = await ghFetch(url, signal);
    for (const item of data.items ?? []) {
      pushResult(results, seen, {
        tier: "github-issues",
        title: item.title,
        url: item.html_url,
        snippet: truncate(item.body, 200)
      });
    }
  } catch (e) {
    const m = errMessage(e);
    wsLog(`[web-search] tier2: ${m}`);
    errors.push(`tier2:${m.slice(0, 80)}`);
  }
  return errors;
}
async function tier3GitHubCode(query, results, seen, signal) {
  const errors = [];
  if (!ghToken()) return errors;
  try {
    const q = sanitizeQuery(query);
    if (!q) return errors;
    const url = `https://api.github.com/search/code?q=${encodeURIComponent(q)}&per_page=3`;
    const data = await ghFetch(url, signal);
    for (const item of data.items ?? []) {
      const repo = item.repository?.full_name;
      pushResult(results, seen, {
        tier: "github-code",
        title: item.path || item.name,
        url: item.html_url,
        snippet: repo ? `${repo} \u2014 ${item.path}` : item.path
      });
    }
  } catch (e) {
    const m = errMessage(e);
    wsLog(`[web-search] tier3: ${m}`);
    errors.push(`tier3:${m.slice(0, 80)}`);
  }
  return errors;
}
async function searchContext(query, frameworks, keyDeps, timeoutMs) {
  const results = [];
  const docRefs = [];
  const errors = [];
  const seen = /* @__PURE__ */ new Set();
  const timeout = Math.max(100, Number(timeoutMs ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const signal = controller.signal;
  try {
    const q = (query || "").trim();
    const fws = effectiveFrameworks(frameworks, keyDeps);
    errors.push(...await tier1OfficialDocs(q, fws, results, docRefs, seen, signal));
    if (q && results.length < TARGET_RESULT_COUNT && !signal.aborted) {
      errors.push(...await tier2GitHubIssues(q, results, seen, signal));
    }
    if (q && results.length < TARGET_RESULT_COUNT && !signal.aborted) {
      errors.push(...await tier3GitHubCode(q, results, seen, signal));
    }
  } catch (e) {
    const m = errMessage(e);
    wsLog(`[web-search] unexpected error: ${m}`);
    errors.push(`unexpected:${m.slice(0, 80)}`);
  } finally {
    clearTimeout(timer);
  }
  const response = { results, docRefs };
  const joined = errors.filter(Boolean).join("; ");
  if (joined) response.error = joined;
  return response;
}

// src/grade-checks.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, readdirSync, statSync as statSync2 } from "fs";
import { join as join3, relative, resolve } from "path";
var SKIP_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".venv",
  "__pycache__",
  ".cache"
]);
var MAX_FILE_BYTES = 2 * 1024 * 1024;
var MAX_WALK_FILES = 2e3;
var MAX_WALK_DEPTH = 8;
var TEXT_EXT = /* @__PURE__ */ new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".c",
  ".h",
  ".cpp",
  ".sh",
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".txt",
  ".html",
  ".css",
  ".sql"
]);
function listTextFiles(root, out = [], depth = 0) {
  if (depth > MAX_WALK_DEPTH || out.length >= MAX_WALK_FILES) return out;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    const p = join3(root, e.name);
    if (e.isDirectory()) listTextFiles(p, out, depth + 1);
    else if (e.isFile()) {
      const dot = e.name.lastIndexOf(".");
      const ext = dot >= 0 ? e.name.slice(dot).toLowerCase() : "";
      if (TEXT_EXT.has(ext)) out.push(p);
      if (out.length >= MAX_WALK_FILES) break;
    }
  }
  return out;
}
function countMatches(re, text) {
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const m = text.match(new RegExp(re.source, flags));
  return m ? m.length : 0;
}
function grepTargets(root, path) {
  const target = resolve(root, path ?? ".");
  if (!existsSync2(target)) return [];
  const st = statSync2(target);
  if (st.isFile()) return [target];
  return listTextFiles(target);
}
function evalChecks(root, checks) {
  const results = [];
  for (const c of checks) {
    if (c.type === "file-exists") {
      const full = resolve(root, c.path);
      const ok = existsSync2(full);
      results.push({ check: c, pass: ok, detail: `${c.path}: ${ok ? "exists" : "MISSING"}` });
    } else if (c.type === "grep" || c.type === "grep-absent") {
      let re;
      try {
        re = new RegExp(c.pattern);
      } catch (e) {
        results.push({ check: c, pass: false, detail: `invalid regex ${JSON.stringify(c.pattern)}: ${String(e?.message ?? e).slice(0, 80)}` });
        continue;
      }
      const targets = grepTargets(root, c.path);
      let total = 0;
      const hits = [];
      for (const t of targets) {
        let text;
        try {
          if (statSync2(t).size > MAX_FILE_BYTES) continue;
          text = readFileSync2(t, "utf8");
        } catch {
          continue;
        }
        const n = countMatches(re, text);
        if (n > 0) {
          total += n;
          if (hits.length < 5) hits.push(`${relative(root, t)}:${n}`);
        }
      }
      if (targets.length === 0) {
        results.push({ check: c, pass: false, detail: `path ${c.path ?? "."}: no scan targets found` });
      } else if (c.type === "grep") {
        const min = c.minCount ?? 1;
        results.push({ check: c, pass: total >= min, detail: `pattern ${JSON.stringify(c.pattern)}: ${total} match(es), need >= ${min}${hits.length ? " \u2014 e.g. " + hits.join(", ") : ""}` });
      } else {
        results.push({ check: c, pass: total === 0, detail: `pattern ${JSON.stringify(c.pattern)}: ${total} match(es), need 0${hits.length ? " \u2014 e.g. " + hits.join(", ") : ""}` });
      }
    } else if (c.type === "line-count") {
      const full = resolve(root, c.path);
      if (!existsSync2(full) || !statSync2(full).isFile()) {
        results.push({ check: c, pass: false, detail: `${c.path}: MISSING` });
        continue;
      }
      let n;
      try {
        n = readFileSync2(full, "utf8").split("\n").filter((l) => l.trim()).length;
      } catch {
        results.push({ check: c, pass: false, detail: `${c.path}: unreadable` });
        continue;
      }
      const minOk = c.min === void 0 || n >= c.min;
      const maxOk = c.max === void 0 || n <= c.max;
      results.push({ check: c, pass: minOk && maxOk, detail: `${c.path}: ${n} non-empty lines (min ${c.min ?? "-"}, max ${c.max ?? "-"})` });
    } else {
      results.push({ check: c, pass: false, detail: `unknown check type: ${c.type}` });
    }
  }
  return { pass: results.length > 0 && results.every((r) => r.pass), results };
}
function formatCheckReport(r) {
  return r.results.map((x) => `${x.pass ? "PASS" : "FAIL"} [${x.check.type}] ${x.detail}`).join("\n");
}

// src/tool-defs.ts
function buildToolDefs() {
  const defs = [
    {
      name: TOOL_NAMES[0],
      description: TOOL_SCHEMAS.harness_start.description,
      schema: TOOL_SCHEMAS.harness_start.schema,
      async execute(args, call) {
        writeHarness(call.sessionID, { name: args.name, total: args.total, current: 0, tasks: [], usage: {}, active: true, scanRequired: true, startedAt: (/* @__PURE__ */ new Date()).toISOString() });
        return `Harness '${args.name}' started (${args.total} tasks).

\u26A0 DIAGNOSIS GATE \u2014 unknown_scan is REQUIRED before generate/generate_batch.
  unknown_scan({ prompt: "<user request>", tasks: [{id:1, title:"..."}, ...] })
  If you skip it, generate will inject a \u26A0 warning into the sub-session prompt.
  Review the report: if QUESTIONS are flagged \u2192 call question() to present them
  to the user BEFORE generate (it is enforced \u2014 generate will block with a
  warning until answers are recorded). If TASK REFINEMENTS are suggested \u2192
  apply via task_update. Unknown unknowns found will be automatically injected
  into generate prompts as context.

STEP LIMIT (default ${DEFAULT_MAX_STEPS}): each generate call creates a sub-session that is automatically aborted if it exceeds ${DEFAULT_MAX_STEPS} assistant steps. Before starting the loop, review each task: can it be completed in a focused, single-pass effort? If a task seems too broad (multiple files, multiple features, open-ended research), SPLIT it now into 2-3 smaller subtasks. A timeout wastes quota \u2014 split upfront.

DETERMINISTIC LOOP \u2014 first classify the tasks:
  INDEPENDENT = task B does NOT need task A's output  ->  use PATH A (parallel, faster)
  DEPENDENT   = task B needs task A's output          ->  use PATH B (sequential)

PATH A \u2014 INDEPENDENT (parallel via generate_batch + grade_batch):
  1. task_update(1..${args.total}, title, "generating")
  2. generate_batch({tasks: [{id:1, prompt:"Task: <title1>. Perform it."}, ...]})  -> all results + NEXT
  3. task_update(1..${args.total}, title, "grading")
  4. grade_batch({tasks: [{id:1, prompt:"Evaluate... PASS/FAIL first line. Task: <title1>"}, ...]})  -> all verdicts + per-task NEXT
  5. for each i: PASS -> task_update(i, title, "completed", "PASS"); FAIL -> revise (up to 2x) or task_update(i, title, "failed", "FAIL")
  Note: grade_batch runs all grades IN PARALLEL \u2014 much faster than grading one-by-one.
  After revisions, you can grade_batch the revised tasks together too.

PATH B \u2014 DEPENDENT (sequential \u2014 one task at a time):
  Optional: task_update(1..N, title, "pending")  \u2190 pre-register all tasks first
  for i in 1..${args.total}:
    1. task_update(i, title, "generating")
    2. generate({prompt:"Task: <title>. Perform it."})  -> work + NEXT
    3. task_update(i, title, "grading")
    4. grade(...)  -> verdict + NEXT
    5. PASS -> task_update(i, title, "completed", "PASS"); FAIL -> revise (up to 2x) or failed
  Note: use single grade() here \u2014 tasks are dependent, grading is one at a time.

Then: harness_done(). Follow the [usage-coach NEXT] directive each tool returns. Do NOT improvise the sequence.`;
      }
    },
    {
      name: TOOL_NAMES[1],
      description: TOOL_SCHEMAS.unknown_scan.description,
      schema: TOOL_SCHEMAS.unknown_scan.schema,
      async execute(args, call, host) {
        const tasks = args.tasks && args.tasks.length > 0 ? args.tasks : [{ id: 1, title: args.prompt.slice(0, 80) }];
        let profile;
        if (args.skip_scan) {
          profile = { skipped: true, reason: "skip_scan requested", language: "unknown", frameworks: [], structure: [], manifestFiles: [], keyDeps: [], configFiles: [], totalFiles: 0 };
        } else {
          try {
            const dir = (call.directory ?? host.rt.directory) || ".";
            const result2 = spawnSync("find", [
              dir,
              "-maxdepth",
              "4",
              "-type",
              "f",
              "-not",
              "-path",
              "*/node_modules/*",
              "-not",
              "-path",
              "*/.git/*",
              "-not",
              "-path",
              "*/dist/*",
              "-not",
              "-path",
              "*/.cache/*"
            ], { encoding: "utf8", timeout: 1e4, maxBuffer: 1024 * 1024 });
            const fileList = result2.stdout || "";
            profile = parseFileList(fileList, call.directory ?? host.rt.directory);
            if (profile.totalFiles < 5) {
              profile = { ...profile, skipped: true, reason: `directory nearly empty (${profile.totalFiles} files)` };
            }
          } catch (e) {
            profile = { skipped: true, reason: `scan error: ${String(e).slice(0, 100)}`, language: "unknown", frameworks: [], structure: [], manifestFiles: [], keyDeps: [], configFiles: [], totalFiles: 0 };
          }
        }
        let domainNodes = [];
        let domainHits = 0;
        try {
          const combined = `${args.prompt} ${tasks.map((t) => t.title).join(" ")}`;
          const kw = extractKeywords(combined);
          if (kw.length) {
            const graph = queryDomainGraph(kw, 2);
            domainNodes = graph.nodes || [];
            domainHits = domainNodes.length;
          }
        } catch (e) {
          log(`unknown_scan domain query err: ${String(e)}`);
        }
        let webResults = [];
        let docRefs = [];
        try {
          const searchQuery = `${args.prompt} ${tasks.map((t) => t.title).join(" ")}`.slice(0, 256);
          const webResp = await searchContext(searchQuery, profile.frameworks, profile.keyDeps);
          webResults = webResp.results;
          docRefs = webResp.docRefs;
          if (webResp.error) log(`unknown_scan web search: ${webResp.error}`);
          log(`unknown_scan web search: ${webResults.length} results, ${docRefs.length} doc refs`);
        } catch (e) {
          log(`unknown_scan web search err: ${String(e).slice(0, 200)}`);
        }
        const cfg = readHarnessCfg(call.directory ?? host.rt.directory);
        if (!cfg.generator) {
          const result2 = {
            scannedAt: (/* @__PURE__ */ new Date()).toISOString(),
            codebaseProfile: profile,
            knownKnowns: [],
            knownUnknowns: [],
            unknownKnowns: [],
            unknownUnknowns: [],
            questions: [],
            taskRefinements: [],
            domainHits,
            domainMisses: 0,
            rawAnalysis: "ERROR: no generator configured"
          };
          writeUnknownScan(call.sessionID, result2);
          return formatReport(result2) + '\n\nERROR: no generator model configured. Set "generator" in harness.config.json for model-assisted analysis.';
        }
        let decision = "GO";
        try {
          decision = host.current().decision;
        } catch {
        }
        if (decision === "STOP") {
          const result2 = {
            scannedAt: (/* @__PURE__ */ new Date()).toISOString(),
            codebaseProfile: profile,
            knownKnowns: [],
            knownUnknowns: [],
            unknownKnowns: [],
            unknownUnknowns: [],
            questions: [],
            taskRefinements: [],
            domainHits,
            domainMisses: 0,
            rawAnalysis: "quota STOP \u2014 model analysis skipped"
          };
          writeUnknownScan(call.sessionID, result2);
          return formatReport(result2) + "\n\n[usage-coach] quota STOP \u2014 model-assisted analysis skipped. Proceed with caution.";
        }
        const throttle = decision === "THROTTLE" && cfg.lighterModel;
        const model = throttle ? cfg.lighterModel : cfg.generator;
        const gapPrompt = buildGapPrompt(args.prompt, tasks, profile, domainNodes, webResults, docRefs);
        const raw = await runModel(host.rt.session, model, gapPrompt, call.directory ?? host.rt.directory, void 0, 15, call.signal);
        const result = parseGapAnalysis(raw, profile, domainHits);
        result.webResults = webResults;
        result.docRefs = docRefs;
        try {
          for (const uk of result.unknownKnowns.slice(0, 5)) {
            const kw = extractKeywords(uk.finding);
            if (kw.length) saveInvestigationResult(kw, uk.finding, "unknown_scan");
          }
          for (const uu of result.unknownUnknowns.slice(0, 3)) {
            const kw = extractKeywords(uu.finding);
            if (kw.length) saveInvestigationResult(kw, `${uu.finding} (impact: ${uu.impact})`, "unknown_scan");
          }
        } catch (e) {
          log(`unknown_scan save err: ${String(e)}`);
        }
        writeUnknownScan(call.sessionID, result);
        return formatReport(result);
      }
    },
    {
      name: TOOL_NAMES[2],
      description: TOOL_SCHEMAS.question.description,
      schema: TOOL_SCHEMAS.question.schema,
      async execute(args, call) {
        const h = readHarness(call.sessionID);
        if (!h || !h.unknownScan || !h.unknownScan.questions?.length) {
          return "No questions from unknown_scan. [usage-coach NEXT] proceed to generate.";
        }
        const questions = h.unknownScan.questions;
        if (!args.answers) {
          const lines2 = [`unknown_scan found ${questions.length} question(s) that need user input before proceeding:
`];
          questions.forEach((q) => {
            lines2.push(`[${q.id}] ${q.question}`);
          });
          lines2.push('\nPresent ALL of these questions to the user. Collect their answers, then call question({ answers: { "' + questions[0].id + '": "..." } }) with ALL answers.');
          lines2.push("[usage-coach NEXT] Present the questions above to the user verbatim. After they respond, call question({answers:{...}}) to record answers, then proceed to generate.");
          return lines2.join("\n");
        }
        h.questionsResolved = true;
        h.questionAnswers = args.answers;
        writeHarness(call.sessionID, h);
        const answered = Object.keys(args.answers).length;
        const lines = [`Questions resolved (${answered}/${questions.length} answered).
`];
        questions.forEach((q) => {
          const ans = args.answers[q.id];
          if (ans) lines.push(`  ${q.id}: ${q.question}
  \u2192 ${ans}`);
        });
        lines.push("\n[usage-coach NEXT] Answers recorded. Proceed to generate \u2014 they will be injected into the sub-session prompt.");
        return lines.join("\n");
      }
    },
    {
      name: TOOL_NAMES[3],
      description: TOOL_SCHEMAS.task_update.description,
      schema: TOOL_SCHEMAS.task_update.schema,
      async execute(args, call, host) {
        const VALID_STATUSES = ["pending", "generating", "grading", "revising", "completed", "failed", "timed_out", "halted_quota"];
        const status = args.status && VALID_STATUSES.includes(args.status) ? args.status : "generating";
        const cfg = readHarnessCfg(call.directory ?? host.rt.directory);
        const h = readHarness(call.sessionID) ?? { name: "batch", total: 0, current: 0, tasks: [], usage: {}, active: true };
        h.tasks = h.tasks.filter((x) => x.id !== args.id);
        const model = args.model || cfg.generator || "";
        if (!model) return `ERROR: task ${args.id} has no model and no generator configured. Set "generator" in harness.config.json.`;
        h.tasks.push({ id: args.id, title: args.title, status, model, revisions: args.revisions ?? 0, score: args.score ?? null, startedAt: (/* @__PURE__ */ new Date()).toISOString() });
        if (args.id > h.current) h.current = args.id;
        writeHarness(call.sessionID, h);
        return `task ${args.id} -> ${status}${args.score ? ` (${args.score})` : ""}`;
      }
    },
    {
      name: TOOL_NAMES[4],
      description: TOOL_SCHEMAS.harness_done.description,
      schema: TOOL_SCHEMAS.harness_done.schema,
      async execute(_args, call) {
        const h = readHarness(call.sessionID);
        if (h) {
          h.current = h.total;
          h.active = false;
          writeHarness(call.sessionID, h);
        }
        return "Harness complete.";
      }
    },
    {
      name: TOOL_NAMES[5],
      description: TOOL_SCHEMAS.record_failure.description,
      schema: TOOL_SCHEMAS.record_failure.schema,
      async execute(args) {
        const rec = { ts: (/* @__PURE__ */ new Date()).toISOString(), task: args.task, prompt: args.prompt, gradeResult: args.gradeResult, model: args.model, revisions: args.revisions };
        try {
          mkdirSync3(STATE_DIR, { recursive: true });
          appendFileSync3(failuresFile(), JSON.stringify(rec) + "\n");
        } catch (e) {
          log(`record_failure err: ${String(e)}`);
        }
        return `Failure recorded. [usage-coach NEXT] call investigate({failure: ${JSON.stringify(rec)}}) to find the root cause.`;
      }
    },
    {
      name: TOOL_NAMES[6],
      description: TOOL_SCHEMAS.investigate.description,
      schema: TOOL_SCHEMAS.investigate.schema,
      async execute(args, call, host) {
        const cfg = readHarnessCfg(call.directory ?? host.rt.directory);
        if (!cfg.generator) return 'ERROR: no generator model configured. Set "generator" in harness.config.json (see harness.config.example.json).';
        let domainPrefix = "";
        let keywords = [];
        let domainEmpty = true;
        try {
          keywords = extractKeywords(`${args.task} ${args.gradeResult}`);
          if (keywords.length) {
            const { nodes, edges } = queryDomain(keywords, { maxNodes: cfg.domainMaxNodes ?? 12 });
            logDomainInjection(keywords, nodes.map((n) => n.id));
            if (nodes && nodes.length || edges && edges.length) {
              domainEmpty = false;
              domainPrefix = `Known facts from domain DB: ${JSON.stringify({ nodes, edges })}. Use these if relevant.

---

`;
            }
          }
        } catch (e) {
          log(`investigate domain query err: ${String(e)}`);
        }
        const rcaPrompt = `A task failed. Analyze the ROOT CAUSE (not just the symptom).
Task: ${args.task}
What was expected (from grade): ${args.gradeResult}
Read relevant files in the directory if needed.
Output a structured root cause:
category: (one of: constraint-violation, missing-context, tool-misuse, model-limitation, other)
explanation: <why it failed>
evidence: <file/line or specific quote>`;
        const invTaskId = findActiveTaskId(call.sessionID, "revising");
        const out = await runModel(
          host.rt.session,
          cfg.generator,
          domainPrefix + rcaPrompt,
          call.directory ?? host.rt.directory,
          invTaskId ? { sessionID: call.sessionID, taskId: invTaskId } : void 0,
          void 0,
          call.signal
        );
        if (domainEmpty && keywords.length) {
          try {
            saveInvestigationResult(keywords, out, "investigate");
          } catch (e) {
            log(`investigate save err: ${String(e)}`);
          }
        }
        return out + "\n[usage-coach NEXT] call verify_diagnosis with this diagnosis.";
      }
    },
    {
      name: TOOL_NAMES[7],
      description: TOOL_SCHEMAS.verify_diagnosis.description,
      schema: TOOL_SCHEMAS.verify_diagnosis.schema,
      async execute(args, call, host) {
        const cfg = readHarnessCfg(call.directory ?? host.rt.directory);
        const model = cfg.grader ?? cfg.generator;
        if (!model) return "FAIL\n(ERROR: no grader/generator model configured.)\n[usage-coach NEXT] configure grader in harness.config.json, then retry verify_diagnosis.";
        const verifyPrompt = `Verify this root-cause analysis for a failure.
Task: ${args.task}
Grade feedback: ${args.gradeResult}
Diagnosis: ${args.diagnosis}
Is the diagnosis CORRECT and ACTIONABLE (leads to a useful rule)?
Output PASS (the diagnosis is right) or FAIL (re-investigate needed), then reason.`;
        const verTaskId = findActiveTaskId(call.sessionID, "revising");
        const out = await runModel(
          host.rt.session,
          model,
          verifyPrompt,
          call.directory ?? host.rt.directory,
          verTaskId ? { sessionID: call.sessionID, taskId: verTaskId } : void 0,
          void 0,
          call.signal
        );
        let verdict = "FAIL";
        if (!out.startsWith("ERROR:")) {
          const f = (out.split("\n").find((l) => l.trim()) ?? "").trim();
          if (/^pass\b/i.test(f)) verdict = "PASS";
          else verdict = "FAIL";
        }
        const next = verdict === "PASS" ? `
[usage-coach NEXT] call generalize with this verified diagnosis.` : `
[usage-coach NEXT] FAIL \u2014 re-investigate the root cause.`;
        return out + "\n" + next;
      }
    },
    {
      name: TOOL_NAMES[8],
      description: TOOL_SCHEMAS.generalize.description,
      schema: TOOL_SCHEMAS.generalize.schema,
      async execute(args, call, host) {
        const cfg = readHarnessCfg(call.directory ?? host.rt.directory);
        if (!cfg.generator) return 'ERROR: no generator model configured. Set "generator" in harness.config.json (see harness.config.example.json).';
        const genPrompt = `Turn this verified root cause into a GENERAL, REUSABLE rule for future tasks of this kind.
Diagnosis: ${args.diagnosis}
Failed task: ${args.task}
Output a single rule in the form: 'For <task-type> tasks, always <check/do X> because <reason>.'
Keep it concrete and actionable.`;
        const genRuleTaskId = findActiveTaskId(call.sessionID, "revising");
        const out = await runModel(
          host.rt.session,
          cfg.generator,
          genPrompt,
          call.directory ?? host.rt.directory,
          genRuleTaskId ? { sessionID: call.sessionID, taskId: genRuleTaskId } : void 0,
          void 0,
          call.signal
        );
        const rule = out;
        try {
          const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
          mkdirSync3(STATE_DIR, { recursive: true });
          appendFileSync3(rulesFile(), `## Rule (${date})
${rule}
Origin: ${args.task}

`);
        } catch (e) {
          log(`generalize err: ${String(e)}`);
        }
        return `${rule}
[usage-coach NEXT] rule saved to rules.md. The next generate call will include it. Call task_update for the original failed task -> failed, then proceed.`;
      }
    },
    // Per-role model execution (config-driven, quota-aware, same server, no deadlock).
    // P1: quota decision drives model selection + concurrency.
    {
      name: TOOL_NAMES[9],
      description: TOOL_SCHEMAS.generate.description,
      schema: TOOL_SCHEMAS.generate.schema,
      async execute(args, call, host) {
        const cfg = readHarnessCfg(call.directory ?? host.rt.directory);
        if (!cfg.generator) {
          const h = readHarness(call.sessionID);
          if (h) {
            h.active = false;
            writeHarness(call.sessionID, h);
          }
          return 'ERROR: no generator model configured. Set "generator" in harness.config.json (see harness.config.example.json). HARNESS TERMINATED \u2014 configure a generator model, then restart the harness.';
        }
        let decision = "GO";
        try {
          decision = host.current().decision;
        } catch {
        }
        const throttle = decision === "THROTTLE" && cfg.lighterModel;
        const model = throttle ? cfg.lighterModel : cfg.generator;
        const rules = readRules();
        let prefix = rules ? `Lessons learned from previous failures (apply where relevant):
${rules}

---

` : "";
        let keywords = [];
        let domainEmpty = true;
        let domainNodeCount = 0;
        let domainEdgeCount = 0;
        try {
          keywords = extractKeywords(args.prompt);
          if (keywords.length) {
            const { nodes, edges } = queryDomain(keywords, { maxNodes: cfg.domainMaxNodes ?? 12 });
            logDomainInjection(keywords, nodes.map((n) => n.id));
            if (nodes && nodes.length || edges && edges.length) {
              domainEmpty = false;
              domainNodeCount = nodes.length;
              domainEdgeCount = edges.length;
              prefix = `Known facts from domain DB: ${JSON.stringify({ nodes, edges })}. Use these if relevant.

---

` + prefix;
              log(`generate domain HIT: ${nodes.length} nodes, ${edges.length} edges (kw=[${keywords.join(",")}])`);
            } else {
              log(`generate domain MISS: 0 nodes (kw=[${keywords.join(",")}])`);
            }
          }
        } catch (e) {
          log(`generate domain query err: ${String(e)}`);
        }
        let notesLines = 0;
        try {
          const priorNotes = keywords.length ? readImplNotesByGraph(keywords, 5) : readImplNotes(5);
          if (priorNotes) {
            notesLines = priorNotes.split("\n").filter(Boolean).length;
            prefix = `Notes from previous runs (context for this task):
${priorNotes}

---

` + prefix;
          }
        } catch (e) {
          log(`generate impl-notes read err: ${String(e)}`);
        }
        prefix += IMPL_NOTE_INSTRUCTION;
        const gate = checkScanGate(call.sessionID);
        if (gate.warning) {
          prefix = `${gate.warning}

---

` + prefix;
        }
        if (gate.summary) {
          prefix = `Pre-flight scan findings (from unknown_scan \u2014 heed these):
${gate.summary}

---

` + prefix;
        }
        const genTaskId = findActiveTaskId(call.sessionID, "generating");
        const maxSteps = resolveMaxSteps(cfg, args.max_steps);
        const injected = {
          rules: rules ? rules.split("\n").filter(Boolean).length : 0,
          implNotes: notesLines,
          domainNodes: domainNodeCount,
          domainEdges: domainEdgeCount,
          hasScanFindings: !!gate.summary
        };
        if (genTaskId) {
          try {
            mutateHarness(call.sessionID, (h) => {
              const t = h.tasks.find((x) => x.id === genTaskId);
              if (t) t.injected = injected;
            });
          } catch {
          }
        }
        const out = await runModel(
          host.rt.session,
          model,
          prefix + args.prompt,
          call.directory ?? host.rt.directory,
          genTaskId ? { sessionID: call.sessionID, taskId: genTaskId } : void 0,
          maxSteps,
          call.signal
        );
        const isTimeoutOrError = out.startsWith("Task appears too large") || out.startsWith("ERROR:");
        if (domainEmpty && keywords.length && !isTimeoutOrError) {
          try {
            saveInvestigationResult(keywords, out, "generate");
          } catch (e) {
            log(`generate save err: ${String(e)}`);
          }
        }
        if (!isTimeoutOrError) {
          try {
            const { notes } = extractImplNotes(out);
            if (notes) {
              appendImplNotes(notes, args.prompt);
              if (keywords.length) {
                const noteNodeId = saveInvestigationResult(keywords, notes, "impl-note", 0.5);
                if (noteNodeId) linkImplNoteToDomain(noteNodeId, notes);
              }
            }
          } catch (e) {
            log(`generate impl-notes extract err: ${String(e)}`);
          }
        }
        if (out.startsWith("Task appears too large")) return out;
        return out + (throttle ? `
[usage-coach] quota THROTTLE \u2014 used lighter model ${cfg.lighterModel}` : "") + `
[usage-coach NEXT] call task_update(i, title, "grading"), then grade to evaluate this work.`;
      }
    },
    {
      name: TOOL_NAMES[10],
      description: TOOL_SCHEMAS.generate_batch.description,
      schema: TOOL_SCHEMAS.generate_batch.schema,
      async execute(args, call, host) {
        const cfg = readHarnessCfg(call.directory ?? host.rt.directory);
        if (!cfg.generator) {
          const h = readHarness(call.sessionID);
          if (h) {
            h.active = false;
            writeHarness(call.sessionID, h);
          }
          return 'ERROR: no generator model configured. Set "generator" in harness.config.json (see harness.config.example.json). HARNESS TERMINATED \u2014 configure a generator model, then restart the harness.';
        }
        let decision = "GO";
        try {
          decision = host.current().decision;
        } catch {
        }
        if (decision === "STOP") return 'ERROR: quota STOP \u2014 halt the harness loop now. Call task_update(current, "halted_quota") and stop.';
        const throttle = decision === "THROTTLE" && cfg.lighterModel;
        const model = throttle ? cfg.lighterModel : cfg.generator;
        const limit = resolveBatchLimit(args.tasks, decision);
        if (limit === 1 && args.tasks.length > 1) log(`generate_batch: file overlap detected, forcing sequential (limit=1)`);
        const rules = readRules();
        const priorNotes = readImplNotes(5);
        const maxSteps = resolveMaxSteps(cfg, args.max_steps);
        const gate = checkScanGate(call.sessionID);
        const gatePrefix = gate.warning ? `${gate.warning}

---

` : gate.summary ? `Pre-flight scan findings (from unknown_scan \u2014 heed these):
${gate.summary}

---

` : "";
        const runOne = async (t) => {
          let prefix = gatePrefix;
          prefix += rules ? `Lessons learned from previous failures (apply where relevant):
${rules}

---

` : "";
          if (priorNotes) prefix = `Notes from previous runs (context for this task):
${priorNotes}

---

` + prefix;
          prefix += IMPL_NOTE_INSTRUCTION;
          const r = await runModel(
            host.rt.session,
            model,
            prefix + t.prompt,
            call.directory ?? host.rt.directory,
            { sessionID: call.sessionID, taskId: t.id },
            maxSteps,
            call.signal
          );
          const isTimeoutOrError = r.startsWith("Task appears too large") || r.startsWith("ERROR:");
          if (!isTimeoutOrError) {
            try {
              const { notes } = extractImplNotes(r);
              if (notes) {
                appendImplNotes(notes, t.prompt);
                const kw = extractKeywords(t.prompt);
                if (kw.length) {
                  const noteNodeId = saveInvestigationResult(kw, notes, "impl-note", 0.5);
                  if (noteNodeId) linkImplNoteToDomain(noteNodeId, notes);
                }
              }
            } catch (e) {
              log(`generate_batch impl-notes extract err: ${String(e)}`);
            }
          }
          return { id: t.id, result: r };
        };
        const results = [];
        const failed = [];
        for (let i = 0; i < args.tasks.length; i += limit) {
          const batch = args.tasks.slice(i, i + limit);
          const settled = await Promise.allSettled(batch.map((t) => runOne(t)));
          for (let j = 0; j < settled.length; j++) {
            const s = settled[j];
            const t = batch[j];
            if (s.status === "fulfilled") {
              results.push(`[task ${s.value.id}] ${s.value.result}`);
            } else {
              const err = String(s.reason ?? "unknown rejection");
              log(`generate_batch task ${t.id} REJECTED: ${err}`);
              failed.push({ id: t.id, prompt: t.prompt, files: t.files, error: err });
            }
          }
        }
        if (failed.length > 0) {
          log(`generate_batch: retrying ${failed.length} failed task(s) sequentially`);
          for (const f of failed) {
            try {
              const r = await runOne(f);
              results.push(`[task ${r.id}] (retry) ${r.result}`);
            } catch (e2) {
              const err2 = String(e2 ?? "unknown rejection on retry");
              log(`generate_batch task ${f.id} retry ALSO FAILED: ${err2}`);
              results.push(`[task ${f.id}] ERROR: task failed on both batch and retry. Error: ${err2}`);
            }
          }
        }
        const failedCount = results.filter((r) => r.includes("ERROR:")).length;
        const note = throttle ? `
[usage-coach] quota THROTTLE \u2014 lighter model ${cfg.lighterModel}, concurrency capped at ${limit}` : "";
        const failNext = failedCount > 0 ? `
[usage-coach NEXT] ${failedCount} task(s) failed even after retry. Re-run each failed task individually with generate() (sequential), NOT generate_batch. This isolates failures and avoids batch-level abort.` : "";
        return results.join("\n\n") + note + failNext;
      }
    },
    {
      name: TOOL_NAMES[11],
      description: TOOL_SCHEMAS.grade.description,
      schema: TOOL_SCHEMAS.grade.schema,
      async execute(args, call, host) {
        if (args.checks && args.checks.length > 0) {
          const r = evalChecks(call.directory ?? host.rt.directory, args.checks);
          try {
            const gr2 = applyReward(r.pass ? "pass" : "fail", harnessTaskTitle(call.sessionID, findActiveTaskId(call.sessionID, "grading")));
            log(`applyReward(${r.pass ? "pass" : "fail"}): applied ${gr2.applied}`);
          } catch (e) {
            log(`applyReward err: ${String(e)}`);
          }
          const next2 = r.pass ? `
[usage-coach NEXT] PASS -> call task_update(i, title, "completed", "PASS"), then proceed to next task (or harness_done if last).` : `
[usage-coach NEXT] FAIL -> if revisions < 2: task_update(i, title, "revising", revisions+1) + generate({prompt: "Apply feedback:\\n{grade result}\\nTask: {title}"}); else: run the learning loop (record_failure -> investigate -> verify_diagnosis -> generalize), then task_update(i, title, "failed", "FAIL").`;
          return `${r.pass ? "PASS" : "FAIL"}
(verified by ${r.results.length} deterministic check(s) \u2014 grader model skipped)
${formatCheckReport(r)}
graded claim: ${args.prompt.slice(0, 300)}
${next2}`;
        }
        const cfg = readHarnessCfg(call.directory ?? host.rt.directory);
        const model = cfg.grader ?? cfg.generator;
        if (!model) return "FAIL\n(ERROR: no grader/generator model configured.)\n[usage-coach NEXT] configure grader in harness.config.json, then retry grade.";
        const gradeTaskId = findActiveTaskId(call.sessionID, "grading");
        const out = await runModel(
          host.rt.session,
          model,
          buildGradePrompt(args.prompt),
          call.directory ?? host.rt.directory,
          gradeTaskId ? { sessionID: call.sessionID, taskId: gradeTaskId } : void 0,
          void 0,
          call.signal
        );
        let verdict = "FAIL";
        let verdictClear = false;
        if (!out.startsWith("ERROR:")) {
          const f = (out.split("\n").find((l) => l.trim()) ?? "").trim();
          if (/^pass\b/i.test(f)) {
            verdict = "PASS";
            verdictClear = true;
          } else if (/^fail\b/i.test(f)) {
            verdict = "FAIL";
            verdictClear = true;
          } else verdict = "FAIL";
        }
        if (verdictClear) {
          try {
            const r = applyReward(verdict === "PASS" ? "pass" : "fail", harnessTaskTitle(call.sessionID, gradeTaskId));
            log(`applyReward(${verdict.toLowerCase()}): applied ${r.applied}`);
          } catch (e) {
            log(`applyReward err: ${String(e)}`);
          }
        }
        const next = verdict === "PASS" ? `
[usage-coach NEXT] PASS -> call task_update(i, title, "completed", "PASS"), then proceed to next task (or harness_done if last).` : `
[usage-coach NEXT] FAIL -> if revisions < 2: task_update(i, title, "revising", revisions+1) + generate({prompt: "Apply feedback:\\n{grade result}\\nTask: {title}"}); else: run the learning loop before failing \u2014
  1. record_failure({task, prompt, gradeResult, model, revisions})
  2. investigate({task, prompt, gradeResult}) -> diagnosis
  3. verify_diagnosis({diagnosis, task, gradeResult}) -> if PASS: generalize({diagnosis, task}) (saves rule to rules.md)
  4. task_update(i, title, "failed", "FAIL") -> next task.
The next generate call will automatically include the new rule.`;
        return out + "\n" + next;
      }
    },
    {
      name: TOOL_NAMES[12],
      description: TOOL_SCHEMAS.grade_batch.description,
      schema: TOOL_SCHEMAS.grade_batch.schema,
      async execute(args, call, host) {
        const cfg = readHarnessCfg(call.directory ?? host.rt.directory);
        const model = cfg.grader ?? cfg.generator;
        if (!model) {
          return 'ERROR: no grader/generator model configured. Set "grader" or "generator" in harness.config.json.';
        }
        let decision = "GO";
        try {
          decision = host.current().decision;
        } catch {
        }
        if (decision === "STOP") {
          return 'ERROR: quota STOP \u2014 halt the harness loop now. Call task_update(current, "halted_quota") and stop.';
        }
        const limit = decision === "THROTTLE" ? 2 : args.tasks.length;
        const gradeOne = async (t) => {
          if (t.checks && t.checks.length > 0) {
            const r = evalChecks(call.directory ?? host.rt.directory, t.checks);
            try {
              const title = harnessTaskTitle(call.sessionID, t.id);
              const rw = applyReward(r.pass ? "pass" : "fail", title ? `batch #${t.id} ${title}` : `batch #${t.id}`);
              log(`applyReward(${r.pass ? "pass" : "fail"}) batch #${t.id}: applied ${rw.applied}`);
            } catch (e) {
              log(`applyReward err: ${String(e)}`);
            }
            const next2 = r.pass ? `[usage-coach NEXT] task ${t.id}: PASS -> task_update(${t.id}, title, "completed", "PASS"), then proceed.` : `[usage-coach NEXT] task ${t.id}: FAIL -> if revisions < 2: task_update(${t.id}, title, "revising") + generate({prompt:"Apply feedback:\\n${formatCheckReport(r).slice(0, 500)}\\nTask: {title}"}); else: record_failure + investigate + verify + generalize, then task_update(${t.id}, title, "failed", "FAIL").`;
            return { id: t.id, result: `[task ${t.id}] ${r.pass ? "PASS" : "FAIL"}
(verified by ${r.results.length} deterministic check(s) \u2014 grader model skipped)
${formatCheckReport(r)}
${next2}` };
          }
          const gradeTaskId = findActiveTaskId(call.sessionID, "grading");
          const out = await runModel(
            host.rt.session,
            model,
            buildGradePrompt(t.prompt),
            call.directory ?? host.rt.directory,
            gradeTaskId ? { sessionID: call.sessionID, taskId: gradeTaskId } : void 0,
            void 0,
            call.signal
          );
          let verdict = "FAIL";
          let verdictClear = false;
          if (!out.startsWith("ERROR:")) {
            const f = (out.split("\n").find((l) => l.trim()) ?? "").trim();
            if (/^pass\b/i.test(f)) {
              verdict = "PASS";
              verdictClear = true;
            } else if (/^fail\b/i.test(f)) {
              verdict = "FAIL";
              verdictClear = true;
            }
          }
          if (verdictClear) {
            try {
              const title = harnessTaskTitle(call.sessionID, t.id);
              const r = applyReward(verdict === "PASS" ? "pass" : "fail", title ? `batch #${t.id} ${title}` : `batch #${t.id}`);
              log(`applyReward(${verdict.toLowerCase()}) batch #${t.id}: applied ${r.applied}`);
            } catch (e) {
              log(`applyReward err: ${String(e)}`);
            }
          }
          const next = verdict === "PASS" ? `[usage-coach NEXT] task ${t.id}: PASS -> task_update(${t.id}, title, "completed", "PASS"), then proceed.` : `[usage-coach NEXT] task ${t.id}: FAIL -> if revisions < 2: task_update(${t.id}, title, "revising") + generate({prompt:"Apply feedback:\\n${out.slice(0, 500)}\\nTask: {title}"}); else: record_failure + investigate + verify + generalize, then task_update(${t.id}, title, "failed", "FAIL").`;
          return { id: t.id, result: `[task ${t.id}] ${verdict}
${out}
${next}` };
        };
        const results = [];
        const failed = [];
        for (let i = 0; i < args.tasks.length; i += limit) {
          const batch = args.tasks.slice(i, i + limit);
          const settled = await Promise.allSettled(batch.map((t) => gradeOne(t)));
          for (let j = 0; j < settled.length; j++) {
            const s = settled[j];
            const t = batch[j];
            if (s.status === "fulfilled") {
              results.push(s.value.result);
            } else {
              const err = String(s.reason ?? "unknown rejection");
              log(`grade_batch task ${t.id} REJECTED: ${err}`);
              failed.push({ id: t.id, prompt: t.prompt, error: err });
            }
          }
        }
        if (failed.length > 0) {
          log(`grade_batch: retrying ${failed.length} failed grade(s) sequentially`);
          for (const f of failed) {
            try {
              const r = await gradeOne(f);
              results.push(r.result.replace(`[task ${r.id}]`, `[task ${r.id}] (retry)`));
            } catch (e2) {
              const err2 = String(e2 ?? "unknown rejection on retry");
              log(`grade_batch task ${f.id} retry ALSO FAILED: ${err2}`);
              results.push(`[task ${f.id}] FAIL
(ERROR: grade failed on both batch and retry: ${err2})
[usage-coach NEXT] task ${f.id}: grade error \u2014 re-run grade() individually for this task.`);
            }
          }
        }
        const throttleNote = decision === "THROTTLE" ? `
[usage-coach] quota THROTTLE \u2014 grader concurrency capped at ${limit}.` : "";
        const passCount = results.filter((r) => /\[task \d+\] PASS/.test(r)).length;
        const summary = `
[usage-coach] Graded ${results.length} task(s): ${passCount} PASS, ${results.length - passCount} FAIL.`;
        return results.join("\n\n") + summary + throttleNote;
      }
    },
    {
      name: TOOL_NAMES[13],
      description: TOOL_SCHEMAS.reverse_interview.description,
      schema: TOOL_SCHEMAS.reverse_interview.schema,
      async execute(args, call, host) {
        const sessionID = call.sessionID;
        const cfg = readHarnessCfg(call.directory ?? host.rt.directory);
        const resolveModel = () => {
          if (!cfg.generator) return null;
          let decision = "GO";
          try {
            decision = host.current().decision;
          } catch {
          }
          const throttle = decision === "THROTTLE" && cfg.lighterModel;
          return throttle ? cfg.lighterModel : cfg.generator;
        };
        let state = readInterview(sessionID);
        if (args.force_complete) {
          if (state && state.phase !== "complete") {
            return await completeInterview(state, sessionID, host.rt.session, resolveModel(), call.directory ?? host.rt.directory, call.signal);
          }
          return "No active interview to complete.\n[usage-coach NEXT] proceed to harness_start \u2192 generate.";
        }
        if (args.answer !== void 0 && args.answer !== null && state && state.phase === "asking" && state.currentIndex < state.questions.length) {
          const q2 = state.questions[state.currentIndex];
          state.answers.push({
            questionId: q2.id,
            questionText: q2.text,
            answer: String(args.answer),
            ts: (/* @__PURE__ */ new Date()).toISOString()
          });
          state.currentIndex++;
          writeInterview(sessionID, state);
          const maxQ = state.maxQuestions;
          if (state.currentIndex >= state.questions.length || state.answers.length >= maxQ) {
            return await completeInterview(state, sessionID, host.rt.session, resolveModel(), call.directory ?? host.rt.directory, call.signal);
          }
        }
        if (!state || state.phase === "complete") {
          if (!cfg.generator) return 'ERROR: no generator model configured. Set "generator" in harness.config.json (see harness.config.example.json).\n[usage-coach NEXT] proceed to harness_start \u2192 generate using best-effort assumptions.';
          const model = resolveModel();
          const userRequest = args.task;
          const mQ = DEFAULT_MAX_QUESTIONS;
          let graphNodes = [];
          try {
            const keywords = extractKeywords(args.task + " " + (args.context ?? ""));
            if (keywords.length) {
              const g = queryDomainGraph(keywords, 2);
              graphNodes = g.nodes || [];
            }
          } catch (e) {
            log(`reverse_interview domain query err: ${String(e)}`);
          }
          const domainSection = graphNodes.length ? `
Domain knowledge (from local graph DB \u2014 do NOT ask about things already known):
${graphNodes.slice(0, 20).map(
            (n) => `- [d${n.distance ?? 9}] ${n.name} (${n.type}): ${String(n.props?.result ?? JSON.stringify(n.props)).slice(0, 150)}`
          ).join("\n")}
` : "";
          const planningPrompt = `You are a senior architect conducting a reverse interview.
Analyze this task and identify the TOP ambiguities that, if left unresolved, would lead to the WRONG implementation.

Task: ${args.task}
User request: ${userRequest}
Additional context: ${args.context ?? "none"}${domainSection}

Rules:
1. Focus on questions whose answers CHANGE THE ARCHITECTURE or SCOPE.
   "What database?" is high-impact. "Variable naming?" is low-impact \u2014 exclude it.
2. Maximum ${mQ} questions.
3. Rank by design impact: critical > high > medium > low.
4. For each question, explain WHY it matters (the consequence of guessing wrong).
5. Categorize each: architecture | scope | constraint | preference | constraint-env | tradeoff.
6. For each question, name the core CONCEPT it targets (a single word/phrase).

Output JSON ONLY (no markdown fences, no prose):
{"questions":[{"text":"the question (concise, specific)","why":"what goes wrong if we guess","priority":"critical|high|medium|low","category":"architecture|scope|constraint|preference|constraint-env|tradeoff","optional":true,"concept":"single-word-concept"}]}
If the task is already well-specified with no significant ambiguities, return {"questions":[]}.`;
          const out = await runModel(host.rt.session, model, planningPrompt, call.directory ?? host.rt.directory, void 0, void 0, call.signal);
          if (out.startsWith("ERROR:") || out.startsWith("Task appears too large")) {
            return `Cannot generate interview questions: ${out}
[usage-coach NEXT] proceed to harness_start \u2192 generate using best-effort assumptions, or wait for quota reset and retry reverse_interview.`;
          }
          const parsed = parseInterviewQuestions(out, mQ, graphNodes);
          if (parsed.length === 0) {
            state = {
              id: `int_${Date.now().toString(36)}`,
              task: args.task,
              userRequest,
              startedAt: (/* @__PURE__ */ new Date()).toISOString(),
              updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
              questions: [],
              answers: [],
              currentIndex: 0,
              phase: "complete",
              maxQuestions: mQ,
              summary: "No significant ambiguities found. The task appears well-specified."
            };
            writeInterview(sessionID, state);
            return "No significant ambiguities found \u2014 the task appears well-specified.\n[usage-coach NEXT] proceed directly to harness_start \u2192 generate.";
          }
          state = {
            id: `int_${Date.now().toString(36)}`,
            task: args.task,
            userRequest,
            startedAt: (/* @__PURE__ */ new Date()).toISOString(),
            updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
            questions: parsed,
            answers: [],
            currentIndex: 0,
            phase: "asking",
            maxQuestions: mQ
          };
          writeInterview(sessionID, state);
        }
        const q = state.questions[state.currentIndex];
        const total = state.questions.length;
        const qNum = state.currentIndex + 1;
        return formatQuestionOutput(qNum, total, q);
      }
    },
    {
      name: TOOL_NAMES[14],
      description: TOOL_SCHEMAS.coach_config.description,
      schema: TOOL_SCHEMAS.coach_config.schema,
      async execute(args, call, host) {
        const dir = call.directory ?? host.rt.directory;
        const current = readHarnessCfg(dir);
        const hasUpdates = args.generator !== void 0 || args.grader !== void 0 || args.lighterModel !== void 0 || args.provider !== void 0 || args.maxSteps !== void 0 || args.domainMaxNodes !== void 0;
        if (!hasUpdates) {
          const envOverrides = [];
          if (process.env.UC_PROVIDER) envOverrides.push(`UC_PROVIDER=${process.env.UC_PROVIDER}`);
          if (process.env.UC_LIGHTER_MODEL) envOverrides.push(`UC_LIGHTER_MODEL=${process.env.UC_LIGHTER_MODEL}`);
          if (process.env.UC_MAX_STEPS) envOverrides.push(`UC_MAX_STEPS=${process.env.UC_MAX_STEPS}`);
          return [
            `Harness Configuration`,
            `\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`,
            `  generator:     ${current.generator ?? "(not set \u2014 harness won't work!)"}`,
            `  grader:        ${current.grader ?? "(defaults to generator)"}`,
            `  lighterModel:  ${current.lighterModel ?? "(not set \u2014 no THROTTLE fallback)"}`,
            `  provider:      ${current.provider ?? "(auto-detected from model)"}`,
            `  maxSteps:      ${current.maxSteps ?? 30}  (env: UC_MAX_STEPS)`,
            `\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`,
            envOverrides.length > 0 ? `
Environment overrides (take precedence):
  ${envOverrides.join("\n  ")}` : "",
            `
Config file: ~/.config/opencode-usage-coach/harness.config.json`,
            `
To update, call: coach_config({ generator: "provider/model-id", maxSteps: 15, ... })`
          ].filter(Boolean).join("\n");
        }
        const updates = {};
        if (args.generator !== void 0) updates.generator = args.generator.trim();
        if (args.grader !== void 0) updates.grader = args.grader.trim();
        if (args.lighterModel !== void 0) updates.lighterModel = args.lighterModel.trim();
        if (args.provider !== void 0) updates.provider = args.provider.trim();
        if (args.maxSteps !== void 0) updates.maxSteps = args.maxSteps;
        if (args.domainMaxNodes !== void 0) updates.domainMaxNodes = args.domainMaxNodes;
        const writtenPath = writeHarnessCfg(updates);
        const updated = readHarnessCfg(dir);
        return [
          `\u2705 Harness config updated successfully!`,
          `\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`,
          `  generator:     ${updated.generator ?? "(not set)"}`,
          `  grader:        ${updated.grader ?? "(defaults to generator)"}`,
          `  lighterModel:  ${updated.lighterModel ?? "(not set)"}`,
          `  provider:      ${updated.provider ?? "(auto-detected)"}`,
          `  maxSteps:      ${updated.maxSteps ?? 30}`,
          `  domainMaxNodes: ${updated.domainMaxNodes ?? "(default 12)"}`,
          `\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`,
          `
Saved to: ${writtenPath}`,
          `
Note: Changes take effect immediately for new generate/grade calls.`,
          `       A running harness will pick up the new config on the next tool call.`
        ].join("\n");
      }
    },
    {
      name: TOOL_NAMES[15],
      description: TOOL_SCHEMAS.coach_analyze.description,
      schema: TOOL_SCHEMAS.coach_analyze.schema,
      async execute(_args, call) {
        const a = analyzeInjection(call.sessionID);
        const lines = [
          "\u2550\u2550\u2550 Knowledge Injection Effectiveness \u2550\u2550\u2550",
          `Total graded tasks: ${a.total} (PASS: ${a.passed}, FAIL: ${a.failed})`,
          "",
          `With injection:    ${a.withInjection.total} tasks \u2192 ${a.withInjection.passRate}% PASS`,
          `Without injection: ${a.withoutInjection.total} tasks \u2192 ${a.withoutInjection.passRate}% PASS`,
          "",
          "By category (PASS rate when injected):"
        ];
        for (const [cat, d] of Object.entries(a.byCategory)) {
          const rate = d.total > 0 ? Math.round(d.passed * 100 / d.total) : 0;
          lines.push(`  ${cat}: ${d.passed}/${d.total} = ${rate}%`);
        }
        const delta = a.withInjection.passRate - a.withoutInjection.passRate;
        if (a.withInjection.total > 0 && a.withoutInjection.total > 0) {
          lines.push("");
          lines.push(delta > 0 ? `\u2192 Injection helps: +${delta}% PASS rate with knowledge injection.` : delta < 0 ? `\u2192 Injection HURTS: ${delta}% PASS rate. Injected knowledge may be noise.` : `\u2192 No measurable difference (${delta}%).`);
        } else {
          lines.push("", "\u2192 Need more data (both groups need 5+ tasks).");
        }
        return lines.join("\n");
      }
    }
  ];
  if (defs.length !== TOOL_NAMES.length || defs.some((d, i) => d.name !== TOOL_NAMES[i])) {
    throw new Error(`tool-defs: buildToolDefs() out of sync with TOOL_NAMES`);
  }
  return defs;
}

// src/quota.ts
import { spawn } from "child_process";
var TTL_MS = Number(process.env.UC_TTL_MS ?? 6e4);
var num = (e, d) => {
  try {
    const v = Number(process.env[e]);
    return Number.isFinite(v) && v >= 0 ? v : d;
  } catch {
    return d;
  }
};
var STOP_5H = num("UC_STOP_5H", 92);
var THR_5H = num("UC_THROTTLE_5H", 70);
var STOP_WK = num("UC_STOP_WEEKLY", 95);
var THR_WK = num("UC_THROTTLE_WEEKLY", 85);
var STOP_MO = num("UC_STOP_MONTHLY", 98);
function humanRemaining(iso) {
  try {
    if (!iso) return "";
    const ms = new Date(iso).getTime();
    if (Number.isNaN(ms)) return "";
    const mins = Math.floor((ms - Date.now()) / 6e4);
    if (mins < 0) return "resets soon";
    if (mins < 60) return `resets in ${mins}m`;
    if (mins < 1440) return `resets in ${Math.floor(mins / 60)}h ${mins % 60}m`;
    return `${Math.floor(mins / 1440)}d left`;
  } catch {
    return "";
  }
}
var codexbarMissing = false;
function isCodexbarMissing() {
  return codexbarMissing;
}
function __resetCodexbarMissing() {
  codexbarMissing = false;
}
function captureStdout(args) {
  return new Promise((resolve3) => {
    let out = "";
    let p;
    try {
      p = spawn("codexbar", args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return resolve3("");
    }
    p.stdout?.on("data", (d) => {
      out += d.toString();
    });
    p.on("error", (err) => {
      if (err.code === "ENOENT") codexbarMissing = true;
      resolve3("");
    });
    p.on("close", () => resolve3(out));
  });
}
async function fetchEnabledProviders() {
  if (codexbarMissing) return [];
  const out = await captureStdout(["config", "providers"]);
  const ids = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*([a-zA-Z0-9_-]+):\s*enabled/);
    if (m) ids.push(m[1]);
  }
  return ids;
}
function providerAdvice(h5, wk) {
  const S5H = STOP_5H, SWK = STOP_WK, T5H = THR_5H, TWK = THR_WK;
  if (h5 !== null && h5 >= S5H || wk !== null && wk >= SWK) return "STOP \u2014 finish current only";
  if (h5 !== null && wk !== null && h5 >= T5H && wk >= TWK) return "small tasks only \u2014 big ones will hit both limits";
  if (h5 !== null && h5 >= T5H) return "small tasks only \u2014 5h window nearly full, big tasks after reset";
  if (wk !== null && wk >= TWK) return "small tasks only \u2014 big ones will strain late-week";
  if (h5 !== null && h5 >= 50 || wk !== null && wk >= 50) return "moderate tasks OK \u2014 save big ones for headroom";
  return "big tasks OK \u2014 short & long limits comfortable";
}
async function fetchProvidersCoach() {
  const ids = await fetchEnabledProviders();
  const results = await Promise.all(ids.map(async (id) => {
    try {
      const out = await captureStdout(["usage", "--provider", id, "--json"]);
      const q = parseQuotaResponse(out);
      if (!q) return null;
      const h5 = q.fiveHour ? Math.round(q.fiveHour.usedPercent ?? 0) : null;
      const wk = q.weekly ? Math.round(q.weekly.usedPercent ?? 0) : null;
      return {
        id,
        name: id,
        fiveHour: h5 ?? -1,
        weekly: wk ?? -1,
        fiveHourReset: q.fiveHour ? humanRemaining(q.fiveHour.resetsAt) : "",
        weeklyReset: q.weekly ? humanRemaining(q.weekly.resetsAt) : "",
        advice: providerAdvice(h5, wk)
      };
    } catch {
      return null;
    }
  }));
  return results.filter(Boolean);
}
function parseQuotaResponse(rawText) {
  try {
    const text = (rawText || "").trim();
    if (!text || text === "[]") return null;
    const u = JSON.parse(text)[0]?.usage;
    if (!u) return null;
    const result = { weekly: null, monthly: null, fiveHour: null };
    const entries = [
      { key: "primary", slot: u.primary },
      { key: "secondary", slot: u.secondary },
      { key: "tertiary", slot: u.tertiary }
    ].filter((e) => e.slot != null);
    for (const { key, slot } of entries) {
      const mins = slot.windowMinutes ?? 0;
      const desc = String(slot.resetDescription ?? "").toLowerCase();
      if (mins === 300 || desc.includes("5 hour") || desc.includes("5h")) {
        result.fiveHour = slot;
      } else if (mins === 10080 || desc.includes("week")) {
        result.weekly = slot;
      } else if (desc.includes("month")) {
        result.monthly = slot;
      } else if (mins > 0 && mins <= 360) {
        result.fiveHour = slot;
      } else if (mins > 360 && mins <= 14400) {
        result.weekly = slot;
      } else if (mins > 14400) {
        result.monthly = slot;
      } else if (key === "primary") {
        result.weekly = slot;
      } else if (key === "secondary") {
        result.monthly = slot;
      } else if (key === "tertiary") {
        result.fiveHour = slot;
      }
    }
    return result;
  } catch {
    return null;
  }
}
function fetchQuota(provider) {
  return new Promise((resolve3) => {
    let out = "";
    let p;
    try {
      const args = provider ? ["usage", "--provider", provider, "--json"] : ["usage", "--json"];
      p = spawn("codexbar", args, {
        stdio: ["ignore", "pipe", "ignore"]
      });
    } catch {
      return resolve3(null);
    }
    p.stdout?.on("data", (d) => {
      out += d.toString();
    });
    p.on("error", (err) => {
      if (err.code === "ENOENT") codexbarMissing = true;
      resolve3(null);
    });
    p.on("close", () => {
      resolve3(parseQuotaResponse(out));
    });
  });
}
async function fetchQuotaWithRetry(provider, maxRetries = 3) {
  if (codexbarMissing) return null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const q = await fetchQuota(provider);
    if (q) return q;
    if (attempt < maxRetries - 1) {
      await new Promise((r) => setTimeout(r, 1e3 * (attempt + 1)));
    }
  }
  return null;
}
function coach(q, lighter) {
  if (!q) return { decision: "GO", advice: "quota unavailable \u2014 retrying. proceeding cautiously.", weekly: -2, monthly: -2, fiveHour: -2 };
  const wk = q.weekly ? Math.round(q.weekly.usedPercent ?? 0) : null;
  const mo = q.monthly ? Math.round(q.monthly.usedPercent ?? 0) : null;
  const h5 = q.fiveHour ? Math.round(q.fiveHour.usedPercent ?? 0) : null;
  if (wk !== null && Number.isNaN(wk) || mo !== null && Number.isNaN(mo) || h5 !== null && Number.isNaN(h5)) {
    const sWk = wk !== null && !Number.isNaN(wk) ? wk : 0;
    const sMo = mo !== null && !Number.isNaN(mo) ? mo : 0;
    const sH5 = h5 !== null && !Number.isNaN(h5) ? h5 : 0;
    return { decision: "THROTTLE", advice: "invalid quota data \u2014 proceeding with caution. switch to lighter model if available.", weekly: sWk, monthly: sMo, fiveHour: sH5 };
  }
  const wkR = q.weekly ? humanRemaining(q.weekly.resetsAt) : "";
  const h5R = q.fiveHour ? humanRemaining(q.fiveHour.resetsAt) : "";
  const stop = (r) => ({ decision: "STOP", advice: `STOP recommend \u2014 ${r}. window nearly exhausted. stop now or it will be force-blocked.`, weekly: wk ?? -1, monthly: mo ?? -1, fiveHour: h5 ?? -1 });
  const thr = (r) => ({ decision: "THROTTLE", advice: `Throttle recommend \u2014 ${r}. switch to lighter model (${lighter}) or wait for window reset.`, weekly: wk ?? -1, monthly: mo ?? -1, fiveHour: h5 ?? -1 });
  if (h5 !== null && h5 >= STOP_5H) return stop(`5h window ${h5}% (${h5R})`);
  if (wk !== null && wk >= STOP_WK) return stop(`weekly ${wk}% (${wkR})`);
  if (mo !== null && mo >= STOP_MO) return stop(`monthly ${mo}%`);
  if (h5 !== null && h5 >= THR_5H) return thr(`5h window ${h5}% (${h5R})`);
  if (wk !== null && wk >= THR_WK) return thr(`weekly ${wk}% (${wkR})`);
  const parts = [];
  if (wk !== null) parts.push(`weekly ${wk}%`);
  if (h5 !== null) parts.push(`5h ${h5}%`);
  if (mo !== null) parts.push(`monthly ${mo}%`);
  const summary = parts.length > 0 ? parts.join(" \xB7 ") : "no quota limits detected";
  const resetInfo = h5R ? ` 5h window ${h5R}.` : wkR ? ` weekly ${wkR}.` : "";
  return { decision: "GO", advice: `Comfortable \u2014 ${summary}. proceed.${resetInfo}`, weekly: wk ?? -1, monthly: mo ?? -1, fiveHour: h5 ?? -1 };
}
function isFreeModel(model, provider) {
  if (!model && !provider) return false;
  if (provider === "opencode") return true;
  if (model.toLowerCase().includes("free")) return true;
  return false;
}
function providerToCodexbar(provider) {
  if (!provider) return "";
  const first = provider.split("-")[0];
  return first || provider;
}
var LOADING = { decision: "GO", advice: "quota loading\u2026", weekly: -1, monthly: -1, fiveHour: -1 };
function createQuotaMachine(opts) {
  const PROVIDER = opts.provider ?? "";
  const LIGHTER = opts.lighter ?? "a lighter model";
  const agentOf = opts.getAgent ?? (() => "");
  const doFetch = opts.fetchQuota ?? ((provider) => fetchQuotaWithRetry(provider));
  const persist = opts.stateWriter ?? ((c) => writeState(c));
  const injected = !!opts.fetchQuota;
  let last = null;
  let lastKnownQuota = null;
  let lastFetchedAt = 0;
  let refreshing = false;
  let currentModel = "";
  let currentProvider = "";
  let modelChanged = false;
  const refreshBackground = () => {
    try {
      if (refreshing) return;
      if (codexbarMissing && !injected) {
        last = { decision: "GO", advice: "codexbar not installed \u2014 running in GO-only mode (no quota sensing).", weekly: -3, monthly: -3, fiveHour: -3 };
        lastFetchedAt = Date.now();
        refreshing = false;
        return;
      }
      if (last && !modelChanged && Date.now() - lastFetchedAt < TTL_MS) return;
      refreshing = true;
      modelChanged = false;
      if (isFreeModel(currentModel, currentProvider)) {
        last = { decision: "GO", advice: `${currentModel || currentProvider || "free model"} \u2014 no quota limit.`, weekly: -1, monthly: -1, fiveHour: -1, model: currentModel, provider: currentProvider, isFree: true };
        lastFetchedAt = Date.now();
        persist({ ...last, providers: [], model: currentModel, provider: currentProvider, isFree: true, agent: agentOf(), updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
        log(`FREE | model=${currentModel} provider=${currentProvider}`);
        refreshing = false;
        return;
      }
      const activeProvider = providerToCodexbar(currentProvider) || PROVIDER;
      doFetch(activeProvider).then(async (q) => {
        try {
          if (q) lastKnownQuota = q;
          const effectiveQ = q ?? lastKnownQuota;
          last = coach(effectiveQ, LIGHTER);
          lastFetchedAt = Date.now();
          let providers = [];
          if (!injected) {
            try {
              providers = await fetchProvidersCoach();
            } catch {
            }
          }
          if (providers.length > 0 && last.weekly < 0 && last.fiveHour < 0) {
            const p0 = providers[0];
            const newWeekly = p0.weekly >= 0 ? p0.weekly : last.weekly;
            const newFiveHour = p0.fiveHour >= 0 ? p0.fiveHour : last.fiveHour;
            const newDecision = newWeekly >= STOP_WK || newFiveHour >= STOP_5H ? "STOP" : newWeekly >= THR_WK || newFiveHour >= THR_5H ? "THROTTLE" : "GO";
            last = { ...last, weekly: newWeekly, fiveHour: newFiveHour, advice: p0.advice, decision: newDecision };
          }
          persist({ ...last, providers, model: currentModel, provider: currentProvider, isFree: false, agent: agentOf(), updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
          log(`${last.decision} | weekly=${last.weekly}% 5h=${last.fiveHour}% | providers=${providers.length}`);
        } catch (e) {
          log(`refresh-in-then err: ${String(e)}`);
        }
      }).catch((e) => {
        log(`fetchQuotaWithRetry err: ${String(e)}`);
      }).finally(() => {
        refreshing = false;
      });
    } catch (e) {
      log(`refreshBackground err: ${String(e)}`);
    }
  };
  const current = () => {
    try {
      if (!last) refreshBackground();
      return last ?? LOADING;
    } catch {
      return LOADING;
    }
  };
  const setModel = (model, provider) => {
    if (currentModel && model && currentModel !== model) {
      log(`MODEL CHANGED: ${currentModel} \u2192 ${model} (provider: ${currentProvider} \u2192 ${provider})`);
      modelChanged = true;
    }
    currentModel = model;
    currentProvider = provider;
  };
  return {
    current,
    refresh: refreshBackground,
    setModel,
    markModelChanged() {
      modelChanged = true;
    }
  };
}

// src/v2.ts
import { Plugin } from "@opencode/plugin";

// src/v2-session.ts
function extractText(m) {
  return String(m?.text ?? m?.info?.text ?? m?.content ?? m?.info?.content ?? m?.data?.text ?? "");
}
function makeV2SessionOps(ctx) {
  return {
    async create(directory, title) {
      const s = await ctx.session.create({ title });
      const id = s?.id ?? s?.data?.id;
      if (!id) throw new Error(`session.create returned no id (response: ${JSON.stringify(s?.data ?? s).slice(0, 200)})`);
      return id;
    },
    async prompt(id, providerID, modelID, text) {
      await ctx.session.switchModel({ sessionID: id, model: { providerID, id: modelID } });
      await ctx.session.prompt({ sessionID: id, text });
      await ctx.session.wait({ sessionID: id });
      const msgs = await ctx.session.context({ sessionID: id });
      const list = Array.isArray(msgs) ? msgs.slice() : Array.isArray(msgs?.data) ? msgs.data.slice() : [];
      for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        const role = m?.role ?? m?.info?.role;
        if (role !== "assistant") continue;
        const parts = m?.parts ?? m?.info?.parts;
        if (Array.isArray(parts)) return { data: { parts } };
        return { data: { parts: [{ type: "text", text: extractText(m) }] } };
      }
      return { data: { parts: [] } };
    },
    async messages(id) {
      const msgs = await ctx.session.context({ sessionID: id });
      if (Array.isArray(msgs)) return msgs.slice();
      if (Array.isArray(msgs?.data)) return msgs.data.slice();
      return [];
    },
    async abort(id) {
      try {
        await ctx.session.interrupt({ sessionID: id, continue: false });
      } catch {
      }
    },
    async delete(id) {
      try {
        await ctx.session.remove({ sessionID: id });
      } catch {
      }
    },
    async get(id) {
      const s = await ctx.session.get({ sessionID: id });
      return s?.data ?? s ?? null;
    },
    // `summarize` is intentionally omitted — not in the V2 session domain.
    async generateText(model, prompt) {
      const slash = model.indexOf("/");
      const providerID = slash >= 0 ? model.slice(0, slash) : model;
      const id = slash >= 0 ? model.slice(slash + 1) : "";
      const r = await ctx.generate.text({ model: { providerID, id }, prompt });
      return r?.text ?? r?.data?.text ?? "";
    }
  };
}

// src/v2.ts
var HARNESS_TOOLS = ["unknown_scan", "question", "generate", "generate_batch", "grade", "grade_batch", "investigate", "verify_diagnosis", "generalize", "harness_start", "task_update", "harness_done", "record_failure", "reverse_interview"];
async function v2Setup(ctx, injected) {
  setStateDir(ctx.location.directory);
  initDomain(STATE_DIR);
  const cfg0 = readHarnessCfg(ctx.location.directory);
  if (cfg0.domainAutoLink !== void 0) process.env.UC_AUTOLINK = cfg0.domainAutoLink ? "1" : "0";
  const rt = { directory: ctx.location.directory, session: makeV2SessionOps(ctx) };
  let currentAgent2 = "";
  const quota = injected?.quota ?? createQuotaMachine({
    directory: rt.directory,
    provider: process.env.UC_PROVIDER ?? cfg0.provider ?? "",
    lighter: process.env.UC_LIGHTER_MODEL ?? cfg0.lighterModel ?? "a lighter model",
    getAgent: () => currentAgent2
  });
  const host = { rt, current: quota.current, refresh: quota.refresh };
  await ctx.tool.transform((editor) => {
    for (const def of buildToolDefs()) {
      editor.add({
        name: def.name,
        description: def.description,
        input: def.schema,
        execute: async (input, context) => ({
          content: await def.execute(input, { sessionID: context?.sessionID, directory: rt.directory, signal: context?.signal }, host)
        })
      });
    }
  });
  await ctx.tool.hook("execute.before", async (event) => {
    const sessionID = event?.sessionID ?? event.sessionID;
    const info = await resolveAgent(rt.session, sessionID);
    currentAgent2 = info.agent;
    quota.setModel(info.model, info.provider);
    quota.refresh();
    if (!HARNESS_TOOLS.includes(event?.tool)) return;
    if (!isHarnessAgent(info.agent)) {
      throw new Error(`[${PLUGIN_NAME}] '${event.tool}' is restricted to agent mode ${JSON.stringify(HARNESS_AGENTS)} (current: ${JSON.stringify(info.agent || "unknown")}). Switch to that agent mode to use it.`);
    }
    let decision;
    try {
      decision = quota.current().decision;
    } catch {
      decision = "GO";
    }
    if (decision === "STOP") {
      throw new Error(`[${PLUGIN_NAME}] blocked: quota limit exceeded. ${quota.current().advice}`);
    }
  });
  const sessionCoaching = async (event) => {
    try {
      const sessionID = event?.sessionID;
      if (sessionID) {
        const info = await resolveAgent(rt.session, sessionID);
        quota.setModel(info.model, info.provider);
        quota.refresh();
        if (!isHarnessAgent(info.agent)) return;
      }
      const c = quota.current();
      let instruction = "";
      if (c.decision === "STOP") instruction = `[${PLUGIN_NAME}] QUOTA limit exceeded. ${c.advice} Stop making further tool calls, finish the in-progress work, then report the quota status to the user.`;
      else if (c.decision === "THROTTLE") instruction = `[${PLUGIN_NAME}] ${c.advice} Hold off on long/heavy tasks.`;
      else if (c.weekly >= 0 || c.fiveHour >= 0) {
        const parts = [];
        if (c.weekly >= 0) parts.push(`weekly ${c.weekly}%`);
        if (c.fiveHour >= 0) parts.push(`5h ${c.fiveHour}%`);
        if (c.monthly >= 0) parts.push(`monthly ${c.monthly}%`);
        instruction = `[${PLUGIN_NAME}] quota ok \u2014 ${parts.join(" \xB7 ")}.`;
      }
      if (instruction) event.system.push({ type: "text", text: instruction });
    } catch (e) {
      log(`system.transform err: ${String(e)}`);
    }
  };
  await ctx.session.hook("context", sessionCoaching);
  await ctx.session.hook("compaction", sessionCoaching);
  await ctx.session.hook("title", sessionCoaching);
  const controller = new AbortController();
  void (async () => {
    try {
      const stream = await ctx.event.subscribe({ signal: controller.signal });
      for await (const ev of stream) {
        try {
          const type = ev?.type;
          if (type === "session.created" || type === "session.idle") quota.refresh();
          if (type === "session.idle") {
            try {
              const r = evictStale(WORM_MAX_AGE_DAYS, WORM_MAX_NODES);
              if (r.removed) log(`evictStale: removed ${r.removed}, kept ${r.kept} (maxAge=${WORM_MAX_AGE_DAYS}d, maxNodes=${WORM_MAX_NODES})`);
            } catch (e) {
              log(`evictStale err: ${String(e)}`);
            }
            try {
              const sh = evictSharedStale(SHARED_WORM_MAX_AGE_DAYS, SHARED_WORM_MAX_NODES);
              if (sh.removed) log(`evictSharedStale: removed ${sh.removed}, kept ${sh.kept} (maxAge=${SHARED_WORM_MAX_AGE_DAYS}d, maxNodes=${SHARED_WORM_MAX_NODES})`);
            } catch (e) {
              log(`evictSharedStale err: ${String(e)}`);
            }
            try {
              const s = sweepDeadEdges();
              log(`sweepDeadEdges: removed ${s.removed}, kept ${s.kept}`);
            } catch (e) {
              log(`sweepDeadEdges err: ${String(e)}`);
            }
          }
        } catch (e) {
          log(`event err: ${String(e)}`);
        }
      }
    } catch {
    }
  })();
  quota.refresh();
  return () => controller.abort();
}
var V2Plugin = Plugin.define({
  id: "opencode-usage-coach",
  setup: v2Setup
});

// src/index.ts
var PLUGIN_NAME = "opencode-usage-coach";
var DEFAULT_MAX_STEPS = Number(process.env.UC_MAX_STEPS ?? 30) || 30;
function resolveMaxSteps(cfg, explicit) {
  return explicit ?? cfg.maxSteps ?? DEFAULT_MAX_STEPS;
}
function normalizeFilePath(p) {
  return p.trim().replace(/^(\.\/)+/, "").toLowerCase();
}
function resolveBatchLimit(tasks, decision) {
  if (tasks.length === 0) return 0;
  const seen = /* @__PURE__ */ new Set();
  for (const t of tasks) {
    const files = new Set((t.files ?? []).map(normalizeFilePath).filter(Boolean));
    for (const f of files) if (seen.has(f)) return 1;
    for (const f of files) seen.add(f);
  }
  return decision === "THROTTLE" ? 2 : tasks.length;
}
var WATCHDOG_POLL_MS = Math.max(1e3, Number(process.env.UC_WATCHDOG_POLL_MS ?? 3e3) || 3e3);
var WALL_TIMEOUT_MS = Math.max(1, Number(process.env.UC_WALL_TIMEOUT_MIN ?? 30) || 30) * 60 * 1e3;
var STALL_MS = Math.max(0, Number(process.env.UC_STALL_MIN ?? 12) || 0) * 60 * 1e3;
var DEFAULT_MAX_QUESTIONS = Math.max(1, Math.round(Number(process.env.UC_MAX_QUESTIONS ?? 7)) || 7);
var PIPE_LOG = join4(homedir2(), ".cache", "opencode-usage-coach", "pipeline.log");
function pipeLog(msg) {
  try {
    mkdirSync4(dirname2(PIPE_LOG), { recursive: true });
    appendFileSync4(PIPE_LOG, `[SERVER] ${(/* @__PURE__ */ new Date()).toISOString()} ${msg}
`);
  } catch {
  }
}
pipeLog(`MODULE LOADED | node=${process.version} | pid=${process.pid}`);
var STATE_DIR = join4(homedir2(), ".cache", "opencode-usage-coach");
var STATE_FILE = join4(STATE_DIR, "state.json");
var LOG_FILE = join4(STATE_DIR, "coach.log");
function projectStateDir(dir) {
  const abs = resolve2(dir || ".");
  const h = createHash("sha1").update(abs).digest("hex").slice(0, 12);
  return join4(homedir2(), ".cache", "opencode-usage-coach", "projects", h);
}
function setStateDir(dir) {
  STATE_DIR = process.env.UC_STATE_DIR ?? projectStateDir(dir);
  STATE_FILE = join4(STATE_DIR, "state.json");
  LOG_FILE = join4(STATE_DIR, "coach.log");
}
var NOOP_HOOKS = {};
function log(msg) {
  try {
    appendFileSync4(LOG_FILE, `${(/* @__PURE__ */ new Date()).toISOString()} ${msg}
`);
  } catch {
  }
}
function writeState(c) {
  try {
    mkdirSync4(STATE_DIR, { recursive: true });
    writeFileSync2(STATE_FILE, JSON.stringify({ ...c, updatedAt: (/* @__PURE__ */ new Date()).toISOString() }));
  } catch {
  }
}
function rulesFile() {
  return join4(STATE_DIR, "rules.md");
}
function failuresFile() {
  return join4(STATE_DIR, "failures.ndjson");
}
function readRules() {
  try {
    const f = rulesFile();
    if (!existsSync3(f)) return "";
    return readFileSync3(f, "utf8").trim();
  } catch {
    return "";
  }
}
function implNotesFile() {
  return join4(STATE_DIR, "impl-notes.md");
}
var IMPL_NOTE_INSTRUCTION = `
## Implementation Notes (important!)
During this task, if you:
  - Made a decision that differed from the obvious/expected approach
  - Discovered a constraint, limitation, or surprising behavior in the codebase/API
  - Found something that was different from what the prompt implied
Then append a block at the END of your response in this exact format:

<impl-notes>
- **Decision**: <what you chose and why it wasn't obvious>
- **Constraint**: <limitation/surprise you discovered>
- **Unexpected**: <how reality differed from the prompt's assumption>
</impl-notes>

If nothing notable happened, omit the block entirely. Do not fabricate notes.
`;
function readImplNotes(limit = 5) {
  try {
    const f = implNotesFile();
    if (!existsSync3(f)) return "";
    const content = readFileSync3(f, "utf8").trim();
    if (!content) return "";
    const notes = content.split(/^## Note /m).filter(Boolean);
    const recent = notes.slice(-limit);
    return recent.map((n) => `## Note ${n.trim()}`).join("\n\n");
  } catch {
    return "";
  }
}
function extractImplNotes(output) {
  const match = output.match(/<impl-notes>([\s\S]*?)<\/impl-notes>/i);
  if (!match) return { notes: "", cleanText: output };
  const notes = match[1].trim();
  const cleanText = output.replace(/<impl-notes>[\s\S]*?<\/impl-notes>\s*/i, "").trim();
  return { notes, cleanText };
}
function appendImplNotes(notes, taskSummary) {
  try {
    const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    const shortTask = taskSummary.slice(0, 80).replace(/\n/g, " ");
    const entry = `## Note (${date}, task: "${shortTask}")
${notes}
Source: generate task "${shortTask}"

`;
    mkdirSync4(STATE_DIR, { recursive: true });
    appendFileSync4(implNotesFile(), entry);
  } catch (e) {
    log(`appendImplNotes err: ${String(e)}`);
  }
}
function linkImplNoteToDomain(noteNodeId, noteText, maxEdges = 3) {
  try {
    const words = new Set(
      noteText.toLowerCase().replace(/[^a-z0-9가-힣\s-]/g, " ").split(/\s+/).filter((w) => w.length >= 3)
    );
    if (words.size === 0) return 0;
    const existing = readNodes().filter((n) => n.id !== noteNodeId);
    const scored = existing.map((n) => {
      const hay = (n.name + " " + JSON.stringify(n.props)).toLowerCase();
      let hits = 0;
      for (const w of words) if (hay.includes(w)) hits++;
      return { node: n, hits };
    }).filter((s) => s.hits > 0).sort((a, b) => b.hits - a.hits).slice(0, maxEdges);
    const edgeKey = new Set(readEdges().map((e) => `${e.from}|${e.to}|${e.rel}`));
    let added = 0;
    for (const { node } of scored) {
      const k1 = `${noteNodeId}|${node.id}|related-to`;
      const k2 = `${node.id}|${noteNodeId}|related-to`;
      if (edgeKey.has(k1) || edgeKey.has(k2)) continue;
      addDomainEdge({ from: noteNodeId, to: node.id, rel: "related-to", note: "impl-note auto-link" });
      edgeKey.add(k1);
      added++;
    }
    return added;
  } catch {
    return 0;
  }
}
function readImplNotesByGraph(keywords, limit = 5) {
  try {
    if (!keywords.length) return readImplNotes(limit);
    const { nodes: neighborhood } = queryDomainGraph(keywords, 2);
    if (neighborhood.length === 0) return readImplNotes(limit);
    const noteTexts = neighborhood.filter((n) => n.source === "impl-note" || n.source === "generate").map((n) => String(n.props?.result ?? ""));
    if (noteTexts.length === 0) return readImplNotes(limit);
    const f = implNotesFile();
    const fileContent = existsSync3(f) ? readFileSync3(f, "utf8") : "";
    if (!fileContent.trim()) return readImplNotes(limit);
    const entries = fileContent.split(/^## Note /m).filter(Boolean);
    const matched = entries.filter((e) => noteTexts.some((t) => t && e.includes(t.slice(0, 60)))).slice(0, limit);
    if (matched.length === 0) return readImplNotes(limit);
    return matched.map((e) => `## Note ${e.trim()}`).join("\n\n");
  } catch {
    return readImplNotes(limit);
  }
}
function extractKeywords(text) {
  try {
    const STOP = /* @__PURE__ */ new Set([
      // articles / prepositions / conjunctions
      "the",
      "and",
      "for",
      "with",
      "that",
      "this",
      "from",
      "into",
      "your",
      "you",
      "are",
      "was",
      "but",
      "not",
      "all",
      "any",
      "use",
      "task",
      "prompt",
      // generic verbs
      "apply",
      "add",
      "make",
      "set",
      "get",
      "run",
      "try",
      "put",
      "let",
      "new",
      "will",
      "can",
      "has",
      "had",
      "have",
      "been",
      "were",
      "they",
      "them",
      "when",
      "then",
      "than",
      "also",
      "just",
      "like",
      "what",
      "which",
      "how",
      "should",
      "would",
      "could",
      "must",
      "does",
      "doing",
      "done",
      "via",
      // generic nouns / adjectives
      "some",
      "more",
      "most",
      "such",
      "each",
      "other",
      "very",
      "much",
      "here",
      "there",
      "where",
      "while",
      "about",
      "after",
      "before",
      "main",
      "call",
      "file",
      "code",
      "data",
      "line",
      "name",
      "type",
      "true",
      "false",
      "null",
      "void",
      "return",
      "function",
      "const",
      "note",
      "notes",
      "result",
      "output",
      "input",
      "detail",
      "reason",
      "reasons",
      "improve",
      "fix",
      "fixed",
      "error",
      "issue",
      "thing",
      "things",
      "stuff",
      "case",
      "cases",
      "way",
      "ways",
      "first",
      "second",
      "third",
      "last",
      "next",
      "prev",
      "previous",
      "following",
      "above",
      "below",
      "since",
      "until",
      "without"
    ]);
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    const clean = (text ?? "").replace(/\b[\w.-]+(?:\/[\w.-]+)+\b/g, " ");
    for (const raw of clean.toLowerCase().split(/[^a-z0-9_-]+/)) {
      const t = raw.trim();
      if (t.length < 3 || STOP.has(t) || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= 8) break;
    }
    return out;
  } catch {
    return [];
  }
}
function harnessFile(sessionID) {
  return join4(STATE_DIR, sessionID || "_default", "harness.json");
}
function readHarness(sessionID) {
  try {
    const f = harnessFile(sessionID);
    if (!existsSync3(f)) return null;
    return JSON.parse(readFileSync3(f, "utf8"));
  } catch {
    return null;
  }
}
function writeHarness(sessionID, h) {
  try {
    const f = harnessFile(sessionID);
    mkdirSync4(dirname2(f), { recursive: true });
    h.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    writeFileSync2(f, JSON.stringify(h, null, 2));
  } catch {
  }
}
var harnessQueue = /* @__PURE__ */ new Map();
function mutateHarness(sessionID, fn) {
  const prev = harnessQueue.get(sessionID) ?? Promise.resolve();
  const next = prev.then(() => {
    const h = readHarness(sessionID);
    if (!h) return;
    const result = fn(h);
    writeHarness(sessionID, result ?? h);
  }).catch(() => {
  });
  harnessQueue.set(sessionID, next);
  next.finally(() => {
    if (harnessQueue.get(sessionID) === next) harnessQueue.delete(sessionID);
  });
  return next;
}
function interviewFile(sessionID) {
  return join4(STATE_DIR, sessionID || "_default", "interview.json");
}
function readInterview(sessionID) {
  try {
    const f = interviewFile(sessionID);
    if (!existsSync3(f)) return null;
    return JSON.parse(readFileSync3(f, "utf8"));
  } catch {
    return null;
  }
}
function writeInterview(sessionID, s) {
  try {
    const f = interviewFile(sessionID);
    mkdirSync4(dirname2(f), { recursive: true });
    s.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    writeFileSync2(f, JSON.stringify(s, null, 2));
  } catch {
  }
}
var PRIORITY_WEIGHT = { critical: 0, high: 1, medium: 2, low: 3 };
var CATEGORY_WEIGHT = { architecture: 0, scope: 1, constraint: 2, tradeoff: 3, preference: 4, "constraint-env": 5 };
function resolveGraphDistance(concept, graphNodes) {
  if (!concept) return 9;
  const lc = concept.toLowerCase().trim();
  if (!lc) return 9;
  for (const n of graphNodes) {
    if ((n.name ?? "").toLowerCase() === lc) return n.distance ?? 9;
  }
  for (const n of graphNodes) {
    const nm = (n.name ?? "").toLowerCase();
    if (nm.includes(lc) || lc.includes(nm)) return n.distance ?? 9;
  }
  return 9;
}
function parseInterviewQuestions(raw, maxQ, graphNodes) {
  try {
    let s = raw.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first >= 0 && last > first) s = s.slice(first, last + 1);
    const p = JSON.parse(s);
    const arr = Array.isArray(p.questions) ? p.questions : [];
    const qs = arr.map((q) => ({
      id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      text: String(q.text || ""),
      why: String(q.why || ""),
      priority: ["critical", "high", "medium", "low"].includes(String(q.priority)) ? String(q.priority) : "medium",
      category: String(q.category || "scope"),
      optional: Boolean(q.optional),
      concept: q.concept ? String(q.concept) : void 0
    })).filter((q) => q.text);
    qs.sort((a, b) => {
      const ka = (PRIORITY_WEIGHT[a.priority] ?? 3) * 100 + resolveGraphDistance(a.concept, graphNodes) * 10 + (CATEGORY_WEIGHT[a.category] ?? 5);
      const kb = (PRIORITY_WEIGHT[b.priority] ?? 3) * 100 + resolveGraphDistance(b.concept, graphNodes) * 10 + (CATEGORY_WEIGHT[b.category] ?? 5);
      return ka - kb;
    });
    return qs.slice(0, maxQ);
  } catch {
    return [];
  }
}
function formatQuestionOutput(qNum, total, q) {
  return `Interview Q${qNum}/${total} [${q.priority}]: ${q.text}
` + (q.why ? `  Why it matters: ${q.why}
` : "") + `
[usage-coach NEXT] Present Q${qNum}/${total} to the user VERBATIM (copy the question text above). Do NOT answer it yourself \u2014 you are interviewing the USER, not guessing. End your turn after presenting the question. When the user responds, call reverse_interview({task: "...", answer: "<their response>"}) to record the answer and get the next question.`;
}
function formatCompleteOutput(state) {
  const n = state.answers.length;
  const lines = [`Interview complete (${n} question${n === 1 ? "" : "s"} answered).`, "", "Resolved constraints:"];
  if (state.answers.length) {
    state.answers.forEach((a, i) => lines.push(`${i + 1}. ${a.questionText}: ${a.answer}`));
  } else {
    lines.push("(no questions were asked)");
  }
  lines.push("");
  lines.push("[usage-coach NEXT] Interview complete. The resolved constraints above MUST be injected into every generate prompt. Call harness_start(name, N) now, then for each task call generate with the constraints prepended to the prompt.");
  return lines.join("\n");
}
async function completeInterview(state, sessionID, session, model, directory, signal) {
  if (state.phase === "complete") return formatCompleteOutput(state);
  const pairs = state.answers.map((a, i) => `Q${i + 1}: ${a.questionText}
A: ${a.answer}`).join("\n\n");
  let summary = "";
  const constraints = {};
  if (model) {
    const sumPrompt = `Summarize this reverse interview as actionable constraints for implementation.

Q&A pairs:
${pairs || "(none)"}

Output JSON ONLY (no markdown fences, no prose):
{"summary":"human-readable bullet list of resolved decisions","constraints":{"key":"value"}}`;
    const out = await runModel(session, model, sumPrompt, directory, void 0, void 0, signal);
    if (!out.startsWith("ERROR:") && !out.startsWith("Task appears too large")) {
      try {
        let s = out.trim();
        const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fence) s = fence[1].trim();
        const fi = s.indexOf("{");
        const la = s.lastIndexOf("}");
        if (fi >= 0 && la > fi) s = s.slice(fi, la + 1);
        const p = JSON.parse(s);
        summary = String(p.summary ?? "");
        if (p.constraints && typeof p.constraints === "object") {
          for (const [k, v] of Object.entries(p.constraints)) constraints[String(k)] = String(v);
        }
      } catch {
      }
    }
  }
  if (!summary) {
    summary = state.answers.length ? state.answers.map((a, i) => `${i + 1}. ${a.questionText}: ${a.answer}`).join("\n") : "No significant ambiguities found. The task appears well-specified.";
  }
  state.summary = summary;
  state.constraints = constraints;
  state.phase = "complete";
  writeInterview(sessionID, state);
  try {
    const kw = extractKeywords(state.task);
    if (kw.length) saveInvestigationResult(kw, summary, "reverse_interview", 0.9);
  } catch (e) {
    log(`reverse_interview save err: ${String(e)}`);
  }
  return formatCompleteOutput(state);
}
function updateSubSession(sessionID, taskId, fields) {
  return mutateHarness(sessionID, (h) => {
    const t = h.tasks.find((x) => x.id === taskId);
    if (t) Object.assign(t, fields);
  });
}
function clearSubSession(sessionID, taskId) {
  return mutateHarness(sessionID, (h) => {
    const t = h.tasks.find((x) => x.id === taskId);
    if (!t) return;
    t.subSessionId = void 0;
    t.subStep = void 0;
    t.lastActivity = void 0;
    t.subElapsed = void 0;
    t.lastPollTs = void 0;
  });
}
function analyzeInjection(sessionID) {
  try {
    const h = readHarness(sessionID);
    if (!h) return { total: 0, passed: 0, failed: 0, withInjection: { total: 0, passRate: 0 }, withoutInjection: { total: 0, passRate: 0 }, byCategory: {} };
    const tasks = h.tasks.filter((t) => t.score === "PASS" || t.score === "FAIL");
    let withInj = 0, withInjPass = 0, withoutInj = 0, withoutInjPass = 0;
    const cats = {};
    for (const t of tasks) {
      const inj = t.injected;
      const hasAny = inj && (inj.rules > 0 || inj.implNotes > 0 || inj.domainNodes > 0 || inj.hasScanFindings);
      if (hasAny) {
        withInj++;
        if (t.score === "PASS") withInjPass++;
      } else {
        withoutInj++;
        if (t.score === "PASS") withoutInjPass++;
      }
      if (inj) {
        for (const k of ["rules", "implNotes", "domainNodes", "hasScanFindings"]) {
          const v = inj[k];
          if (typeof v === "number" && v > 0 || v === true) {
            if (!cats[k]) cats[k] = { total: 0, passed: 0 };
            cats[k].total++;
            if (t.score === "PASS") cats[k].passed++;
          }
        }
      }
    }
    return {
      total: tasks.length,
      passed: tasks.filter((t) => t.score === "PASS").length,
      failed: tasks.filter((t) => t.score === "FAIL").length,
      withInjection: { total: withInj, passRate: withInj > 0 ? Math.round(withInjPass * 100 / withInj) : 0 },
      withoutInjection: { total: withoutInj, passRate: withoutInj > 0 ? Math.round(withoutInjPass * 100 / withoutInj) : 0 },
      byCategory: cats
    };
  } catch {
    return { total: 0, passed: 0, failed: 0, withInjection: { total: 0, passRate: 0 }, withoutInjection: { total: 0, passRate: 0 }, byCategory: {} };
  }
}
function findActiveTaskId(sessionID, status) {
  try {
    const h = readHarness(sessionID);
    if (!h) return void 0;
    return h.tasks.find((x) => x.status === status)?.id;
  } catch {
    return void 0;
  }
}
function harnessTaskTitle(sessionID, taskId) {
  if (taskId === void 0) return void 0;
  try {
    const t = readHarness(sessionID)?.tasks.find((x) => x.id === taskId);
    return typeof t?.title === "string" && t.title ? t.title : void 0;
  } catch {
    return void 0;
  }
}
var MANIFEST_FILES_SET = /* @__PURE__ */ new Set([
  "package.json",
  "go.mod",
  "requirements.txt",
  "pyproject.toml",
  "Cargo.toml",
  "deno.json",
  "pom.xml",
  "build.gradle",
  "mix.exs",
  "Gemfile"
]);
var FRAMEWORK_SIG = {
  "react": ["react", "react-dom", "next"],
  "solid-js": ["solid-js", "@opentui/solid"],
  "vue": ["vue", "nuxt"],
  "svelte": ["svelte", "@sveltejs/kit"],
  "express": ["express"],
  "fastify": ["fastify"],
  "hono": ["hono"],
  "vitest": ["vitest"],
  "jest": ["jest"],
  "tsup": ["tsup"],
  "eslint": ["eslint"]
};
function parseFileList(rawList, baseDir) {
  const empty = {
    skipped: false,
    language: "unknown",
    frameworks: [],
    structure: [],
    manifestFiles: [],
    keyDeps: [],
    configFiles: [],
    totalFiles: 0
  };
  try {
    const lines = (rawList || "").split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return { ...empty, skipped: true, reason: "no files found" };
    const relFiles = lines.map((l) => l.startsWith(baseDir) ? l.slice(baseDir.length).replace(/^\//, "") : l).slice(0, 200);
    const extCounts = {};
    for (const f of relFiles) {
      const dot = f.lastIndexOf(".");
      if (dot >= 0) {
        const ext = f.slice(dot + 1).toLowerCase();
        extCounts[ext] = (extCounts[ext] || 0) + 1;
      }
    }
    const language = detectLanguage(extCounts);
    const manifestFiles = relFiles.filter((f) => {
      const base = f.split("/").pop() || f;
      return MANIFEST_FILES_SET.has(base);
    });
    let keyDeps = [];
    let frameworks = [];
    let testPattern;
    let testFramework;
    for (const mf of manifestFiles) {
      const full = join4(baseDir, mf);
      if (existsSync3(full)) {
        try {
          const content = JSON.parse(readFileSync3(full, "utf8"));
          const depNames = Object.keys({ ...content.dependencies || {}, ...content.devDependencies || {} });
          keyDeps = [.../* @__PURE__ */ new Set([...keyDeps, ...depNames])].slice(0, 50);
          for (const [fw, sigs] of Object.entries(FRAMEWORK_SIG)) {
            if (sigs.some((s) => depNames.includes(s))) frameworks = [.../* @__PURE__ */ new Set([...frameworks, fw])];
          }
          if (depNames.includes("vitest")) testFramework = "vitest";
          else if (depNames.includes("jest")) testFramework = "jest";
          else if (depNames.includes("pytest")) testFramework = "pytest";
        } catch {
        }
      }
    }
    const testFiles = relFiles.filter(
      (f) => /\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/.test(f) || /(^|\/)(test_[^.]+|.+_test)\.(py|go)$/.test(f)
    );
    if (testFiles.length) {
      const m = testFiles[0].match(/(\.(test|spec)\.[a-z]+|test_[a-z]+\.(py|go)|_[a-z]+_test\.(py|go))$/i);
      if (m) testPattern = "*" + m[0];
    }
    const configFiles = relFiles.filter(
      (f) => /\.(eslintrc|prettierrc|tsconfig|jsconfig|babelrc|stylelintrc)/.test(f) || f.endsWith("tsconfig.json") || f.endsWith(".eslintrc") || f.endsWith(".prettierrc")
    );
    const dirCounts = {};
    for (const f of relFiles) {
      const parts = f.split("/");
      const dir = parts.length > 1 ? parts[0] : ".";
      dirCounts[dir] = (dirCounts[dir] || 0) + 1;
    }
    const structure = Object.entries(dirCounts).map(([dir, fileCount]) => ({ dir, fileCount })).sort((a, b) => b.fileCount - a.fileCount).slice(0, 8);
    return {
      skipped: false,
      language,
      frameworks,
      testPattern,
      testFramework,
      structure,
      manifestFiles,
      keyDeps,
      configFiles,
      totalFiles: lines.length
    };
  } catch {
    return { ...empty, skipped: true, reason: "scan error" };
  }
}
function detectLanguage(extCounts) {
  const sum = (exts) => exts.reduce((s, e) => s + (extCounts[e] || 0), 0);
  const ts = sum(["ts", "tsx", "mts", "cts"]);
  const js = sum(["js", "jsx", "mjs", "cjs"]);
  if (ts > 0 && ts >= js) return "TypeScript";
  if (js > 0) return "JavaScript";
  if ((extCounts["py"] || 0) > 0) return "Python";
  if ((extCounts["go"] || 0) > 0) return "Go";
  if ((extCounts["rs"] || 0) > 0) return "Rust";
  if ((extCounts["java"] || 0) > 0) return "Java";
  return "unknown";
}
function buildGapPrompt(userRequest, tasks, profile, domainNodes, webResults, docRefs) {
  const taskList = tasks.map((t) => `${t.id}: ${t.title}`).join("\n");
  const profileStr = profile.skipped ? `(skipped \u2014 ${profile.reason || "unknown reason"})` : [
    `- Language: ${profile.language}`,
    `- Frameworks: ${profile.frameworks.join(", ") || "none detected"}`,
    `- Test pattern: ${profile.testPattern || "not detected"} (${profile.testFramework || "?"})`,
    `- Structure: ${profile.structure.map((s) => `${s.dir}/(${s.fileCount})`).join(", ")}`,
    `- Manifest: ${profile.manifestFiles.join(", ") || "none"}`,
    `- Key deps: ${profile.keyDeps.slice(0, 20).join(", ") || "none"}`,
    `- Config: ${profile.configFiles.join(", ") || "none"}`,
    `- Total files: ${profile.totalFiles}`
  ].join("\n");
  const domainStr = domainNodes.length ? domainNodes.slice(0, 15).map((n) => `- ${n.name}: ${JSON.stringify(n.props).slice(0, 200)}`).join("\n") : "(empty \u2014 no prior knowledge stored)";
  const webResultsStr = webResults && webResults.length ? webResults.slice(0, 8).map((r, i) => `${i + 1}. [${r.tier}] ${r.title}
   ${r.url}
   ${r.snippet}`).join("\n") : "(no web results \u2014 either network issue or no relevant findings)";
  const docRefsStr = docRefs && docRefs.length ? docRefs.map((d) => `- ${d.name}: ${d.url}`).join("\n") : "(none)";
  return `You are a pre-flight gap analyst. Compare the user's request (the MAP) with the actual codebase (the TERRITORY) and classify every gap.

USER REQUEST:
${userRequest}

PROPOSED TASKS:
${taskList}

CODEBASE PROFILE:
${profileStr}

EXISTING DOMAIN KNOWLEDGE (from local DB):
${domainStr}

WEB SEARCH RESULTS (from official docs references, GitHub issues, and code search):
${webResultsStr}

OFFICIAL DOCUMENTATION REFERENCES:
${docRefsStr}

Classify into EXACTLY these 4 categories:

1. KNOWN KNOWNS \u2014 requirements explicitly stated in the user request.
   For each: which task it maps to, and the specific requirement.
2. KNOWN UNKNOWNS \u2014 the user left ambiguous / didn't specify.
   For each: what is ambiguous, which task it affects, and a suggestion.
3. UNKNOWN KNOWNS \u2014 implicit knowledge in the codebase not mentioned in the prompt
   (conventions, patterns, dependencies, tool registration style, test framework).
   For each: the finding and where in the codebase it comes from.
4. UNKNOWN UNKNOWNS \u2014 blind spots: things neither the prompt nor the codebase surface,
   but that WILL affect the work (platform quirks, hidden coupling, ordering deps).
   For each: the finding, its impact (high/medium/low), and a mitigation.

Also output:
- QUESTIONS: questions the agent should ask the user before proceeding.
  Only include questions where the answer materially changes the approach.
- TASK REFINEMENTS: suggestions to split, merge, reorder, add, or remove tasks.

Output as JSON ONLY (no markdown fences, no prose before or after):
{"knownKnowns":[{"taskId":1,"title":"","note":"requirement from prompt"}],"knownUnknowns":[{"taskId":1,"gap":"what is ambiguous","suggestion":"how to resolve"}],"unknownKnowns":[{"finding":"implicit knowledge","source":"file or pattern"}],"unknownUnknowns":[{"finding":"blind spot","impact":"high","mitigation":"how to handle"}],"questions":[{"id":"Q1","question":"..."}],"taskRefinements":[{"taskId":1,"action":"split","detail":"..."}]}`;
}
function buildGradePrompt(userPrompt) {
  return `[usage-coach] Verification protocol \u2014 obey ALL of these:
1. PASS requires evidence cited as file:line references (e.g., src/index.ts:42). No citations -> FAIL.
2. If the project has tests, run them and report the command and the result. If you cannot run them, state why.
3. Do not judge only by what is visible \u2014 actively check for missing edge cases and unhandled errors (WYSIATI).
4. OUTPUT CONTRACT: your FIRST line must be exactly "PASS" or "FAIL" with nothing else on it; all evidence and reasoning go on the following lines.

---

${userPrompt}`;
}
function parseGapAnalysis(raw, profile, domainHits) {
  const scannedAt = (/* @__PURE__ */ new Date()).toISOString();
  const base = {
    scannedAt,
    codebaseProfile: profile,
    knownKnowns: [],
    knownUnknowns: [],
    unknownKnowns: [],
    unknownUnknowns: [],
    questions: [],
    taskRefinements: [],
    domainHits,
    domainMisses: 0
  };
  if (!raw || raw.startsWith("ERROR:") || raw.startsWith("Task appears too large")) {
    base.rawAnalysis = raw;
    return base;
  }
  try {
    let jsonStr = raw.trim();
    const fence = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) jsonStr = fence[1].trim();
    const first = jsonStr.indexOf("{");
    const last = jsonStr.lastIndexOf("}");
    if (first >= 0 && last > first) jsonStr = jsonStr.slice(first, last + 1);
    const p = JSON.parse(jsonStr);
    const arr = (v, map) => Array.isArray(v) ? v.map(map) : [];
    base.knownKnowns = arr(p.knownKnowns, (k) => ({
      taskId: Number(k.taskId) || 0,
      title: String(k.title || ""),
      note: String(k.note || "")
    }));
    base.knownUnknowns = arr(p.knownUnknowns, (k) => ({
      taskId: Number(k.taskId) || 0,
      gap: String(k.gap || ""),
      suggestion: k.suggestion ? String(k.suggestion) : void 0
    }));
    base.unknownKnowns = arr(p.unknownKnowns, (k) => ({
      finding: String(k.finding || ""),
      source: String(k.source || "codebase")
    }));
    base.unknownUnknowns = arr(p.unknownUnknowns, (k) => ({
      finding: String(k.finding || ""),
      impact: String(k.impact || "medium"),
      mitigation: k.mitigation ? String(k.mitigation) : void 0
    }));
    base.questions = arr(p.questions, (q, i) => ({
      id: String(q.id || `Q${i + 1}`),
      question: String(q.question || "")
    })).filter((q) => q.question);
    base.taskRefinements = arr(p.taskRefinements, (t) => ({
      taskId: Number(t.taskId) || 0,
      action: String(t.action || "split"),
      detail: String(t.detail || "")
    }));
    base.domainMisses = base.unknownKnowns.length + base.unknownUnknowns.length;
  } catch {
    base.unknownUnknowns = [{ finding: raw.slice(0, 500), impact: "medium", mitigation: "review the raw analysis" }];
    base.rawAnalysis = raw;
    base.domainMisses = 1;
  }
  return base;
}
function formatReport(r) {
  const L = [];
  L.push(`Unknown Scan Report \u2014 ${new Date(r.scannedAt).toLocaleString()}`);
  L.push("=".repeat(50));
  const p = r.codebaseProfile;
  if (p.skipped) {
    L.push(`
Codebase Profile: SKIPPED (${p.reason || "unknown"})`);
  } else {
    L.push("\nCodebase Profile:");
    L.push(`  language: ${p.language}`);
    if (p.frameworks.length) L.push(`  frameworks: ${p.frameworks.join(", ")}`);
    if (p.testPattern) L.push(`  test: ${p.testPattern} (${p.testFramework || "?"})`);
    if (p.structure.length) L.push(`  structure: ${p.structure.map((s) => `${s.dir}/(${s.fileCount})`).join(", ")}`);
    L.push(`  total files: ${p.totalFiles}`);
  }
  L.push(`
Domain DB: ${r.domainHits} hits, ${r.domainMisses} new findings`);
  if (r.knownKnowns.length) {
    L.push(`
Known Knowns (${r.knownKnowns.length}):`);
    for (const k of r.knownKnowns) L.push(`  + task ${k.taskId}: ${k.note}`);
  }
  if (r.knownUnknowns.length) {
    L.push(`
Known Unknowns (${r.knownUnknowns.length}):`);
    for (const k of r.knownUnknowns) {
      L.push(`  ! task ${k.taskId}: ${k.gap}`);
      if (k.suggestion) L.push(`    -> ${k.suggestion}`);
    }
  }
  if (r.unknownKnowns.length) {
    L.push(`
Unknown Knowns (${r.unknownKnowns.length}) \u2014 implicit, from codebase:`);
    for (const k of r.unknownKnowns) L.push(`  i  ${k.finding}`);
  }
  if (r.unknownUnknowns.length) {
    L.push(`
Unknown Unknowns (${r.unknownUnknowns.length}) \u2014 blind spots:`);
    for (const k of r.unknownUnknowns) {
      L.push(`  *  ${k.finding}`);
      L.push(`    impact: ${k.impact}`);
      if (k.mitigation) L.push(`    mitigation: ${k.mitigation}`);
    }
  }
  if (r.questions.length) {
    L.push(`
Questions for the user (${r.questions.length}):`);
    for (const q of r.questions) L.push(`  [${q.id}] ${q.question}`);
  }
  if (r.taskRefinements.length) {
    L.push("\nTask Refinement Suggestions:");
    for (const t of r.taskRefinements) L.push(`  -> task ${t.taskId}: ${t.action} - ${t.detail}`);
  }
  if (r.webResults && r.webResults.length) {
    L.push(`
WEB SEARCH (${r.webResults.length} results):`);
    if (r.docRefs && r.docRefs.length) {
      L.push(`  Official docs: ${r.docRefs.map((d) => d.name).join(", ")}`);
    }
    L.push("  Top results:");
    for (let i = 0; i < Math.min(r.webResults.length, 5); i++) {
      const w = r.webResults[i];
      L.push(`    ${i + 1}. [${w.tier}] ${w.title}`);
      L.push(`       ${w.url}`);
      L.push(`       ${w.snippet.slice(0, 100)}`);
    }
  }
  if (r.rawAnalysis) L.push(`
Raw analysis: ${r.rawAnalysis.slice(0, 200)}`);
  L.push("\n[usage-coach NEXT] unknowns reviewed:");
  L.push("  - If questions are flagged, call question() to present them to the user.");
  L.push("  - If task splits are suggested, adjust via task_update.");
  L.push("  - Then proceed to generate/generate_batch.");
  return L.join("\n");
}
function writeUnknownScan(sessionID, result) {
  try {
    const h = readHarness(sessionID);
    if (h) {
      h.unknownScan = result;
      h.scanDone = true;
      h.scanSummary = buildScanSummary(result);
      writeHarness(sessionID, h);
    }
  } catch {
  }
}
function buildScanSummary(r) {
  const lines = [];
  if (r.unknownUnknowns?.length) {
    lines.push(`Unknown Unknowns (${r.unknownUnknowns.length}):`);
    for (const uu of r.unknownUnknowns.slice(0, 5)) {
      lines.push(`  [${uu.impact?.toUpperCase() ?? "?"}] ${uu.finding}${uu.mitigation ? ` \u2192 ${uu.mitigation}` : ""}`);
    }
  }
  if (r.unknownKnowns?.length) {
    lines.push(`Implicit knowledge (${r.unknownKnowns.length}):`);
    for (const uk of r.unknownKnowns.slice(0, 5)) {
      lines.push(`  \u2139 ${uk.finding}`);
    }
  }
  if (r.questions?.length) {
    lines.push(`Pending questions (${r.questions.length}):`);
    for (const q of r.questions.slice(0, 5)) {
      lines.push(`  [Q] ${q.question}`);
    }
  }
  return lines.join("\n");
}
function checkScanGate(sessionID) {
  try {
    const h = readHarness(sessionID);
    if (!h || !h.scanRequired) return { warning: null, summary: null };
    if (!h.scanDone) {
      return {
        warning: `\u26A0 DIAGNOSIS GATE: unknown_scan was NOT called before this generate. You are generating without pre-flight gap analysis. Blind spots (unknown unknowns) may cause wrong assumptions and waste steps. Call unknown_scan first, OR proceed consciously accepting the risk.`,
        summary: null
      };
    }
    if (h.unknownScan?.questions?.length && !h.questionsResolved) {
      return {
        warning: `\u26A0 UNRESOLVED QUESTIONS: unknown_scan found ${h.unknownScan.questions.length} question(s) for the user, but the question tool was not called. You MUST call question() to present these to the user before generating. The answers materially affect the approach. Do NOT proceed without asking.`,
        summary: h.scanSummary ?? null
      };
    }
    let summary = h.scanSummary ?? null;
    if (h.questionsResolved && h.questionAnswers) {
      const answers = Object.entries(h.questionAnswers).map(([id, ans]) => `  ${id}: ${ans}`).join("\n");
      summary = summary ? `${summary}
User answers to scan questions:
${answers}` : `User answers to scan questions:
${answers}`;
    }
    return { warning: null, summary };
  } catch {
    return { warning: null, summary: null };
  }
}
function readHarnessCfg(dir) {
  const tryRead = (p) => {
    try {
      if (existsSync3(p)) return JSON.parse(readFileSync3(p, "utf8"));
    } catch {
    }
    return {};
  };
  return {
    ...tryRead(join4(homedir2(), ".config", "opencode-usage-coach", "harness.config.json")),
    ...tryRead(join4(dir, "harness.config.json"))
  };
}
function writeHarnessCfg(updates) {
  const configDir = join4(homedir2(), ".config", "opencode-usage-coach");
  const configPath = join4(configDir, "harness.config.json");
  try {
    mkdirSync4(configDir, { recursive: true });
    const existing = (() => {
      try {
        return JSON.parse(readFileSync3(configPath, "utf8"));
      } catch {
        return {};
      }
    })();
    const merged = { ...existing, ...updates };
    writeFileSync2(configPath, JSON.stringify(merged, null, 2) + "\n");
    return configPath;
  } catch (e) {
    throw new Error(`Failed to write harness config: ${String(e)}`, { cause: e });
  }
}
async function runModel(session, model, prompt, directory, track, maxSteps = DEFAULT_MAX_STEPS, signal) {
  const t0 = Date.now();
  const subStart = Date.now();
  let poller = null;
  let wallTimer = null;
  let subId = null;
  let timedOut = false;
  let stalled = false;
  let pollerDone = false;
  let lastStepSeen = -1;
  let lastTsSeen = "";
  let lastProgressAt = Date.now();
  let lastPollOk = true;
  let signalTimeout;
  const timeoutSignal = new Promise((resolve3) => {
    signalTimeout = resolve3;
  });
  const onAbort = () => {
    if (timedOut) return;
    timedOut = true;
    log(`runModel(${model}): SIGNAL aborted, aborting session ${subId}`);
    try {
      if (subId) session.abort(subId);
    } catch {
    }
    signalTimeout();
  };
  try {
    if (signal?.aborted) return "ERROR: cancelled before start (signal already aborted).";
    signal?.addEventListener("abort", onAbort, { once: true });
    const slash = model.indexOf("/");
    const providerID = slash >= 0 ? model.slice(0, slash) : model;
    const modelID = slash >= 0 ? model.slice(slash + 1) : "";
    let id;
    try {
      id = await session.create(directory, "uc-harness-sub");
    } catch (e) {
      if (!(e instanceof Error && e.message.startsWith("session.create returned no id"))) throw e;
      log(`runModel(${model}): session.create ${Date.now() - t0}ms`);
      return `ERROR: ${e.message}`;
    }
    log(`runModel(${model}): session.create ${Date.now() - t0}ms`);
    subId = id;
    log(`runModel(${model}): session ${id} created, sending prompt (${prompt.length} chars), max_steps=${maxSteps}`);
    poller = setInterval(async () => {
      if (timedOut || pollerDone) return;
      try {
        let step = 0;
        let lastTs = (/* @__PURE__ */ new Date()).toISOString();
        try {
          const msgList = await session.messages(id);
          if (pollerDone) return;
          if (msgList.length) {
            step = msgList.filter((m) => {
              const role = m?.role ?? m?.info?.role;
              return role === "assistant";
            }).length;
            const last = msgList[msgList.length - 1];
            const ts = last?.ts ?? last?.info?.updatedAt ?? last?.info?.completedAt ?? last?.updatedAt;
            if (ts) lastTs = String(ts);
            lastPollOk = true;
          }
        } catch {
          lastPollOk = false;
        }
        if (lastPollOk && (step !== lastStepSeen || lastTs !== lastTsSeen)) {
          lastStepSeen = step;
          lastTsSeen = lastTs;
          lastProgressAt = Date.now();
        }
        if (step > maxSteps) {
          log(`runModel(${model}): STEP LIMIT exceeded (${step} > ${maxSteps}), aborting session ${id}`);
          timedOut = true;
          try {
            await session.abort(id);
          } catch {
          }
          signalTimeout();
          return;
        }
        if (STALL_MS > 0 && lastPollOk && Date.now() - lastProgressAt > STALL_MS) {
          stalled = true;
          timedOut = true;
          log(`runModel(${model}): STALLED \u2014 no progress for ${Math.round((Date.now() - lastProgressAt) / 1e3)}s (step=${step}, maxSteps=${maxSteps}), aborting session ${id}`);
          try {
            await session.abort(id);
          } catch {
          }
          signalTimeout();
          return;
        }
        if (track && !pollerDone) {
          const elapsed2 = Math.round((Date.now() - subStart) / 1e3);
          updateSubSession(track.sessionID, track.taskId, {
            subSessionId: id,
            subStep: step,
            lastActivity: lastTs,
            subElapsed: elapsed2,
            lastPollTs: Date.now()
          });
        }
      } catch (e) {
        log(`runModel poller err: ${String(e)}`);
      }
    }, WATCHDOG_POLL_MS);
    wallTimer = setTimeout(() => {
      if (!timedOut) {
        timedOut = true;
        log(`runModel(${model}): WALL-CLOCK timeout after ${WALL_TIMEOUT_MS / 1e3}s, aborting session ${id}`);
        try {
          session.abort(id);
        } catch {
        }
        signalTimeout();
      }
    }, WALL_TIMEOUT_MS);
    const promptP = session.prompt(id, providerID, modelID, prompt).then(
      (r) => r,
      () => null
      // abort causes rejection -> return null (handled via timedOut flag)
    );
    const resp = await Promise.race([promptP, timeoutSignal.then(() => null)]);
    const elapsed = Math.round((Date.now() - t0) / 1e3);
    log(`runModel(${model}): prompt resolved ${elapsed}s, timedOut=${timedOut}`);
    if (timedOut) {
      try {
        const summary = await session.summarize?.(id);
        log(`runModel(${model}): TIMED OUT summary: ${JSON.stringify(summary?.data ?? summary).slice(0, 300)}`);
      } catch {
      }
      try {
        session.delete(id);
      } catch {
      }
      subId = null;
      if (stalled) {
        return `ERROR: stalled \u2014 no message-stream progress for ${Math.round(STALL_MS / 6e4)} min (step ${lastStepSeen}/${maxSteps}). The sub-session was wedged (observed today as the 837s no-output case). Retry this task individually with generate(); if it stalls again, split it.
[usage-coach NEXT] re-run the stalled task alone via generate(), or split it.`;
      }
      log(`runModel(${model}): TIMED OUT after ${elapsed}s (${maxSteps} steps exceeded)`);
      return `Task appears too large (exceeded ${maxSteps} steps, aborted after ${Math.round(elapsed)}s). Consider splitting into smaller subtasks.
[usage-coach NEXT] split the original task into smaller subtasks (each should complete within ${maxSteps} steps), then re-run generate for each subtask. Rule of thumb from observed costs: split BEFORE starting when the task needs >1 output file or >1 distinct transformation \u2014 a failed oversized run costs the full step budget again on retry.`;
    }
    const parts = resp?.data?.parts ?? resp?.parts ?? [];
    const text = parts.filter((p) => p?.type === "text").map((p) => p?.text ?? "").join("");
    const cleanupStart = Date.now();
    try {
      if (session.summarize) session.summarize(id).then((summary) => log(`runModel(${model}): summary ${Date.now() - cleanupStart}ms: ${JSON.stringify(summary?.data ?? summary).slice(0, 300)}`)).catch(() => {
      });
    } catch {
    }
    try {
      session.delete(id).catch(() => {
      });
    } catch {
    }
    subId = null;
    log(`runModel(${model}): done ${elapsed}s, ${text.length} chars (cleanup dispatched)`);
    return text.trim() || `ERROR: no assistant text in prompt response after ${elapsed}s (parts: ${parts.length}, types: ${parts.map((p) => p?.type).join(",")})`;
  } catch (e) {
    const elapsed = Math.round((Date.now() - t0) / 1e3);
    log(`runModel err (${model}, ${elapsed}s): ${String(e)}`);
    return `ERROR: runModel exception after ${elapsed}s: ${String(e)}`;
  } finally {
    pollerDone = true;
    if (poller) clearInterval(poller);
    if (wallTimer) clearTimeout(wallTimer);
    signal?.removeEventListener("abort", onAbort);
    if (track) {
      try {
        clearSubSession(track.sessionID, track.taskId);
      } catch {
      }
    }
    if (subId) {
      try {
        session.delete(subId).catch(() => {
        });
      } catch {
      }
    }
  }
}
var HARNESS_AGENTS = (process.env.UC_HARNESS_AGENT ?? "Usage-Coach-Harness").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
var num2 = (e, d) => {
  try {
    const v = Number(process.env[e]);
    return Number.isFinite(v) && v >= 0 ? v : d;
  } catch {
    return d;
  }
};
var WORM_MAX_AGE_DAYS = num2("UC_WORM_MAX_AGE_DAYS", 180);
var WORM_MAX_NODES = num2("UC_WORM_MAX_NODES", 1e5);
var SHARED_WORM_MAX_AGE_DAYS = num2("UC_SHARED_WORM_MAX_AGE_DAYS", 60);
var SHARED_WORM_MAX_NODES = num2("UC_SHARED_WORM_MAX_NODES", 3e3);
var agentCache = /* @__PURE__ */ new Map();
var currentAgent = "";
var EMPTY_AGENT = { agent: "", model: "", provider: "" };
async function resolveAgent(session, sessionID) {
  if (!sessionID) return EMPTY_AGENT;
  const hit = agentCache.get(sessionID);
  if (hit && Date.now() - hit.ts < 6e4) {
    return { agent: hit.agent, model: hit.model, provider: hit.provider };
  }
  try {
    const info = await session.get(sessionID);
    log(`resolveAgent raw session: ${JSON.stringify(info).slice(0, 500)}`);
    const agent = String(info?.agent ?? "");
    const rawModel = info?.model;
    const model = typeof rawModel === "string" ? rawModel : rawModel?.id ?? rawModel?.modelID ?? rawModel?.name ?? "";
    const rawProvider = info?.providerID ?? info?.provider ?? (typeof rawModel === "object" ? rawModel?.providerID ?? rawModel?.provider : "");
    const provider = typeof rawProvider === "string" ? rawProvider : rawProvider?.id ?? "";
    agentCache.set(sessionID, { agent, model, provider, ts: Date.now() });
    return { agent, model, provider };
  } catch (e) {
    log(`resolveAgent err: ${String(e)}`);
    return EMPTY_AGENT;
  }
}
function isHarnessAgent(agent) {
  if (!agent) return false;
  return HARNESS_AGENTS.includes(agent.toLowerCase());
}
async function UsageCoachPlugin(input) {
  pipeLog(`UsageCoachPlugin CALLED | dir=${input.directory} | worktree=${input.worktree}`);
  try {
    setStateDir(input.directory);
    initDomain(STATE_DIR);
    const rt = { directory: input.directory, session: makeV1SessionOps(input.client) };
    const cfg0 = readHarnessCfg(input.directory);
    if (cfg0.domainAutoLink !== void 0) process.env.UC_AUTOLINK = cfg0.domainAutoLink ? "1" : "0";
    const quota = createQuotaMachine({
      directory: input.directory,
      provider: process.env.UC_PROVIDER ?? cfg0.provider ?? "",
      lighter: process.env.UC_LIGHTER_MODEL ?? cfg0.lighterModel ?? "a lighter model",
      getAgent: () => currentAgent
    });
    const host = { rt, current: quota.current, refresh: quota.refresh };
    const defs = buildToolDefs();
    const toolMap = {};
    for (const def of defs) {
      toolMap[def.name] = tool({
        description: def.description,
        // zod's generic builder signatures are not statically assignable to the
        // structural SchemaLibLike (method bivariance does not span generics),
        // but the runtime shapes line up exactly: every builder returns a
        // chainable node with .describe()/.optional(). Hence the local cast.
        args: convertSchema(def.name, def.schema, tool.schema),
        async execute(args, ctx) {
          return def.execute(args, { sessionID: ctx?.sessionID, directory: ctx?.directory ?? rt.directory }, host);
        }
      });
    }
    return {
      event: async ({ event }) => {
        try {
          if (event.type === "session.created" || event.type === "session.idle") quota.refresh();
          if (event.type === "session.idle") {
            try {
              const r = evictStale(WORM_MAX_AGE_DAYS, WORM_MAX_NODES);
              if (r.removed) log(`evictStale: removed ${r.removed}, kept ${r.kept} (maxAge=${WORM_MAX_AGE_DAYS}d, maxNodes=${WORM_MAX_NODES})`);
            } catch (e) {
              log(`evictStale err: ${String(e)}`);
            }
            try {
              const sh = evictSharedStale(SHARED_WORM_MAX_AGE_DAYS, SHARED_WORM_MAX_NODES);
              if (sh.removed) log(`evictSharedStale: removed ${sh.removed}, kept ${sh.kept} (maxAge=${SHARED_WORM_MAX_AGE_DAYS}d, maxNodes=${SHARED_WORM_MAX_NODES})`);
            } catch (e) {
              log(`evictSharedStale err: ${String(e)}`);
            }
            try {
              const s = sweepDeadEdges();
              log(`sweepDeadEdges: removed ${s.removed}, kept ${s.kept}`);
            } catch (e) {
              log(`sweepDeadEdges err: ${String(e)}`);
            }
          }
        } catch (e) {
          log(`event err: ${String(e)}`);
        }
      },
      // ACT(1) — model/agent detection on EVERY tool call (cached 60s, negligible overhead).
      // Then hard-gate harness tools by agent mode + quota STOP.
      "tool.execute.before": async (_input) => {
        const info = await resolveAgent(rt.session, _input.sessionID);
        currentAgent = info.agent;
        quota.setModel(info.model, info.provider);
        quota.refresh();
        const harnessTools = ["unknown_scan", "question", "generate", "generate_batch", "grade", "grade_batch", "investigate", "verify_diagnosis", "generalize", "harness_start", "task_update", "harness_done", "record_failure", "reverse_interview"];
        if (!harnessTools.includes(_input.tool)) return;
        if (!isHarnessAgent(info.agent)) {
          throw new Error(`[${PLUGIN_NAME}] '${_input.tool}' is restricted to agent mode ${JSON.stringify(HARNESS_AGENTS)} (current: ${JSON.stringify(info.agent || "unknown")}). Switch to that agent mode to use it.`);
        }
        let decision;
        try {
          decision = quota.current().decision;
        } catch {
          decision = "GO";
        }
        if (decision === "STOP") {
          throw new Error(`[${PLUGIN_NAME}] blocked: quota limit exceeded. ${quota.current().advice}`);
        }
      },
      // ACT(2) inject coaching into system prompt — ONLY in the harness agent mode,
      // so other modes' system prompts stay completely clean. Silent on error.
      "experimental.chat.system.transform": async (_input, output) => {
        try {
          if (_input.sessionID) {
            const info = await resolveAgent(rt.session, _input.sessionID);
            quota.setModel(info.model, info.provider);
            quota.refresh();
            if (!isHarnessAgent(info.agent)) return;
          }
          const c = quota.current();
          let instruction = "";
          if (c.decision === "STOP") instruction = `[${PLUGIN_NAME}] QUOTA limit exceeded. ${c.advice} Stop making further tool calls, finish the in-progress work, then report the quota status to the user.`;
          else if (c.decision === "THROTTLE") instruction = `[${PLUGIN_NAME}] ${c.advice} Hold off on long/heavy tasks.`;
          else if (c.weekly >= 0 || c.fiveHour >= 0) {
            const parts = [];
            if (c.weekly >= 0) parts.push(`weekly ${c.weekly}%`);
            if (c.fiveHour >= 0) parts.push(`5h ${c.fiveHour}%`);
            if (c.monthly >= 0) parts.push(`monthly ${c.monthly}%`);
            instruction = `[${PLUGIN_NAME}] quota ok \u2014 ${parts.join(" \xB7 ")}.`;
          }
          if (instruction) output.system.push(instruction);
        } catch (e) {
          log(`system.transform err: ${String(e)}`);
        }
      },
      // Custom tools for the harness agent mode — report status to the panel.
      // Definitions (bodies included) live in tool-defs.ts — version-agnostic and
      // shared with the V2 adapter. This map only adapts them to the V1
      // tool() shape: JSON Schema args are converted via schema-convert.
      tool: toolMap
    };
  } catch (e) {
    pipeLog(`PLUGIN INIT FAILED (no-op): ${String(e)}`);
    log(`PLUGIN INIT FAILED (no-op): ${String(e)}`);
    return NOOP_HOOKS;
  }
}
var dual = { id: "opencode-usage-coach", setup: v2Setup, server: UsageCoachPlugin };
var src_default = dual;
export { UsageCoachPlugin, UsageCoachPlugin as server, dual as default };
