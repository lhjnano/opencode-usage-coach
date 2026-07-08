# Learning Loop Design (5-stage evolution)

> Goal: when grade returns FAIL, trigger a learning cycle so the harness gets smarter with each failure. Over time, accumulated rules make the next generation avoid known pitfalls. This IS the irreducible value (ROADMAP P3, made concrete).

---

## Overview

```
grade FAIL
   ↓
1. RECORD     — structure what went wrong       → failures.ndjson
2. INVESTIGATE — why did it fail? (RCA)          → root cause {category, explanation, evidence}
3. VERIFY     — is the diagnosis correct?        → PASS → generalize / FAIL → re-investigate
4. GENERALIZE — turn it into a reusable rule     → "For <task-type>, always <check> X because <reason>"
5. REFERENCE  — inject accumulated rules         → rules.md → next generate prompt
   ↓
next generate reads rules.md → avoids the pitfall → fewer FAILs over time
```

The loop **evolves**: each FAIL adds a rule. A fresh copy starts with empty `rules.md`; this instance's accumulated rules ARE the craft that can't be copied.

---

## Stage 1 — RECORD (`record_failure`)

**Trigger**: grade returns FAIL (inside the harness loop, after the revise budget is exhausted OR on first FAIL if configured).

**Tool**: internal function (not a model call) — fast, deterministic.

**Input**: the grade result + task context
```ts
recordFailure({
  taskTitle: string,
  prompt: string,          // the generate prompt that was sent
  gradeResult: string,     // the FAIL verdict + reason
  model: string,           // which generator model was used
  revisions: number,       // how many revises were attempted
  timestamp: string,       // ISO
})
```

**Storage**: append-only NDJSON at `~/.cache/opencode-usage-coach/.../failures.ndjson`
```json
{"ts":"2026-07-06T...","task":"Create CHANGELOG.md","model":"zai-coding-plan/glm-5.1","revisions":2,"grade":"FAIL: file was 34 lines, limit 30","prompt":"..."}
```

---

## Stage 2 — INVESTIGATE (`investigate`)

**Tool**: model call (generator) — root-cause analysis.

**Input**: the failure record + the relevant files
```ts
investigate({
  failure: FailureRecord,   // from stage 1
  directory: string,        // to read the actual files
})
```

**Prompt to generator**:
> A task failed. Analyze the ROOT CAUSE — not just the symptom.
> Task: {taskTitle}
> What was expected: {from grade feedback}
> What happened: {actual result}
> Read the relevant files in {directory} if needed.
> Output a structured root cause: category (e.g. "constraint-violation", "missing-context", "tool-misuse", "model-limitation"), explanation, and evidence (file/line or specific quote).

**Output**: `{ category, explanation, evidence }`

---

## Stage 3 — VERIFY (`verify_diagnosis`)

**Tool**: model call (grader) — is the root-cause analysis correct?

**Input**: the diagnosis from stage 2
```ts
verifyDiagnosis({
  diagnosis: { category, explanation, evidence },
  failure: FailureRecord,
})
```

**Prompt to grader**:
> A root-cause analysis was produced for a failure. Is it CORRECT and ACTIONABLE?
> Failure: {failure}
> Diagnosis: {diagnosis}
> Output PASS (the diagnosis is right and leads to a useful rule) or FAIL (re-investigate).

**Output**: PASS → proceed to stage 4 / FAIL → back to stage 2 (with a note that the previous diagnosis was rejected).

---

## Stage 4 — GENERALIZE (`generalize`)

**Tool**: model call (generator) — extract a reusable rule.

**Input**: the verified diagnosis
```ts
generalize({
  diagnosis: VerifiedDiagnosis,
  failure: FailureRecord,
})
```

**Prompt to generator**:
> Turn this verified root cause into a GENERAL, REUSABLE rule that applies to future tasks of this kind.
> Diagnosis: {diagnosis}
> Output a single rule in the form: "For <task-type> tasks, always <check/do X> because <reason>."
> Keep it concrete and actionable — not vague.

**Output**: a rule string, e.g.:
> "For documentation-generation tasks, always count lines BEFORE claiming completion, because the generator underestimates line-count constraints."

**Storage**: append to `rules.md`:
```md
## Rule N (2026-07-06, category: constraint-violation)
For documentation-generation tasks, always count lines BEFORE claiming completion, because the generator underestimates line-count constraints.
Origin: CHANGELOG.md task — output was 34 lines vs 30-line limit.
```

---

## Stage 5 — REFERENCE (injection into generate)

**Mechanism**: when `generate` is called, prepend the accumulated rules to the prompt.

**In `generate` execute**:
```ts
const rules = readRules(ctx.directory); // reads rules.md, returns the rule lines
const rulesPrefix = rules.length > 0
  ? `Lessons learned from previous failures (apply where relevant):\n${rules.map((r, i) => `${i+1}. ${r}`).join("\n")}\n\n`
  : "";
const out = await runModel(input.client, model, rulesPrefix + args.prompt, ctx.directory);
```

**Effect**: the next generate sees the rules in its prompt. If a rule says "count lines before claiming completion", the generator is more likely to comply → fewer FAILs → the loop converges.

