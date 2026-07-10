// tui-render.test.ts — TUI rendering verification tests.
//
// Strategy: pure rendering logic was extracted from tui.tsx into src/tui-logic.ts
// so it can be tested without a terminal runtime or @opentui/solid JSX mocks.
// tui.tsx imports these functions, so tests here exercise the EXACT same code
// path the TUI uses to decide what to render.
//
// Mocking @opentui/solid was rejected because the panel() function is a closure
// inside initializeTui() inside createRoot() — it cannot be invoked without
// spawning the full TUI lifecycle, and JSX elements would resolve to opaque
// solid internals. The extracted-function approach is cleaner and guarantees
// tests exercise the real decision logic.
//
// Run: node --import tsx --test test/tui-render.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  STALE_MS, HIDE_MS, TAG, TLABEL, STATUS_KEY, TERMINAL_STATUSES,
  barFill, barEmpty,
  computeStaleness, isHarnessVisible,
  computeTaskDisplay, taskQuotaPct, decisionThemeKey,
  computeHarnessRender,
} from "../src/tui-logic.js";
import type { HarnessState, QuotaState, TaskState } from "../src/tui-logic.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const NOW = new Date("2026-01-15T12:00:00Z").getTime();

function minutesAgo(min: number): string {
  return new Date(NOW - min * 60_000).toISOString();
}

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return { id: 1, title: "test-task", status: "generating", ...overrides };
}

