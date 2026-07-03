// src/tui.tsx
import { setProp as _$setProp } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { createHash } from "crypto";
import { homedir } from "os";
import { join, resolve } from "path";
import { createRoot, createSignal, onCleanup } from "solid-js";
function projectStateDir(dir) {
  const abs = resolve(dir || ".");
  const h = createHash("sha1").update(abs).digest("hex").slice(0, 12);
  return join(homedir(), ".cache", "opencode-usage-coach", "projects", h);
}
var STATE_DIR = join(homedir(), ".cache", "opencode-usage-coach");
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
  STATE_DIR = process.env.UC_STATE_DIR ?? projectStateDir(api.state.path.directory);
  STATE_FILE = join(STATE_DIR, "state.json");
  HARNESS_FILE = join(STATE_DIR, "harness.json");
  MARKER = join(STATE_DIR, "tui-loaded.txt");
  try {
    mkdirSync(STATE_DIR, {
      recursive: true
    });
    writeFileSync(MARKER, `loaded ${(/* @__PURE__ */ new Date()).toISOString()} @ ${api.state.path.directory}`);
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
  const statusKey = {
    generating: "info",
    grading: "accent",
    revising: "warning",
    completed: "success",
    failed: "error",
    timed_out: "error",
    halted_quota: "error"
  };
  const panel = (ctx) => {
    const th = ctx.theme?.current ?? {};
    const st = (k) => ({
      fg: th[k]
    });
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
      const dKey = s.decision === "GO" ? "success" : s.decision === "THROTTLE" ? "warning" : "error";
      nodes.push((() => {
        var _el$ = _$createElement("text"), _el$2 = _$createTextNode(`usage-coach [`), _el$3 = _$createTextNode(`]`);
        _$insertNode(_el$, _el$2);
        _$insertNode(_el$, _el$3);
        _$insert(_el$, () => TAG[s.decision], _el$3);
        _$effect((_$p) => _$setProp(_el$, "style", st(dKey), _$p));
        return _el$;
      })());
      if (s.providers && s.providers.length > 0) {
        for (const p of s.providers) {
          nodes.push((() => {
            var _el$4 = _$createElement("text"), _el$5 = _$createTextNode(` `);
            _$insertNode(_el$4, _el$5);
            _$insert(_el$4, () => p.name, null);
            _$effect((_$p) => _$setProp(_el$4, "style", st("textMuted"), _$p));
            return _el$4;
          })());
          const k5 = p.fiveHour >= 70 ? "error" : p.fiveHour >= 40 ? "warning" : "success";
          const kw = p.weekly >= 85 ? "error" : p.weekly >= 60 ? "warning" : "success";
          nodes.push((() => {
            var _el$6 = _$createElement("text"), _el$7 = _$createTextNode(` 5h `), _el$8 = _$createTextNode(` `), _el$9 = _$createTextNode(`% `);
            _$insertNode(_el$6, _el$7);
            _$insertNode(_el$6, _el$8);
            _$insertNode(_el$6, _el$9);
            _$insert(_el$6, () => bar(p.fiveHour), _el$8);
            _$insert(_el$6, () => p.fiveHour, _el$9);
            _$insert(_el$6, () => p.fiveHourReset, null);
            _$effect((_$p) => _$setProp(_el$6, "style", st(k5), _$p));
            return _el$6;
          })());
          nodes.push((() => {
            var _el$0 = _$createElement("text"), _el$1 = _$createTextNode(` wk `), _el$10 = _$createTextNode(` `), _el$11 = _$createTextNode(`% `);
            _$insertNode(_el$0, _el$1);
            _$insertNode(_el$0, _el$10);
            _$insertNode(_el$0, _el$11);
            _$insert(_el$0, () => bar(p.weekly), _el$10);
            _$insert(_el$0, () => p.weekly, _el$11);
            _$insert(_el$0, () => p.weeklyReset, null);
            _$effect((_$p) => _$setProp(_el$0, "style", st(kw), _$p));
            return _el$0;
          })());
          nodes.push((() => {
            var _el$12 = _$createElement("text"), _el$13 = _$createTextNode(` -> `);
            _$insertNode(_el$12, _el$13);
            _$insert(_el$12, () => p.advice, null);
            _$effect((_$p) => _$setProp(_el$12, "style", st(dKey), _$p));
            return _el$12;
          })());
        }
      } else {
        nodes.push((() => {
          var _el$16 = _$createElement("text"), _el$17 = _$createTextNode(` 5h `), _el$18 = _$createTextNode(` `), _el$19 = _$createTextNode(`%`);
          _$insertNode(_el$16, _el$17);
          _$insertNode(_el$16, _el$18);
          _$insertNode(_el$16, _el$19);
          _$insert(_el$16, () => bar(s.fiveHour), _el$18);
          _$insert(_el$16, () => s.fiveHour, _el$19);
          return _el$16;
        })());
        nodes.push((() => {
          var _el$20 = _$createElement("text"), _el$21 = _$createTextNode(` wk `), _el$22 = _$createTextNode(` `), _el$23 = _$createTextNode(`%`);
          _$insertNode(_el$20, _el$21);
          _$insertNode(_el$20, _el$22);
          _$insertNode(_el$20, _el$23);
          _$insert(_el$20, () => bar(s.weekly), _el$22);
          _$insert(_el$20, () => s.weekly, _el$23);
          return _el$20;
        })());
        nodes.push((() => {
          var _el$24 = _$createElement("text"), _el$25 = _$createTextNode(` mo `), _el$26 = _$createTextNode(` `), _el$27 = _$createTextNode(`%`);
          _$insertNode(_el$24, _el$25);
          _$insertNode(_el$24, _el$26);
          _$insertNode(_el$24, _el$27);
          _$insert(_el$24, () => bar(s.monthly), _el$26);
          _$insert(_el$24, () => s.monthly, _el$27);
          return _el$24;
        })());
      }
    } else {
      nodes.push((() => {
        var _el$28 = _$createElement("text");
        _$insertNode(_el$28, _$createTextNode(`usage-coach: ...`));
        return _el$28;
      })());
    }
    if (h && h.active !== false && h.tasks.length > 0) {
      nodes.push((() => {
        var _el$30 = _$createElement("text");
        _$insertNode(_el$30, _$createTextNode(` `));
        return _el$30;
      })());
      nodes.push((() => {
        var _el$32 = _$createElement("text"), _el$33 = _$createTextNode(`harness: `), _el$34 = _$createTextNode(` `), _el$35 = _$createTextNode(`/`);
        _$insertNode(_el$32, _el$33);
        _$insertNode(_el$32, _el$34);
        _$insertNode(_el$32, _el$35);
        _$insert(_el$32, () => h.name, _el$34);
        _$insert(_el$32, () => h.current, _el$35);
        _$insert(_el$32, () => h.total, null);
        _$effect((_$p) => _$setProp(_el$32, "style", st("textMuted"), _$p));
        return _el$32;
      })());
      for (const t of h.tasks) {
        const sKey = statusKey[t.status] ?? "text";
        const lbl = TLABEL[t.status] ?? t.status;
        const rev = t.revisions > 0 && t.status === "revising" ? `(${t.revisions})` : "";
        const mdl = t.model ? ` ${t.model.split("/").pop() ?? t.model}` : "";
        nodes.push((() => {
          var _el$36 = _$createElement("text"), _el$37 = _$createTextNode(` \u25CF `), _el$38 = _$createTextNode(` `), _el$39 = _$createTextNode(` `);
          _$insertNode(_el$36, _el$37);
          _$insertNode(_el$36, _el$38);
          _$insertNode(_el$36, _el$39);
          _$insert(_el$36, () => t.id, _el$38);
          _$insert(_el$36, mdl, _el$38);
          _$insert(_el$36, lbl, _el$39);
          _$insert(_el$36, rev, _el$39);
          _$insert(_el$36, () => short(t.title, 12), null);
          _$effect((_$p) => _$setProp(_el$36, "style", st(sKey), _$p));
          return _el$36;
        })());
        const pv = t.model ? t.model.startsWith("zai") ? "zai" : (t.model.split("/")[0] ?? "").split("-")[0] : "";
        const q = pv && h.quotas?.[pv] ? h.quotas[pv] : null;
        const pct = q ? q.fiveHour : 0;
        const qKey = pct >= 70 ? "error" : pct >= 40 ? "warning" : "success";
        nodes.push((() => {
          var _el$40 = _$createElement("text"), _el$41 = _$createTextNode(` 5h `), _el$42 = _$createTextNode(` `), _el$43 = _$createTextNode(`%`);
          _$insertNode(_el$40, _el$41);
          _$insertNode(_el$40, _el$42);
          _$insertNode(_el$40, _el$43);
          _$insert(_el$40, () => bar(pct), _el$42);
          _$insert(_el$40, pct, _el$43);
          _$effect((_$p) => _$setProp(_el$40, "style", st(qKey), _$p));
          return _el$40;
        })());
      }
    }
    return (() => {
      var _el$44 = _$createElement("box");
      _$setProp(_el$44, "flexDirection", "column");
      _$insert(_el$44, nodes);
      return _el$44;
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
            var _el$45 = _$createElement("text");
            _$insertNode(_el$45, _$createTextNode(`usage-coach`));
            return _el$45;
          })();
        }
      },
      home_footer(ctx) {
        try {
          return panel(ctx);
        } catch {
          return (() => {
            var _el$47 = _$createElement("text");
            _$insertNode(_el$47, _$createTextNode(`usage-coach`));
            return _el$47;
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
