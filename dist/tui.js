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
    const HARNESS_AGENTS = ["usage-coach-harness"];
    if (s && s.agent && !HARNESS_AGENTS.includes(s.agent)) {
      return _$createElement("box");
    }
    if (s) {
      const dKey = s.decision === "GO" ? "success" : s.decision === "THROTTLE" ? "warning" : "error";
      const modelShort = s.model ? s.model.split("/").pop() ?? s.model : "";
      if (s.isFree) {
        nodes.push((() => {
          var _el$5 = _$createElement("box"), _el$6 = _$createElement("text"), _el$8 = _$createElement("text"), _el$9 = _$createTextNode(` `);
          _$insertNode(_el$5, _el$6);
          _$insertNode(_el$5, _el$8);
          _$setProp(_el$5, "flexDirection", "row");
          _$insertNode(_el$6, _$createTextNode(`usage-coach [free]`));
          _$insertNode(_el$8, _el$9);
          _$insert(_el$8, modelShort, null);
          _$effect((_p$) => {
            var _v$ = st(dKey), _v$2 = st("textMuted");
            _v$ !== _p$.e && (_p$.e = _$setProp(_el$6, "style", _v$, _p$.e));
            _v$2 !== _p$.t && (_p$.t = _$setProp(_el$8, "style", _v$2, _p$.t));
            return _p$;
          }, {
            e: void 0,
            t: void 0
          });
          return _el$5;
        })());
      } else {
        if (modelShort) {
          nodes.push((() => {
            var _el$0 = _$createElement("box"), _el$1 = _$createElement("text"), _el$10 = _$createTextNode(`usage-coach [`), _el$11 = _$createTextNode(`]`), _el$12 = _$createElement("text"), _el$13 = _$createTextNode(` `);
            _$insertNode(_el$0, _el$1);
            _$insertNode(_el$0, _el$12);
            _$setProp(_el$0, "flexDirection", "row");
            _$insertNode(_el$1, _el$10);
            _$insertNode(_el$1, _el$11);
            _$insert(_el$1, () => TAG[s.decision], _el$11);
            _$insertNode(_el$12, _el$13);
            _$insert(_el$12, modelShort, null);
            _$effect((_p$) => {
              var _v$3 = st(dKey), _v$4 = st("textMuted");
              _v$3 !== _p$.e && (_p$.e = _$setProp(_el$1, "style", _v$3, _p$.e));
              _v$4 !== _p$.t && (_p$.t = _$setProp(_el$12, "style", _v$4, _p$.t));
              return _p$;
            }, {
              e: void 0,
              t: void 0
            });
            return _el$0;
          })());
        } else {
          nodes.push((() => {
            var _el$14 = _$createElement("text"), _el$15 = _$createTextNode(`usage-coach [`), _el$16 = _$createTextNode(`]`);
            _$insertNode(_el$14, _el$15);
            _$insertNode(_el$14, _el$16);
            _$insert(_el$14, () => TAG[s.decision], _el$16);
            _$effect((_$p) => _$setProp(_el$14, "style", st(dKey), _$p));
            return _el$14;
          })());
        }
        if (s.providers && s.providers.length > 0) {
          for (const p of s.providers) {
            nodes.push((() => {
              var _el$17 = _$createElement("box"), _el$18 = _$createElement("text"), _el$20 = _$createElement("text"), _el$21 = _$createElement("text"), _el$22 = _$createElement("text"), _el$23 = _$createTextNode(` `), _el$24 = _$createTextNode(`% `);
              _$insertNode(_el$17, _el$18);
              _$insertNode(_el$17, _el$20);
              _$insertNode(_el$17, _el$21);
              _$insertNode(_el$17, _el$22);
              _$setProp(_el$17, "flexDirection", "row");
              _$insertNode(_el$18, _$createTextNode(` 5h `));
              _$insert(_el$20, () => barFill(p.fiveHour));
              _$insert(_el$21, () => barEmpty(p.fiveHour));
              _$insertNode(_el$22, _el$23);
              _$insertNode(_el$22, _el$24);
              _$insert(_el$22, () => p.fiveHour, _el$24);
              _$insert(_el$22, () => p.fiveHourReset, null);
              _$effect((_p$) => {
                var _v$5 = st("text"), _v$6 = st("text");
                _v$5 !== _p$.e && (_p$.e = _$setProp(_el$20, "style", _v$5, _p$.e));
                _v$6 !== _p$.t && (_p$.t = _$setProp(_el$21, "style", _v$6, _p$.t));
                return _p$;
              }, {
                e: void 0,
                t: void 0
              });
              return _el$17;
            })());
            nodes.push((() => {
              var _el$25 = _$createElement("box"), _el$26 = _$createElement("text"), _el$28 = _$createElement("text"), _el$29 = _$createElement("text"), _el$30 = _$createElement("text"), _el$31 = _$createTextNode(` `), _el$32 = _$createTextNode(`% `);
              _$insertNode(_el$25, _el$26);
              _$insertNode(_el$25, _el$28);
              _$insertNode(_el$25, _el$29);
              _$insertNode(_el$25, _el$30);
              _$setProp(_el$25, "flexDirection", "row");
              _$insertNode(_el$26, _$createTextNode(` 1w `));
              _$insert(_el$28, () => barFill(p.weekly));
              _$insert(_el$29, () => barEmpty(p.weekly));
              _$insertNode(_el$30, _el$31);
              _$insertNode(_el$30, _el$32);
              _$insert(_el$30, () => p.weekly, _el$32);
              _$insert(_el$30, () => p.weeklyReset, null);
              _$effect((_p$) => {
                var _v$7 = st("text"), _v$8 = st("text");
                _v$7 !== _p$.e && (_p$.e = _$setProp(_el$28, "style", _v$7, _p$.e));
                _v$8 !== _p$.t && (_p$.t = _$setProp(_el$29, "style", _v$8, _p$.t));
                return _p$;
              }, {
                e: void 0,
                t: void 0
              });
              return _el$25;
            })());
          }
        } else {
          nodes.push((() => {
            var _el$33 = _$createElement("box"), _el$34 = _$createElement("text"), _el$36 = _$createElement("text"), _el$37 = _$createElement("text"), _el$38 = _$createElement("text");
            _$insertNode(_el$33, _el$34);
            _$insertNode(_el$33, _el$36);
            _$insertNode(_el$33, _el$37);
            _$insertNode(_el$33, _el$38);
            _$setProp(_el$33, "flexDirection", "row");
            _$insertNode(_el$34, _$createTextNode(` 5h `));
            _$insert(_el$36, () => barFill(s.fiveHour));
            _$insert(_el$37, () => barEmpty(s.fiveHour));
            _$insertNode(_el$38, _$createTextNode(` 0%`));
            _$effect((_p$) => {
              var _v$9 = st("text"), _v$0 = st("text");
              _v$9 !== _p$.e && (_p$.e = _$setProp(_el$36, "style", _v$9, _p$.e));
              _v$0 !== _p$.t && (_p$.t = _$setProp(_el$37, "style", _v$0, _p$.t));
              return _p$;
            }, {
              e: void 0,
              t: void 0
            });
            return _el$33;
          })());
          nodes.push((() => {
            var _el$40 = _$createElement("box"), _el$41 = _$createElement("text"), _el$43 = _$createElement("text"), _el$44 = _$createElement("text"), _el$45 = _$createElement("text");
            _$insertNode(_el$40, _el$41);
            _$insertNode(_el$40, _el$43);
            _$insertNode(_el$40, _el$44);
            _$insertNode(_el$40, _el$45);
            _$setProp(_el$40, "flexDirection", "row");
            _$insertNode(_el$41, _$createTextNode(` 1w `));
            _$insert(_el$43, () => barFill(s.weekly));
            _$insert(_el$44, () => barEmpty(s.weekly));
            _$insertNode(_el$45, _$createTextNode(` 0%`));
            _$effect((_p$) => {
              var _v$1 = st("text"), _v$10 = st("text");
              _v$1 !== _p$.e && (_p$.e = _$setProp(_el$43, "style", _v$1, _p$.e));
              _v$10 !== _p$.t && (_p$.t = _$setProp(_el$44, "style", _v$10, _p$.t));
              return _p$;
            }, {
              e: void 0,
              t: void 0
            });
            return _el$40;
          })());
        }
      }
    } else {
      nodes.push((() => {
        var _el$47 = _$createElement("text");
        _$insertNode(_el$47, _$createTextNode(`usage-coach: ...`));
        return _el$47;
      })());
    }
    if (h && h.active !== false && h.tasks.length > 0) {
      nodes.push((() => {
        var _el$49 = _$createElement("text");
        _$insertNode(_el$49, _$createTextNode(` `));
        return _el$49;
      })());
      nodes.push((() => {
        var _el$51 = _$createElement("text"), _el$52 = _$createTextNode(`harness: `), _el$53 = _$createTextNode(` `), _el$54 = _$createTextNode(`/`);
        _$insertNode(_el$51, _el$52);
        _$insertNode(_el$51, _el$53);
        _$insertNode(_el$51, _el$54);
        _$insert(_el$51, () => h.name, _el$53);
        _$insert(_el$51, () => h.current, _el$54);
        _$insert(_el$51, () => h.total, null);
        _$effect((_$p) => _$setProp(_el$51, "style", st("textMuted"), _$p));
        return _el$51;
      })());
      for (const t of h.tasks) {
        const sKey = statusKey[t.status] ?? "text";
        const lbl = TLABEL[t.status] ?? t.status;
        const rev = t.revisions > 0 && t.status === "revising" ? `(${t.revisions})` : "";
        const mdl = t.model ? ` ${t.model.split("/").pop() ?? t.model}` : "";
        const elapsed = t.startedAt ? Math.max(0, Math.round((Date.now() - new Date(t.startedAt).getTime()) / 1e3)) : 0;
        const elapsedStr = t.status === "completed" || t.status === "failed" ? "" : elapsed > 0 ? ` ${elapsed}s` : "";
        nodes.push((() => {
          var _el$55 = _$createElement("text"), _el$56 = _$createTextNode(` \u25CF `), _el$57 = _$createTextNode(` `), _el$58 = _$createTextNode(` `);
          _$insertNode(_el$55, _el$56);
          _$insertNode(_el$55, _el$57);
          _$insertNode(_el$55, _el$58);
          _$insert(_el$55, () => t.id, _el$57);
          _$insert(_el$55, mdl, _el$57);
          _$insert(_el$55, lbl, _el$58);
          _$insert(_el$55, rev, _el$58);
          _$insert(_el$55, elapsedStr, _el$58);
          _$insert(_el$55, () => t.title, null);
          _$effect((_$p) => _$setProp(_el$55, "style", st(sKey), _$p));
          return _el$55;
        })());
        const pv = t.model ? (t.model.split("/")[0] ?? "").split("-")[0] : "";
        const provCoach = pv ? s?.providers?.find((p) => p.id === pv || pv && p.id.startsWith(pv) || pv && pv.startsWith(p.id)) : s?.providers?.[0];
        const rawPct = provCoach?.fiveHour ?? s?.fiveHour ?? -1;
        const pct = rawPct < 0 ? 0 : rawPct;
        const pctLabel = rawPct < 0 ? "n/a" : `${rawPct}%`;
        nodes.push((() => {
          var _el$59 = _$createElement("box"), _el$60 = _$createElement("text"), _el$62 = _$createElement("text"), _el$63 = _$createElement("text"), _el$64 = _$createElement("text"), _el$65 = _$createTextNode(` `);
          _$insertNode(_el$59, _el$60);
          _$insertNode(_el$59, _el$62);
          _$insertNode(_el$59, _el$63);
          _$insertNode(_el$59, _el$64);
          _$setProp(_el$59, "flexDirection", "row");
          _$insertNode(_el$60, _$createTextNode(` 5h `));
          _$insert(_el$62, () => barFill(pct));
          _$insert(_el$63, () => barEmpty(pct));
          _$insertNode(_el$64, _el$65);
          _$insert(_el$64, pctLabel, null);
          _$effect((_p$) => {
            var _v$11 = st("text"), _v$12 = st("text");
            _v$11 !== _p$.e && (_p$.e = _$setProp(_el$62, "style", _v$11, _p$.e));
            _v$12 !== _p$.t && (_p$.t = _$setProp(_el$63, "style", _v$12, _p$.t));
            return _p$;
          }, {
            e: void 0,
            t: void 0
          });
          return _el$59;
        })());
      }
    }
    return (() => {
      var _el$66 = _$createElement("box");
      _$setProp(_el$66, "flexDirection", "column");
      _$insert(_el$66, nodes);
      return _el$66;
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
            var _el$67 = _$createElement("text");
            _$insertNode(_el$67, _$createTextNode(`usage-coach`));
            return _el$67;
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
