# opencode-usage-coach — 계획서 (PLAN)

> opencode 를 위한 **폐루프 사용량 코치(loop controller) 플러그인**.
> "표시"가 아니라 "사용량 → 코칭 → 정지/진행 → 서브에이전트"가 한 줄로 꿰인,
> Claude Code 사이드 패널 경험의 opencode 구현.

---

## 1. 비전 / 문제 정의

### 보고 있는 표적(references)
- Claude Code: 메인 에이전트가 서브에이전트(Codex)를 호출해 채점하고, 사이드 패널이
  **사용량 + "지금 어떻게 쓰면 좋은지" 코칭**을 보여주며, 사용량 문제 시 루프가 스스로 멈춘다.
- 합격하면 다음 작업으로 자동 진행.

### 기성품 한계(검증 완료)
| 기성 opencode 플러그인 | 역할 | 한계 |
|---|---|---|
| `opencode-usage-total` | 서브에이전트별 모델/토큰/비용 표시 | 표시 전용(observer). 루프 제어 0 |
| `opencode-subagent-statusline` | 서브에이전트 상태 모니터 | 표시 전용. "어떤 작업" 미확인 |
| `oc-plugin-usage` | z.ai 계정 quota 사이드바 | 표시 전용. 루프 제어 0 |
| `opencode-cost-guard` | 비용 초과 시 warn/stop | **USD 기반** → 정액제 GLM(opencode stats `$0.00`)에 무력. 코칭 없음. 이진 판단 |
| `@ramtinj95/opencode-tokenscope` | 토큰 상세 리포트 | 리포트 형태(라이브 루프 아님) |

### 핵심 진단
기성품은 전부 **"Sense + Display"** 다. 표적은 **"Sense → Decide(코칭) → Act(정지/진행)"**
폐루프 제어계다. 게다가 정액제(coding-plan)에서 유의미한 한도는 USD 비용이 아니라
**quota window 사용률(5h / 주간 / 월간)** 이다 — 이 메트릭을 다루는 기성품은 없다.

---

## 2. 목표 / 비목표

### 목표 (Goals)
1. **코칭**: quota window(5h/주간/월간)를 읽어 "지금 어떻게 쓰면 좋은지" 조언(GO/절제/정지 + 리셋 시각 + 가벼운 모델 권고).
2. **루프 제어**: 코칭 결정으로 에이전트 루프를 **실시간**으로 정지/절제. (사후 `session.idle` 가 아닌 루프 안 개입)
3. **TUI 가시화**: 코칭/잔여 quota/활성 서브에이전트(모델 + 작업)를 TUI 안에 **통합** 표시. 대시보드 느낌 제거.
4. **하네스**: "생성 → 채점 → 합격 시 다음 작업" 폐루프를 명령 하나로 구동.
5. **정액제 친화**: USD가 아닌 quota window 기반. (1차 타깃: z.ai/GLM. 구조는 provider-agnostic)

### 비목표 (Non-Goals)
- per-token USD 청구 모델용 결제 대시보드 (기성품이 이미 함).
- macOS 메뉴바/GUI 앱 (CodexBar 영역).
- 모든 provider 지원 (1차는 z.ai; 구조만 확장 가능하게).
- Claude Code 자체 기능 복제의 완벽주의 (핵심 루프 경험에 집중).

---

## 3. 핵심 개념: 폐루프 제어계

```
        ┌──────────────────────────────────────────────────────────┐
        │                       SENSE                              │
        │  quota(z.ai 5h/주간/월간 usedPercent) + opencode 토큰량    │
        │  소스: codexbar CLI (이미 연결/검증) or 직접 z.ai API      │
        └────────────────────────────┬─────────────────────────────┘
                                     ▼
        ┌──────────────────────────────────────────────────────────┐
        │                       DECIDE (코칭 브레인)                │
        │  가장 압박인 창 기준 → GO / THROTTLE / STOP + 조언 문장    │
        │  (프로토타입 glm-coach 검증됨: 리셋 시각·모델 전환 권고)    │
        └────────────────────────────┬─────────────────────────────┘
                                     ▼
        ┌─────────────── ACT ────────────────┐   ┌──── DISPLAY ────┐
        │  tool.execute.before → 차단/절제    │   │ tui.toast.show  │
        │  session.idle       → 후속 게이트   │←→│ tui.prompt.append│
        │  루프 스크립트       → 다음 작업 진행 │   │ sidebar/status  │
        └────────────────────────────────────┘   └─────────────────┘
```

