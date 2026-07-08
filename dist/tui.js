// src/tui.tsx
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, statSync, appendFileSync } from "fs";
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
    let best = null;
    let entries = [];
    try {
      entries = readdirSync(STATE_DIR);
    } catch {
    }
    for (const d of entries) {
      const sub = join(STATE_DIR, d);
      let isDir = false;
      try {
        isDir = statSync(sub).isDirectory();
      } catch {
      }
      if (!isDir) continue;
      const f = join(sub, "harness.json");
      if (!existsSync(f)) continue;
      let st;
      try {
        st = statSync(f);
      } catch {
        continue;
      }
      let active = false;
      try {
        active = !!JSON.parse(readFileSync(f, "utf8")).active;
      } catch {
      }
      if (!best || active && !best.active || active === best.active && st.mtimeMs > best.mtime) {
        best = {
          file: f,
          mtime: st.mtimeMs,
          active
        };
      }
    }
    if (best) return JSON.parse(readFileSync(best.file, "utf8"));
    if (existsSync(HARNESS_FILE)) return JSON.parse(readFileSync(HARNESS_FILE, "utf8"));
    return null;
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
  const n = p <= 0 ? 0 : Math.max(1, Math.min(10, Math.round(p / 10)));
  return "\u2588".repeat(n);
}
function barEmpty(p) {
  const n = p <= 0 ? 0 : Math.max(1, Math.min(10, Math.round(p / 10)));
  return "\u2591".repeat(10 - n);
}
function initializeTui(api, disposeRoot) {
  STATE_DIR = process.env.UC_STATE_DIR ?? projectStateDir(api.state.path.directory);
  STATE_FILE = join(STATE_DIR, "state.json");
  HARNESS_FILE = join(STATE_DIR, "harness.json");
  MARKER = join(STATE_DIR, "tui-loaded.txt");
  const TUI_LOG = join(STATE_DIR, "tui-debug.log");
  const tlog = (msg) => {
    try {
      appendFileSync(MARKER, `${(/* @__PURE__ */ new Date()).toISOString()} ${msg}
`);
      appendFileSync(TUI_LOG, `${(/* @__PURE__ */ new Date()).toISOString()} ${msg}
`);
    } catch (e) {
      try {
        appendFileSync(MARKER, `TLOG ERR: ${String(e)}
`);
      } catch {
      }
    }
  };
  try {
    mkdirSync(STATE_DIR, {
      recursive: true
    });
    writeFileSync(MARKER, `loaded-v2 ${(/* @__PURE__ */ new Date()).toISOString()} @ ${api.state.path.directory}`);
  } catch {
  }
  tlog(`init start | dir=${api.state.path.directory} | STATE_DIR=${STATE_DIR}`);
  try {
    tlog(`api keys=${Object.keys(api).join(",")}`);
    tlog(`api.state=${JSON.stringify(api.state).slice(0, 400)}`);
    tlog(`api.state.path=${JSON.stringify(api.state?.path).slice(0, 300)}`);
    const r = api.route;
    tlog(`api.route type=${typeof r} keys=${r && typeof r === "object" ? Object.keys(r).join(",") : "?"} val=${JSON.stringify(r).slice(0, 400)}`);
  } catch (e) {
    tlog(`api probe err: ${String(e)}`);
  }
  const [getState, setState] = createSignal(readState());
  const timer = setInterval(() => {
    try {
      setState(readState());
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
    let s;
    try {
      s = getState();
    } catch {
      s = null;
    }
    let h = null;
    try {
      const routeSid = api.route?.current?.params?.sessionID ?? "";
      const sid = routeSid || (ctx.session_id ?? "");
      if (sid) {
        const hf = join(STATE_DIR, sid, "harness.json");
        if (existsSync(hf)) h = JSON.parse(readFileSync(hf, "utf8"));
      } else {
        h = readHarness();
      }
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
              var _v$ = st("text"), _v$2 = st("text");
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
            _$insertNode(_el$16, _$createTextNode(` 1w `));
            _$insert(_el$18, () => barFill(p.weekly));
            _$insert(_el$19, () => barEmpty(p.weekly));
            _$insertNode(_el$20, _el$21);
            _$insertNode(_el$20, _el$22);
            _$insert(_el$20, () => p.weekly, _el$22);
            _$insert(_el$20, () => p.weeklyReset, null);
            _$effect((_p$) => {
              var _v$3 = st("text"), _v$4 = st("text");
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
          var _el$27 = _$createElement("box"), _el$28 = _$createElement("text"), _el$30 = _$createElement("text"), _el$31 = _$createElement("text"), _el$32 = _$createElement("text");
          _$insertNode(_el$27, _el$28);
          _$insertNode(_el$27, _el$30);
          _$insertNode(_el$27, _el$31);
          _$insertNode(_el$27, _el$32);
          _$setProp(_el$27, "flexDirection", "row");
          _$insertNode(_el$28, _$createTextNode(` 5h `));
          _$insert(_el$30, () => barFill(s.fiveHour));
          _$insert(_el$31, () => barEmpty(s.fiveHour));
          _$insertNode(_el$32, _$createTextNode(` 0%`));
          _$effect((_p$) => {
            var _v$5 = st("text"), _v$6 = st("text");
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
          var _el$34 = _$createElement("box"), _el$35 = _$createElement("text"), _el$37 = _$createElement("text"), _el$38 = _$createElement("text"), _el$39 = _$createElement("text");
          _$insertNode(_el$34, _el$35);
          _$insertNode(_el$34, _el$37);
          _$insertNode(_el$34, _el$38);
          _$insertNode(_el$34, _el$39);
          _$setProp(_el$34, "flexDirection", "row");
          _$insertNode(_el$35, _$createTextNode(` 1w `));
          _$insert(_el$37, () => barFill(s.weekly));
          _$insert(_el$38, () => barEmpty(s.weekly));
          _$insertNode(_el$39, _$createTextNode(` 0%`));
          _$effect((_p$) => {
            var _v$7 = st("text"), _v$8 = st("text");
            _v$7 !== _p$.e && (_p$.e = _$setProp(_el$37, "style", _v$7, _p$.e));
            _v$8 !== _p$.t && (_p$.t = _$setProp(_el$38, "style", _v$8, _p$.t));
            return _p$;
          }, {
            e: void 0,
            t: void 0
          });
          return _el$34;
        })());
      }
    } else {
      nodes.push((() => {
        var _el$41 = _$createElement("text");
        _$insertNode(_el$41, _$createTextNode(`usage-coach: ...`));
        return _el$41;
      })());
    }
    if (h && h.active !== false && h.tasks.length > 0) {
      nodes.push((() => {
        var _el$43 = _$createElement("text");
        _$insertNode(_el$43, _$createTextNode(` `));
        return _el$43;
      })());
      nodes.push((() => {
        var _el$45 = _$createElement("text"), _el$46 = _$createTextNode(`harness: `), _el$47 = _$createTextNode(` `), _el$48 = _$createTextNode(`/`);
        _$insertNode(_el$45, _el$46);
        _$insertNode(_el$45, _el$47);
        _$insertNode(_el$45, _el$48);
        _$insert(_el$45, () => h.name, _el$47);
        _$insert(_el$45, () => h.current, _el$48);
        _$insert(_el$45, () => h.total, null);
        _$effect((_$p) => _$setProp(_el$45, "style", st("textMuted"), _$p));
        return _el$45;
      })());
      for (const t of h.tasks) {
        const sKey = statusKey[t.status] ?? "text";
        const lbl = TLABEL[t.status] ?? t.status;
        const rev = t.revisions > 0 && t.status === "revising" ? `(${t.revisions})` : "";
        const mdl = t.model ? ` ${t.model.split("/").pop() ?? t.model}` : "";
        const elapsed = t.startedAt ? Math.max(0, Math.round((Date.now() - new Date(t.startedAt).getTime()) / 1e3)) : 0;
        const elapsedStr = t.status === "completed" || t.status === "failed" ? "" : elapsed > 0 ? ` ${elapsed}s` : "";
        nodes.push((() => {
          var _el$49 = _$createElement("text"), _el$50 = _$createTextNode(` \u25CF `), _el$51 = _$createTextNode(` `), _el$52 = _$createTextNode(` `);
          _$insertNode(_el$49, _el$50);
          _$insertNode(_el$49, _el$51);
          _$insertNode(_el$49, _el$52);
          _$insert(_el$49, () => t.id, _el$51);
          _$insert(_el$49, mdl, _el$51);
          _$insert(_el$49, lbl, _el$52);
          _$insert(_el$49, rev, _el$52);
          _$insert(_el$49, elapsedStr, _el$52);
          _$insert(_el$49, () => t.title, null);
          _$effect((_$p) => _$setProp(_el$49, "style", st(sKey), _$p));
          return _el$49;
        })());
        const pv = t.model ? (t.model.split("/")[0] ?? "").split("-")[0] : "";
        const provCoach = pv ? s?.providers?.find((p) => p.id === pv || pv && p.id.startsWith(pv) || pv && pv.startsWith(p.id)) : s?.providers?.[0];
        const rawPct = provCoach?.fiveHour ?? s?.fiveHour ?? -1;
        const pct = rawPct < 0 ? 0 : rawPct;
        const pctLabel = rawPct < 0 ? "n/a" : `${rawPct}%`;
        nodes.push((() => {
          var _el$53 = _$createElement("box"), _el$54 = _$createElement("text"), _el$56 = _$createElement("text"), _el$57 = _$createElement("text"), _el$58 = _$createElement("text"), _el$59 = _$createTextNode(` `);
          _$insertNode(_el$53, _el$54);
          _$insertNode(_el$53, _el$56);
          _$insertNode(_el$53, _el$57);
          _$insertNode(_el$53, _el$58);
          _$setProp(_el$53, "flexDirection", "row");
          _$insertNode(_el$54, _$createTextNode(` 5h `));
          _$insert(_el$56, () => barFill(pct));
          _$insert(_el$57, () => barEmpty(pct));
          _$insertNode(_el$58, _el$59);
          _$insert(_el$58, pctLabel, null);
          _$effect((_p$) => {
            var _v$9 = st("text"), _v$0 = st("text");
            _v$9 !== _p$.e && (_p$.e = _$setProp(_el$56, "style", _v$9, _p$.e));
            _v$0 !== _p$.t && (_p$.t = _$setProp(_el$57, "style", _v$0, _p$.t));
            return _p$;
          }, {
            e: void 0,
            t: void 0
          });
          return _el$53;
        })());
      }
    }
    return (() => {
      var _el$60 = _$createElement("box");
      _$setProp(_el$60, "flexDirection", "column");
      _$insert(_el$60, nodes);
      return _el$60;
    })();
  };
  tlog("registering slots");
  api.slots.register({
    order: 80,
    slots: {
      sidebar_footer(ctx) {
        tlog("sidebar_footer slot called");
        let result;
        try {
          result = panel(ctx);
        } catch (e) {
          tlog(`sidebar_footer err: ${String(e)}`);
          result = (() => {
            var _el$61 = _$createElement("text");
            _$insertNode(_el$61, _$createTextNode(`usage-coach`));
            return _el$61;
          })();
        }
        return result;
      }
    }
  });
  tlog("slots registered, init complete");
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
