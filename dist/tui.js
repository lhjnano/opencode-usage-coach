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
function barFill(p) {
  return "\u2588".repeat(Math.max(0, Math.min(10, Math.round(p / 10))));
}
function barEmpty(p) {
  return "\u2591".repeat(10 - Math.max(0, Math.min(10, Math.round(p / 10))));
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
          nodes.push((() => {
            var _el$9 = _$createElement("box"), _el$0 = _$createElement("text"), _el$10 = _$createElement("text"), _el$11 = _$createElement("text"), _el$12 = _$createElement("text"), _el$13 = _$createTextNode(` `), _el$14 = _$createTextNode(`% `);
            _$insertNode(_el$9, _el$0);
            _$insertNode(_el$9, _el$10);
            _$insertNode(_el$9, _el$11);
            _$insertNode(_el$9, _el$12);
            _$setProp(_el$9, "flexDirection", "row");
            _$insertNode(_el$0, _$createTextNode(` 5h `));
            _$insert(_el$10, () => barFill(p.fiveHour));
            _$insert(_el$11, () => barEmpty(p.fiveHour));
            _$insertNode(_el$12, _el$13);
            _$insertNode(_el$12, _el$14);
            _$insert(_el$12, () => p.fiveHour, _el$14);
            _$insert(_el$12, () => p.fiveHourReset, null);
            _$effect((_p$) => {
              var _v$ = st("text"), _v$2 = st("textMuted");
              _v$ !== _p$.e && (_p$.e = _$setProp(_el$10, "style", _v$, _p$.e));
              _v$2 !== _p$.t && (_p$.t = _$setProp(_el$11, "style", _v$2, _p$.t));
              return _p$;
            }, {
              e: void 0,
              t: void 0
            });
            return _el$9;
          })());
          nodes.push((() => {
            var _el$15 = _$createElement("box"), _el$16 = _$createElement("text"), _el$18 = _$createElement("text"), _el$19 = _$createElement("text"), _el$20 = _$createElement("text"), _el$21 = _$createTextNode(` `), _el$22 = _$createTextNode(`% `);
            _$insertNode(_el$15, _el$16);
            _$insertNode(_el$15, _el$18);
            _$insertNode(_el$15, _el$19);
            _$insertNode(_el$15, _el$20);
            _$setProp(_el$15, "flexDirection", "row");
            _$insertNode(_el$16, _$createTextNode(` wk `));
            _$insert(_el$18, () => barFill(p.weekly));
            _$insert(_el$19, () => barEmpty(p.weekly));
            _$insertNode(_el$20, _el$21);
            _$insertNode(_el$20, _el$22);
            _$insert(_el$20, () => p.weekly, _el$22);
            _$insert(_el$20, () => p.weeklyReset, null);
            _$effect((_p$) => {
              var _v$3 = st("text"), _v$4 = st("textMuted");
              _v$3 !== _p$.e && (_p$.e = _$setProp(_el$18, "style", _v$3, _p$.e));
              _v$4 !== _p$.t && (_p$.t = _$setProp(_el$19, "style", _v$4, _p$.t));
              return _p$;
            }, {
              e: void 0,
              t: void 0
            });
            return _el$15;
          })());
          nodes.push((() => {
            var _el$23 = _$createElement("text"), _el$24 = _$createTextNode(` -> `);
            _$insertNode(_el$23, _el$24);
            _$insert(_el$23, () => p.advice, null);
            _$effect((_$p) => _$setProp(_el$23, "style", st(dKey), _$p));
            return _el$23;
          })());
        }
      } else {
        nodes.push((() => {
          var _el$27 = _$createElement("box"), _el$28 = _$createElement("text"), _el$30 = _$createElement("text"), _el$31 = _$createElement("text"), _el$32 = _$createElement("text"), _el$33 = _$createTextNode(` `), _el$34 = _$createTextNode(`%`);
          _$insertNode(_el$27, _el$28);
          _$insertNode(_el$27, _el$30);
          _$insertNode(_el$27, _el$31);
          _$insertNode(_el$27, _el$32);
          _$setProp(_el$27, "flexDirection", "row");
          _$insertNode(_el$28, _$createTextNode(` 5h `));
          _$insert(_el$30, () => barFill(s.fiveHour));
          _$insert(_el$31, () => barEmpty(s.fiveHour));
          _$insertNode(_el$32, _el$33);
          _$insertNode(_el$32, _el$34);
          _$insert(_el$32, () => s.fiveHour, _el$34);
          _$effect((_p$) => {
            var _v$5 = st("text"), _v$6 = st("textMuted");
            _v$5 !== _p$.e && (_p$.e = _$setProp(_el$30, "style", _v$5, _p$.e));
            _v$6 !== _p$.t && (_p$.t = _$setProp(_el$31, "style", _v$6, _p$.t));
            return _p$;
          }, {
            e: void 0,
            t: void 0
          });
          return _el$27;
        })());
        nodes.push((() => {
          var _el$35 = _$createElement("box"), _el$36 = _$createElement("text"), _el$38 = _$createElement("text"), _el$39 = _$createElement("text"), _el$40 = _$createElement("text"), _el$41 = _$createTextNode(` `), _el$42 = _$createTextNode(`%`);
          _$insertNode(_el$35, _el$36);
          _$insertNode(_el$35, _el$38);
          _$insertNode(_el$35, _el$39);
          _$insertNode(_el$35, _el$40);
          _$setProp(_el$35, "flexDirection", "row");
          _$insertNode(_el$36, _$createTextNode(` wk `));
          _$insert(_el$38, () => barFill(s.weekly));
          _$insert(_el$39, () => barEmpty(s.weekly));
          _$insertNode(_el$40, _el$41);
          _$insertNode(_el$40, _el$42);
          _$insert(_el$40, () => s.weekly, _el$42);
          _$effect((_p$) => {
            var _v$7 = st("text"), _v$8 = st("textMuted");
            _v$7 !== _p$.e && (_p$.e = _$setProp(_el$38, "style", _v$7, _p$.e));
            _v$8 !== _p$.t && (_p$.t = _$setProp(_el$39, "style", _v$8, _p$.t));
            return _p$;
          }, {
            e: void 0,
            t: void 0
          });
          return _el$35;
        })());
        nodes.push((() => {
          var _el$43 = _$createElement("box"), _el$44 = _$createElement("text"), _el$46 = _$createElement("text"), _el$47 = _$createElement("text"), _el$48 = _$createElement("text"), _el$49 = _$createTextNode(` `), _el$50 = _$createTextNode(`%`);
          _$insertNode(_el$43, _el$44);
          _$insertNode(_el$43, _el$46);
          _$insertNode(_el$43, _el$47);
          _$insertNode(_el$43, _el$48);
          _$setProp(_el$43, "flexDirection", "row");
          _$insertNode(_el$44, _$createTextNode(` mo `));
          _$insert(_el$46, () => barFill(s.monthly));
          _$insert(_el$47, () => barEmpty(s.monthly));
          _$insertNode(_el$48, _el$49);
          _$insertNode(_el$48, _el$50);
          _$insert(_el$48, () => s.monthly, _el$50);
          _$effect((_p$) => {
            var _v$9 = st("text"), _v$0 = st("textMuted");
            _v$9 !== _p$.e && (_p$.e = _$setProp(_el$46, "style", _v$9, _p$.e));
            _v$0 !== _p$.t && (_p$.t = _$setProp(_el$47, "style", _v$0, _p$.t));
            return _p$;
          }, {
            e: void 0,
            t: void 0
          });
          return _el$43;
        })());
      }
    } else {
      nodes.push((() => {
        var _el$51 = _$createElement("text");
        _$insertNode(_el$51, _$createTextNode(`usage-coach: ...`));
        return _el$51;
      })());
    }
    if (h && h.active !== false && h.tasks.length > 0) {
      nodes.push((() => {
        var _el$53 = _$createElement("text");
        _$insertNode(_el$53, _$createTextNode(` `));
        return _el$53;
      })());
      nodes.push((() => {
        var _el$55 = _$createElement("text"), _el$56 = _$createTextNode(`harness: `), _el$57 = _$createTextNode(` `), _el$58 = _$createTextNode(`/`);
        _$insertNode(_el$55, _el$56);
        _$insertNode(_el$55, _el$57);
        _$insertNode(_el$55, _el$58);
        _$insert(_el$55, () => h.name, _el$57);
        _$insert(_el$55, () => h.current, _el$58);
        _$insert(_el$55, () => h.total, null);
        _$effect((_$p) => _$setProp(_el$55, "style", st("textMuted"), _$p));
        return _el$55;
      })());
      for (const t of h.tasks) {
        const sKey = statusKey[t.status] ?? "text";
        const lbl = TLABEL[t.status] ?? t.status;
        const rev = t.revisions > 0 && t.status === "revising" ? `(${t.revisions})` : "";
        const mdl = t.model ? ` ${t.model.split("/").pop() ?? t.model}` : "";
        nodes.push((() => {
          var _el$59 = _$createElement("text"), _el$60 = _$createTextNode(` \u25CF `), _el$61 = _$createTextNode(` `), _el$62 = _$createTextNode(` `);
          _$insertNode(_el$59, _el$60);
          _$insertNode(_el$59, _el$61);
          _$insertNode(_el$59, _el$62);
          _$insert(_el$59, () => t.id, _el$61);
          _$insert(_el$59, mdl, _el$61);
          _$insert(_el$59, lbl, _el$62);
          _$insert(_el$59, rev, _el$62);
          _$insert(_el$59, () => short(t.title, 12), null);
          _$effect((_$p) => _$setProp(_el$59, "style", st(sKey), _$p));
          return _el$59;
        })());
        const pv = t.model ? t.model.startsWith("zai") ? "zai" : (t.model.split("/")[0] ?? "").split("-")[0] : "";
        const q = pv && h.quotas?.[pv] ? h.quotas[pv] : null;
        const pct = q ? q.fiveHour : 0;
        nodes.push((() => {
          var _el$63 = _$createElement("box"), _el$64 = _$createElement("text"), _el$66 = _$createElement("text"), _el$67 = _$createElement("text"), _el$68 = _$createElement("text"), _el$69 = _$createTextNode(` `), _el$70 = _$createTextNode(`%`);
          _$insertNode(_el$63, _el$64);
          _$insertNode(_el$63, _el$66);
          _$insertNode(_el$63, _el$67);
          _$insertNode(_el$63, _el$68);
          _$setProp(_el$63, "flexDirection", "row");
          _$insertNode(_el$64, _$createTextNode(` 5h `));
          _$insert(_el$66, () => barFill(pct));
          _$insert(_el$67, () => barEmpty(pct));
          _$insertNode(_el$68, _el$69);
          _$insertNode(_el$68, _el$70);
          _$insert(_el$68, pct, _el$70);
          _$effect((_p$) => {
            var _v$1 = st("text"), _v$10 = st("textMuted");
            _v$1 !== _p$.e && (_p$.e = _$setProp(_el$66, "style", _v$1, _p$.e));
            _v$10 !== _p$.t && (_p$.t = _$setProp(_el$67, "style", _v$10, _p$.t));
            return _p$;
          }, {
            e: void 0,
            t: void 0
          });
          return _el$63;
        })());
      }
    }
    return (() => {
      var _el$71 = _$createElement("box");
      _$setProp(_el$71, "flexDirection", "column");
      _$insert(_el$71, nodes);
      return _el$71;
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
            var _el$72 = _$createElement("text");
            _$insertNode(_el$72, _$createTextNode(`usage-coach`));
            return _el$72;
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