---

## 4. 아키텍처

### 4.1 데이터 소스 (SENSE) — 이미 검증
실제 응답(`codexbar usage --provider zai --json`):
```json
[{"provider":"zai","usage":{
  "primary":{"resetDescription":"1 week window","usedPercent":10,"resetsAt":"2026-07-08T10:46:01Z"},
  "secondary":{"resetDescription":"Monthly","usedPercent":0,"resetsAt":"2026-07-10T10:46:01Z"},
  "tertiary":{"resetDescription":"5 hours window","usedPercent":1,"resetsAt":"2026-07-02T05:30:41Z"}}}]
```
→ `primary`=주간, `secondary`=월간, `tertiary`=5h. 각각 `usedPercent` + `resetsAt`.

### 4.2 플러그인 = 2개 분리 모듈 (M0 검증으로 확정)

플러그인은 **Server 모듈**과 **TUI 모듈**로 나뉘며, 각각 별도 config(`opencode.json` / `tui.json`)에 등록한다. 이게 기성 `usage-total`(server)과 `subagent-statusline`(tui)가 config가 다른 이유다.

**Server 모듈** — 감지·코칭·게이트 (`Hooks`, opencode.json)
| 훅 | 시그니처 | 역할 |
|---|---|---|
| `event` | `(input:{event:Event}) => void` | 모든 이벤트 수신(quota 갱신 트리거: session.idle, 툜 이벤트 등) |
| `permission.ask` | `(input:Permission, output:{status:"ask"\|"deny"\|"allow"})` | **게이트**: quota 초과 시 `deny` 로 툴 호출 차단 |
| `experimental.chat.system.transform` | `(input, output:{system:string[]})` | **정지 유도**: 시스템 프롬프트에 코칭/정지 지시 주입 → 모델이 루프를 멈춤 |
| `chat.message` | `(input:{agent,model:{providerID,modelID}})` | 활성 **에이전트+모델** 감지(표시용) |
| `tool` (커스텀) | `tool({description,args,execute})` | `check_quota` 툴 노출 → 에이전트 자가 진단 |

> 참고: `tool.execute.before`는 `output:{args}` 만 → **args 수정 가능, 중단 불가**.
> `tool.execute.after`는 `output:{title,output,metadata}` → 사후 관찰만.

**TUI 모듈** — 가시화 (`TuiPluginApi`, tui.json, **SolidJS**)
| API | 역할 |
|---|---|
| `ui.toast({variant,title,message,duration})` | 코칭/정지 토스트 (info/success/warning/error) |
| `ui.Slot name="sidebar_content"/"sidebar_footer"/"home_footer"` | **통합 사이드 패널** — quota 미터 + 활성 서브에이전트(모델+작업) 렌더 |
| `command.register()` | `/coach`, `/run-loop` 커맨드 |
| `state.session.{messages,status,part}()` | 세션 메시지/상태/파트 → 서브에이전트 "어떤 작업" 추출 |
| `event.on(type, handler)` | 라이브 이벤트 구독(툜 호출/세션 상태) |
| `kv` | 영속(quota 캐시, usage-total과 동일 방식) |
| `client` (OpencodeClient) | server 모듈/세션 데이터 접근 |

