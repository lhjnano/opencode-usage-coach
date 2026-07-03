#!/usr/bin/env bash
# glm-guard — opencode/GLM 루프 가드
# codexbar 의 z.ai quota window 사용률(usedPercent)을 검사한 뒤에만
# 뒤따르는 명령(보통 `opencode run ...`)을 실행합니다.
# 어느 윈도우든 임계치를 넘으면 exit 1 로 루프를 차단합니다.
#
# 사용:
#   glm-guard opencode run "리팩터링해 줘"
#   while true; do glm-guard opencode run "..." || { echo 중단; break; }; sleep 5; done
#
# 임계치(환경변수, 기본값):
#   GLM_GUARD_WEEKLY=85   GLM_GUARD_MONTHLY=90   GLM_GUARD_5H=80
#   GLM_GUARD_PROVIDER=zai  GLM_GUARD_SKIP=1  (검사 건너뛰기, 디버그용)

set -euo pipefail

W_WEEKLY="${GLM_GUARD_WEEKLY:-85}"
W_MONTHLY="${GLM_GUARD_MONTHLY:-90}"
W_5H="${GLM_GUARD_5H:-80}"
PROVIDER="${GLM_GUARD_PROVIDER:-zai}"

if [ "${GLM_GUARD_SKIP:-0}" = "1" ]; then
  echo "[glm-guard] GLM_GUARD_SKIP=1 → 검사 생략" >&2
  exec "$@"
fi

if ! command -v codexbar >/dev/null 2>&1; then
  echo "[glm-guard] 오류: codexbar 를 찾을 수 없습니다 (~/.local/bin 확인)." >&2
  exit 2
fi

# codexbar 에서 quota JSON 조회
JSON="$(codexbar usage --provider "$PROVIDER" --json 2>/dev/null || true)"
if [ -z "$JSON" ] || [ "$JSON" = "[]" ]; then
  echo "[glm-guard] 경고: $PROVIDER quota 를 가져오지 못했습니다(키/네트워크 확인). 차단하지 않고 계속합니다." >&2
  exec "$@"
fi

# usedPercent 파싱 + 임계치 판정 (python3 사용)
read -r WEEKLY MONTHLY H5 < <(python3 -c '
import json, sys
data = json.loads(sys.argv[1])
u = (data[0].get("usage") or {}) if data else {}
def pct(key):
    w = u.get(key) or {}
    return int(round(float(w.get("usedPercent") or 0)))
print(pct("primary"), pct("secondary"), pct("tertiary"))
' "$JSON")

echo "[glm-guard] weekly=${WEEKLY}%/${W_WEEKLY}  monthly=${MONTHLY}%/${W_MONTHLY}  5h=${H5}%/${W_5H}" >&2

viol=""
[ "$WEEKLY"  -ge "$W_WEEKLY"  ] && viol="weekly(${WEEKLY}%>=${W_WEEKLY})"
[ "$MONTHLY" -ge "$W_MONTHLY" ] && viol="${viol:+$viol }monthly(${MONTHLY}%>=${W_MONTHLY})"
[ "$H5"      -ge "$W_5H"      ] && viol="${viol:+$viol }5h(${H5}%>=${W_5H})"

if [ -n "$viol" ]; then
  echo "[glm-guard] ❌ 한도 초과 → 실행 거부: $viol" >&2
  echo "[glm-guard] (강제 실행: GLM_GUARD_SKIP=1 을 설정)" >&2
  exit 1
fi

echo "[glm-guard] ✅ 안전 구역 → 실행" >&2
exec "$@"
