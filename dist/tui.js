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

// src/tui-logic.ts
var STALE_MS = 5 * 6e4;
var HIDE_MS = 30 * 6e4;
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
  halted_quota: "quota-halt",
  stale: "STALE"
};
var STATUS_KEY = {
  generating: "info",
  grading: "accent",
  revising: "warning",
  completed: "success",
  failed: "error",
  timed_out: "error",
  halted_quota: "error"
};
var TERMINAL_STATUSES = /* @__PURE__ */ new Set([
  "completed",
  "failed",
  "timed_out",
  "halted_quota"
]);
function barFill(p) {
  const n = !Number.isFinite(p) || p <= 0 ? 0 : Math.max(1, Math.min(10, Math.round(p / 10)));
  return "\u2588".repeat(n);
}
function barEmpty(p) {
  const n = !Number.isFinite(p) || p <= 0 ? 0 : Math.max(1, Math.min(10, Math.round(p / 10)));
  return "\u2591".repeat(10 - n);
}
function computeStaleness(h, now = Date.now()) {
  const hAge = h.updatedAt ? now - new Date(h.updatedAt).getTime() : 0;
  const hasActiveSub = h.tasks.some((t) => !!t.subSessionId);
  const isStale = !hasActiveSub && hAge > STALE_MS;
  const shouldHide = hAge > HIDE_MS && !hasActiveSub;
  return { hAge, hasActiveSub, isStale, shouldHide };
}
function isHarnessVisible(h, staleness) {
  if (!h) return false;
  if (h.tasks.length === 0) return false;
  if (h.active !== true) return false;
  if (staleness.shouldHide) return false;
  return true;
}
function computeTaskDisplay(t, isStale, now = Date.now()) {
  const displayStatus = isStale && !TERMINAL_STATUSES.has(t.status) ? "stale" : t.status;
  const sKey = STATUS_KEY[displayStatus] ?? "text";
  const lbl = TLABEL[displayStatus] ?? displayStatus;
  const rev = (t.revisions ?? 0) > 0 && t.status === "revising" ? `(${t.revisions})` : "";
  const mdl = t.model ? ` ${t.model.split("/").pop() ?? t.model}` : "";
  const hasSub = !!t.subSessionId;
  const subStepStr = hasSub && t.subStep !== void 0 && t.subStep > 0 ? ` step:${t.subStep}` : "";
  const subEl = hasSub && t.subElapsed !== void 0 ? ` ${t.subElapsed}s` : "";
  const subWarn = hasSub && (t.subElapsed ?? 0) > 300;
  const elapsed = t.startedAt ? Math.max(0, Math.round((now - new Date(t.startedAt).getTime()) / 1e3)) : 0;
  const taskEl = t.status === "completed" || t.status === "failed" ? "" : elapsed > 0 ? ` ${elapsed}s` : "";
  const displayEl = hasSub ? subEl : taskEl;
  const lineKey = subWarn ? "warning" : sKey;
  return {
    displayStatus,
    themeKey: lineKey,
    label: lbl,
    revSuffix: rev,
    modelStr: mdl,
    stepStr: subStepStr,
    elapsedStr: displayEl,
    hasSub,
    subWarn
  };
}
function decisionThemeKey(decision) {
  return decision === "GO" ? "success" : decision === "THROTTLE" ? "warning" : "error";
}
function taskQuotaPct(t, s) {
  const pv = t.model ? (t.model.split("/")[0] ?? "").split("-")[0] : "";
  const provCoach = pv ? s?.providers?.find((p) => p.id === pv || pv && p.id.startsWith(pv) || pv && pv.startsWith(p.id)) : s?.providers?.[0];
  const rawPct = provCoach?.fiveHour ?? s?.fiveHour ?? -1;
  const pct = rawPct < 0 ? 0 : rawPct;
  const label = rawPct === -1 ? "\u2026" : rawPct < 0 ? "retry" : `${rawPct}%`;
  return { pct, label };
}