### 4.3 컴포넌트 — "검증됨 vs 신규"
| 컴포넌트 | 상태 | 비고 |
|---|---|---|
| quota JSON 파싱 | ✅ 검증 | codexbar zai 연결 완료 |
| 코칭 브레인(GO/THROTTLE/STOP + 조언) | ✅ 프로토타입 | `~/.local/bin/glm-coach` — TS로 포팅 |
| 하드 게이트 | ✅ 프로토큀b | `~/.local/bin/glm-guard` — 루프 스크립트용 |
| opencode 플러그인(TS) 골격 | 🆕 신규 | M0 |
| `tool.execute.before` 루프 개입 | 🆕 신규 | M1 (블로킹 시그니처 미확정) |
| TUI 통합 표시 | 🆕 신규 | M2 |
| 서브에이전트 하네스(생성→채점→진행) | 🆕 신규 | M3 |
| 패키징(npm) | 🆕 신규 | M4 |

---

## 5. 마일스톤

### M0 — 훅 시그니처 검증 + 기반 ✅ 검증 완료
**결과** (권위 소스: `/home/lhjnano/.opencode/node_modules/@opencode-ai/plugin/dist/*.d.ts`):
- [x] `tool.execute.before` → args 수정만, **중단 불가** 확정.
- [x] 차단 수단 = **`permission.ask`(`deny`)** + 정지유도 = **`system.transform`**.
- [x] TUI = **별도 모듈**(SolidJS, `tui.json`), `ui.toast`/`Slot`(sidebar_*)/`command`/`kv`/`state`/`event`.
- [x] 커스텀 툴 형태 확정: `tool({description,args:zod,execute}) → string`, `ctx.agent`/`sessionID`.
- [ ] TS 골격 생성 + 2모듈 로드 확인 (M1 첫 단계로 이관)
- [ ] codexbar 의존 정책 결정(Q3) — 1차 codexbar 의존 가즈

### M1 — 코어 루프 컨트롤러 (코칭 + 정지, server 모듈) ✅ 검증 완료
**결과** (opencode 1.17.13 + zai-coding-plan/glm-5.1, 단일 파일 `src/index.ts`):
- [x] TS server 골격 + 로컬 로드(`.opencode/plugins/` 자동 로드) — init 로그 확인.
- [x] 코칭 로직 인라인 포팅(quota→GO/THROTTLE/STOP+조언).
- [x] SENSE: codexbar subprocess via BunShell `$` (★ `stdout` 은 **Buffer** → `.toString()` 변환 필수).
- [x] DECIDE: `session.created` 에서 코칭 산출 — `weekly=12% monthly=0% 5h=3% → GO` 실제값.
- [x] ACT: `tool.execute.before` STOP 시 **throw → 툴 호출 차단** — `read` 툴 "실행 거부" 확인. 에이전트 자기 정지.
- [x] ★ 핵심 패턴: `tool.execute.before` 에서 **throw 시 툴 호출 중단** (공식 .env 차단 예제 동일).
- [x] ★ 이벤트: 헤드리스 `opencode run`에선 `session.idle` 미발화 → `session.created`로 갱신(안정). TUI 모드에선 `session.idle`도 잡음.
- [x] ★ 로컬 플러그인은 `plugins/` 내 `.ts` 각각을 별도 플러그인으로 로드 → **단일 파일 필수**(npm 패키징 시 분할).
- [ ] `experimental.chat.system.transform` 코칭 주입(M1 보강 — 모델 정지 유도 강화).
- [ ] `check_quota` 커스텀 툴(★ args zod 형태 필요 → 보강 시 추가).
- [ ] `/coach` TUI 커맨드(M2로 이관).
- **완료 기준 달성**: quota 한도 도달 시 루프 자기 정지 + 코칭 표시. ✅

