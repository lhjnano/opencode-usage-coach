// quota-stale-guard.test.ts — UC-3 freshness guard (사실 35 재발 방지).
// A stale codexbar payload (observed in the wild: weekly=100% + resetsAt on an
// unlimited plan, payload updatedAt hours old) must not hard-STOP the harness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { coach, parseQuotaResponse } from "../src/quota.js";

const H = 3600_000;
function quota(weeklyPct: number, ageMs: number | null) {
  return {
    weekly: { usedPercent: weeklyPct, resetsAt: new Date(Date.now() + 3 * 24 * H).toISOString(), windowMinutes: 10080, resetDescription: "1 week window" },
    monthly: { usedPercent: 0, resetsAt: new Date(Date.now() + 20 * 24 * H).toISOString(), resetDescription: "Monthly" },
    fiveHour: { usedPercent: 0, windowMinutes: 300, resetDescription: "5 hours window" },
    payloadUpdatedAt: ageMs === null ? undefined : new Date(Date.now() - ageMs).toISOString(),
  };
}

test("stale payload: weekly 96% (>= STOP_WK) is downgraded to THROTTLE with stale marker", () => {
  const c = coach(quota(96, 2 * H) as any, "lighter"); // 2h old
  assert.equal(c.decision, "THROTTLE", "STOP must not fire on stale data");
  assert.match(c.advice, /STALE payload/);
  assert.match(c.advice, /downgraded/);
  assert.equal(c.weekly, 96);
});

test("fresh payload: weekly 96% still issues STOP unchanged", () => {
  const c = coach(quota(96, 5 * 60_000) as any, "lighter"); // 5min old
  assert.equal(c.decision, "STOP");
  assert.ok(!c.advice.includes("STALE"), "no stale marker on fresh data");
});

test("missing payloadUpdatedAt: treated as fresh (backward compat)", () => {
  const c = coach(quota(96, null) as any, "lighter");
  assert.equal(c.decision, "STOP");
});

test("invalid payloadUpdatedAt string: treated as fresh, no crash", () => {
  const q = quota(96, null) as any;
  q.payloadUpdatedAt = "not-a-date";
  const c = coach(q, "lighter");
  assert.equal(c.decision, "STOP");
});

test("boundary: exactly QUOTA_STALE_MIN age is fresh, +1m is stale", () => {
  assert.equal(coach(quota(96, 30 * 60_000) as any, "l").decision, "STOP"); // 30m == threshold → fresh
  assert.equal(coach(quota(96, 31 * 60_000) as any, "l").decision, "THROTTLE"); // 31m → stale
});

test("stale guard does not affect non-STOP decisions (GO stays GO)", () => {
  const c = coach(quota(40, 2 * H) as any, "lighter");
  assert.equal(c.decision, "GO");
  assert.ok(!c.advice.includes("STALE"));
});

test("parseQuotaResponse captures payload updatedAt", () => {
  const raw = JSON.stringify([{
    usage: {
      primary: { windowMinutes: 10080, usedPercent: 100, resetsAt: "2026-09-11T13:44:10Z", resetDescription: "1 week window" },
      secondary: { usedPercent: 0, resetsAt: "2026-09-24T09:00:02Z", resetDescription: "Monthly" },
      tertiary: { windowMinutes: 300, usedPercent: 0, resetDescription: "5 hours window" },
      updatedAt: "2026-09-07T17:50:16Z",
    },
  }]);
  const q = parseQuotaResponse(raw);
  assert.ok(q, "parses");
  assert.equal(q!.payloadUpdatedAt, "2026-09-07T17:50:16Z");
  assert.equal(q!.weekly!.usedPercent, 100);
});

test("repro of the 2026-09-30 incident shape: that payload, judged now, cannot STOP", () => {
  // exact shape of the stale payload from the incident — updatedAt months old
  const raw = JSON.stringify([{
    usage: {
      primary: { windowMinutes: 10080, usedPercent: 100, resetsAt: "2026-09-11T13:44:10Z", resetDescription: "1 week window" },
      secondary: { usedPercent: 0, resetsAt: "2026-09-10T02:02:40Z", resetDescription: "Monthly" },
      tertiary: { windowMinutes: 300, usedPercent: 0, resetDescription: "5 hours window" },
      updatedAt: "2026-09-07T17:50:16Z",
    },
  }]);
  const c = coach(parseQuotaResponse(raw), "lighter");
  assert.equal(c.decision, "THROTTLE", "incident payload must not STOP anymore");
  assert.match(c.advice, /STALE payload/);
});
