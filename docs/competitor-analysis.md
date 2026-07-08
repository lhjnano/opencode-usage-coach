# Competitor Analysis (2026-07-05)

Manual research (harness unavailable). Sources: official docs/pricing pages via webfetch.

---

## 1. Claude Code (Anthropic)

**Quota model:** Subscription-based (Claude Pro / Max, or Anthropic Console API). No explicit "quota windows" surfaced in docs — usage is governed by the subscription tier and Anthropic's backend rate management.

**How users manage it:** Users pick a subscription tier. Overages/rate-limits are handled by Anthropic; users see "rate limit" messages but there's no user-facing quota dashboard in the docs. The Desktop app and web surfaces show usage indirectly.

**Gap opencode-usage-coach fills:** Claude Code is single-provider (Anthropic). There's no need for multi-provider quota aggregation or cross-provider coaching. **This plugin's value proposition does NOT apply to Claude Code** — Anthropic manages quota natively.

---

## 2. Cursor

**Quota model:** Hybrid — subscription tiers (Hobby free / Individual $20/mo with Pro/Pro+/Ultra sub-tiers / Teams $40/user / Enterprise). Each tier includes a set amount of model usage; on-demand (usage-based) billing kicks in after the included amount is consumed.

Key quote from pricing FAQ: *"Every plan includes a set amount of model usage. On-demand usage allows you to continue using models after your included amount is consumed, billed in arrears."*

**How users manage it:** Admin Dashboard for teams (usage analytics). Individual users see usage in-app. Cursor manages the quota internally — users don't configure providers.

**Gap:** Cursor is a closed, single-vendor product. Users can't bring their own provider or API key for quota management. **This plugin doesn't apply** — Cursor owns the quota layer entirely.

---

## 3. GitHub Copilot

**Quota model:** Subscription (Copilot Free / Pro / Business / Enterprise). Policy-based — org admins control feature availability, model access, and third-party agent access (Anthropic Claude, OpenAI Codex can be enabled as "partner agents"). Cloud agent runs on GitHub infra.

**How users manage it:** Org admins set policies. No per-user quota windows in docs — it's policy/access controlled, not rate-window controlled.

**Gap:** Copilot is subscription + policy based. No 5h/weekly/monthly quota windows like flat-rate coding plans. **This plugin's quota-window model doesn't map to Copilot's access-control model.**

---

## 4. OpenAI Codex (ChatGPT coding)

**Quota model:** Bundled with ChatGPT subscriptions (Plus/Pro/Team) or API usage (pay-per-token). The coding agent runs in ChatGPT or via API.

**How users manage it:** Subscription tier determines access; API users manage spend via spend limits in the console. No user-facing quota-window coaching.

**Gap:** Same as above — either bundled (subscription) or metered (API spend). The flat-rate quota-window problem this plugin solves is specific to plans like z.ai's coding-plan.

---

## 5. Existing opencode plugins

| Plugin | What it does | Limit |
|--------|-------------|-------|
| opencode-usage-total | Per-subagent model/token/cost display | Display-only (observer). No loop control. |
| opencode-cost-guard | Warn/stop on USD cost exceeded | USD-based → useless for flat-rate plans (cost shows $0.00). Binary, no coaching. |
| opencode-subagent-statusline | Subagent status monitor | Display-only. No quota awareness. |
| @ramtinj95/opencode-tokenscope | Detailed token report | Report format, not live loop. |

**Gap (confirmed):** All existing opencode plugins are **Sense + Display only**. None does **Sense → Decide (coaching) → Act (gate/loop)**. None handles flat-rate quota windows (5h/weekly/monthly) instead of USD. **opencode-usage-coach's closed-loop + quota-window model is genuinely novel in the opencode ecosystem.**

---

## Where opencode-usage-coach fits — synthesis

**The niche is narrow but real:**

opencode is unique among AI coding tools because it's **open-source and provider-agnostic** — users bring their own provider (z.ai, OpenAI, Anthropic, Ollama, etc.). This means:
- The platform does NOT manage quota natively (unlike Claude Code, Cursor, Copilot).
- Users on **flat-rate coding plans** (e.g. z.ai) face quota windows (5h/weekly/monthly) that USD-based tools can't see.
- Users who switch providers need quota coaching that follows the provider, not the platform.

**This plugin fits exactly that gap.** Competitors (Claude Code, Cursor, Copilot) don't have this problem because they own the provider layer. opencode's openness creates the problem; this plugin solves it.

**Strategic implication for the roadmap:**
1. **Claude Code / Cursor porting is low-value** — they have native quota management; the plugin would duplicate or conflict with it.
2. **The moat is opencode depth**, not platform breadth. Deepening opencode integration (agent mode, coaching quality) serves the audience that actually needs this (opencode + flat-rate provider users).
3. **Provider-agnosticism is the product**, not a limitation to "fix" by calling z.ai API directly. codexbar is the right abstraction layer.
4. **The risk** is not competitors — it's whether the opencode + flat-rate-provider audience is large enough to sustain the project. That's a distribution problem, not a feature problem.

**Bottom line:** Stop worrying about porting to platforms that don't need this. Make opencode-usage-coach the indispensable quota tool for opencode users on metered/flat-rate plans. Integration depth + judgment quality, on opencode, for provider-agnostic quota.
