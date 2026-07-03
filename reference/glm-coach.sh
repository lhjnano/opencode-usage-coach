#!/usr/bin/env bash
# glm-coach — GLM(z.ai) 사용량 "코칭"
# 단순 숫자가 아니라, 어느 quota 창이 압박인지 보고
# "지금 어떻게 쓰면 좋은지" 조언 + 정지 여부(exit code)를 낸다.
#
# 출력:
#   stdout  → 코칭 메시지(사람이 읽기용, TUI 에 띄우기 좋음)
#   stderr  → [coach] 디버그 한 줄
#   exit 0  = GO      (진행, 필요시 가벼운 모델 권고)
#   exit 1  = STOP    (창 소진, 루프 즉시 정지)
#
# 테스트:  GLM_COACH_JSON='<json>' glm-coach   (codexbar 호출 안 함)
#          GLM_COACH_STOP=5h    5h 창이 STOP 임계치인 것처럼 시뮬레이션
set -euo pipefail
PROVIDER="${GLM_GUARD_PROVIDER:-zai}"

if [ -n "${GLM_COACH_JSON:-}" ]; then
  JSON="$GLM_COACH_JSON"
else
  command -v codexbar >/dev/null 2>&1 || { echo "codexbar 없음" >&2; exit 0; }
  JSON="$(codexbar usage --provider "$PROVIDER" --json 2>/dev/null || true)"
fi
[ -n "$JSON" ] && [ "$JSON" != "[]" ] || { echo "quota 미취득 — 진행(보수적 GO)"; exit 0; }

# 임계치(환경변수 오버라이드 가능)
S_5H="${GLM_COACH_STOP_5H:-92}"; T_5H="${GLM_COACH_THROTTLE_5H:-70}"
S_WK="${GLM_COACH_STOP_WEEKLY:-95}"; T_WK="${GLM_COACH_THROTTLE_WEEKLY:-85}"
S_MO="${GLM_COACH_STOP_MONTHLY:-98}"

python3 - "$JSON" "$S_5H" "$T_5H" "$S_WK" "$T_WK" "$S_MO" <<'PY'
import json, sys, datetime

def human_remaining(iso):
    try:
        reset = datetime.datetime.fromisoformat(iso.replace("Z","+00:00"))
        now   = datetime.datetime.now(datetime.timezone.utc)
        mins  = int((reset - now).total_seconds() // 60)
        if mins < 0:   return "곧 리셋"
        if mins<60:    return f"{mins}분 후 리셋"
        if mins<1440:  return f"{mins//60}시간 후 리셋"
        return f"{mins//1440}일 후 리셋"
    except Exception:
        return ""

raw = json.loads(sys.argv[1])
u = (raw[0].get("usage") or {}) if raw else {}
def w(key):
    d = u.get(key) or {}
    return int(round(float(d.get("usedPercent") or 0))), human_remaining(d.get("resetsAt",""))

wk_pct, wk_rest = w("primary")     # 1 week
mo_pct, mo_rest = w("secondary")   # monthly
h5_pct, h5_rest = w("tertiary")    # 5 hours
S_5H,T_5H,S_WK,T_WK,S_MO = map(int, sys.argv[2:7])

# 결정: 가장 압박이 큰 창 기준
stop=False; throttle=False; reason=""
if h5_pct >= S_5H:      stop=True;  reason=f"5시간 창 {h5_pct}%({h5_rest})"
elif wk_pct >= S_WK:    stop=True;  reason=f"주간 {wk_pct}%({wk_rest})"
elif mo_pct >= S_MO:    stop=True;  reason=f"월간 {mo_pct}%({mo_rest})"
elif h5_pct >= T_5H:    throttle=True; reason=f"5시간 창 {h5_pct}%({h5_rest})"
elif wk_pct >= T_WK:    throttle=True; reason=f"주간 {wk_pct}%({wk_rest})"

# 코칭 메시지
if stop:
    advice = (f"🛑 정지 권고 — {reason}. 창이 거의 소진됐습니다. "
              f"지금 멈추지 않으면 곧 강제 차단됩니다.")
elif throttle:
    lighter = "glm-4.5-air"
    advice = (f"⚠️ 절제 권고 — {reason}. 긴 작업은 보류하고 "
              f"가벼운 모델({lighter})로 전환하거나 창 리셋까지 대기하세요.")
else:
    advice = (f"✅ 여유 — 주간 {wk_pct}% · 5시간 {h5_pct}% · 월간 {mo_pct}%. "
              f"적극 진행. 5시간 창은 {h5_rest}.")

print(advice)
print(f"[coach] weekly={wk_pct}% monthly={mo_pct}% 5h={h5_pct}% -> {'STOP' if stop else 'THROTTLE' if throttle else 'GO'}", file=sys.stderr)
sys.exit(1 if stop else 0)
PY
