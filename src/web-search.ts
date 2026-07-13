// web-search.ts — 3-tier web search module (official docs → GitHub issues → GitHub code).
// Standalone: only uses the Node.js global fetch (Node 22+). No imports from index.ts.
//   - Tier 1: static doc references (FRAMEWORK_DOCS) + org-scoped GitHub issue search.
//   - Tier 2: general GitHub issue search (q + sort=relevance, per_page=5).
//   - Tier 3: GitHub code search (per_page=3) — requires GITHUB_TOKEN / GH_TOKEN, skipped if absent.
// Defensive design: never throws — always returns a WebSearchResponse. Each tier is wrapped
// in try/catch; failures are logged via console.error and execution continues to the next tier.
// Tiers run SEQUENTIALLY (GitHub secondary rate limits trigger on bursts); stops once 5+ results.

export interface WebResult {
  tier: "official-docs" | "github-issues" | "github-code";
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResponse {
  results: WebResult[];
  docRefs: Array<{ name: string; url: string }>;
  error?: string;
}

export const FRAMEWORK_DOCS: Record<
  string,
  { name: string; docs: string; githubOrg?: string }
> = {
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
  "cloudflare": { name: "Cloudflare", docs: "https://developers.cloudflare.com", githubOrg: "cloudflare" },
};

const DEFAULT_TIMEOUT_MS = 8000;
const TARGET_RESULT_COUNT = 5;
const GH_QUERY_MAX = 256; // GitHub Search API limit on the `q` parameter.

function ghToken(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
}

function ghHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "opencode-usage-coach",
  };
  const token = ghToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function truncate(input: string | null | undefined, max: number): string {
  const text = (input ?? "").replace(/[\r\n]+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** Sanitize a raw query string for GitHub Search API compliance.
 *  GitHub Search interprets `:` as qualifier separator, `>`/`<`/`=` as operators,
 *  `-word` as negation, `"..."` as exact match, `NOT`/`AND`/`OR` as boolean.
 *  Any of these in a free-text query can cause 422 Unprocessable Entity.
 *  Solution: extract only keyword tokens (alphanumeric + CJK), drop everything else.
 *  Per GitHub docs: https://docs.github.com/en/search-github/getting-started-with-searching-on-github/understanding-the-search-syntax
 *  Returns empty string if nothing meaningful remains — caller should skip the search. */
function sanitizeQuery(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, " ")   // code blocks first
    .replace(/`[^`]*`/g, " ")           // inline code
    .replace(/https?:\/\/\S+/g, " ")    // URLs
    // Keep only word characters, CJK, and spaces. Strip ALL GitHub qualifier syntax.
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(NOT|AND|OR)\b/gi, " ") // GitHub boolean operators
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, GH_QUERY_MAX);
}

function effectiveFrameworks(frameworks: string[], keyDeps?: string[]): string[] {
  const set = new Set((frameworks || []).filter(Boolean));
  if (keyDeps) {
    for (const dep of keyDeps) {
      if (dep === "wrangler" || dep.startsWith("@cloudflare/")) set.add("cloudflare");
    }
  }
  return [...set];
}

async function ghFetch<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { headers: ghHeaders(), signal });
  if (!res.ok) {
    // Read GitHub's error body — it contains the exact validation failure.
    let ghError: any = null;
    let ghErrorText = "";
    try {
      ghErrorText = await res.text();
      ghError = JSON.parse(ghErrorText);
    } catch { /* not JSON */ }

    // Build a complete diagnostic for debugging 422/403/etc.
    const tag = res.status === 403 || res.status === 429 ? " (rate limit)" :
                res.status === 422 ? " (validation failed)" : "";
    const errs = ghError?.errors;
    const errMsg = ghError?.message ?? ghErrorText.slice(0, 300);
    const detail = errs
      ? errs.map((e: any) => typeof e === "string" ? e : `${e?.field ?? "?"}: ${e?.message ?? e?.code ?? JSON.stringify(e)}`).join("; ")
      : "";

    console.error(JSON.stringify({
      level: "error",
      module: "web-search",
      event: "gh-fetch-error",
      status: res.status,
      tag,
      url,
      ghMessage: errMsg,
      ghErrors: detail,
      rateLimitRemaining: res.headers.get("x-ratelimit-remaining"),
      rateLimitReset: res.headers.get("x-ratelimit-reset"),
    }));

    throw new Error(`HTTP ${res.status}${tag}: ${errMsg}${detail ? ` | ${detail}` : ""}`);
  }
  return (await res.json()) as T;
}

function pushResult(results: WebResult[], seen: Set<string>, r: WebResult): void {
  if (r.url && !seen.has(r.url)) {
    seen.add(r.url);
    results.push(r);
  }
}

// ── Tier 1: official docs (static refs) + org-scoped GitHub issue search ──────────
async function tier1OfficialDocs(
  query: string,
  fws: string[],
  results: WebResult[],
  docRefs: Array<{ name: string; url: string }>,
  seen: Set<string>,
  signal: AbortSignal,
): Promise<string[]> {
  const errors: string[] = [];
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
      // org: is a GitHub qualifier WE control — don't sanitize it.
      // Only sanitize the user's free-text query (which may contain colons, etc.).
      const fullQ = `${cleanQuery} org:${entry.githubOrg}`;
      const url = `https://api.github.com/search/issues?q=${encodeURIComponent(fullQ)}&per_page=3`;
      const data = await ghFetch<{
        items?: Array<{ title: string; html_url: string; body: string | null }>;
      }>(url, signal);
      for (const item of data.items ?? []) {
        pushResult(results, seen, {
          tier: "official-docs",
          title: item.title,
          url: item.html_url,
          snippet: truncate(item.body, 200),
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

// ── Tier 2: general GitHub issue search ──────────────────────────────────────────
async function tier2GitHubIssues(
  query: string,
  results: WebResult[],
  seen: Set<string>,
  signal: AbortSignal,
): Promise<string[]> {
  const errors: string[] = [];
  try {
    const q = sanitizeQuery(query);
    if (!q) return errors;
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=5`;
    const data = await ghFetch<{
      items?: Array<{ title: string; html_url: string; body: string | null }>;
    }>(url, signal);
    for (const item of data.items ?? []) {
      pushResult(results, seen, {
        tier: "github-issues",
        title: item.title,
        url: item.html_url,
        snippet: truncate(item.body, 200),
      });
    }
  } catch (e) {
    const m = errMessage(e);
    console.error(`[web-search] tier2: ${m}`);
    errors.push(`tier2:${m.slice(0, 80)}`);
  }
  return errors;
}

// ── Tier 3: GitHub code search (requires auth) ───────────────────────────────────
async function tier3GitHubCode(
  query: string,
  results: WebResult[],
  seen: Set<string>,
  signal: AbortSignal,
): Promise<string[]> {
  const errors: string[] = [];
  if (!ghToken()) return errors; // skip — code search requires authentication
  try {
    const q = sanitizeQuery(query);
    if (!q) return errors;
    const url = `https://api.github.com/search/code?q=${encodeURIComponent(q)}&per_page=3`;
    const data = await ghFetch<{
      items?: Array<{
        name: string;
        path: string;
        html_url: string;
        repository?: { full_name?: string };
      }>;
    }>(url, signal);
    for (const item of data.items ?? []) {
      const repo = item.repository?.full_name;
      pushResult(results, seen, {
        tier: "github-code",
        title: item.path || item.name,
        url: item.html_url,
        snippet: repo ? `${repo} — ${item.path}` : item.path,
      });
    }
  } catch (e) {
    const m = errMessage(e);
    console.error(`[web-search] tier3: ${m}`);
    errors.push(`tier3:${m.slice(0, 80)}`);
  }
  return errors;
}

// ── Public entry point ───────────────────────────────────────────────────────────
export async function searchContext(
  query: string,
  frameworks: string[],
  keyDeps?: string[],
  timeoutMs?: number,
): Promise<WebSearchResponse> {
  const results: WebResult[] = [];
  const docRefs: Array<{ name: string; url: string }> = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  const timeout = Math.max(100, Number(timeoutMs ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const signal = controller.signal;

  try {
    const q = (query || "").trim();
    const fws = effectiveFrameworks(frameworks, keyDeps);

    errors.push(...(await tier1OfficialDocs(q, fws, results, docRefs, seen, signal)));
    if (q && results.length < TARGET_RESULT_COUNT && !signal.aborted) {
      errors.push(...(await tier2GitHubIssues(q, results, seen, signal)));
    }
    if (q && results.length < TARGET_RESULT_COUNT && !signal.aborted) {
      errors.push(...(await tier3GitHubCode(q, results, seen, signal)));
    }
  } catch (e) {
    const m = errMessage(e);
    console.error(`[web-search] unexpected error: ${m}`);
    errors.push(`unexpected:${m.slice(0, 80)}`);
  } finally {
    clearTimeout(timer);
  }

  const response: WebSearchResponse = { results, docRefs };
  const joined = errors.filter(Boolean).join("; ");
  if (joined) response.error = joined;
  return response;
}
