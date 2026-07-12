// web-search.test.ts — unit tests for the web search module (src/web-search.ts).
// Uses node:test + node:assert/strict (same style as domain.test.ts / index.test.ts).
//
// Mocks global fetch via globalThis.fetch replacement in beforeEach/afterEach.
// No real network calls are made — all fetch responses are synthetic.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { searchContext, FRAMEWORK_DOCS } from "../src/web-search.js";

// ── Mock fetch infrastructure ────────────────────────────────────────────────

interface MockCall {
  url: string;
  headers: Record<string, string>;
}

let savedFetch: typeof globalThis.fetch;
let fetchCalls: MockCall[];
let fetchHandler: ((url: string, init?: any) => Promise<any>) | null;

/** Extract URL string from fetch input (string | URL | Request). */
function getUrl(input: any): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input?.url) return input.url;
  return String(input);
}

/** Normalize fetch headers (Headers | object | array) into a lowercased-key object. */
function normalizeHeaders(h: any): Record<string, string> {
  if (!h) return {};
  if (typeof h.forEach === "function") {
    const obj: Record<string, string> = {};
    h.forEach((v: string, k: string) => { obj[k.toLowerCase()] = v; });
    return obj;
  }
  if (Array.isArray(h)) {
    const obj: Record<string, string> = {};
    for (const [k, v] of h) obj[String(k).toLowerCase()] = String(v);
    return obj;
  }
  const obj: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) obj[k.toLowerCase()] = String(v);
  return obj;
}

beforeEach(() => {
  savedFetch = globalThis.fetch;
  fetchCalls = [];
  fetchHandler = null;
  delete process.env.GITHUB_TOKEN;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = getUrl(input);
    fetchCalls.push({ url, headers: normalizeHeaders(init?.headers) });
    if (fetchHandler) return fetchHandler(url, init);
    return okResponse(ghSearchBody([]));
  }) as any;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  delete process.env.GITHUB_TOKEN;
  fetchHandler = null;
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** GitHub-style search response body. */
function ghSearchBody(items: Array<Record<string, unknown>>) {
  return { total_count: items.length, items };
}

/** A 200 OK fetch response with a JSON body. */
function okResponse(body: any) {
  return { ok: true, status: 200, json: async () => body };
}

/** An error-status fetch response. */
function errorResponse(status: number, body: any) {
  return { ok: false, status, json: async () => body };
}

/** True if the URL contains an `org:` scope qualifier (tier 1 org-scoped search). */
function isOrgScoped(url: string): boolean {
  return url.includes("org%3A") || url.includes("org:");
}

/** True if the URL targets GitHub code search (tier 3). */
function isCodeSearch(url: string): boolean {
  return url.includes("search/code");
}

/** True if the URL targets GitHub issues search (tiers 1 and 2). */
function isIssuesSearch(url: string): boolean {
  return url.includes("search/issues");
}

const VALID_TIERS = ["official-docs", "github-issues", "github-code"];

// ── Tests ────────────────────────────────────────────────────────────────────

// 1. Cloudflare framework → docRefs include docs URL; results have valid tiers.
test("searchContext with Cloudflare framework includes Cloudflare docs in docRefs", async () => {
  fetchHandler = async () =>
    okResponse(ghSearchBody([
      { title: "Workers KV guide", html_url: "https://github.com/cloudflare/workers/issues/1", body: "caching" },
    ]));

  const res = await searchContext("KV caching", ["cloudflare"]);

  assert.ok(res.docRefs.length > 0, "docRefs should not be empty for a known framework");
  const cf = res.docRefs.find((d) => d.name.toLowerCase().includes("cloudflare"));
  assert.ok(cf, "docRefs should include a Cloudflare entry");
  assert.ok(cf!.url.startsWith("https://"), "doc ref URL should be a valid https URL");

  assert.ok(res.results.length > 0, "should have results from mocked fetch");
  for (const r of res.results) {
    assert.ok(VALID_TIERS.includes(r.tier), `result tier should be valid, got: ${r.tier}`);
    assert.ok(typeof r.title === "string" && r.title.length > 0, "result should have a title");
    assert.ok(typeof r.url === "string" && r.url.length > 0, "result should have a url");
    assert.ok(typeof r.snippet === "string", "result should have a snippet");
  }
});

