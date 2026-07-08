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
var HARNESS_AGENT_IDS = (process.env.UC_HARNESS_AGENT ?? "Usage-Coach-Harness").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
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
    const isHarness = s?.agent ? HARNESS_AGENT_IDS.includes(s.agent.toLowerCase()) : false;
    if (s?.agent && !isHarness) {
      return (() => {
        var _el$4 = _$createElement("box"), _el$5 = _$createElement("text");
        _$insertNode(_el$4, _el$5);
        _$insertNode(_el$5, _$createTextNode(`usage-coach`));
        _$effect((_$p) => _$setProp(_el$5, "style", st("textMuted"), _$p));
        return _el$4;
      })();
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
        var _el$7 = _$createElement("text"), _el$8 = _$createTextNode(`usage-coach [`), _el$9 = _$createTextNode(`]`);
        _$insertNode(_el$7, _el$8);
        _$insertNode(_el$7, _el$9);
        _$insert(_el$7, () => TAG[s.decision], _el$9);
        _$effect((_$p) => _$setProp(_el$7, "style", st(dKey), _$p));
        return _el$7;
      })());
      if (s.providers && s.providers.length > 0) {
        for (const p of s.providers) {
          nodes.push((() => {
            var _el$0 = _$createElement("text"), _el$1 = _$createTextNode(` `);
            _$insertNode(_el$0, _el$1);
            _$insert(_el$0, () => p.name, null);
            _$effect((_$p) => _$setProp(_el$0, "style", st("textMuted"), _$p));
            return _el$0;
          })());
          nodes.push((() => {
            var _el$10 = _$createElement("box"), _el$11 = _$createElement("text"), _el$13 = _$createElement("text"), _el$14 = _$createElement("text"), _el$15 = _$createElement("text"), _el$16 = _$createTextNode(` `), _el$17 = _$createTextNode(`% `);
            _$insertNode(_el$10, _el$11);
            _$insertNode(_el$10, _el$13);
            _$insertNode(_el$10, _el$14);
            _$insertNode(_el$10, _el$15);
            _$setProp(_el$10, "flexDirection", "row");
            _$insertNode(_el$11, _$createTextNode(` 5h `));
            _$insert(_el$13, () => barFill(p.fiveHour));
            _$insert(_el$14, () => barEmpty(p.fiveHour));
            _$insertNode(_el$15, _el$16);
            _$insertNode(_el$15, _el$17);
            _$insert(_el$15, () => p.fiveHour, _el$17);
            _$insert(_el$15, () => p.fiveHourReset, null);
            _$effect((_p$) => {
              var _v$ = st("text"), _v$2 = st("text");
              _v$ !== _p$.e && (_p$.e = _$setProp(_el$13, "style", _v$, _p$.e));
              _v$2 !== _p$.t && (_p$.t = _$setProp(_el$14, "style", _v$2, _p$.t));
              return _p$;
            }, {
              e: void 0,
              t: void 0
            });
            return _el$10;
          })());
          nodes.push((() => {
            var _el$18 = _$createElement("box"), _el$19 = _$createElement("text"), _el$21 = _$createElement("text"), _el$22 = _$createElement("text"), _el$23 = _$createElement("text"), _el$24 = _$createTextNode(` `), _el$25 = _$createTextNode(`% `);
            _$insertNode(_el$18, _el$19);
            _$insertNode(_el$18, _el$21);
            _$insertNode(_el$18, _el$22);
            _$insertNode(_el$18, _el$23);
            _$setProp(_el$18, "flexDirection", "row");
            _$insertNode(_el$19, _$createTextNode(` 1w `));
            _$insert(_el$21, () => barFill(p.weekly));
            _$insert(_el$22, () => barEmpty(p.weekly));
            _$insertNode(_el$23, _el$24);
            _$insertNode(_el$23, _el$25);
            _$insert(_el$23, () => p.weekly, _el$25);
            _$insert(_el$23, () => p.weeklyReset, null);
            _$effect((_p$) => {
              var _v$3 = st("text"), _v$4 = st("text");
              _v$3 !== _p$.e && (_p$.e = _$setProp(_el$21, "style", _v$3, _p$.e));
              _v$4 !== _p$.t && (_p$.t = _$setProp(_el$22, "style", _v$4, _p$.t));
              return _p$;
            }, {
              e: void 0,
              t: void 0
            });
            return _el$18;
          })());
          nodes.push((() => {
            var _el$26 = _$createElement("text"), _el$27 = _$createTextNode(` -> `);
            _$insertNode(_el$26, _el$27);
            _$insert(_el$26, () => p.advice, null);
            _$effect((_$p) => _$setProp(_el$26, "style", st(dKey), _$p));
            return _el$26;
          })());
        }
      } else {
        nodes.push((() => {
          var _el$30 = _$createElement("box"), _el$31 = _$createElement("text"), _el$33 = _$createElement("text"), _el$34 = _$createElement("text"), _el$35 = _$createElement("text");
          _$insertNode(_el$30, _el$31);
          _$insertNode(_el$30, _el$33);
          _$insertNode(_el$30, _el$34);
          _$insertNode(_el$30, _el$35);
          _$setProp(_el$30, "flexDirection", "row");
          _$insertNode(_el$31, _$createTextNode(` 5h `));
          _$insert(_el$33, () => barFill(s.fiveHour));
          _$insert(_el$34, () => barEmpty(s.fiveHour));
          _$insertNode(_el$35, _$createTextNode(` 0%`));
          _$effect((_p$) => {
            var _v$5 = st("text"), _v$6 = st("text");
            _v$5 !== _p$.e && (_p$.e = _$setProp(_el$33, "style", _v$5, _p$.e));
            _v$6 !== _p$.t && (_p$.t = _$setProp(_el$34, "style", _v$6, _p$.t));
            return _p$;
          }, {
            e: void 0,
            t: void 0
          });
          return _el$30;
        })());
        nodes.push((() => {
          var _el$37 = _$createElement("box"), _el$38 = _$createElement("text"), _el$40 = _$createElement("text"), _el$41 = _$createElement("text"), _el$42 = _$createElement("text");
          _$insertNode(_el$37, _el$38);
          _$insertNode(_el$37, _el$40);
          _$insertNode(_el$37, _el$41);
          _$insertNode(_el$37, _el$42);
          _$setProp(_el$37, "flexDirection", "row");
          _$insertNode(_el$38, _$createTextNode(` 1w `));
          _$insert(_el$40, () => barFill(s.weekly));
          _$insert(_el$41, () => barEmpty(s.weekly));
          _$insertNode(_el$42, _$createTextNode(` 0%`));
          _$effect((_p$) => {
            var _v$7 = st("text"), _v$8 = st("text");
            _v$7 !== _p$.e && (_p$.e = _$setProp(_el$40, "style", _v$7, _p$.e));
            _v$8 !== _p$.t && (_p$.t = _$setProp(_el$41, "style", _v$8, _p$.t));
            return _p$;
          }, {
            e: void 0,
            t: void 0
          });
          return _el$37;
        })());
      }
    } else {
      nodes.push((() => {
        var _el$44 = _$createElement("text");
        _$insertNode(_el$44, _$createTextNode(`usage-coach: ...`));
        return _el$44;
      })());
    }
    if (h && h.active !== false && h.tasks.length > 0) {
      nodes.push((() => {
        var _el$46 = _$createElement("text");
        _$insertNode(_el$46, _$createTextNode(` `));
        return _el$46;
      })());
      nodes.push((() => {
        var _el$48 = _$createElement("text"), _el$49 = _$createTextNode(`harness: `), _el$50 = _$createTextNode(` `), _el$51 = _$createTextNode(`/`);
        _$insertNode(_el$48, _el$49);
        _$insertNode(_el$48, _el$50);
        _$insertNode(_el$48, _el$51);
        _$insert(_el$48, () => h.name, _el$50);
        _$insert(_el$48, () => h.current, _el$51);
        _$insert(_el$48, () => h.total, null);
        _$effect((_$p) => _$setProp(_el$48, "style", st("textMuted"), _$p));
        return _el$48;
      })());
      for (const t of h.tasks) {
        const sKey = statusKey[t.status] ?? "text";
        const lbl = TLABEL[t.status] ?? t.status;
        const rev = t.revisions > 0 && t.status === "revising" ? `(${t.revisions})` : "";
        const mdl = t.model ? ` ${t.model.split("/").pop() ?? t.model}` : "";
        const elapsed = t.startedAt ? Math.max(0, Math.round((Date.now() - new Date(t.startedAt).getTime()) / 1e3)) : 0;
        const elapsedStr = t.status === "completed" || t.status === "failed" ? "" : elapsed > 0 ? ` ${elapsed}s` : "";
        nodes.push((() => {
          var _el$52 = _$createElement("text"), _el$53 = _$createTextNode(` \u25CF `), _el$54 = _$createTextNode(` `), _el$55 = _$createTextNode(` `);
          _$insertNode(_el$52, _el$53);
          _$insertNode(_el$52, _el$54);
          _$insertNode(_el$52, _el$55);
          _$insert(_el$52, () => t.id, _el$54);
          _$insert(_el$52, mdl, _el$54);
          _$insert(_el$52, lbl, _el$55);
          _$insert(_el$52, rev, _el$55);
          _$insert(_el$52, elapsedStr, _el$55);
          _$insert(_el$52, () => t.title, null);
          _$effect((_$p) => _$setProp(_el$52, "style", st(sKey), _$p));
          return _el$52;
        })());
        if (t.model) {
          const prefix = t.model.split("/")[0] ?? "";
          if (prefix === "opencode") {
            nodes.push((() => {
              var _el$56 = _$createElement("box"), _el$57 = _$createElement("text"), _el$59 = _$createElement("text");
              _$insertNode(_el$56, _el$57);
              _$insertNode(_el$56, _el$59);
              _$setProp(_el$56, "flexDirection", "row");
              _$insertNode(_el$57, _$createTextNode(` `));
              _$insertNode(_el$59, _$createTextNode(`free`));
              _$effect((_$p) => _$setProp(_el$59, "style", st("success"), _$p));
              return _el$56;
            })());
          } else {
            const provCoach = s?.providers?.find((p) => p.id === prefix || p.id.startsWith(prefix) || prefix.startsWith(p.id));
            const rawPct = provCoach?.fiveHour ?? -1;
            if (rawPct >= 0) {
              nodes.push((() => {
                var _el$61 = _$createElement("box"), _el$62 = _$createElement("text"), _el$64 = _$createElement("text"), _el$65 = _$createElement("text"), _el$66 = _$createElement("text"), _el$67 = _$createTextNode(` `), _el$68 = _$createTextNode(`%`);
                _$insertNode(_el$61, _el$62);
                _$insertNode(_el$61, _el$64);
                _$insertNode(_el$61, _el$65);
                _$insertNode(_el$61, _el$66);
                _$setProp(_el$61, "flexDirection", "row");
                _$insertNode(_el$62, _$createTextNode(` 5h `));
                _$insert(_el$64, () => barFill(rawPct));
                _$insert(_el$65, () => barEmpty(rawPct));
                _$insertNode(_el$66, _el$67);
                _$insertNode(_el$66, _el$68);
                _$insert(_el$66, rawPct, _el$68);
                _$effect((_p$) => {
                  var _v$9 = st("text"), _v$0 = st("text");
                  _v$9 !== _p$.e && (_p$.e = _$setProp(_el$64, "style", _v$9, _p$.e));
                  _v$0 !== _p$.t && (_p$.t = _$setProp(_el$65, "style", _v$0, _p$.t));
                  return _p$;
                }, {
                  e: void 0,
                  t: void 0
                });
                return _el$61;
              })());
            }
          }
        }
      }
    }
    return (() => {
      var _el$69 = _$createElement("box");
      _$setProp(_el$69, "flexDirection", "column");
      _$insert(_el$69, nodes);
      return _el$69;
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
            var _el$70 = _$createElement("text");
            _$insertNode(_el$70, _$createTextNode(`usage-coach`));
            return _el$70;
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
