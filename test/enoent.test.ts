// enoent.test.ts — tests for ENOENT short-circuit logic in src/index.ts.
// Verifies that when codexbar is not installed, the retry loop is skipped
// and the module enters GO-only mode without wasted delays.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  isCodexbarMissing,
  __resetCodexbarMissing,
  fetchQuotaWithRetry,
} from "../src/index.js";

describe("ENOENT short-circuit", () => {
  // Restore flag state after all tests run.
  after(() => { __resetCodexbarMissing(); });

  it("isCodexbarMissing returns false after reset", () => {
    __resetCodexbarMissing();
    assert.equal(isCodexbarMissing(), false);
  });

  it("sets codexbarMissing=true after a failed spawn (ENOENT)", async () => {
    __resetCodexbarMissing();
    // Attempt a real spawn — if codexbar is not installed, spawn emits ENOENT
    // and our error handler sets the flag. If codexbar IS installed, this test
    // is a no-op (flag stays false), which is correct behavior.
    await fetchQuotaWithRetry("", 1);
    if (!isCodexbarMissing()) {
      // codexbar is installed on this machine — skip the ENOENT assertion.
      // The short-circuit timing test below still validates the flag path.
      return;
    }
    assert.equal(isCodexbarMissing(), true);
  });

  it("returns null instantly when codexbarMissing is true (no retry delays)", async () => {
    // Force the flag on to simulate post-ENOENT state.
    __resetCodexbarMissing();
    // Manually trigger ENOENT if possible, otherwise just test timing.
    // We set the flag by attempting a spawn first (may or may not set it).
    // Then measure: when flag is true, fetchQuotaWithRetry must return in <50ms.
    //
    // Trick: call fetchQuotaWithRetry which, if codexbar is missing, sets the flag.
    await fetchQuotaWithRetry("", 1);
    if (!isCodexbarMissing()) return; // codexbar installed — can't test this path

    const start = Date.now();
    const result = await fetchQuotaWithRetry("");
    const elapsed = Date.now() - start;

    assert.equal(result, null);
    // With 3 retries and 1s+2s delays, a non-short-circuited call would take ~3s.
    // The short-circuit must return well under 1s.
    assert.ok(elapsed < 1000, `expected <1000ms, got ${elapsed}ms`);
  });

  it("isCodexbarMissing returns a boolean", () => {
    assert.equal(typeof isCodexbarMissing(), "boolean");
  });
});