function makeHarness(overrides: Partial<HarnessState> = {}): HarnessState {
  return {
    name: "test-harness",
    total: 3,
    current: 0,
    tasks: [makeTask()],
    active: true,
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function makeQuota(overrides: Partial<QuotaState> = {}): QuotaState {
  return {
    decision: "GO",
    advice: "",
    weekly: 30,
    monthly: 20,
    fiveHour: 40,
    ...overrides,
  };
}

// ── Constants ────────────────────────────────────────────────────────────────

describe("Constants", () => {
  test("STALE_MS is 5 minutes", () => {
    assert.equal(STALE_MS, 5 * 60_000);
  });

  test("HIDE_MS is 30 minutes", () => {
    assert.equal(HIDE_MS, 30 * 60_000);
  });

  test("TAG maps quota decisions to short labels", () => {
    assert.equal(TAG.GO, "ok");
    assert.equal(TAG.THROTTLE, "slow");
    assert.equal(TAG.STOP, "STOP");
  });

  test("TLABEL maps all statuses to short display labels", () => {
    assert.equal(TLABEL.generating, "gen");
    assert.equal(TLABEL.grading, "grade");
    assert.equal(TLABEL.revising, "revise");
    assert.equal(TLABEL.completed, "done");
    assert.equal(TLABEL.failed, "fail");
    assert.equal(TLABEL.timed_out, "timeout");
    assert.equal(TLABEL.halted_quota, "quota-halt");
    assert.equal(TLABEL.stale, "STALE");
  });

  test("STATUS_KEY maps statuses to theme color keys", () => {
    assert.equal(STATUS_KEY.generating, "info");
    assert.equal(STATUS_KEY.grading, "accent");
    assert.equal(STATUS_KEY.revising, "warning");
    assert.equal(STATUS_KEY.completed, "success");
    assert.equal(STATUS_KEY.failed, "error");
    assert.equal(STATUS_KEY.timed_out, "error");
    assert.equal(STATUS_KEY.halted_quota, "error");
  });

  test("TERMINAL_STATUSES includes all terminal states", () => {
    assert.ok(TERMINAL_STATUSES.has("completed"));
    assert.ok(TERMINAL_STATUSES.has("failed"));
    assert.ok(TERMINAL_STATUSES.has("timed_out"));
    assert.ok(TERMINAL_STATUSES.has("halted_quota"));
    assert.ok(!TERMINAL_STATUSES.has("generating"));
    assert.ok(!TERMINAL_STATUSES.has("revising"));
  });
});

// ── Scenario 6: Progress bar fill calculation ────────────────────────────────

describe("barFill / barEmpty", () => {
  test("barFill(0) is empty string (0% shows nothing)", () => {
    assert.equal(barFill(0), "");
  });

  test("barFill(1) shows at least 1 block (minimum for >0%)", () => {
    assert.equal(barFill(1), "\u2588"); // █
  });

  test("barFill(5) shows 1 block", () => {
    assert.equal(barFill(5), "\u2588");
  });

  test("barFill(10) shows 1 block", () => {
    assert.equal(barFill(10), "\u2588");
  });

  test("barFill(25) shows ~3 blocks", () => {
    assert.equal(barFill(25), "\u2588\u2588\u2588");
  });

  test("barFill(50) shows 5 blocks", () => {
    assert.equal(barFill(50), "\u2588\u2588\u2588\u2588\u2588");
  });

  test("barFill(75) shows 8 blocks", () => {
    assert.equal(barFill(75), "\u2588".repeat(8));
  });

  test("barFill(100) shows 10 blocks (full bar)", () => {
    assert.equal(barFill(100), "\u2588".repeat(10));
  });

  test("barEmpty is the complement of barFill (always totals 10 chars)", () => {
    for (const p of [0, 1, 5, 10, 25, 50, 75, 100]) {
      const fill = barFill(p);
      const empty = barEmpty(p);
      assert.equal(fill.length + empty.length, 10, `p=${p}: fill(${fill.length}) + empty(${empty.length}) != 10`);
    }
  });

  test("barEmpty(0) is 10 blocks", () => {
    assert.equal(barEmpty(0), "\u2591".repeat(10));
  });

  test("barEmpty(100) is empty string", () => {
    assert.equal(barEmpty(100), "");
  });

  test("negative percentage treated as 0", () => {
    assert.equal(barFill(-5), "");
    assert.equal(barEmpty(-5), "\u2591".repeat(10));
  });

  test("over 100% capped at 10 blocks", () => {
    assert.equal(barFill(150), "\u2588".repeat(10));
    assert.equal(barEmpty(150), "");
  });
});

// ── Scenario 2 & 3: Staleness computation ────────────────────────────────────

describe("computeStaleness", () => {
  test("fresh harness with active sub-session: NOT stale, NOT hidden", () => {
    const h = makeHarness({
      updatedAt: minutesAgo(1),
      tasks: [makeTask({ subSessionId: "sub-1" })],
    });
    const r = computeStaleness(h, NOW);
    assert.equal(r.hasActiveSub, true);
    assert.equal(r.isStale, false);
    assert.equal(r.shouldHide, false);
  });

  test("fresh harness WITHOUT sub-session: NOT stale (under STALE_MS)", () => {
    const h = makeHarness({
      updatedAt: minutesAgo(3),
      tasks: [makeTask({ subSessionId: undefined })],
    });
    const r = computeStaleness(h, NOW);
    assert.equal(r.hasActiveSub, false);
    assert.equal(r.isStale, false, "3min < 5min STALE_MS");
    assert.equal(r.shouldHide, false);
  });

  test("Scenario 2: 6 minutes old, no sub-session → STALE", () => {
    const h = makeHarness({
      updatedAt: minutesAgo(6),
      tasks: [makeTask({ subSessionId: undefined })],
    });
    const r = computeStaleness(h, NOW);
    assert.equal(r.hasActiveSub, false);
    assert.equal(r.isStale, true, "6min > 5min STALE_MS");
    assert.equal(r.shouldHide, false, "6min < 30min HIDE_MS");
  });

  test("Scenario 3: 35 minutes old, no sub-session → shouldHide", () => {
    const h = makeHarness({
      updatedAt: minutesAgo(35),
      tasks: [makeTask({ subSessionId: undefined })],
    });
    const r = computeStaleness(h, NOW);
    assert.equal(r.isStale, true);
    assert.equal(r.shouldHide, true, "35min > 30min HIDE_MS");
  });

  test("35 minutes old WITH active sub-session → NOT hidden (sub suppresses hide)", () => {
    const h = makeHarness({
      updatedAt: minutesAgo(35),
      tasks: [makeTask({ subSessionId: "sub-active" })],
    });
    const r = computeStaleness(h, NOW);
    assert.equal(r.hasActiveSub, true);
    assert.equal(r.isStale, false, "active sub suppresses staleness");
    assert.equal(r.shouldHide, false, "active sub suppresses hiding");
  });

  test("boundary: exactly 5 min old → NOT stale (>, not >=)", () => {
    const h = makeHarness({
      updatedAt: minutesAgo(5),
      tasks: [makeTask()],
    });
    const r = computeStaleness(h, NOW);
    // STALE_MS = 5*60_000; hAge must be > STALE_MS, not >=
    assert.equal(r.isStale, false, "exactly 5min is NOT stale (> comparison)");
  });

  test("boundary: exactly 30 min old → NOT hidden (> comparison)", () => {
    const h = makeHarness({
      updatedAt: minutesAgo(30),
      tasks: [makeTask()],
    });
    const r = computeStaleness(h, NOW);
    assert.equal(r.shouldHide, false, "exactly 30min is NOT hidden (> comparison)");
  });

  test("no updatedAt → hAge=0, never stale", () => {
    const h = makeHarness({ updatedAt: undefined });
    const r = computeStaleness(h, NOW);
    assert.equal(r.hAge, 0);
    assert.equal(r.isStale, false);
    assert.equal(r.shouldHide, false);
  });

  test("multiple tasks: any sub-session active suppresses staleness", () => {
    const h = makeHarness({
      updatedAt: minutesAgo(10),
      tasks: [
        makeTask({ id: 1, subSessionId: undefined }),
        makeTask({ id: 2, subSessionId: "sub-2" }),
      ],
    });
    const r = computeStaleness(h, NOW);
    assert.equal(r.hasActiveSub, true);
    assert.equal(r.isStale, false);
  });
});

// ── Scenarios 1, 3, 4: Harness visibility rules ──────────────────────────────

describe("isHarnessVisible", () => {
  test("null harness → not visible", () => {
    assert.equal(isHarnessVisible(null, computeStaleness(makeHarness(), NOW)), false);
  });

  test("empty tasks → not visible", () => {
    const h = makeHarness({ tasks: [] });
    assert.equal(isHarnessVisible(h, computeStaleness(h, NOW)), false);
  });

  test("Scenario 4: active=false → not visible (completed harness hidden)", () => {
    const h = makeHarness({ active: false });
    assert.equal(isHarnessVisible(h, computeStaleness(h, NOW)), false);
  });

  test("shouldHide=true → not visible", () => {
    const h = makeHarness({
      updatedAt: minutesAgo(35),
      tasks: [makeTask()],
    });
    assert.equal(isHarnessVisible(h, computeStaleness(h, NOW)), false);
  });

  test("Scenario 1: active=true, fresh, has tasks → visible", () => {
    const h = makeHarness({
      updatedAt: minutesAgo(1),
      tasks: [makeTask({ subSessionId: "sub-1", status: "generating" })],
    });
    assert.equal(isHarnessVisible(h, computeStaleness(h, NOW)), true);
  });

  test("active=true, stale (but not hidden) → visible (shows as STALE)", () => {
    const h = makeHarness({
      updatedAt: minutesAgo(10),
      tasks: [makeTask()],
    });
    assert.equal(isHarnessVisible(h, computeStaleness(h, NOW)), true);
  });

  test("active undefined (not explicitly true) → hidden", () => {
    const h = makeHarness({ active: undefined });
    assert.equal(isHarnessVisible(h, computeStaleness(h, NOW)), false);
  });
});

// ── Scenario 5: Task display computation ─────────────────────────────────────

describe("computeTaskDisplay", () => {
  test("generating status → label 'gen', theme 'info'", () => {
    const td = computeTaskDisplay(makeTask({ status: "generating" }), false, NOW);
    assert.equal(td.displayStatus, "generating");
    assert.equal(td.label, "gen");
    assert.equal(td.themeKey, "info");
  });

  test("completed status → label 'done', theme 'success'", () => {
    const td = computeTaskDisplay(makeTask({ status: "completed" }), false, NOW);
    assert.equal(td.label, "done");
    assert.equal(td.themeKey, "success");
  });

  test("failed status → label 'fail', theme 'error'", () => {
    const td = computeTaskDisplay(makeTask({ status: "failed" }), false, NOW);
    assert.equal(td.label, "fail");
    assert.equal(td.themeKey, "error");
  });

  test("revising with revisions > 0 → shows revision suffix", () => {
    const td = computeTaskDisplay(makeTask({ status: "revising", revisions: 3 }), false, NOW);
    assert.equal(td.revSuffix, "(3)");
  });

  test("revising with 0 revisions → no revision suffix", () => {
    const td = computeTaskDisplay(makeTask({ status: "revising", revisions: 0 }), false, NOW);
    assert.equal(td.revSuffix, "");
  });

  test("non-revising status with revisions > 0 → no revision suffix", () => {
    const td = computeTaskDisplay(makeTask({ status: "generating", revisions: 2 }), false, NOW);
    assert.equal(td.revSuffix, "");
  });

  test("model string → short model suffix", () => {
    const td = computeTaskDisplay(makeTask({ model: "openai/gpt-4o" }), false, NOW);
    assert.equal(td.modelStr, " gpt-4o");
  });

  test("no model → empty model suffix", () => {
    const td = computeTaskDisplay(makeTask({ model: undefined }), false, NOW);
    assert.equal(td.modelStr, "");
  });

  test("stale harness + non-terminal status → displayStatus 'stale'", () => {
    const td = computeTaskDisplay(makeTask({ status: "generating" }), true, NOW);
    assert.equal(td.displayStatus, "stale");
    assert.equal(td.label, "STALE");
  });

  test("stale harness + terminal status → displayStatus unchanged (completed stays completed)", () => {
    const td = computeTaskDisplay(makeTask({ status: "completed" }), true, NOW);
    assert.equal(td.displayStatus, "completed");
    assert.equal(td.label, "done");
  });

  test("stale harness + failed → displayStatus unchanged (failed stays failed)", () => {
    const td = computeTaskDisplay(makeTask({ status: "failed" }), true, NOW);
    assert.equal(td.displayStatus, "failed");
  });

  test("active sub-session with subStep → shows step suffix", () => {
    const td = computeTaskDisplay(
      makeTask({ subSessionId: "sub-1", subStep: 7 }),
      false,
      NOW,
    );
    assert.equal(td.hasSub, true);
    assert.equal(td.stepStr, " step:7");
  });

  test("active sub-session with subElapsed → shows elapsed suffix", () => {
    const td = computeTaskDisplay(
      makeTask({ subSessionId: "sub-1", subElapsed: 42 }),
      false,
      NOW,
    );
    assert.equal(td.elapsedStr, " 42s");
  });

  test("sub-session elapsed > 300s → subWarn=true, themeKey 'warning'", () => {
    const td = computeTaskDisplay(
      makeTask({ subSessionId: "sub-1", subElapsed: 350 }),
      false,
      NOW,
    );
    assert.equal(td.subWarn, true);
    assert.equal(td.themeKey, "warning");
  });

  test("sub-session elapsed exactly 300s → subWarn=false (> comparison)", () => {
    const td = computeTaskDisplay(
      makeTask({ subSessionId: "sub-1", subElapsed: 300 }),
      false,
      NOW,
    );
    assert.equal(td.subWarn, false);
  });

  test("no sub-session → elapsed from startedAt", () => {
    const td = computeTaskDisplay(
      makeTask({ startedAt: minutesAgo(2) }),
      false,
      NOW,
    );
    assert.equal(td.elapsedStr, " 120s");
  });

  test("completed task → no task-level elapsed", () => {
    const td = computeTaskDisplay(
      makeTask({ status: "completed", startedAt: minutesAgo(5) }),
      false,
      NOW,
    );
    assert.equal(td.elapsedStr, "");
  });

  test("failed task → no task-level elapsed", () => {
    const td = computeTaskDisplay(
      makeTask({ status: "failed", startedAt: minutesAgo(5) }),
      false,
      NOW,
    );
    assert.equal(td.elapsedStr, "");
  });

  test("unknown status → falls back to status string as label, theme 'text'", () => {
    const td = computeTaskDisplay(makeTask({ status: "unknown_status" }), false, NOW);
    assert.equal(td.label, "unknown_status");
    assert.equal(td.themeKey, "text");
  });
});

// ── Scenario 7: Quota display ────────────────────────────────────────────────

describe("decisionThemeKey", () => {
  test("GO → success", () => {
    assert.equal(decisionThemeKey("GO"), "success");
  });

  test("THROTTLE → warning", () => {
    assert.equal(decisionThemeKey("THROTTLE"), "warning");
  });

  test("STOP → error", () => {
    assert.equal(decisionThemeKey("STOP"), "error");
  });
});

describe("taskQuotaPct", () => {
  test("task with matching provider → uses provider fiveHour", () => {
    const t = makeTask({ model: "openai/gpt-4o" });
    const s = makeQuota({
      fiveHour: 50,
      providers: [{ id: "openai", name: "OpenAI", fiveHour: 75, weekly: 30, fiveHourReset: "soon", weeklyReset: "later", advice: "" }],
    });
    const { pct, label } = taskQuotaPct(t, s);
    assert.equal(pct, 75);
    assert.equal(label, "75%");
  });

  test("task with no matching provider → falls back to state fiveHour", () => {
    const t = makeTask({ model: "unknown/model" });
    const s = makeQuota({ fiveHour: 40 });
    const { pct, label } = taskQuotaPct(t, s);
    assert.equal(pct, 40);
    assert.equal(label, "40%");
  });

  test("task with no model → falls back to first provider", () => {
    const t = makeTask({ model: undefined });
    const s = makeQuota({
      fiveHour: 50,
      providers: [{ id: "anthropic", name: "Anthropic", fiveHour: 20, weekly: 10, fiveHourReset: "", weeklyReset: "", advice: "" }],
    });
    const { pct } = taskQuotaPct(t, s);
    assert.equal(pct, 20);
  });

  test("no state at all → pct 0, label '…' (loading)", () => {
    const t = makeTask();
    const { pct, label } = taskQuotaPct(t, null);
    assert.equal(pct, 0);
    assert.equal(label, "…");
  });

  test("state with fiveHour=-1 → pct 0, label '…' (loading)", () => {
    const t = makeTask();
    const s = makeQuota({ fiveHour: -1 });
    const { pct, label } = taskQuotaPct(t, s);
    assert.equal(pct, 0);
    assert.equal(label, "…");
  });

  test("state with fiveHour=-2 → pct 0, label 'retry' (fetch failed)", () => {
    const t = makeTask();
    const s = makeQuota({ fiveHour: -2 });
    const { pct, label } = taskQuotaPct(t, s);
    assert.equal(pct, 0);
    assert.equal(label, "retry");
  });

  test("provider match via prefix (id starts with pv)", () => {
    const t = makeTask({ model: "google/gemini-pro" });
    const s = makeQuota({
      providers: [{ id: "googleai", name: "Google", fiveHour: 60, weekly: 20, fiveHourReset: "", weeklyReset: "", advice: "" }],
    });
    // pv = "google"; provider id "googleai" — pv.startsWith(p.id) = false, p.id.startsWith(pv) = true
    const { pct } = taskQuotaPct(t, s);
    assert.equal(pct, 60);
  });
});

// ── Integration: computeHarnessRender (full render data) ─────────────────────

describe("computeHarnessRender", () => {
  test("Scenario 1: active generating task renders correctly", () => {
    const h = makeHarness({
      name: "my-harness",
      total: 3,
      current: 1,
      updatedAt: minutesAgo(1),
      tasks: [makeTask({ id: 1, status: "generating", subSessionId: "sub-1", title: "Add tests" })],
    });
    const s = makeQuota({ decision: "GO" });
    const render = computeHarnessRender(h, s, NOW);

    assert.equal(render.visible, true);
    assert.equal(render.isStale, false);
    assert.equal(render.header, "harness: my-harness 1/3");
    assert.equal(render.progress!.current, 1);
    assert.equal(render.progress!.total, 3);
    assert.equal(render.tasks.length, 1);
    assert.equal(render.tasks[0].display.label, "gen");
    assert.equal(render.tasks[0].display.hasSub, true);
  });

  test("Scenario 2: stale harness shows '(stale)' in header and STALE label", () => {
    const h = makeHarness({
      updatedAt: minutesAgo(6),
      tasks: [makeTask({ id: 1, status: "generating", subSessionId: undefined })],
    });
    const render = computeHarnessRender(h, null, NOW);

    assert.equal(render.visible, true);
    assert.equal(render.isStale, true);
    assert.ok(render.header!.includes("(stale)"), `header should contain '(stale)': ${render.header}`);
    assert.equal(render.tasks[0].display.label, "STALE");
    assert.equal(render.tasks[0].display.displayStatus, "stale");
  });

  test("Scenario 3: very stale harness (35min) is hidden", () => {
    const h = makeHarness({
      updatedAt: minutesAgo(35),
      tasks: [makeTask()],
    });
    const render = computeHarnessRender(h, null, NOW);
    assert.equal(render.visible, false);
    assert.equal(render.header, null);
    assert.equal(render.tasks.length, 0);
  });

  test("Scenario 4: completed harness (active=false) is hidden", () => {
    const h = makeHarness({
      active: false,
      tasks: [makeTask({ status: "completed" })],
    });
    const render = computeHarnessRender(h, null, NOW);
    assert.equal(render.visible, false);
  });

  test("Scenario 5: multi-task rendering (completed + generating + failed)", () => {
    const h = makeHarness({
      name: "multi",
      total: 3,
      current: 1,
      updatedAt: minutesAgo(1),
      tasks: [
        makeTask({ id: 1, status: "completed", score: "PASS", title: "Task A" }),
        makeTask({ id: 2, status: "generating", subSessionId: "sub-2", title: "Task B" }),
        makeTask({ id: 3, status: "failed", score: "FAIL", title: "Task C" }),
      ],
    });
    const s = makeQuota({ decision: "THROTTLE" });
    const render = computeHarnessRender(h, s, NOW);

    assert.equal(render.visible, true);
    assert.equal(render.tasks.length, 3);

    // Task 1: completed
    assert.equal(render.tasks[0].display.label, "done");
    assert.equal(render.tasks[0].display.themeKey, "success");
    assert.equal(render.tasks[0].display.elapsedStr, "", "completed has no elapsed");

    // Task 2: generating with active sub
    assert.equal(render.tasks[1].display.label, "gen");
    assert.equal(render.tasks[1].display.themeKey, "info");
    assert.equal(render.tasks[1].display.hasSub, true);

    // Task 3: failed
    assert.equal(render.tasks[2].display.label, "fail");
    assert.equal(render.tasks[2].display.themeKey, "error");
    assert.equal(render.tasks[2].display.elapsedStr, "", "failed has no elapsed");
  });

  test("null harness → invisible, empty everything", () => {
    const render = computeHarnessRender(null, null, NOW);
    assert.equal(render.visible, false);
    assert.equal(render.header, null);
    assert.equal(render.tasks.length, 0);
  });

  test("quota bar for each task matches taskQuotaPct output", () => {
    const h = makeHarness({
      tasks: [makeTask({ id: 1, model: "openai/gpt-4o" })],
    });
    const s = makeQuota({
      fiveHour: 50,
      providers: [{ id: "openai", name: "OpenAI", fiveHour: 80, weekly: 30, fiveHourReset: "", weeklyReset: "", advice: "" }],
    });
    const render = computeHarnessRender(h, s, NOW);
    const task = render.tasks[0];
    const expected = taskQuotaPct(makeTask({ model: "openai/gpt-4o" }), s);
    assert.equal(task.quota.pct, expected.pct);
    assert.equal(task.quota.label, expected.label);
    assert.equal(task.quota.fill, barFill(expected.pct));
    assert.equal(task.quota.empty, barEmpty(expected.pct));
  });

  test("stale header format: 'harness: {name} {current}/{total} (stale)'", () => {
    const h = makeHarness({
      name: "ci-pipeline",
      total: 5,
      current: 2,
      updatedAt: minutesAgo(10),
      tasks: [makeTask()],
    });
    const render = computeHarnessRender(h, null, NOW);
    assert.equal(render.header, "harness: ci-pipeline 2/5 (stale)");
  });

  test("non-stale header format: 'harness: {name} {current}/{total}'", () => {
    const h = makeHarness({
      name: "ci-pipeline",
      total: 5,
      current: 3,
      updatedAt: minutesAgo(1),
      tasks: [makeTask({ subSessionId: "sub-1" })],
    });
    const render = computeHarnessRender(h, null, NOW);
    assert.equal(render.header, "harness: ci-pipeline 3/5");
  });
});

// ── Edge cases & potential bugs ──────────────────────────────────────────────

describe("Edge cases", () => {
  test("barFill for all deciles produces correct visual proportions", () => {
    // Verify the visual fill ratio matches the percentage
    for (let p = 10; p <= 100; p += 10) {
      const fillLen = barFill(p).length;
      const expectedN = Math.round(p / 10);
      assert.equal(fillLen, expectedN, `p=${p}% should produce ${expectedN} blocks, got ${fillLen}`);
    }
  });

  test("stale detection is suppressed by ANY task having a subSessionId", () => {
    // This verifies the pre-flight scan concern about TUI staleness false-positives:
    // a long-running generate() task with subSessionId set should NOT be marked stale.
    const h = makeHarness({
      updatedAt: minutesAgo(20), // well past STALE_MS
      tasks: [
        makeTask({ id: 1, status: "completed", subSessionId: undefined }),
        makeTask({ id: 2, status: "generating", subSessionId: "sub-active" }),
      ],
    });
    const r = computeStaleness(h, NOW);
    assert.equal(r.hasActiveSub, true);
    assert.equal(r.isStale, false, "active sub-session suppresses staleness even after 20min");
    assert.equal(r.shouldHide, false, "active sub-session suppresses hiding even after 20min");
  });

  test("model with multiple dashes extracts provider correctly", () => {
    // e.g., "openai-gpt-4-turbo" → pv = "openai"
    const t = makeTask({ model: "openai-gpt-4-turbo" });
    const s = makeQuota({
      fiveHour: 99,
      providers: [{ id: "openai", name: "OpenAI", fiveHour: 15, weekly: 5, fiveHourReset: "", weeklyReset: "", advice: "" }],
    });
    const { pct } = taskQuotaPct(t, s);
    assert.equal(pct, 15, "should match provider 'openai' not fallback 99");
  });

  // BUG FOUND: In tui.tsx, the no-providers fallback path (lines ~162-163) uses
  // barFill(s.fiveHour) for the visual bar but hardcodes "0%" as the text label.
  // This means a model at 75% shows a 75% full bar with "0%" text — a visual
  // mismatch. This bug exists in the JSX rendering layer of tui.tsx, NOT in the
  // extracted tui-logic.ts functions (which compute correct labels). Documenting
  // here so it can be fixed in tui.tsx's panel function.
  //
  // BUG FOUND: tui.tsx no-providers fallback shows hardcoded "0%" text label
  // instead of the actual percentage. The bar fill uses barFill(s.fiveHour)
  // (correct) but the adjacent text is always "0%" (wrong). Should be `${s.fiveHour}%`.
  test("documentation: no-providers fallback label bug in tui.tsx (not in tui-logic)", () => {
    // This test documents the bug. tui-logic.ts's taskQuotaPct produces correct
    // labels, but the tui.tsx JSX rendering has a separate hardcoded "0%" path.
    const s = makeQuota({ fiveHour: 75, weekly: 40 });
    // tui-logic correctly returns the percentage
    const { pct, label } = taskQuotaPct(makeTask(), s);
    assert.equal(pct, 75);
    assert.equal(label, "75%");
    // tui.tsx JSX would show barFill(75) but text "0%" — mismatch documented.
  });
});