// 2. Cloudflare detected from keyDeps when frameworks list is empty.
test("Cloudflare detected from keyDeps when frameworks list is empty", async () => {
  fetchHandler = async () => okResponse(ghSearchBody([]));

  const res = await searchContext("KV storage", [], ["wrangler", "@cloudflare/workers-types"]);

  assert.ok(res.docRefs.length > 0, "docRefs should not be empty when Cloudflare detected from keyDeps");
  const cf = res.docRefs.find((d) => d.name.toLowerCase().includes("cloudflare"));
  assert.ok(cf, "Cloudflare should be detected from keyDeps and appear in docRefs");
});

// 3. Tier priority — official-docs results appear before github-issues.
test("tier priority: official-docs results appear before github-issues", async () => {
  const docsItems = [
    { title: "Official Doc A", html_url: "https://example.com/a" },
    { title: "Official Doc B", html_url: "https://example.com/b" },
    { title: "Official Doc C", html_url: "https://example.com/c" },
  ];
  const issuesItems = [
    { title: "Issue X", html_url: "https://example.com/x" },
    { title: "Issue Y", html_url: "https://example.com/y" },
    { title: "Issue Z", html_url: "https://example.com/z" },
  ];

  fetchHandler = async (url) => {
    if (isIssuesSearch(url) && isOrgScoped(url)) {
      return okResponse(ghSearchBody(docsItems)); // Tier 1: org-scoped
    }
    if (isIssuesSearch(url)) {
      return okResponse(ghSearchBody(issuesItems)); // Tier 2: general
    }
    return okResponse(ghSearchBody([]));
  };

  const res = await searchContext("deployment", ["cloudflare"]);

  const docsResults = res.results.filter((r) => r.tier === "official-docs");
  const issuesResults = res.results.filter((r) => r.tier === "github-issues");

  assert.equal(docsResults.length, 3, "should have 3 official-docs results");
  assert.equal(issuesResults.length, 3, "should have 3 github-issues results");

  // All official-docs results must appear before all github-issues results.
  if (docsResults.length > 0 && issuesResults.length > 0) {
    const lastDocsIdx = res.results.indexOf(docsResults[docsResults.length - 1]);
    const firstIssuesIdx = res.results.indexOf(issuesResults[0]);
    assert.ok(
      lastDocsIdx < firstIssuesIdx,
      `official-docs results (idx ${lastDocsIdx}) should come before github-issues (idx ${firstIssuesIdx})`,
    );
  }
});

// 4. No GITHUB_TOKEN — tier 3 (code search) is skipped, tiers 1+2 still return.
test("without GITHUB_TOKEN, tier 3 code search is skipped", async () => {
  delete process.env.GITHUB_TOKEN;

  fetchHandler = async (url) => {
    if (isCodeSearch(url)) {
      return okResponse(ghSearchBody([
        { title: "Code hit", html_url: "https://github.com/x/y/blob/main/z.ts" },
      ]));
    }
    return okResponse(ghSearchBody([
      { title: "Issue hit", html_url: "https://github.com/org/repo/issues/1" },
    ]));
  };

  const res = await searchContext("rate limiting", ["cloudflare"]);

  const codeCalls = fetchCalls.filter((c) => isCodeSearch(c.url));
  assert.equal(codeCalls.length, 0, "should NOT make any code search calls without GITHUB_TOKEN");

  assert.ok(res.results.length > 0, "should still have results from tiers 1 and 2");
});

// 5. With GITHUB_TOKEN — tier 3 (code search) executes with Authorization header.
test("with GITHUB_TOKEN, tier 3 code search executes with auth header", async () => {
  process.env.GITHUB_TOKEN = "test-token-123";

  fetchHandler = async () =>
    okResponse(ghSearchBody([
      { title: "Result", html_url: "https://github.com/org/repo/issues/1", body: "snippet" },
    ]));

  await searchContext("authentication", ["cloudflare"]);

  const codeCalls = fetchCalls.filter((c) => isCodeSearch(c.url));
  assert.ok(codeCalls.length > 0, "should make at least one code search call with GITHUB_TOKEN");

  const codeCall = codeCalls[0];
  assert.ok(
    codeCall.headers.authorization,
    "code search call should include an Authorization header",
  );
  assert.ok(
    codeCall.headers.authorization.includes("test-token-123"),
    "Authorization header should contain the GITHUB_TOKEN value",
  );
});

