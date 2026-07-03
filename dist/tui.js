// src/tui.tsx
import { setProp as _$setProp } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createRoot, createSignal, onCleanup } from "solid-js";
var STATE_DIR = process.env.UC_STATE_DIR ?? join(homedir(), ".cache", "opencode-usage-coach");
var STATE_FILE = join(STATE_DIR, "state.json");
var HARNESS_FILE = join(STATE_DIR, "harness.json");
var MARKER = join(STATE_DIR, "tui-loaded.txt");
function readState() {
  try {
    if (!existsSync(STATE_FILE)) return null;
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}
function readHarness() {
  try {
    if (!existsSync(HARNESS_FILE)) return null;
    return JSON.parse(readFileSync(HARNESS_FILE, "utf8"));
  } catch {
    return null;
  }
}
var TAG = {
  GO: "ok",
  THROTTLE: "slow",
  STOP: "STOP"
};
var TLABEL = {
  generating: "gen",
  grading: "grade",
  revising: "revise",
  completed: "done",
  failed: "fail",
  timed_out: "timeout",
  halted_quota: "quota-halt"
};
function bar(p) {
  const n = Math.max(0, Math.min(10, Math.round(p / 10)));
  return "\u2588".repeat(n) + "\u2591".repeat(10 - n);
}
function short(s, n) {
  return s.length <= n ? s : s.slice(0, n - 1) + "\u2026";
}
function initializeTui(api, disposeRoot) {
  try {
    mkdirSync(STATE_DIR, {
      recursive: true
    });
    writeFileSync(MARKER, `loaded ${(/* @__PURE__ */ new Date()).toISOString()}`);
  } catch {
  }
  const [getState, setState] = createSignal(readState());
  const [getHarness, setHarness] = createSignal(readHarness());
  const timer = setInterval(() => {
    try {
      setState(readState());
      setHarness(readHarness());
    } catch {
    }
  }, 3e3);
  onCleanup(() => clearInterval(timer));
  onCleanup(() => disposeRoot());
  const statusDot = {
    generating: "\u25CF",
    grading: "\u25CF",
    revising: "\u25CF",
    completed: "\u25CF",
    failed: "\u25CF",
    timed_out: "\u25CF",
    halted_quota: "\u25CF"
  };
  const panel = (ctx) => {
    let s = null;
    try {
      s = getState();
    } catch {
      s = null;
    }
    let h = null;
    try {
      h = getHarness();
    } catch {
      h = null;
    }
    const nodes = [];
    if (s) {
      nodes.push((() => {
        var _el$ = _$createElement("text"), _el$2 = _$createTextNode(`usage-coach [`), _el$3 = _$createTextNode(`]`);
        _$insertNode(_el$, _el$2);
        _$insertNode(_el$, _el$3);
        _$insert(_el$, () => TAG[s.decision], _el$3);
        return _el$;
      })());
      nodes.push((() => {
        var _el$4 = _$createElement("text"), _el$5 = _$createTextNode(` 5h `), _el$6 = _$createTextNode(` `), _el$7 = _$createTextNode(`%`);
        _$insertNode(_el$4, _el$5);
        _$insertNode(_el$4, _el$6);
        _$insertNode(_el$4, _el$7);
        _$insert(_el$4, () => bar(s.fiveHour), _el$6);
        _$insert(_el$4, () => s.fiveHour, _el$7);
        return _el$4;
      })());
      nodes.push((() => {
        var _el$8 = _$createElement("text"), _el$9 = _$createTextNode(` wk `), _el$0 = _$createTextNode(` `), _el$1 = _$createTextNode(`%`);
        _$insertNode(_el$8, _el$9);
        _$insertNode(_el$8, _el$0);
        _$insertNode(_el$8, _el$1);
        _$insert(_el$8, () => bar(s.weekly), _el$0);
        _$insert(_el$8, () => s.weekly, _el$1);
        return _el$8;
      })());
      nodes.push((() => {
        var _el$10 = _$createElement("text"), _el$11 = _$createTextNode(` mo `), _el$12 = _$createTextNode(` `), _el$13 = _$createTextNode(`%`);
        _$insertNode(_el$10, _el$11);
        _$insertNode(_el$10, _el$12);
        _$insertNode(_el$10, _el$13);
        _$insert(_el$10, () => bar(s.monthly), _el$12);
        _$insert(_el$10, () => s.monthly, _el$13);
        return _el$10;
      })());
    } else {
      nodes.push((() => {
        var _el$14 = _$createElement("text");
        _$insertNode(_el$14, _$createTextNode(`usage-coach: ...`));
        return _el$14;
      })());
    }
    const hStatus = h && h.tasks.length > 0 ? `${h.name} ${h.current}/${h.total}` : "idle";
    nodes.push((() => {
      var _el$16 = _$createElement("text");
      _$insertNode(_el$16, _$createTextNode(` `));
      return _el$16;
    })());
    nodes.push((() => {
      var _el$18 = _$createElement("text"), _el$19 = _$createTextNode(`harness: `);
      _$insertNode(_el$18, _el$19);
      _$insert(_el$18, hStatus, null);
      return _el$18;
    })());
    if (h && h.tasks.length > 0) {
      for (const t of h.tasks) {
        const dot = statusDot[t.status] ?? "\xB7";
        const lbl = TLABEL[t.status] ?? t.status;
        const rev = t.revisions > 0 && t.status === "revising" ? `(${t.revisions})` : "";
        const mdl = t.model ? ` ${t.model.split("/").pop() ?? t.model}` : "";
        nodes.push((() => {
          var _el$20 = _$createElement("text"), _el$21 = _$createTextNode(` `), _el$22 = _$createTextNode(` `), _el$23 = _$createTextNode(` `), _el$24 = _$createTextNode(` `);
          _$insertNode(_el$20, _el$21);
          _$insertNode(_el$20, _el$22);
          _$insertNode(_el$20, _el$23);
          _$insertNode(_el$20, _el$24);
          _$insert(_el$20, dot, _el$22);
          _$insert(_el$20, () => t.id, _el$23);
          _$insert(_el$20, mdl, _el$23);
          _$insert(_el$20, lbl, _el$24);
          _$insert(_el$20, rev, _el$24);
          _$insert(_el$20, () => short(t.title, 12), null);
          return _el$20;
        })());
        const pv = t.model ? t.model.startsWith("zai") ? "zai" : (t.model.split("/")[0] ?? "").split("-")[0] : "";
        const q = pv && h.quotas?.[pv] ? h.quotas[pv] : null;
        const pct = q ? q.fiveHour : 0;
        nodes.push((() => {
          var _el$25 = _$createElement("text"), _el$26 = _$createTextNode(` 5h `), _el$27 = _$createTextNode(` `), _el$28 = _$createTextNode(`%`);
          _$insertNode(_el$25, _el$26);
          _$insertNode(_el$25, _el$27);
          _$insertNode(_el$25, _el$28);
          _$insert(_el$25, () => bar(pct), _el$27);
          _$insert(_el$25, pct, _el$28);
          return _el$25;
        })());
      }
    }
    return (() => {
      var _el$29 = _$createElement("box");
      _$setProp(_el$29, "flexDirection", "column");
      _$insert(_el$29, nodes);
      return _el$29;
    })();
  };
  api.slots.register({
    order: 80,
    slots: {
      sidebar_footer(ctx) {
        try {
          return panel(ctx);
        } catch {
          return (() => {
            var _el$30 = _$createElement("text");
            _$insertNode(_el$30, _$createTextNode(`usage-coach`));
            return _el$30;
          })();
        }
      },
      home_footer(ctx) {
        try {
          return panel(ctx);
        } catch {
          return (() => {
            var _el$32 = _$createElement("text");
            _$insertNode(_el$32, _$createTextNode(`usage-coach`));
            return _el$32;
          })();
        }
      }
    }
  });
}
var tui = async (api) => {
  createRoot((disposeRoot) => initializeTui(api, disposeRoot));
};
var plugin = {
  id: "opencode-usage-coach-tui",
  tui
};
var tui_default = plugin;
export {
  tui_default as default
};
