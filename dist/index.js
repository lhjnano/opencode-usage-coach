// src/index.ts
import { mkdirSync as mkdirSync2, writeFileSync as writeFileSync2, appendFileSync as appendFileSync2, readFileSync as readFileSync2, existsSync as existsSync2 } from "fs";
import { spawn, spawnSync } from "child_process";
import { createHash } from "crypto";
import { homedir } from "os";
import { join as join2, resolve, dirname } from "path";
import { tool } from "@opencode-ai/plugin";

// src/domain.ts
import { mkdirSync, appendFileSync, readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
var BASE_DIR = "";
function initDomain(stateDir) {
  BASE_DIR = stateDir;
}
var nodesFile = () => join(BASE_DIR, "nodes.ndjson");
var edgesFile = () => join(BASE_DIR, "edges.ndjson");
function readNdjson(path) {
  try {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
function readNodes() {
  return readNdjson(nodesFile());
}
function readEdges() {
  return readNdjson(edgesFile());
}
function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function addDomainNode(node) {
  const full = { ...node, id: uid("node"), ts: (/* @__PURE__ */ new Date()).toISOString() };
  try {
    mkdirSync(BASE_DIR, { recursive: true });
    appendFileSync(nodesFile(), JSON.stringify(full) + "\n");
  } catch {
  }
  return full.id;
}
function addDomainEdge(edge) {
  const full = { ...edge, ts: (/* @__PURE__ */ new Date()).toISOString() };
  try {
    mkdirSync(BASE_DIR, { recursive: true });
    appendFileSync(edgesFile(), JSON.stringify(full) + "\n");
  } catch {
  }
}
function writeNodes(nodes) {
  try {
    mkdirSync(BASE_DIR, { recursive: true });
    const lines = nodes.map((n) => JSON.stringify(n));
    writeFileSync(nodesFile(), lines.length ? lines.join("\n") + "\n" : "");
  } catch {
  }
}
function queryDomain(keywords) {
  const lc = keywords.map((k) => k.toLowerCase());
  const nodes = readNodes();
  const matched = nodes.filter((n) => {
    const hay = (n.name + " " + JSON.stringify(n.props)).toLowerCase();
    return lc.some((k) => k && hay.includes(k));
  });
  if (matched.length) touchNodes(new Set(matched.map((n) => n.id)));
  const ids = new Set(matched.map((n) => n.id));
  const edges = readEdges().filter((e) => ids.has(e.from) || ids.has(e.to));
  return { nodes: matched, edges };
}
function touchNodes(ids) {
  if (ids.size === 0) return;
  try {
    const nodes = readNodes();
    let changed = false;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    for (const n of nodes) {
      if (ids.has(n.id)) {
        n.lastAccessed = now;
        n.accessCount = (n.accessCount ?? 0) + 1;
        changed = true;
      }
    }
    if (changed) writeNodes(nodes);
  } catch {
  }
}
function evictStale(maxAgeDays = 30, maxNodes = 1e3) {
  try {
    const nodes = readNodes();
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
function traverseNeighborhood(seedNodeIds, maxDepth = 2, opts = {}) {
  const maxNodes = opts.maxNodes ?? 60;
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
    for (const nxt of adj.get(cur) ?? []) {
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
  const seed = queryDomain(keywords);
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
    return addDomainNode({
      type: "fact",
      name: keywords.join(" "),
      props: { result },
      source: source || "investigation",
      confidence
    });
  } catch {
    return "";
  }
}

// src/web-search.ts
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
  return raw.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ").replace(/[#*_[\]()>|]/g, " ").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, GH_QUERY_MAX);
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
    const tag = res.status === 403 || res.status === 429 ? " (rate limit)" : "";
    throw new Error(`HTTP ${res.status}${tag}`);
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
  for (const fw of fws) {
    if (signal.aborted || results.length >= TARGET_RESULT_COUNT) break;
    const entry = FRAMEWORK_DOCS[fw];
    if (!entry?.githubOrg) continue;
    try {
      const q = `${query} org:${entry.githubOrg}`;
      const url = `https://api.github.com/search/issues?q=${encodeURIComponent(sanitizeQuery(q))}&per_page=3`;
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
      console.error(`[web-search] tier1 ${fw}: ${m}`);
      errors.push(`tier1:${fw}:${m.slice(0, 80)}`);
    }
  }
  return errors;
}
async function tier2GitHubIssues(query, results, seen, signal) {
  const errors = [];
  try {
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(sanitizeQuery(query))}&per_page=5`;
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
    console.error(`[web-search] tier2: ${m}`);
    errors.push(`tier2:${m.slice(0, 80)}`);
  }
  return errors;
}
async function tier3GitHubCode(query, results, seen, signal) {
  const errors = [];
  if (!ghToken()) return errors;
  try {
    const url = `https://api.github.com/search/code?q=${encodeURIComponent(sanitizeQuery(query))}&per_page=3`;
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
    console.error(`[web-search] tier3: ${m}`);
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
    console.error(`[web-search] unexpected error: ${m}`);
    errors.push(`unexpected:${m.slice(0, 80)}`);
  } finally {
    clearTimeout(timer);
  }
  const response = { results, docRefs };
  const joined = errors.filter(Boolean).join("; ");
  if (joined) response.error = joined;
  return response;
}

// src/index.ts
var PLUGIN_NAME = "opencode-usage-coach";
var TTL_MS = Number(process.env.UC_TTL_MS ?? 6e4);
var DEFAULT_MAX_STEPS = Number(process.env.UC_MAX_STEPS ?? 30) || 30;
var WATCHDOG_POLL_MS = Math.max(1e3, Number(process.env.UC_WATCHDOG_POLL_MS ?? 3e3) || 3e3);
var WALL_TIMEOUT_MS = Math.max(1, Number(process.env.UC_WALL_TIMEOUT_MIN ?? 30) || 30) * 60 * 1e3;
var DEFAULT_MAX_QUESTIONS = Math.max(1, Math.round(Number(process.env.UC_MAX_QUESTIONS ?? 7)) || 7);
var PIPE_LOG = join2(homedir(), ".cache", "opencode-usage-coach", "pipeline.log");
function pipeLog(msg) {
  try {
    mkdirSync2(dirname(PIPE_LOG), { recursive: true });
    appendFileSync2(PIPE_LOG, `[SERVER] ${(/* @__PURE__ */ new Date()).toISOString()} ${msg}
`);
  } catch {
  }
}
pipeLog(`MODULE LOADED | node=${process.version} | pid=${process.pid}`);
var STATE_DIR = join2(homedir(), ".cache", "opencode-usage-coach");
var STATE_FILE = join2(STATE_DIR, "state.json");
var LOG_FILE = join2(STATE_DIR, "coach.log");
function projectStateDir(dir) {
  const abs = resolve(dir || ".");
  const h = createHash("sha1").update(abs).digest("hex").slice(0, 12);
  return join2(homedir(), ".cache", "opencode-usage-coach", "projects", h);
}
function setStateDir(dir) {
  STATE_DIR = process.env.UC_STATE_DIR ?? projectStateDir(dir);
  STATE_FILE = join2(STATE_DIR, "state.json");
  LOG_FILE = join2(STATE_DIR, "coach.log");
}
var NOOP_HOOKS = {};
function log(msg) {
  try {
    appendFileSync2(LOG_FILE, `${(/* @__PURE__ */ new Date()).toISOString()} ${msg}
`);
  } catch {
  }
}
function writeState(c) {
  try {
    mkdirSync2(STATE_DIR, { recursive: true });
    writeFileSync2(STATE_FILE, JSON.stringify({ ...c, updatedAt: (/* @__PURE__ */ new Date()).toISOString() }));
  } catch {
  }
}
function rulesFile() {
  return join2(STATE_DIR, "rules.md");
}
function failuresFile() {
  return join2(STATE_DIR, "failures.ndjson");
}
function readRules() {
  try {
    const f = rulesFile();
    if (!existsSync2(f)) return "";
    return readFileSync2(f, "utf8").trim();
  } catch {
    return "";
  }
}
function implNotesFile() {
  return join2(STATE_DIR, "impl-notes.md");
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
    if (!existsSync2(f)) return "";
    const content = readFileSync2(f, "utf8").trim();
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
    mkdirSync2(STATE_DIR, { recursive: true });
    appendFileSync2(implNotesFile(), entry);
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
    const fileContent = existsSync2(f) ? readFileSync2(f, "utf8") : "";
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
    const STOP = /* @__PURE__ */ new Set(["the", "and", "for", "with", "that", "this", "from", "into", "your", "you", "are", "was", "but", "not", "all", "any", "use", "task", "prompt"]);
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const raw of (text ?? "").toLowerCase().split(/[^a-z0-9_]+/)) {
      const t = raw.trim();
      if (t.length < 3 || STOP.has(t) || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= 16) break;
    }
    return out;
  } catch {
    return [];
  }
}
function harnessFile(sessionID) {
  return join2(STATE_DIR, sessionID || "_default", "harness.json");
}
function readHarness(sessionID) {
  try {
    const f = harnessFile(sessionID);
    if (!existsSync2(f)) return null;
    return JSON.parse(readFileSync2(f, "utf8"));
  } catch {
    return null;
  }
}
function writeHarness(sessionID, h) {
  try {
    const f = harnessFile(sessionID);
    mkdirSync2(dirname(f), { recursive: true });
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
  return join2(STATE_DIR, sessionID || "_default", "interview.json");
}
function readInterview(sessionID) {
  try {
    const f = interviewFile(sessionID);
    if (!existsSync2(f)) return null;
    return JSON.parse(readFileSync2(f, "utf8"));
  } catch {
    return null;
  }
}
function writeInterview(sessionID, s) {
  try {
    const f = interviewFile(sessionID);
    mkdirSync2(dirname(f), { recursive: true });
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
async function completeInterview(state, sessionID, client, model, directory) {
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
    const out = await runModel(client, model, sumPrompt, directory);
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
  });
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
      const full = join2(baseDir, mf);
      if (existsSync2(full)) {
        try {
          const content = JSON.parse(readFileSync2(full, "utf8"));
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
      if (existsSync2(p)) return JSON.parse(readFileSync2(p, "utf8"));
    } catch {
    }
    return {};
  };
  return {
    ...tryRead(join2(homedir(), ".config", "opencode-usage-coach", "harness.config.json")),
    ...tryRead(join2(dir, "harness.config.json"))
  };
}
function writeHarnessCfg(updates) {
  const configDir = join2(homedir(), ".config", "opencode-usage-coach");
  const configPath = join2(configDir, "harness.config.json");
  try {
    mkdirSync2(configDir, { recursive: true });
    const existing = (() => {
      try {
        return JSON.parse(readFileSync2(configPath, "utf8"));
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
async function runModel(client, model, prompt, directory, track, maxSteps = DEFAULT_MAX_STEPS) {
  const t0 = Date.now();
  const subStart = Date.now();
  let poller = null;
  let wallTimer = null;
  let subId = null;
  let timedOut = false;
  let pollerDone = false;
  let signalTimeout;
  const timeoutSignal = new Promise((resolve2) => {
    signalTimeout = resolve2;
  });
  try {
    const slash = model.indexOf("/");
    const providerID = slash >= 0 ? model.slice(0, slash) : model;
    const modelID = slash >= 0 ? model.slice(slash + 1) : "";
    const s = await client.session.create({ body: { title: "uc-harness-sub" }, query: { directory } });
    const id = s?.data?.info?.id ?? s?.data?.id ?? s?.id;
    if (!id) return `ERROR: session.create returned no id (response: ${JSON.stringify(s?.data ?? s).slice(0, 200)})`;
    subId = id;
    log(`runModel(${model}): session ${id} created, sending prompt (${prompt.length} chars), max_steps=${maxSteps}`);
    poller = setInterval(async () => {
      if (timedOut || pollerDone) return;
      try {
        let step = 0;
        let lastTs = (/* @__PURE__ */ new Date()).toISOString();
        try {
          const msgs = await client.session.messages?.({ path: { id } });
          if (pollerDone) return;
          const msgList = Array.isArray(msgs?.data) ? msgs.data : Array.isArray(msgs) ? msgs : [];
          if (msgList.length) {
            step = msgList.filter((m) => {
              const role = m?.role ?? m?.info?.role;
              return role === "assistant";
            }).length;
            const last = msgList[msgList.length - 1];
            const ts = last?.ts ?? last?.info?.updatedAt ?? last?.info?.completedAt ?? last?.updatedAt;
            if (ts) lastTs = String(ts);
          }
        } catch {
        }
        if (step > maxSteps) {
          log(`runModel(${model}): STEP LIMIT exceeded (${step} > ${maxSteps}), aborting session ${id}`);
          timedOut = true;
          try {
            await client.session.abort?.({ path: { id } });
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
            subElapsed: elapsed2
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
          client.session.abort?.({ path: { id } });
        } catch {
        }
        signalTimeout();
      }
    }, WALL_TIMEOUT_MS);
    const promptP = client.session.prompt({
      path: { id },
      body: { model: { providerID, modelID }, parts: [{ type: "text", text: prompt }] }
    }).then(
      (r) => r,
      () => null
      // abort causes rejection -> return null (handled via timedOut flag)
    );
    const resp = await Promise.race([promptP, timeoutSignal.then(() => null)]);
    const elapsed = Math.round((Date.now() - t0) / 1e3);
    if (timedOut) {
      try {
        const summary = await client.session.summarize?.({ path: { id } });
        log(`runModel(${model}): TIMED OUT summary: ${JSON.stringify(summary?.data ?? summary).slice(0, 300)}`);
      } catch {
      }
      try {
        await client.session.delete?.({ path: { id } });
      } catch {
      }
      subId = null;
      log(`runModel(${model}): TIMED OUT after ${elapsed}s (${maxSteps} steps exceeded)`);
      return `Task appears too large (exceeded ${maxSteps} steps). Consider splitting into smaller subtasks.
[usage-coach NEXT] split the original task into smaller subtasks (each should complete within ${maxSteps} steps), then re-run generate for each subtask.`;
    }
    const parts = resp?.data?.parts ?? resp?.parts ?? [];
    const text = parts.filter((p) => p?.type === "text").map((p) => p?.text ?? "").join("");
    try {
      const summary = await client.session.summarize?.({ path: { id } });
      log(`runModel(${model}): sub-session summary: ${JSON.stringify(summary?.data ?? summary).slice(0, 300)}`);
    } catch {
    }
    try {
      await client.session.delete?.({ path: { id } });
    } catch {
    }
    subId = null;
    log(`runModel(${model}): done ${elapsed}s, ${text.length} chars`);
    return text.trim() || `ERROR: no assistant text in prompt response after ${elapsed}s (parts: ${parts.length}, types: ${parts.map((p) => p?.type).join(",")})`;
  } catch (e) {
    const elapsed = Math.round((Date.now() - t0) / 1e3);
    log(`runModel err (${model}, ${elapsed}s): ${String(e)}`);
    return `ERROR: runModel exception after ${elapsed}s: ${String(e)}`;
  } finally {
    pollerDone = true;
    if (poller) clearInterval(poller);
    if (wallTimer) clearTimeout(wallTimer);
    if (track) {
      try {
        clearSubSession(track.sessionID, track.taskId);
      } catch {
      }
    }
    if (subId) {
      try {
        await client.session.delete?.({ path: { id: subId } });
      } catch {
      }
    }
  }
}
var HARNESS_AGENTS = (process.env.UC_HARNESS_AGENT ?? "Usage-Coach-Harness").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
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
var WORM_MAX_AGE_DAYS = num("UC_WORM_MAX_AGE_DAYS", 180);
var WORM_MAX_NODES = num("UC_WORM_MAX_NODES", 1e5);
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
function captureStdout(args) {
  return new Promise((resolve2) => {
    let out = "";
    let p;
    try {
      p = spawn("codexbar", args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return resolve2("");
    }
    p.stdout?.on("data", (d) => {
      out += d.toString();
    });
    p.on("error", () => resolve2(""));
    p.on("close", () => resolve2(out));
  });
}
async function fetchEnabledProviders() {
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
  if (h5 >= S5H || wk >= SWK) return "STOP \u2014 finish current only";
  if (h5 >= T5H && wk >= TWK) return "small tasks only \u2014 big ones will hit both limits";
  if (h5 >= T5H) return "small tasks only \u2014 5h window nearly full, big tasks after reset";
  if (wk >= TWK) return "small tasks only \u2014 big ones will strain late-week";
  if (h5 >= 50 || wk >= 50) return "moderate tasks OK \u2014 save big ones for headroom";
  return "big tasks OK \u2014 short & long limits comfortable";
}
async function fetchProvidersCoach() {
  const ids = await fetchEnabledProviders();
  const results = await Promise.all(ids.map(async (id) => {
    try {
      const out = await captureStdout(["usage", "--provider", id, "--json"]);
      const u = JSON.parse(out)[0]?.usage;
      if (!u) return null;
      const h5 = Math.round(u.tertiary?.usedPercent ?? 0);
      const wk = Math.round(u.primary?.usedPercent ?? 0);
      return {
        id,
        name: id,
        fiveHour: h5,
        weekly: wk,
        fiveHourReset: humanRemaining(u.tertiary?.resetsAt),
        weeklyReset: humanRemaining(u.primary?.resetsAt),
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
    return {
      weekly: u.primary ?? { usedPercent: 0 },
      monthly: u.secondary ?? { usedPercent: 0 },
      fiveHour: u.tertiary ?? { usedPercent: 0 }
    };
  } catch {
    return null;
  }
}
function fetchQuota(provider) {
  return new Promise((resolve2) => {
    let out = "";
    let p;
    try {
      const args = provider ? ["usage", "--provider", provider, "--json"] : ["usage", "--json"];
      p = spawn("codexbar", args, {
        stdio: ["ignore", "pipe", "ignore"]
      });
    } catch {
      return resolve2(null);
    }
    p.stdout?.on("data", (d) => {
      out += d.toString();
    });
    p.on("error", () => resolve2(null));
    p.on("close", () => {
      resolve2(parseQuotaResponse(out));
    });
  });
}
async function fetchQuotaWithRetry(provider, maxRetries = 3) {
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
  const wk = Math.round(q.weekly?.usedPercent ?? 0), mo = Math.round(q.monthly?.usedPercent ?? 0), h5 = Math.round(q.fiveHour?.usedPercent ?? 0);
  if (Number.isNaN(wk) || Number.isNaN(mo) || Number.isNaN(h5)) return { decision: "THROTTLE", advice: "invalid quota data \u2014 proceeding with caution. switch to lighter model if available.", weekly: Number.isNaN(wk) ? 0 : wk, monthly: Number.isNaN(mo) ? 0 : mo, fiveHour: Number.isNaN(h5) ? 0 : h5 };
  const wkR = humanRemaining(q.weekly?.resetsAt), h5R = humanRemaining(q.fiveHour?.resetsAt);
  const stop = (r) => ({ decision: "STOP", advice: `STOP recommend \u2014 ${r}. window nearly exhausted. stop now or it will be force-blocked.`, weekly: wk, monthly: mo, fiveHour: h5 });
  const thr = (r) => ({ decision: "THROTTLE", advice: `Throttle recommend \u2014 ${r}. switch to lighter model (${lighter}) or wait for window reset.`, weekly: wk, monthly: mo, fiveHour: h5 });
  if (h5 >= STOP_5H) return stop(`5h window ${h5}% (${h5R})`);
  if (wk >= STOP_WK) return stop(`weekly ${wk}% (${wkR})`);
  if (mo >= STOP_MO) return stop(`monthly ${mo}%`);
  if (h5 >= THR_5H) return thr(`5h window ${h5}% (${h5R})`);
  if (wk >= THR_WK) return thr(`weekly ${wk}% (${wkR})`);
  return { decision: "GO", advice: `Comfortable \u2014 weekly ${wk}% \xB7 5h ${h5}% \xB7 monthly ${mo}%. proceed. 5h window ${h5R}.`, weekly: wk, monthly: mo, fiveHour: h5 };
}
var agentCache = /* @__PURE__ */ new Map();
var currentModel = "";
var currentProvider = "";
var currentAgent = "";
var modelChanged = false;
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
async function resolveAgent(client, sessionID) {
  if (!sessionID) return "";
  const hit = agentCache.get(sessionID);
  if (hit && Date.now() - hit.ts < 6e4) {
    currentModel = hit.model;
    currentProvider = hit.provider;
    return hit.agent;
  }
  try {
    const s = await client.session.get({ path: { id: sessionID } });
    log(`resolveAgent raw session: ${JSON.stringify(s?.data?.info ?? s?.data ?? s?.info ?? s).slice(0, 500)}`);
    const info = s?.data?.info ?? s?.data ?? s?.info ?? s;
    const agent = String(info?.agent ?? "");
    const rawModel = info?.model;
    const model = typeof rawModel === "string" ? rawModel : rawModel?.id ?? rawModel?.modelID ?? rawModel?.name ?? "";
    const rawProvider = info?.providerID ?? info?.provider ?? (typeof rawModel === "object" ? rawModel?.providerID ?? rawModel?.provider : "");
    const provider = typeof rawProvider === "string" ? rawProvider : rawProvider?.id ?? "";
    if (currentModel && model && currentModel !== model) {
      log(`MODEL CHANGED: ${currentModel} \u2192 ${model} (provider: ${currentProvider} \u2192 ${provider})`);
      modelChanged = true;
    }
    agentCache.set(sessionID, { agent, model, provider, ts: Date.now() });
    currentModel = model;
    currentProvider = provider;
    return agent;
  } catch (e) {
    log(`resolveAgent err: ${String(e)}`);
    return "";
  }
}
function isHarnessAgent(agent) {
  if (!agent) return false;
  return HARNESS_AGENTS.includes(agent.toLowerCase());
}
var LOADING = { decision: "GO", advice: "quota loading\u2026", weekly: -1, monthly: -1, fiveHour: -1 };
async function UsageCoachPlugin(input) {
  pipeLog(`UsageCoachPlugin CALLED | dir=${input.directory} | worktree=${input.worktree}`);
  try {
    setStateDir(input.directory);
    initDomain(STATE_DIR);
    const cfg0 = readHarnessCfg(input.directory);
    const PROVIDER = process.env.UC_PROVIDER ?? cfg0.provider ?? "";
    const LIGHTER = process.env.UC_LIGHTER_MODEL ?? cfg0.lighterModel ?? "a lighter model";
    let last = null;
    let lastKnownQuota = null;
    let lastFetchedAt = 0;
    let refreshing = false;
    const refreshBackground = () => {
      try {
        if (refreshing) return;
        if (last && !modelChanged && Date.now() - lastFetchedAt < TTL_MS) return;
        refreshing = true;
        modelChanged = false;
        if (isFreeModel(currentModel, currentProvider)) {
          last = { decision: "GO", advice: `${currentModel || currentProvider || "free model"} \u2014 no quota limit.`, weekly: -1, monthly: -1, fiveHour: -1, model: currentModel, provider: currentProvider, isFree: true };
          lastFetchedAt = Date.now();
          writeState({ ...last, providers: [], model: currentModel, provider: currentProvider, isFree: true, agent: currentAgent, updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
          log(`FREE | model=${currentModel} provider=${currentProvider}`);
          refreshing = false;
          return;
        }
        const activeProvider = providerToCodexbar(currentProvider) || PROVIDER;
        fetchQuotaWithRetry(activeProvider).then(async (q) => {
          try {
            if (q) lastKnownQuota = q;
            const effectiveQ = q ?? lastKnownQuota;
            last = coach(effectiveQ, LIGHTER);
            lastFetchedAt = Date.now();
            let providers = [];
            try {
              providers = await fetchProvidersCoach();
            } catch {
            }
            if (providers.length > 0 && last.weekly < 0) {
              const p0 = providers[0];
              last = { ...last, weekly: p0.weekly, fiveHour: p0.fiveHour, monthly: p0.weekly >= 0 ? 0 : -1, advice: p0.advice, decision: p0.weekly >= STOP_WK ? "STOP" : p0.weekly >= THR_WK ? "THROTTLE" : "GO" };
            }
            writeState({ ...last, providers, model: currentModel, provider: currentProvider, isFree: false, agent: currentAgent, updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
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
    return {
      event: async ({ event }) => {
        try {
          if (event.type === "session.created" || event.type === "session.idle") refreshBackground();
          if (event.type === "session.idle") {
            try {
              const r = evictStale(WORM_MAX_AGE_DAYS, WORM_MAX_NODES);
              if (r.removed) log(`evictStale: removed ${r.removed}, kept ${r.kept} (maxAge=${WORM_MAX_AGE_DAYS}d, maxNodes=${WORM_MAX_NODES})`);
            } catch (e) {
              log(`evictStale err: ${String(e)}`);
            }
          }
        } catch (e) {
          log(`event err: ${String(e)}`);
        }
      },
      // ACT(1) — model/agent detection on EVERY tool call (cached 60s, negligible overhead).
      // Then hard-gate harness tools by agent mode + quota STOP.
      "tool.execute.before": async (_input) => {
        const agent = await resolveAgent(input.client, _input.sessionID);
        currentAgent = agent;
        refreshBackground();
        const harnessTools = ["unknown_scan", "question", "generate", "generate_batch", "grade", "investigate", "verify_diagnosis", "generalize", "harness_start", "task_update", "harness_done", "record_failure", "reverse_interview"];
        if (!harnessTools.includes(_input.tool)) return;
        if (!isHarnessAgent(agent)) {
          throw new Error(`[${PLUGIN_NAME}] '${_input.tool}' is restricted to agent mode ${JSON.stringify(HARNESS_AGENTS)} (current: ${JSON.stringify(agent || "unknown")}). Switch to that agent mode to use it.`);
        }
        let decision;
        try {
          decision = current().decision;
        } catch {
          decision = "GO";
        }
        if (decision === "STOP") {
          throw new Error(`[${PLUGIN_NAME}] blocked: quota limit exceeded. ${current().advice}`);
        }
      },
      // ACT(2) inject coaching into system prompt — ONLY in the harness agent mode,
      // so other modes' system prompts stay completely clean. Silent on error.
      "experimental.chat.system.transform": async (_input, output) => {
        try {
          if (_input.sessionID) {
            const agent = await resolveAgent(input.client, _input.sessionID);
            refreshBackground();
            if (!isHarnessAgent(agent)) return;
          }
          const c = current();
          let instruction = "";
          if (c.decision === "STOP") instruction = `[${PLUGIN_NAME}] QUOTA limit exceeded. ${c.advice} Stop making further tool calls, finish the in-progress work, then report the quota status to the user.`;
          else if (c.decision === "THROTTLE") instruction = `[${PLUGIN_NAME}] ${c.advice} Hold off on long/heavy tasks.`;
          else if (c.weekly >= 0) instruction = `[${PLUGIN_NAME}] quota ok \u2014 weekly ${c.weekly}% \xB7 5h ${c.fiveHour}% \xB7 monthly ${c.monthly}%.`;
          if (instruction) output.system.push(instruction);
        } catch (e) {
          log(`system.transform err: ${String(e)}`);
        }
      },
      // Custom tools for the harness agent mode — report status to the panel.
      tool: {
        harness_start: tool({
          description: "Start the harness: register the total task count on the panel. Call once when the harness loop begins. IMPORTANT: each generate/generate_batch sub-session is step-limited (default 30). If any task seems too large, split it into smaller subtasks BEFORE starting \u2014 oversized tasks will timeout.",
          args: { name: tool.schema.string(), total: tool.schema.number() },
          async execute(args, ctx) {
            writeHarness(ctx.sessionID, { name: args.name, total: args.total, current: 0, tasks: [], usage: {}, active: true, scanRequired: true, startedAt: (/* @__PURE__ */ new Date()).toISOString() });
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

PATH A \u2014 INDEPENDENT (parallel via generate_batch):
  1. task_update(1..${args.total}, title, "generating")
  2. generate_batch({tasks: [{id:1, prompt:"Task: <title1>. Perform it."}, ...]})  -> all results + NEXT
  3. for each i: task_update(i, title, "grading") + grade({prompt:"Evaluate... PASS/FAIL first line. Task: <title>"})  -> verdict + NEXT
  4. for each i: PASS -> task_update(i, title, "completed", "PASS"); FAIL -> revise (up to 2x) or task_update(i, title, "failed", "FAIL")

PATH B \u2014 DEPENDENT (sequential):
  for i in 1..${args.total}:
    1. task_update(i, title, "generating")
    2. generate({prompt:"Task: <title>. Perform it."})  -> work + NEXT
    3. task_update(i, title, "grading")
    4. grade(...)  -> verdict + NEXT
    5. PASS -> task_update(i, title, "completed", "PASS"); FAIL -> revise (up to 2x) or failed

Then: harness_done(). Follow the [usage-coach NEXT] directive each tool returns. Do NOT improvise the sequence.`;
          }
        }),
        unknown_scan: tool({
          description: "Pre-flight gap analysis: call AFTER harness_start, BEFORE generate. Scans the codebase against the user's request to find blind spots (unknown unknowns) that could waste 30+ steps if discovered late. Returns identified unknowns + task split suggestions + user confirmation questions. Writes results to harness.json for TUI display.",
          args: {
            prompt: tool.schema.string().describe("The user's original request (the full prompt that triggered the harness)."),
            tasks: tool.schema.array(tool.schema.object({ id: tool.schema.number(), title: tool.schema.string() })).optional().describe("Tasks registered via harness_start (id + title). If omitted, a single task derived from the prompt is assumed."),
            skip_scan: tool.schema.boolean().optional().describe("true: skip codebase scan and do prompt analysis only (default false; auto-skips for dirs with <5 files).")
          },
          async execute(args, ctx) {
            const tasks = args.tasks && args.tasks.length > 0 ? args.tasks : [{ id: 1, title: args.prompt.slice(0, 80) }];
            let profile;
            if (args.skip_scan) {
              profile = { skipped: true, reason: "skip_scan requested", language: "unknown", frameworks: [], structure: [], manifestFiles: [], keyDeps: [], configFiles: [], totalFiles: 0 };
            } else {
              try {
                const dir = ctx.directory || ".";
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
                profile = parseFileList(fileList, ctx.directory);
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
            const cfg = readHarnessCfg(ctx.directory);
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
              writeUnknownScan(ctx.sessionID, result2);
              return formatReport(result2) + '\n\nERROR: no generator model configured. Set "generator" in harness.config.json for model-assisted analysis.';
            }
            let decision = "GO";
            try {
              decision = current().decision;
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
              writeUnknownScan(ctx.sessionID, result2);
              return formatReport(result2) + "\n\n[usage-coach] quota STOP \u2014 model-assisted analysis skipped. Proceed with caution.";
            }
            const throttle = decision === "THROTTLE" && cfg.lighterModel;
            const model = throttle ? cfg.lighterModel : cfg.generator;
            const gapPrompt = buildGapPrompt(args.prompt, tasks, profile, domainNodes, webResults, docRefs);
            const raw = await runModel(input.client, model, gapPrompt, ctx.directory, void 0, 15);
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
            writeUnknownScan(ctx.sessionID, result);
            return formatReport(result);
          }
        }),
        question: tool({
          description: "Present unknown_scan questions to the user. REQUIRED after unknown_scan finds questions \u2014 call BEFORE generate. First call (no answers) returns the questions formatted for presentation. Present them to the user, then call again with their answers.",
          args: {
            answers: tool.schema.record(tool.schema.string(), tool.schema.string()).optional().describe(`User's answers keyed by question ID (e.g. {"Q1": "yes", "Q2": "node"}). Omit on first call to get the questions.`)
          },
          async execute(args, ctx) {
            const h = readHarness(ctx.sessionID);
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
            writeHarness(ctx.sessionID, h);
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
        }),
        task_update: tool({
          description: "Update a harness task's status on the panel. Call whenever a task transitions to generating/grading/revising/completed/failed.",
          args: {
            id: tool.schema.number(),
            title: tool.schema.string(),
            status: tool.schema.string().describe("generating | grading | revising | completed | failed | timed_out"),
            revisions: tool.schema.number().optional(),
            score: tool.schema.string().optional().describe("PASS | FAIL"),
            model: tool.schema.string().optional()
          },
          async execute(args, ctx) {
            const VALID_STATUSES = ["generating", "grading", "revising", "completed", "failed", "timed_out", "halted_quota"];
            if (!args.status || !VALID_STATUSES.includes(args.status)) {
              return `ERROR: task_update status must be one of: ${VALID_STATUSES.join(", ")}. Got: "${args.status}". Call task_update with a valid status.`;
            }
            const cfg = readHarnessCfg(ctx.directory);
            const h = readHarness(ctx.sessionID) ?? { name: "batch", total: 0, current: 0, tasks: [], usage: {}, active: true };
            h.tasks = h.tasks.filter((x) => x.id !== args.id);
            const model = args.model || cfg.generator || "";
            if (!model) return `ERROR: task ${args.id} has no model and no generator configured. Set "generator" in harness.config.json.`;
            h.tasks.push({ id: args.id, title: args.title, status: args.status, model, revisions: args.revisions ?? 0, score: args.score ?? null, startedAt: (/* @__PURE__ */ new Date()).toISOString() });
            if (args.id > h.current) h.current = args.id;
            writeHarness(ctx.sessionID, h);
            return `task ${args.id} -> ${args.status}${args.score ? ` (${args.score})` : ""}`;
          }
        }),
        harness_done: tool({
          description: "Mark the harness as complete \u2014 call when the loop ends.",
          args: {},
          async execute(_args, ctx) {
            const h = readHarness(ctx.sessionID);
            if (h) {
              h.current = h.total;
              h.active = false;
              writeHarness(ctx.sessionID, h);
            }
            return "Harness complete.";
          }
        }),
        record_failure: tool({
          description: "Stage 1 (RECORD) of the learning loop. Append a failure record to failures.ndjson for later root-cause analysis.",
          args: {
            task: tool.schema.string(),
            prompt: tool.schema.string(),
            gradeResult: tool.schema.string(),
            model: tool.schema.string().optional(),
            revisions: tool.schema.number().optional()
          },
          async execute(args, _ctx) {
            const rec = { ts: (/* @__PURE__ */ new Date()).toISOString(), task: args.task, prompt: args.prompt, gradeResult: args.gradeResult, model: args.model, revisions: args.revisions };
            try {
              mkdirSync2(STATE_DIR, { recursive: true });
              appendFileSync2(failuresFile(), JSON.stringify(rec) + "\n");
            } catch (e) {
              log(`record_failure err: ${String(e)}`);
            }
            return `Failure recorded. [usage-coach NEXT] call investigate({failure: ${JSON.stringify(rec)}}) to find the root cause.`;
          }
        }),
        investigate: tool({
          description: "Stage 2 (INVESTIGATE) of the learning loop. Run the generator to analyze the ROOT CAUSE of a failure (not just the symptom).",
          args: {
            task: tool.schema.string(),
            prompt: tool.schema.string(),
            gradeResult: tool.schema.string(),
            model: tool.schema.string().optional()
          },
          async execute(args, ctx) {
            const cfg = readHarnessCfg(ctx.directory);
            if (!cfg.generator) return 'ERROR: no generator model configured. Set "generator" in harness.config.json (see harness.config.example.json).';
            let domainPrefix = "";
            let keywords = [];
            let domainEmpty = true;
            try {
              keywords = extractKeywords(`${args.task} ${args.gradeResult}`);
              if (keywords.length) {
                const { nodes, edges } = queryDomain(keywords);
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
            const invTaskId = findActiveTaskId(ctx.sessionID, "revising");
            const out = await runModel(
              input.client,
              cfg.generator,
              domainPrefix + rcaPrompt,
              ctx.directory,
              invTaskId ? { sessionID: ctx.sessionID, taskId: invTaskId } : void 0
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
        }),
        verify_diagnosis: tool({
          description: "Stage 3 (VERIFY) of the learning loop. Run the grader to check whether a diagnosis is CORRECT and ACTIONABLE (leads to a useful rule). Returns PASS/FAIL + a [usage-coach NEXT] directive.",
          args: {
            diagnosis: tool.schema.string(),
            task: tool.schema.string(),
            gradeResult: tool.schema.string()
          },
          async execute(args, ctx) {
            const cfg = readHarnessCfg(ctx.directory);
            const model = cfg.grader ?? cfg.generator;
            if (!model) return "FAIL\n(ERROR: no grader/generator model configured.)\n[usage-coach NEXT] configure grader in harness.config.json, then retry verify_diagnosis.";
            const verifyPrompt = `Verify this root-cause analysis for a failure.
Task: ${args.task}
Grade feedback: ${args.gradeResult}
Diagnosis: ${args.diagnosis}
Is the diagnosis CORRECT and ACTIONABLE (leads to a useful rule)?
Output PASS (the diagnosis is right) or FAIL (re-investigate needed), then reason.`;
            const verTaskId = findActiveTaskId(ctx.sessionID, "revising");
            const out = await runModel(
              input.client,
              model,
              verifyPrompt,
              ctx.directory,
              verTaskId ? { sessionID: ctx.sessionID, taskId: verTaskId } : void 0
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
        }),
        generalize: tool({
          description: "Stage 4 (GENERALIZE) of the learning loop. Run the generator to turn a verified root cause into a reusable rule and append it to rules.md, so the next generate call includes it. Returns the rule text and a [usage-coach NEXT] directive.",
          args: {
            diagnosis: tool.schema.string(),
            task: tool.schema.string()
          },
          async execute(args, ctx) {
            const cfg = readHarnessCfg(ctx.directory);
            if (!cfg.generator) return 'ERROR: no generator model configured. Set "generator" in harness.config.json (see harness.config.example.json).';
            const genPrompt = `Turn this verified root cause into a GENERAL, REUSABLE rule for future tasks of this kind.
Diagnosis: ${args.diagnosis}
Failed task: ${args.task}
Output a single rule in the form: 'For <task-type> tasks, always <check/do X> because <reason>.'
Keep it concrete and actionable.`;
            const genRuleTaskId = findActiveTaskId(ctx.sessionID, "revising");
            const out = await runModel(
              input.client,
              cfg.generator,
              genPrompt,
              ctx.directory,
              genRuleTaskId ? { sessionID: ctx.sessionID, taskId: genRuleTaskId } : void 0
            );
            const rule = out;
            try {
              const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
              mkdirSync2(STATE_DIR, { recursive: true });
              appendFileSync2(rulesFile(), `## Rule (${date})
${rule}
Origin: ${args.task}

`);
            } catch (e) {
              log(`generalize err: ${String(e)}`);
            }
            return `${rule}
[usage-coach NEXT] rule saved to rules.md. The next generate call will include it. Call task_update for the original failed task -> failed, then proceed.`;
          }
        }),
        // Per-role model execution (config-driven, quota-aware, same server, no deadlock).
        // P1: quota decision drives model selection + concurrency.
        generate: tool({
          description: "Run the GENERATOR model on a prompt. Quota-aware: on THROTTLE, auto-switches to lighterModel if configured. Returns the model's text response. Step-limited: aborts after max_steps (default 30) to prevent runaway tasks.",
          args: { prompt: tool.schema.string(), max_steps: tool.schema.number().optional().describe("Maximum sub-session steps before timeout (default 30). Increase for complex tasks, decrease to fail fast on scope creep.") },
          async execute(args, ctx) {
            const cfg = readHarnessCfg(ctx.directory);
            if (!cfg.generator) {
              const h = readHarness(ctx.sessionID);
              if (h) {
                h.active = false;
                writeHarness(ctx.sessionID, h);
              }
              return 'ERROR: no generator model configured. Set "generator" in harness.config.json (see harness.config.example.json). HARNESS TERMINATED \u2014 configure a generator model, then restart the harness.';
            }
            let decision = "GO";
            try {
              decision = current().decision;
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
            try {
              keywords = extractKeywords(args.prompt);
              if (keywords.length) {
                const { nodes, edges } = queryDomain(keywords);
                if (nodes && nodes.length || edges && edges.length) {
                  domainEmpty = false;
                  prefix = `Known facts from domain DB: ${JSON.stringify({ nodes, edges })}. Use these if relevant.

---

` + prefix;
                }
              }
            } catch (e) {
              log(`generate domain query err: ${String(e)}`);
            }
            try {
              const priorNotes = keywords.length ? readImplNotesByGraph(keywords, 5) : readImplNotes(5);
              if (priorNotes) {
                prefix = `Notes from previous runs (context for this task):
${priorNotes}

---

` + prefix;
              }
            } catch (e) {
              log(`generate impl-notes read err: ${String(e)}`);
            }
            prefix += IMPL_NOTE_INSTRUCTION;
            const gate = checkScanGate(ctx.sessionID);
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
            const genTaskId = findActiveTaskId(ctx.sessionID, "generating");
            const maxSteps = args.max_steps ?? DEFAULT_MAX_STEPS;
            const out = await runModel(
              input.client,
              model,
              prefix + args.prompt,
              ctx.directory,
              genTaskId ? { sessionID: ctx.sessionID, taskId: genTaskId } : void 0,
              maxSteps
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
        }),
        generate_batch: tool({
          description: "Run the GENERATOR model on MULTIPLE tasks. Quota-aware: GO = full parallel; THROTTLE = lighter model + concurrency capped at 2; STOP = refused. Use for INDEPENDENT tasks. Step-limited: each sub-session aborts after max_steps (default 30). Resilient: failed tasks are retried sequentially (once); if retry also fails, re-run them individually with generate().",
          args: { tasks: tool.schema.array(tool.schema.object({ id: tool.schema.number(), prompt: tool.schema.string() })), max_steps: tool.schema.number().optional().describe("Maximum sub-session steps per task before timeout (default 30).") },
          async execute(args, ctx) {
            const cfg = readHarnessCfg(ctx.directory);
            if (!cfg.generator) {
              const h = readHarness(ctx.sessionID);
              if (h) {
                h.active = false;
                writeHarness(ctx.sessionID, h);
              }
              return 'ERROR: no generator model configured. Set "generator" in harness.config.json (see harness.config.example.json). HARNESS TERMINATED \u2014 configure a generator model, then restart the harness.';
            }
            let decision = "GO";
            try {
              decision = current().decision;
            } catch {
            }
            if (decision === "STOP") return 'ERROR: quota STOP \u2014 halt the harness loop now. Call task_update(current, "halted_quota") and stop.';
            const throttle = decision === "THROTTLE" && cfg.lighterModel;
            const model = throttle ? cfg.lighterModel : cfg.generator;
            const limit = decision === "THROTTLE" ? 2 : args.tasks.length;
            const rules = readRules();
            const priorNotes = readImplNotes(5);
            const maxSteps = args.max_steps ?? DEFAULT_MAX_STEPS;
            const gate = checkScanGate(ctx.sessionID);
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
                input.client,
                model,
                prefix + t.prompt,
                ctx.directory,
                { sessionID: ctx.sessionID, taskId: t.id },
                maxSteps
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
                  failed.push({ id: t.id, prompt: t.prompt, error: err });
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
        }),
        grade: tool({
          description: "Run the GRADER model on a prompt. Returns PASS/FAIL on the first line + a [usage-coach NEXT] directive. Falls back to generator if grader quota is out.",
          args: { prompt: tool.schema.string() },
          async execute(args, ctx) {
            const cfg = readHarnessCfg(ctx.directory);
            const model = cfg.grader ?? cfg.generator;
            if (!model) return "FAIL\n(ERROR: no grader/generator model configured.)\n[usage-coach NEXT] configure grader in harness.config.json, then retry grade.";
            const gradeTaskId = findActiveTaskId(ctx.sessionID, "grading");
            const out = await runModel(
              input.client,
              model,
              args.prompt,
              ctx.directory,
              gradeTaskId ? { sessionID: ctx.sessionID, taskId: gradeTaskId } : void 0
            );
            let verdict = "FAIL";
            if (!out.startsWith("ERROR:")) {
              const f = (out.split("\n").find((l) => l.trim()) ?? "").trim();
              if (/^pass\b/i.test(f)) verdict = "PASS";
              else if (/^fail\b/i.test(f)) verdict = "FAIL";
              else verdict = "FAIL";
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
        }),
        reverse_interview: tool({
          description: "Reverse interview: identify ambiguities in the task and ask the user one question at a time, highest design-impact first. Call WITHOUT answer to start or get the next question. Call WITH answer to record the user's response and advance. Returns the next question or a completion summary. ALWAYS present the question to the user verbatim \u2014 do NOT answer it yourself.",
          args: {
            task: tool.schema.string().describe(
              "The current task description (what the user asked for)."
            ),
            context: tool.schema.string().optional().describe(
              "Additional context from unknown_scan, codebase exploration, or prior turns. Injected into the question-generation prompt for better prioritization."
            ),
            answer: tool.schema.string().optional().describe(
              "The user's response to the previous question. Omit on the first call (or when there is no answer to record)."
            ),
            force_complete: tool.schema.boolean().optional().describe(
              "Force the interview to end now and return the summary. Use when the user says 'that's enough' or 'just proceed'."
            )
          },
          async execute(args, ctx) {
            const sessionID = ctx.sessionID;
            const cfg = readHarnessCfg(ctx.directory);
            const resolveModel = () => {
              if (!cfg.generator) return null;
              let decision = "GO";
              try {
                decision = current().decision;
              } catch {
              }
              const throttle = decision === "THROTTLE" && cfg.lighterModel;
              return throttle ? cfg.lighterModel : cfg.generator;
            };
            let state = readInterview(sessionID);
            if (args.force_complete) {
              if (state && state.phase !== "complete") {
                return await completeInterview(state, sessionID, input.client, resolveModel(), ctx.directory);
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
                return await completeInterview(state, sessionID, input.client, resolveModel(), ctx.directory);
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
              const out = await runModel(input.client, model, planningPrompt, ctx.directory);
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
        }),
        coach_config: tool({
          description: 'View or update harness model configuration (generator, grader, lighterModel, provider). Call with no args to view current config. Pass any combination of generator/grader/lighterModel/provider to update. Example: coach_config({ generator: "anthropic/claude-sonnet-4-20250514", grader: "opencode/mimo-v2.5-free" })',
          args: {
            generator: tool.schema.string().optional(),
            grader: tool.schema.string().optional(),
            lighterModel: tool.schema.string().optional(),
            provider: tool.schema.string().optional()
          },
          async execute(args, ctx) {
            const dir = ctx?.directory ?? input.directory;
            const current2 = readHarnessCfg(dir);
            const hasUpdates = args.generator !== void 0 || args.grader !== void 0 || args.lighterModel !== void 0 || args.provider !== void 0;
            if (!hasUpdates) {
              const envOverrides = [];
              if (process.env.UC_PROVIDER) envOverrides.push(`UC_PROVIDER=${process.env.UC_PROVIDER}`);
              if (process.env.UC_LIGHTER_MODEL) envOverrides.push(`UC_LIGHTER_MODEL=${process.env.UC_LIGHTER_MODEL}`);
              return [
                `Harness Configuration`,
                `\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`,
                `  generator:     ${current2.generator ?? "(not set \u2014 harness won't work!)"}`,
                `  grader:        ${current2.grader ?? "(defaults to generator)"}`,
                `  lighterModel:  ${current2.lighterModel ?? "(not set \u2014 no THROTTLE fallback)"}`,
                `  provider:      ${current2.provider ?? "(auto-detected from model)"}`,
                `\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`,
                envOverrides.length > 0 ? `
Environment overrides (take precedence):
  ${envOverrides.join("\n  ")}` : "",
                `
Config file: ~/.config/opencode-usage-coach/harness.config.json`,
                `
To update, call: coach_config({ generator: "provider/model-id", ... })`
              ].filter(Boolean).join("\n");
            }
            const updates = {};
            if (args.generator !== void 0) updates.generator = args.generator.trim();
            if (args.grader !== void 0) updates.grader = args.grader.trim();
            if (args.lighterModel !== void 0) updates.lighterModel = args.lighterModel.trim();
            if (args.provider !== void 0) updates.provider = args.provider.trim();
            const writtenPath = writeHarnessCfg(updates);
            const updated = readHarnessCfg(dir);
            return [
              `\u2705 Harness config updated successfully!`,
              `\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`,
              `  generator:     ${updated.generator ?? "(not set)"}`,
              `  grader:        ${updated.grader ?? "(defaults to generator)"}`,
              `  lighterModel:  ${updated.lighterModel ?? "(not set)"}`,
              `  provider:      ${updated.provider ?? "(auto-detected)"}`,
              `\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`,
              `
Saved to: ${writtenPath}`,
              `
Note: Changes take effect immediately for new generate/grade calls.`,
              `       A running harness will pick up the new config on the next tool call.`
            ].join("\n");
          }
        })
      }
    };
  } catch (e) {
    pipeLog(`PLUGIN INIT FAILED (no-op): ${String(e)}`);
    log(`PLUGIN INIT FAILED (no-op): ${String(e)}`);
    return NOOP_HOOKS;
  }
}
export {
  buildGapPrompt,
  buildScanSummary,
  checkScanGate,
  clearSubSession,
  coach,
  UsageCoachPlugin as default,
  detectLanguage,
  extractImplNotes,
  extractKeywords,
  findActiveTaskId,
  formatReport,
  humanRemaining,
  isFreeModel,
  isHarnessAgent,
  parseFileList,
  parseGapAnalysis,
  parseQuotaResponse,
  providerAdvice,
  providerToCodexbar,
  readHarness,
  readHarnessCfg,
  readRules,
  UsageCoachPlugin as server,
  setStateDir,
  updateSubSession,
  writeHarness,
  writeHarnessCfg
};