---

## Integration with existing harness

**Where it triggers**: in the harness loop, when grade returns FAIL and the revise budget is exhausted (or immediately on FAIL if `learnOnFirstFail` config is set).

**New tools** (added to the `tool` block in `src/index.ts`):
- `record_failure` — internal, fast
- `investigate` — model call (generator)
- `verify_diagnosis` — model call (grader)
- `generalize` — model call (generator)

**Modified**:
- `generate` — prepends rules.md content to the prompt (stage 5)
- `grade` NEXT directive — on FAIL with revisions exhausted: `NEXT: run the learning loop (record_failure → investigate → verify_diagnosis → generalize), then mark failed`

**NEXT directive update** for grade FAIL (revisions exhausted):
```
[usage-coach NEXT] FAIL (revisions exhausted). Run the learning loop:
  1. record_failure({task, prompt, gradeResult, model, revisions})
  2. investigate({failure}) → diagnosis
  3. verify_diagnosis({diagnosis, failure}) → PASS/FAIL
  4. generalize({diagnosis, failure}) → rule (appended to rules.md)
  5. task_update(i, title, "failed", "FAIL") → next task
The next generate call will automatically include the new rule.
```

---

## Data formats

**`failures.ndjson`** (append-only, one JSON per line):
```json
{"ts":"...","task":"...","model":"...","revisions":N,"grade":"...","prompt":"..."}
```

**`rules.md`** (append-only, human-readable):
```md
## Rule 1 (date, category)
<rule text>
Origin: <task> — <brief failure summary>

## Rule 2 (date, category)
...
```

**File locations**:
- `~/.cache/opencode-usage-coach/projects/<dir-hash>/failures.ndjson`
- `~/.cache/opencode-usage-coach/projects/<dir-hash>/rules.md`
- (per-project, like harness state)

---

## Concrete example

1. Task: "Create CHANGELOG.md, under 30 lines"
2. generate → 34 lines
3. grade → FAIL (34 > 30)
4. revise → still 32 lines
5. grade → FAIL (revisions exhausted)
6. **Learning loop triggers**:
   - record_failure: {task, "FAIL: 34 lines", model, revisions:2}
   - investigate: {category:"constraint-violation", explanation:"generator doesn't count output lines against a limit", evidence:"output was 34, no line-count check"}
   - verify_diagnosis: PASS
   - generalize: "For tasks with a line/size limit, always verify the output length before returning, because the generator doesn't track its own output size."
   - rules.md += this rule
7. **Next task** "Create CONTRIBUTING.md, under 30 lines":
   - generate prompt now starts with the rule → generator checks length → outputs 29 lines → PASS

The harness got smarter from one failure.

---

## Implementation order

1. **Stage 5 (reference) first** — `generate` reads rules.md. Empty at first, but the mechanism exists.
2. **Stage 1 (record)** — `record_failure` appends to failures.ndjson.
3. **Stages 2-4** — investigate/verify/generalize tools (model calls).
4. **Integration** — grade FAIL triggers the loop via NEXT directive.

Each stage is independently useful and testable.

---

## Extension — Domain knowledge base (declarative learning)

Runs **in parallel** with the learning loop (procedural: "how") to accumulate domain knowledge (declarative: "what"). Together, the two constitute "evidence-based judgment".

### Purpose
**Structurally compensates** for the LLM weakness of "jumping to conclusions by guessing" — query the domain DB before making a judgment; if it's not there, investigate and store it. As it accumulates, judgments become faster and more accurate.

> Real example (this session): guessed that "session.status() detects sub-session completion" → failed. In reality, status() was not an official method. Had such domain knowledge been investigated and stored in the DB in advance, the judgment would have been based on fact rather than guess.

### Stored as connected form (graph)
Concepts are not simple key-values, but a **graph/network connected by relationships**:
- `session.prompt` --[returns]--> `AssistantMessage` --[synchronously, after agent loop]-->
- `session.status` --[NOT a documented SDK method]--> `events (session.idle)`
- `opencode tool execute` --[has timeout ~60-120s, not configurable]-->

Relationship types: returns / is-a / part-of / contradicts / depends-on / not-applicable

### Structure (TBD — needs design)
Efficient storage/retrieval form needs consideration. Candidates:
- **ladybugDB** (graph DB, strong at relational queries)
- **SQLite + relational tables** (simple, general-purpose)
- **Custom** (NDJSON nodes/edges + index)
- Search: semantic (embedding) / keyword / graph traversal — which suits this use case requires experimentation

Decision criteria: write frequency (during investigation), read frequency (during judgment), relational query complexity, dependency size.

### Combination with the learning loop
- **Stage 2 (investigate)** queries the domain DB first — reuse if already investigated (fast).
- If the failure cause is "unknown domain / jumping to conclusions", investigate (webfetch/docs) and **store in the domain DB**.
- The learning loop's rule itself can become "in this situation, query the domain DB first" — procedural learning promotes the use of declarative learning.

### Priority
Build the learning loop (procedural, rules.md) first → then the domain DB (declarative). Both are P3. The structure design of the domain DB is separated as a separate task.