### M2 — TUI 통합 가시화 (TUI 모듈, SolidJS) — 빌드 파이프라인 완성, 시각 보류
- [x] 아키텍처: server↔TUI 별개 프로세스 → 상태 파일 통신(`~/.cache/opencode-usage-coach/state.json`).
- [x] server: refresh 마다 상태 파일 갱신 — 검증.
- [x] TUI `src/tui.tsx`: SolidJS, 3초 폴링, `sidebar_footer` 슬롯 quota 미터.
- [x] ★ **빌드 파이프라인(다른 TUI 플러그인 패턴 차용)**: `tsup` + `esbuild-plugin-solid`, solid 계열 **external** + JSX 빌드타임 컴파일(universal).
- [x] ★ **의존성 충돌 원인/해결**: solid 를 config node_modules 에 따로 설치하면 opencode 자체 TUI solid 와 **중복 인스턴스 충돌** → opencode 기동 불가. 해결: solid 는 peer 선언만(설치 X), **컴파일된 dist/*.js 로 로드**, node_modules 의 solid 잔재 제거.
- [x] `tsc --noEmit` exit=0, `tsup` 빌드 성공(dist/index.js, dist/tui.js), tui.js solid external 확인.
- [x] 런타임 검증(헤드리스): opencode exit=0(크래시 없음), 서버 코칭 작동, agent-factory 에러 해소, solid 에러 없음.
- [ ] 🟡 시각 검증: 대화형 `opencode` 사이드바 하단 패널 — 사용자 확인 필요(헤드리스 TTY 불가).
- **완료 기준(빌드/런타임)**: ✅. 시각: 보류.

### M3 — 서브에이전트 하네스 (표적 경험의 완성)
- [ ] "생성 → 채점(rubric) → 합격 시 다음 작업" 폐루프 커맨드(`/run-loop` 또는 스크립트).
- [ ] 활성 서브에이전트 표시: **어떤 모델 + 어떤 작업 + 상태**(M2와 통합). "작업"은 서브에이전트 task 본문/요약에서 추출(Q4).
- [ ] 채점 합격/불합격 분기 → 다음 작업 진행 / 개선 재시도.
- **완료 기준**: 사용자가 작업 목록 + rubric을 주면 자동으로 생성-채점-진행 하며 quota 위반 시 자기 정지.

### M4 — 패키징 / 확장
- [ ] npm 게시(`opencode-usage-coach`).
- [ ] provider 포팅(z.ai → 다른 quota-기반 provider 구조화).
- [ ] 문서/설정 가이드.

---

## 6. 설계 결정 (M0 검증 완료 — @opencode-ai/plugin 타입정의 기반)

- **Q1 (해결)**: `tool.execute.before` 는 **args 수정만 가능, 중단 불가**.
  시그니처: `(input:{tool,sessionID,callID}, output:{args}) => Promise<void>`.
  → **차단은 `permission.ask` (`status:"deny"`) 로**, 그리고 모델 정지 유도는
  **`experimental.chat.system.transform`** (시스템 프롬프트에 정지 지시 주입) 로.
  단일 "세션 즉시 abort" 훅은 없음(native 기능 sst/opencode#4559 미구현과 일치).
  폴백: 외부 `glm-guard`(검증됨)로 다중 세션 루프 레벨 가드.
- **Q2 (확정)**: 정액제 GLM(opencode stats `$0.00`)이므로 **quota window(5h/주간/월간)만** 본다.
  USD 비용 표시는 보조/생략.
- **Q3 (결정 보류 → M1에서 결정)**: codexbar 런타임 의존 vs z.ai API 인라인.
  1차는 codexbar 의존(빠른 구현) → 안정화 후 인라인 전환 검토.
- **Q4 (부분 해결)**: 서브에이전트 **"어떤 작업"** — 커스텀 툴 `ctx.agent`/`sessionID` +
  TUI `state.session.messages()`/`state.part()` 로 메시지/파트에서 추출 가능.
  툜 호출 인자 본문은 `event` 훅의 툜 이벤트에서도 접근 가능(검증 예정).
- **Q5 (해결)**: **플러그인은 2개 분리 모듈**이다.
  - **Server 모듈** (`opencode.json`): `{server: Plugin, tui?: never}`. 감지/코칭/게이트.
  - **TUI 모듈** (`tui.json`): `{tui: TuiPlugin, server?: never}`. **SolidJS** 로
    `sidebar_content`/`sidebar_footer`/`home_footer`/`session_prompt_right` 슬롯에 렌더.
    `ui.toast()`, `command.register()`, `kv`, `state`, `event.on()` 사용.

---

## 7. 위험

| 위험 | 영향 | 완화 |
|---|---|---|
| `tool.execute.before` 블로킹 미지원 | 루프 안 실시간 정지 불가 → 사후 정지로 품질 저하 | M0 에서 먼저 검증; 폴백은 외부 glm-guard(검증됨) |
| opencode 버전(1.17.13) 훅 API 변경 | 플러그인 파손 | `@latest` 고정 회피, 버전 명시; M0 에 타입정의 기준 고정 |
| 기존 사이드바 플러그인과 충돌 | 표시 중복/깨짐 | 자체 통합 패널 우선; 필요 시 usage-total 대체 |
| z.ai quota API 형식/엔드포인트 변경 | SENSE 단절 | codexbar 추상화 계층 유지(Q3) |
| 정액제/종량제 혼용 시 메트릭 혼란 | 코칭 오판 | provider 마다 메트릭 종류(quota-window vs USD) 명시 매핑 |

---

## 8. 검증 계획

- **단위**: 코칭 결정 로직 — 실제 quota JSON + 시뮬레이션(고사용) 케이스로 GO/THROTTLE/STOP 매트릭스. (프로토타입에서 이미 GO/STOP 검증됨)
- **통합(M1)**: 의도적으로 임계치를 낮춰(`UC_STOP_5H=1`) 에이전트가 자기 정지하는지 확인.
- **E2E(M3)**: 더미 작업 3개 + rubric 으로 `/run-loop` → 합격 진행 / quota 임계 시 정지 시나리오.
- **비용**: 전 구간 `opencode stats` + `codexbar usage` 로 회귀 없음 확인.

---

## 9. 프로젝트 구조(예정 — 2모듈 분리)

```
opencode-usage-coach/
├── PLAN.md                  # 이 문서
├── README.md
├── package.json             # exports: server(index), tui
├── tsconfig.json
├── src/
│   ├── index.ts             # SERVER 모듈 진입(opencode.json): 훅 바인딩
│   ├── tui.ts               # TUI 모듈 진입(tui.json): Solid 컴포넌트
│   ├── coach.ts             # 코칭 결정 엔진(glm-coach 포팅) — 공유
│   ├── sense.ts             # quota 파싱(codexbar/z.ai) — 공유
│   ├── server/
│   │   ├── gate.ts          # permission.ask deny + system.transform
│   │   └── tools.ts         # check_quota 커스텀 툴
│   ├── tui/
│   │   ├── panel.tsx        # sidebar_content Solid 패널(quota+서브에이전트)
│   │   └── commands.ts      # /coach, /run-loop
│   └── harness.ts           # 생성→채점→진행 루프(M3)
├── reference/
│   ├── quota-sample.json    # 실제 z.ai 응답 샘플
│   ├── glm-coach.sh         # 검증된 프로토타입(참고용)
│   └── glm-guard.sh
└── tests/
```

등록 예정:
- `~/.config/opencode/opencode.json` → `"plugin": ["opencode-usage-coach"]` (server)
- `~/.config/opencode/tui.json` → `"plugin": ["opencode-usage-coach/tui"]` (tui)

---

## 10. 1차 타깃 환경 (이미 세팅됨)
- opencode 1.17.13, `zai-coding-plan/glm-5.1` 인증됨.
- codexbar CLI + zai 키 연결됨(`codexbar usage --provider zai --json` 검증).
- `glm-coach` / `glm-guard` 프로토타입 `~/.local/bin` 에서 검증됨.
- 공식 타입정의 위치: `/home/lhjnano/.opencode/node_modules/@opencode-ai/plugin/dist/`

## 다음 행동
**M0 완료** → **M1 시작**: TS server 골격 생성 + `opencode.json` 로드 확인부터.
첫 목표: `event`/`session.idle` 훅에서 codexbar quota를 읽어 콘솔에 찍는 최소 server 플러그인이 로드되는 것.