// 6. Network error — graceful degradation, never throws.
test("network error (fetch throws) → graceful degradation without throwing", async () => {
  fetchHandler = async () => {
    throw new TypeError("fetch failed");
  };

  const res = await searchContext("anything", ["cloudflare"]);

  assert.ok(Array.isArray(res.results), "results should be an array even on network error");
  assert.equal(res.results.length, 0, "results should be empty on network error");
  assert.ok(Array.isArray(res.docRefs), "docRefs should be present even on network error");
  // error field may be set with tier failure messages — that's diagnostic, not a crash.
  // The key invariant: searchContext never throws, always returns a valid WebSearchResponse.
});

// 7. GitHub 403 rate limit — graceful degradation with partial or empty results.
test("GitHub 403 rate limit → graceful degradation", async () => {
  fetchHandler = async () => errorResponse(403, { message: "API rate limit exceeded" });

  const res = await searchContext("throttled query", ["cloudflare"]);

  assert.ok(Array.isArray(res.results), "results should be an array even on 403");
  assert.ok(Array.isArray(res.docRefs), "docRefs should be present even on 403");
  // docRefs come from FRAMEWORK_DOCS (not network), so should still be populated.
  assert.ok(res.docRefs.length > 0, "docRefs should be populated from framework config regardless of 403");
});

// 8. Timeout handling — searchContext returns quickly when fetch exceeds timeoutMs.
test("timeout: searchContext returns quickly when fetch exceeds timeoutMs", async () => {
  fetchHandler = async (_url, init) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => resolve(okResponse(ghSearchBody([
          { title: "Late result", html_url: "https://example.com/late" },
        ]))),
        500,
      );
      const signal = init?.signal;
      if (signal) {
        if (signal.aborted) { clearTimeout(timer); reject(new Error("aborted")); return; }
        signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); });
      }
    });

  const start = Date.now();
  const res = await searchContext("slow query", ["cloudflare"], undefined, 100);
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 350, `should return well under the 500ms mock delay (timeout 100ms), took ${elapsed}ms`);
  assert.ok(Array.isArray(res.docRefs), "docRefs should always be present");
  assert.ok(Array.isArray(res.results), "results should always be an array");
});

// 9. FRAMEWORK_DOCS has entries for common frameworks with name, docs, and githubOrg.
test("FRAMEWORK_DOCS has entries for hono, react, and express", () => {
  for (const key of ["hono", "react", "express"]) {
    const entry = FRAMEWORK_DOCS[key];
    assert.ok(entry, `FRAMEWORK_DOCS should have an entry for '${key}'`);
    assert.ok(typeof entry!.name === "string" && entry!.name.length > 0, `'${key}' entry should have a name`);
    assert.ok(typeof entry!.docs === "string" && entry!.docs.length > 0, `'${key}' entry should have a docs URL`);
    assert.ok(entry!.docs.startsWith("https://"), `'${key}' docs URL should start with https://`);
    assert.ok(entry!.githubOrg, `'${key}' entry should have a githubOrg`);
    assert.ok(typeof entry!.githubOrg === "string", `'${key}' githubOrg should be a string`);
  }
});

// 10. Empty frameworks + empty keyDeps → docRefs empty, tier 1 skipped, tier 2 runs.
test("empty frameworks and keyDeps: docRefs empty, tier 1 skipped, tier 2 still runs", async () => {
  fetchHandler = async () =>
    okResponse(ghSearchBody([
      { title: "General result", html_url: "https://github.com/some/repo/issues/1" },
    ]));

  const res = await searchContext("general query", [], []);

  assert.equal(res.docRefs.length, 0, "docRefs should be empty with no frameworks detected");

  // Tier 1 (org-scoped) should NOT have been called.
  const orgScopedCalls = fetchCalls.filter((c) => isOrgScoped(c.url));
  assert.equal(orgScopedCalls.length, 0, "should not make any org-scoped search calls without frameworks");

  // Tier 2 (general search) should still execute — at least one non-org-scoped call.
  const generalCalls = fetchCalls.filter((c) => !isOrgScoped(c.url));
  assert.ok(generalCalls.length > 0, "tier 2 general search should still execute");
});
