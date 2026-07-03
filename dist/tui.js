// src/tui.tsx
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
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
  const [collapsed, setCollapsed] = createSignal(false);
  let cmdDispose;
  try {
    cmdDispose = api.command?.register?.(() => [{
      title: "Toggle usage-coach panel",
      value: "usage-coach-toggle",
      category: "usage-coach",
      keybind: "alt+h",
      onSelect: () => {
        setCollapsed((c) => !c);
      }
    }]);
  } catch {
  }
  onCleanup(() => {
    try {
      cmdDispose?.();
    } catch {
    }
  });
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
    if (collapsed()) {
      return (() => {
        var _el$ = _$createElement("box"), _el$2 = _$createElement("text");
        _$insertNode(_el$, _el$2);
        _$insertNode(_el$2, _$createTextNode(`usage-coach (hidden \u2014 Alt+H)`));
        _$effect((_$p) => _$setProp(_el$2, "style", st("textMuted"), _$p));
        return _el$;
      })();
    }
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
        var _el$4 = _$createElement("text"), _el$5 = _$createTextNode(`usage-coach [`), _el$6 = _$createTextNode(`]`);
        _$insertNode(_el$4, _el$5);
        _$insertNode(_el$4, _el$6);
        _$insert(_el$4, () => TAG[s.decision], _el$6);
        _$effect((_$p) => _$setProp(_el$4, "style", st(dKey), _$p));
        return _el$4;
      })());
      if (s.providers && s.providers.length > 0) {
        for (const p of s.providers) {
          nodes.push((() => {
            var _el$7 = _$createElement("text"), _el$8 = _$createTextNode(` `);
            _$insertNode(_el$7, _el$8);
            _$insert(_el$7, () => p.name, null);
            _$effect((_$p) => _$setProp(_el$7, "style", st("textMuted"), _$p));
            return _el$7;
          })());
          const k5 = p.fiveHour >= 70 ? "error" : p.fiveHour >= 40 ? "warning" : "success";
          const kw = p.weekly >= 85 ? "error" : p.weekly >= 60 ? "warning" : "success";
          nodes.push((() => {
            var _el$9 = _$createElement("text"), _el$0 = _$createTextNode(` 5h `), _el$1 = _$createTextNode(` `), _el$10 = _$createTextNode(`% `);
            _$insertNode(_el$9, _el$0);
            _$insertNode(_el$9, _el$1);
            _$insertNode(_el$9, _el$10);
            _$insert(_el$9, () => bar(p.fiveHour), _el$1);
            _$insert(_el$9, () => p.fiveHour, _el$10);
            _$insert(_el$9, () => p.fiveHourReset, null);
            _$effect((_$p) => _$setProp(_el$9, "style", st(k5), _$p));
            return _el$9;
          })());
          nodes.push((() => {
            var _el$11 = _$createElement("text"), _el$12 = _$createTextNode(` wk `), _el$13 = _$createTextNode(` `), _el$14 = _$createTextNode(`% `);
            _$insertNode(_el$11, _el$12);
            _$insertNode(_el$11, _el$13);
            _$insertNode(_el$11, _el$14);
            _$insert(_el$11, () => bar(p.weekly), _el$13);
            _$insert(_el$11, () => p.weekly, _el$14);
            _$insert(_el$11, () => p.weeklyReset, null);
            _$effect((_$p) => _$setProp(_el$11, "style", st(kw), _$p));
            return _el$11;
          })());
          nodes.push((() => {
            var _el$15 = _$createElement("text"), _el$16 = _$createTextNode(` -> `);
            _$insertNode(_el$15, _el$16);
            _$insert(_el$15, () => p.advice, null);
            _$effect((_$p) => _$setProp(_el$15, "style", st(dKey), _$p));
            return _el$15;
          })());
        }
      } else {
        nodes.push((() => {
          var _el$19 = _$createElement("text"), _el$20 = _$createTextNode(` 5h `), _el$21 = _$createTextNode(` `), _el$22 = _$createTextNode(`%`);
          _$insertNode(_el$19, _el$20);
          _$insertNode(_el$19, _el$21);
          _$insertNode(_el$19, _el$22);
          _$insert(_el$19, () => bar(s.fiveHour), _el$21);
          _$insert(_el$19, () => s.fiveHour, _el$22);
          return _el$19;
        })());
        nodes.push((() => {
          var _el$23 = _$createElement("text"), _el$24 = _$createTextNode(` wk `), _el$25 = _$createTextNode(` `), _el$26 = _$createTextNode(`%`);
          _$insertNode(_el$23, _el$24);
          _$insertNode(_el$23, _el$25);
          _$insertNode(_el$23, _el$26);
          _$insert(_el$23, () => bar(s.weekly), _el$25);
          _$insert(_el$23, () => s.weekly, _el$26);
          return _el$23;
        })());
        nodes.push((() => {
          var _el$27 = _$createElement("text"), _el$28 = _$createTextNode(` mo `), _el$29 = _$createTextNode(` `), _el$30 = _$createTextNode(`%`);
          _$insertNode(_el$27, _el$28);
          _$insertNode(_el$27, _el$29);
          _$insertNode(_el$27, _el$30);
          _$insert(_el$27, () => bar(s.monthly), _el$29);
          _$insert(_el$27, () => s.monthly, _el$30);
          return _el$27;
        })());
      }
    } else {
      nodes.push((() => {
        var _el$31 = _$createElement("text");
        _$insertNode(_el$31, _$createTextNode(`usage-coach: ...`));
        return _el$31;
      })());
    }
    if (h && h.active !== false && h.tasks.length > 0) {
      nodes.push((() => {
        var _el$33 = _$createElement("text");
        _$insertNode(_el$33, _$createTextNode(` `));
        return _el$33;
      })());
      nodes.push((() => {
        var _el$35 = _$createElement("text"), _el$36 = _$createTextNode(`harness: `), _el$37 = _$createTextNode(` `), _el$38 = _$createTextNode(`/`);
        _$insertNode(_el$35, _el$36);
        _$insertNode(_el$35, _el$37);
        _$insertNode(_el$35, _el$38);
        _$insert(_el$35, () => h.name, _el$37);
        _$insert(_el$35, () => h.current, _el$38);
        _$insert(_el$35, () => h.total, null);
        _$effect((_$p) => _$setProp(_el$35, "style", st("textMuted"), _$p));
        return _el$35;
      })());
      for (const t of h.tasks) {
        const sKey = statusKey[t.status] ?? "text";
        const lbl = TLABEL[t.status] ?? t.status;
        const rev = t.revisions > 0 && t.status === "revising" ? `(${t.revisions})` : "";
        const mdl = t.model ? ` ${t.model.split("/").pop() ?? t.model}` : "";
        nodes.push((() => {
          var _el$39 = _$createElement("text"), _el$40 = _$createTextNode(` \u25CF `), _el$41 = _$createTextNode(` `), _el$42 = _$createTextNode(` `);
          _$insertNode(_el$39, _el$40);
          _$insertNode(_el$39, _el$41);
          _$insertNode(_el$39, _el$42);
          _$insert(_el$39, () => t.id, _el$41);
          _$insert(_el$39, mdl, _el$41);
          _$insert(_el$39, lbl, _el$42);
          _$insert(_el$39, rev, _el$42);
          _$insert(_el$39, () => short(t.title, 12), null);
          _$effect((_$p) => _$setProp(_el$39, "style", st(sKey), _$p));
          return _el$39;
        })());
        const pv = t.model ? t.model.startsWith("zai") ? "zai" : (t.model.split("/")[0] ?? "").split("-")[0] : "";
        const q = pv && h.quotas?.[pv] ? h.quotas[pv] : null;
        const pct = q ? q.fiveHour : 0;
        const qKey = pct >= 70 ? "error" : pct >= 40 ? "warning" : "success";
        nodes.push((() => {
          var _el$43 = _$createElement("text"), _el$44 = _$createTextNode(` 5h `), _el$45 = _$createTextNode(` `), _el$46 = _$createTextNode(`%`);
          _$insertNode(_el$43, _el$44);
          _$insertNode(_el$43, _el$45);
          _$insertNode(_el$43, _el$46);
          _$insert(_el$43, () => bar(pct), _el$45);
          _$insert(_el$43, pct, _el$46);
          _$effect((_$p) => _$setProp(_el$43, "style", st(qKey), _$p));
          return _el$43;
        })());
      }
    }
    return (() => {
      var _el$47 = _$createElement("box");
      _$setProp(_el$47, "flexDirection", "column");
      _$insert(_el$47, nodes);
      return _el$47;
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
            var _el$48 = _$createElement("text");
            _$insertNode(_el$48, _$createTextNode(`usage-coach`));
            return _el$48;
          })();
        }
      },
      home_footer(ctx) {
        try {
          return panel(ctx);
        } catch {
          return (() => {
            var _el$50 = _$createElement("text");
            _$insertNode(_el$50, _$createTextNode(`usage-coach`));
            return _el$50;
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