// src/tui.tsx
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
      const dKey = decisionThemeKey(s.decision);
      const modelShort = s.model ? s.model.split("/").pop() ?? s.model : "";
      if (s.isFree) {
        nodes.push((() => {
          var _el$4 = _$createElement("box"), _el$5 = _$createElement("text"), _el$7 = _$createElement("text"), _el$8 = _$createTextNode(` `);
          _$insertNode(_el$4, _el$5);
          _$insertNode(_el$4, _el$7);
          _$setProp(_el$4, "flexDirection", "row");
          _$insertNode(_el$5, _$createTextNode(`usage-coach [free]`));
          _$insertNode(_el$7, _el$8);
          _$insert(_el$7, modelShort, null);
          _$effect((_p$) => {
            var _v$ = st(dKey), _v$2 = st("textMuted");
            _v$ !== _p$.e && (_p$.e = _$setProp(_el$5, "style", _v$, _p$.e));
            _v$2 !== _p$.t && (_p$.t = _$setProp(_el$7, "style", _v$2, _p$.t));
            return _p$;
          }, {
            e: void 0,
            t: void 0
          });
          return _el$4;
        })());
      } else {
        if (modelShort) {
          nodes.push((() => {
            var _el$9 = _$createElement("box"), _el$0 = _$createElement("text"), _el$1 = _$createTextNode(`usage-coach [`), _el$10 = _$createTextNode(`]`), _el$11 = _$createElement("text"), _el$12 = _$createTextNode(` `);
            _$insertNode(_el$9, _el$0);
            _$insertNode(_el$9, _el$11);
            _$setProp(_el$9, "flexDirection", "row");
            _$insertNode(_el$0, _el$1);
            _$insertNode(_el$0, _el$10);
            _$insert(_el$0, () => TAG[s.decision], _el$10);
            _$insertNode(_el$11, _el$12);
            _$insert(_el$11, modelShort, null);
            _$effect((_p$) => {
              var _v$3 = st(dKey), _v$4 = st("textMuted");
              _v$3 !== _p$.e && (_p$.e = _$setProp(_el$0, "style", _v$3, _p$.e));
              _v$4 !== _p$.t && (_p$.t = _$setProp(_el$11, "style", _v$4, _p$.t));
              return _p$;
            }, {
              e: void 0,
              t: void 0
            });
            return _el$9;
          })());
        } else {
          nodes.push((() => {
            var _el$13 = _$createElement("text"), _el$14 = _$createTextNode(`usage-coach [`), _el$15 = _$createTextNode(`]`);
            _$insertNode(_el$13, _el$14);
            _$insertNode(_el$13, _el$15);
            _$insert(_el$13, () => TAG[s.decision], _el$15);
            _$effect((_$p) => _$setProp(_el$13, "style", st(dKey), _$p));
            return _el$13;
          })());
        }
        if (s.providers && s.providers.length > 0) {
          for (const p of s.providers) {
            if (p.fiveHour >= 0) nodes.push((() => {
              var _el$16 = _$createElement("box"), _el$17 = _$createElement("text"), _el$19 = _$createElement("text"), _el$20 = _$createElement("text"), _el$21 = _$createElement("text"), _el$22 = _$createTextNode(` `), _el$23 = _$createTextNode(`% `);
              _$insertNode(_el$16, _el$17);
              _$insertNode(_el$16, _el$19);
              _$insertNode(_el$16, _el$20);
              _$insertNode(_el$16, _el$21);
              _$setProp(_el$16, "flexDirection", "row");
              _$insertNode(_el$17, _$createTextNode(` 5h `));
              _$insert(_el$19, () => barFill(p.fiveHour));
              _$insert(_el$20, () => barEmpty(p.fiveHour));
              _$insertNode(_el$21, _el$22);
              _$insertNode(_el$21, _el$23);
              _$insert(_el$21, () => p.fiveHour, _el$23);
              _$insert(_el$21, () => p.fiveHourReset, null);
              _$effect((_p$) => {
                var _v$5 = st("text"), _v$6 = st("text");
                _v$5 !== _p$.e && (_p$.e = _$setProp(_el$19, "style", _v$5, _p$.e));
                _v$6 !== _p$.t && (_p$.t = _$setProp(_el$20, "style", _v$6, _p$.t));
                return _p$;
              }, {
                e: void 0,
                t: void 0
              });
              return _el$16;
            })());
            if (p.weekly >= 0) nodes.push((() => {
              var _el$24 = _$createElement("box"), _el$25 = _$createElement("text"), _el$27 = _$createElement("text"), _el$28 = _$createElement("text"), _el$29 = _$createElement("text"), _el$30 = _$createTextNode(` `), _el$31 = _$createTextNode(`% `);
              _$insertNode(_el$24, _el$25);
              _$insertNode(_el$24, _el$27);
              _$insertNode(_el$24, _el$28);
              _$insertNode(_el$24, _el$29);
              _$setProp(_el$24, "flexDirection", "row");
              _$insertNode(_el$25, _$createTextNode(` 1w `));
              _$insert(_el$27, () => barFill(p.weekly));
              _$insert(_el$28, () => barEmpty(p.weekly));
              _$insertNode(_el$29, _el$30);
              _$insertNode(_el$29, _el$31);
              _$insert(_el$29, () => p.weekly, _el$31);
              _$insert(_el$29, () => p.weeklyReset, null);
              _$effect((_p$) => {
                var _v$7 = st("text"), _v$8 = st("text");
                _v$7 !== _p$.e && (_p$.e = _$setProp(_el$27, "style", _v$7, _p$.e));
                _v$8 !== _p$.t && (_p$.t = _$setProp(_el$28, "style", _v$8, _p$.t));
                return _p$;
              }, {
                e: void 0,
                t: void 0
              });
              return _el$24;
            })());
          }
        } else {
          if (s.fiveHour >= 0) nodes.push((() => {
            var _el$32 = _$createElement("box"), _el$33 = _$createElement("text"), _el$35 = _$createElement("text"), _el$36 = _$createElement("text"), _el$37 = _$createElement("text"), _el$38 = _$createTextNode(` `), _el$39 = _$createTextNode(`%`);
            _$insertNode(_el$32, _el$33);
            _$insertNode(_el$32, _el$35);
            _$insertNode(_el$32, _el$36);
            _$insertNode(_el$32, _el$37);
            _$setProp(_el$32, "flexDirection", "row");
            _$insertNode(_el$33, _$createTextNode(` 5h `));
            _$insert(_el$35, () => barFill(s.fiveHour));
            _$insert(_el$36, () => barEmpty(s.fiveHour));
            _$insertNode(_el$37, _el$38);
            _$insertNode(_el$37, _el$39);
            _$insert(_el$37, () => s.fiveHour, _el$39);
            _$effect((_p$) => {
              var _v$9 = st("text"), _v$0 = st("text");
              _v$9 !== _p$.e && (_p$.e = _$setProp(_el$35, "style", _v$9, _p$.e));
              _v$0 !== _p$.t && (_p$.t = _$setProp(_el$36, "style", _v$0, _p$.t));
              return _p$;
            }, {
              e: void 0,
              t: void 0
            });
            return _el$32;
          })());
          if (s.weekly >= 0) nodes.push((() => {
            var _el$40 = _$createElement("box"), _el$41 = _$createElement("text"), _el$43 = _$createElement("text"), _el$44 = _$createElement("text"), _el$45 = _$createElement("text"), _el$46 = _$createTextNode(` `), _el$47 = _$createTextNode(`%`);
            _$insertNode(_el$40, _el$41);
            _$insertNode(_el$40, _el$43);
            _$insertNode(_el$40, _el$44);
            _$insertNode(_el$40, _el$45);
            _$setProp(_el$40, "flexDirection", "row");
            _$insertNode(_el$41, _$createTextNode(` 1w `));
            _$insert(_el$43, () => barFill(s.weekly));
            _$insert(_el$44, () => barEmpty(s.weekly));
            _$insertNode(_el$45, _el$46);
            _$insertNode(_el$45, _el$47);
            _$insert(_el$45, () => s.weekly, _el$47);
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
        var _el$48 = _$createElement("text");
        _$insertNode(_el$48, _$createTextNode(`usage-coach: ...`));
        return _el$48;
      })());
    }
    if (h) {
      const staleness = computeStaleness(h);
      if (isHarnessVisible(h, staleness)) {
        const isStale = staleness.isStale;
        nodes.push((() => {
          var _el$50 = _$createElement("text");
          _$insertNode(_el$50, _$createTextNode(` `));
          return _el$50;
        })());
        nodes.push((() => {
          var _el$52 = _$createElement("text"), _el$53 = _$createTextNode(`harness: `), _el$54 = _$createTextNode(` `), _el$55 = _$createTextNode(`/`);
          _$insertNode(_el$52, _el$53);
          _$insertNode(_el$52, _el$54);
          _$insertNode(_el$52, _el$55);
          _$insert(_el$52, () => h.name, _el$54);
          _$insert(_el$52, () => h.current, _el$55);
          _$insert(_el$52, () => h.total, null);
          _$insert(_el$52, isStale ? " (stale)" : "", null);
          _$effect((_$p) => _$setProp(_el$52, "style", st("textMuted"), _$p));
          return _el$52;
        })());
        for (const t of h.tasks) {
          const td = computeTaskDisplay(t, isStale);
          nodes.push((() => {
            var _el$56 = _$createElement("text"), _el$57 = _$createTextNode(` \u25CF `), _el$58 = _$createTextNode(` `), _el$59 = _$createTextNode(` `);
            _$insertNode(_el$56, _el$57);
            _$insertNode(_el$56, _el$58);
            _$insertNode(_el$56, _el$59);
            _$insert(_el$56, () => t.id, _el$58);
            _$insert(_el$56, () => td.modelStr, _el$58);
            _$insert(_el$56, () => td.label, _el$59);
            _$insert(_el$56, () => td.revSuffix, _el$59);
            _$insert(_el$56, () => td.stepStr, _el$59);
            _$insert(_el$56, () => td.elapsedStr, _el$59);
            _$insert(_el$56, () => t.title, null);
            _$effect((_$p) => _$setProp(_el$56, "style", st(td.themeKey), _$p));
            return _el$56;
          })());
          const {
            pct,
            label: pctLabel
          } = taskQuotaPct(t, s);
          nodes.push((() => {
            var _el$60 = _$createElement("box"), _el$61 = _$createElement("text"), _el$63 = _$createElement("text"), _el$64 = _$createElement("text"), _el$65 = _$createElement("text"), _el$66 = _$createTextNode(` `);
            _$insertNode(_el$60, _el$61);
            _$insertNode(_el$60, _el$63);
            _$insertNode(_el$60, _el$64);
            _$insertNode(_el$60, _el$65);
            _$setProp(_el$60, "flexDirection", "row");
            _$insertNode(_el$61, _$createTextNode(` 5h `));
            _$insert(_el$63, () => barFill(pct));
            _$insert(_el$64, () => barEmpty(pct));
            _$insertNode(_el$65, _el$66);
            _$insert(_el$65, pctLabel, null);
            _$effect((_p$) => {
              var _v$11 = st("text"), _v$12 = st("text");
              _v$11 !== _p$.e && (_p$.e = _$setProp(_el$63, "style", _v$11, _p$.e));
              _v$12 !== _p$.t && (_p$.t = _$setProp(_el$64, "style", _v$12, _p$.t));
              return _p$;
            }, {
              e: void 0,
              t: void 0
            });
            return _el$60;
          })());
        }
      }
    }
    return (() => {
      var _el$67 = _$createElement("box");
      _$setProp(_el$67, "flexDirection", "column");
      _$insert(_el$67, nodes);
      return _el$67;
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
            var _el$68 = _$createElement("text");
            _$insertNode(_el$68, _$createTextNode(`usage-coach`));
            return _el$68;
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
