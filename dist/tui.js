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
            var _el$9 = _$createElement("text");
            _$insertNode(_el$9, _$createTextNode(` 5h `));
            return _el$9;
          })());
          nodes.push((() => {
            var _el$1 = _$createElement("text");
            _$insert(_el$1, () => barFill(p.fiveHour));
            _$effect((_$p) => _$setProp(_el$1, "style", st("text"), _$p));
            return _el$1;
          })());
          nodes.push((() => {
            var _el$10 = _$createElement("text");
            _$insert(_el$10, () => barEmpty(p.fiveHour));
            _$effect((_$p) => _$setProp(_el$10, "style", st("textMuted"), _$p));
            return _el$10;
          })());
          nodes.push((() => {
            var _el$11 = _$createElement("text"), _el$12 = _$createTextNode(` `), _el$13 = _$createTextNode(`% `);
            _$insertNode(_el$11, _el$12);
            _$insertNode(_el$11, _el$13);
            _$insert(_el$11, () => p.fiveHour, _el$13);
            _$insert(_el$11, () => p.fiveHourReset, null);
            return _el$11;
          })());
          nodes.push((() => {
            var _el$14 = _$createElement("text");
            _$insertNode(_el$14, _$createTextNode(` wk `));
            return _el$14;
          })());
          nodes.push((() => {
            var _el$16 = _$createElement("text");
            _$insert(_el$16, () => barFill(p.weekly));
            _$effect((_$p) => _$setProp(_el$16, "style", st("text"), _$p));
            return _el$16;
          })());
          nodes.push((() => {
            var _el$17 = _$createElement("text");
            _$insert(_el$17, () => barEmpty(p.weekly));
            _$effect((_$p) => _$setProp(_el$17, "style", st("textMuted"), _$p));
            return _el$17;
          })());
          nodes.push((() => {
            var _el$18 = _$createElement("text"), _el$19 = _$createTextNode(` `), _el$20 = _$createTextNode(`% `);
            _$insertNode(_el$18, _el$19);
            _$insertNode(_el$18, _el$20);
            _$insert(_el$18, () => p.weekly, _el$20);
            _$insert(_el$18, () => p.weeklyReset, null);
            return _el$18;
          })());
          nodes.push((() => {
            var _el$21 = _$createElement("text"), _el$22 = _$createTextNode(` -> `);
            _$insertNode(_el$21, _el$22);
            _$insert(_el$21, () => p.advice, null);
            _$effect((_$p) => _$setProp(_el$21, "style", st(dKey), _$p));
            return _el$21;
          })());
        }
      } else {
        nodes.push((() => {
          var _el$25 = _$createElement("text");
          _$insertNode(_el$25, _$createTextNode(` 5h `));
          return _el$25;
        })());
        nodes.push((() => {
          var _el$27 = _$createElement("text");
          _$insert(_el$27, () => barFill(s.fiveHour));
          _$effect((_$p) => _$setProp(_el$27, "style", st("text"), _$p));
          return _el$27;
        })());
        nodes.push((() => {
          var _el$28 = _$createElement("text");
          _$insert(_el$28, () => barEmpty(s.fiveHour));
          _$effect((_$p) => _$setProp(_el$28, "style", st("textMuted"), _$p));
          return _el$28;
        })());
        nodes.push((() => {
          var _el$29 = _$createElement("text"), _el$30 = _$createTextNode(` `), _el$31 = _$createTextNode(`%`);
          _$insertNode(_el$29, _el$30);
          _$insertNode(_el$29, _el$31);
          _$insert(_el$29, () => s.fiveHour, _el$31);
          return _el$29;
        })());
        nodes.push((() => {
          var _el$32 = _$createElement("text");
          _$insertNode(_el$32, _$createTextNode(` wk `));
          return _el$32;
        })());
        nodes.push((() => {
          var _el$34 = _$createElement("text");
          _$insert(_el$34, () => barFill(s.weekly));
          _$effect((_$p) => _$setProp(_el$34, "style", st("text"), _$p));
          return _el$34;
        })());
        nodes.push((() => {
          var _el$35 = _$createElement("text");
          _$insert(_el$35, () => barEmpty(s.weekly));
          _$effect((_$p) => _$setProp(_el$35, "style", st("textMuted"), _$p));
          return _el$35;
        })());
        nodes.push((() => {
          var _el$36 = _$createElement("text"), _el$37 = _$createTextNode(` `), _el$38 = _$createTextNode(`%`);
          _$insertNode(_el$36, _el$37);
          _$insertNode(_el$36, _el$38);
          _$insert(_el$36, () => s.weekly, _el$38);
          return _el$36;
        })());
        nodes.push((() => {
          var _el$39 = _$createElement("text");
          _$insertNode(_el$39, _$createTextNode(` mo `));
          return _el$39;
        })());
        nodes.push((() => {
          var _el$41 = _$createElement("text");
          _$insert(_el$41, () => barFill(s.monthly));
          _$effect((_$p) => _$setProp(_el$41, "style", st("text"), _$p));
          return _el$41;
        })());
        nodes.push((() => {
          var _el$42 = _$createElement("text");
          _$insert(_el$42, () => barEmpty(s.monthly));
          _$effect((_$p) => _$setProp(_el$42, "style", st("textMuted"), _$p));
          return _el$42;
        })());
        nodes.push((() => {
          var _el$43 = _$createElement("text"), _el$44 = _$createTextNode(` `), _el$45 = _$createTextNode(`%`);
          _$insertNode(_el$43, _el$44);
          _$insertNode(_el$43, _el$45);
          _$insert(_el$43, () => s.monthly, _el$45);
          return _el$43;
        })());
      }
    } else {
      nodes.push((() => {
        var _el$46 = _$createElement("text");
        _$insertNode(_el$46, _$createTextNode(`usage-coach: ...`));
        return _el$46;
      })());
    }
    if (h && h.active !== false && h.tasks.length > 0) {
      nodes.push((() => {
        var _el$48 = _$createElement("text");
        _$insertNode(_el$48, _$createTextNode(` `));
        return _el$48;
      })());
      nodes.push((() => {
        var _el$50 = _$createElement("text"), _el$51 = _$createTextNode(`harness: `), _el$52 = _$createTextNode(` `), _el$53 = _$createTextNode(`/`);
        _$insertNode(_el$50, _el$51);
        _$insertNode(_el$50, _el$52);
        _$insertNode(_el$50, _el$53);
        _$insert(_el$50, () => h.name, _el$52);
        _$insert(_el$50, () => h.current, _el$53);
        _$insert(_el$50, () => h.total, null);
        _$effect((_$p) => _$setProp(_el$50, "style", st("textMuted"), _$p));
        return _el$50;
      })());
      for (const t of h.tasks) {
        const sKey = statusKey[t.status] ?? "text";
        const lbl = TLABEL[t.status] ?? t.status;
        const rev = t.revisions > 0 && t.status === "revising" ? `(${t.revisions})` : "";
        const mdl = t.model ? ` ${t.model.split("/").pop() ?? t.model}` : "";
        nodes.push((() => {
          var _el$54 = _$createElement("text"), _el$55 = _$createTextNode(` \u25CF `), _el$56 = _$createTextNode(` `), _el$57 = _$createTextNode(` `);
          _$insertNode(_el$54, _el$55);
          _$insertNode(_el$54, _el$56);
          _$insertNode(_el$54, _el$57);
          _$insert(_el$54, () => t.id, _el$56);
          _$insert(_el$54, mdl, _el$56);
          _$insert(_el$54, lbl, _el$57);
          _$insert(_el$54, rev, _el$57);
          _$insert(_el$54, () => short(t.title, 12), null);
          _$effect((_$p) => _$setProp(_el$54, "style", st(sKey), _$p));
          return _el$54;
        })());
        const pv = t.model ? t.model.startsWith("zai") ? "zai" : (t.model.split("/")[0] ?? "").split("-")[0] : "";
        const q = pv && h.quotas?.[pv] ? h.quotas[pv] : null;
        const pct = q ? q.fiveHour : 0;
        nodes.push((() => {
          var _el$58 = _$createElement("text");
          _$insertNode(_el$58, _$createTextNode(` 5h `));
          return _el$58;
        })());
        nodes.push((() => {
          var _el$60 = _$createElement("text");
          _$insert(_el$60, () => barFill(pct));
          _$effect((_$p) => _$setProp(_el$60, "style", st("text"), _$p));
          return _el$60;
        })());
        nodes.push((() => {
          var _el$61 = _$createElement("text");
          _$insert(_el$61, () => barEmpty(pct));
          _$effect((_$p) => _$setProp(_el$61, "style", st("textMuted"), _$p));
          return _el$61;
        })());
        nodes.push((() => {
          var _el$62 = _$createElement("text"), _el$63 = _$createTextNode(` `), _el$64 = _$createTextNode(`%`);
          _$insertNode(_el$62, _el$63);
          _$insertNode(_el$62, _el$64);
          _$insert(_el$62, pct, _el$64);
          return _el$62;
        })());
      }
    }
    return (() => {
      var _el$65 = _$createElement("box");
      _$setProp(_el$65, "flexDirection", "column");
      _$insert(_el$65, nodes);
      return _el$65;
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
            var _el$66 = _$createElement("text");
            _$insertNode(_el$66, _$createTextNode(`usage-coach`));
            return _el$66;
          })();
        }
      },
      home_footer(ctx) {
        try {
          return panel(ctx);
        } catch {
          return (() => {
            var _el$68 = _$createElement("text");
            _$insertNode(_el$68, _$createTextNode(`usage-coach`));
            return _el$68;
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
