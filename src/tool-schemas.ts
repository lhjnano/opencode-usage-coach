// tool-schemas.ts — JSON Schema single source of truth for every harness tool.
// Shared by the V1 adapter (converted to `tool.schema` via schema-convert.ts)
// and the future V2 adapter (consumed directly as JSON Schema).
//
// Conventions:
//  - every schema is `{ type: "object", properties, required, additionalProperties: false }`
//    (strict at the top level AND on nested object nodes);
//  - optional fields are simply absent from `required`;
//  - a record<string, string> is expressed as an object with NO `properties` and
//    `additionalProperties: { type: "string" }` (detected by schema-convert);
//  - every field carries a `description`.
//
// Tool-level `description`s are the FULL V1 protocol text, copied verbatim from
// the original inline `tool({...})` blocks (multi-sentence guidance including
// quota-awareness, gates and NEXT hints). They are the single source served by
// BOTH adapters — do not shorten them.

export type ToolSchema = { description: string; schema: any };

export const TOOL_NAMES = [
  "harness_start",
  "unknown_scan",
  "question",
  "task_update",
  "harness_done",
  "record_failure",
  "investigate",
  "verify_diagnosis",
  "generalize",
  "generate",
  "generate_batch",
  "grade",
  "grade_batch",
  "reverse_interview",
  "coach_config",
  "coach_analyze",
] as const;

const CHECK_TYPE_ENUM = ["file-exists", "grep", "grep-absent", "line-count"];

export const TOOL_SCHEMAS: Record<string, ToolSchema> = {
  harness_start: {
    description: "Start the harness: register the total task count on the panel. Call once when the harness loop begins. IMPORTANT: each generate/generate_batch sub-session is step-limited (default 30). If any task seems too large, split it into smaller subtasks BEFORE starting — oversized tasks will timeout.",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Harness name (shown on the TUI panel)." },
        total: { type: "number", description: "Total number of tasks in this harness run." },
      },
      required: ["name", "total"],
      additionalProperties: false,
    },
  },

  unknown_scan: {
    description: "Pre-flight gap analysis: call AFTER harness_start, BEFORE generate. Scans the codebase against the user's request to find blind spots (unknown unknowns) that could waste 30+ steps if discovered late. Returns identified unknowns + task split suggestions + user confirmation questions. Writes results to harness.json for TUI display.",
    schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The user's original request (the full prompt that triggered the harness).",
        },
        tasks: {
          type: "array",
          description:
            "Tasks registered via harness_start (id + title). If omitted, a single task derived from the prompt is assumed.",
          items: {
            type: "object",
            properties: {
              id: { type: "number", description: "Task ID." },
              title: { type: "string", description: "Task title." },
            },
            required: ["id", "title"],
            additionalProperties: false,
          },
        },
        skip_scan: {
          type: "boolean",
          description:
            "true: skip codebase scan and do prompt analysis only (default false; auto-skips for dirs with <5 files).",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },

  question: {
    description: "Present unknown_scan questions to the user. REQUIRED after unknown_scan finds questions — call BEFORE generate. First call (no answers) returns the questions formatted for presentation. Present them to the user, then call again with their answers.",
    schema: {
      type: "object",
      properties: {
        answers: {
          type: "object",
          description:
            'User\'s answers keyed by question ID (e.g. {"Q1": "yes", "Q2": "node"}). Omit on first call to get the questions.',
          additionalProperties: { type: "string" },
        },
      },
      required: [],
      additionalProperties: false,
    },
  },

  task_update: {
    description: "Update a harness task's status on the panel. Call whenever a task transitions to generating/grading/revising/completed/failed.",
    schema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Task ID." },
        title: { type: "string", description: "Task title." },
        status: {
          type: "string",
          description: "pending | generating | grading | revising | completed | failed | timed_out",
        },
        revisions: { type: "number", description: "Revision count so far." },
        score: { type: "string", description: "PASS | FAIL" },
        model: { type: "string", description: "Model used for this task." },
      },
      required: ["id", "title", "status"],
      additionalProperties: false,
    },
  },

  harness_done: {
    description: "Mark the harness as complete — call when the loop ends.",
    schema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },

  record_failure: {
    description: "Stage 1 (RECORD) of the learning loop. Append a failure record to failures.ndjson for later root-cause analysis.",
    schema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task description." },
        prompt: { type: "string", description: "The generation prompt that produced the failing output." },
        gradeResult: { type: "string", description: "The grader's verdict/output." },
        model: { type: "string", description: "Model used." },
        revisions: { type: "number", description: "Revision count so far." },
      },
      required: ["task", "prompt", "gradeResult"],
      additionalProperties: false,
    },
  },

  investigate: {
    description: "Stage 2 (INVESTIGATE) of the learning loop. Run the generator to analyze the ROOT CAUSE of a failure (not just the symptom).",
    schema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task description." },
        prompt: { type: "string", description: "The generation prompt that produced the failing output." },
        gradeResult: { type: "string", description: "The grader's verdict/output." },
        model: { type: "string", description: "Model used." },
      },
      required: ["task", "prompt", "gradeResult"],
      additionalProperties: false,
    },
  },

  verify_diagnosis: {
    description: "Stage 3 (VERIFY) of the learning loop. Run the grader to check whether a diagnosis is CORRECT and ACTIONABLE (leads to a useful rule). Returns PASS/FAIL + a [usage-coach NEXT] directive.",
    schema: {
      type: "object",
      properties: {
        diagnosis: { type: "string", description: "Root-cause diagnosis to verify." },
        task: { type: "string", description: "Task description." },
        gradeResult: { type: "string", description: "The grader's verdict/output." },
      },
      required: ["diagnosis", "task", "gradeResult"],
      additionalProperties: false,
    },
  },

  generalize: {
    description: "Stage 4 (GENERALIZE) of the learning loop. Run the generator to turn a verified root cause into a reusable rule and append it to rules.md, so the next generate call includes it. Returns the rule text and a [usage-coach NEXT] directive.",
    schema: {
      type: "object",
      properties: {
        diagnosis: { type: "string", description: "Verified root-cause diagnosis." },
        task: { type: "string", description: "Task description." },
      },
      required: ["diagnosis", "task"],
      additionalProperties: false,
    },
  },

  generate: {
    description: "Run the GENERATOR model on a prompt. Quota-aware: on THROTTLE, auto-switches to lighterModel if configured. Returns the model's text response. Step-limited: aborts after max_steps (default 30) to prevent runaway tasks.",
    schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The generation prompt for the sub-session." },
        max_steps: {
          type: "number",
          description:
            "Maximum sub-session steps before timeout (default 30). Increase for complex tasks, decrease to fail fast on scope creep.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },

  generate_batch: {
    description: "Run the GENERATOR model on MULTIPLE tasks. Quota-aware: GO = full parallel; THROTTLE = lighter model + concurrency capped at 2; STOP = refused. Use for INDEPENDENT tasks. Step-limited: each sub-session aborts after max_steps (default 30). Resilient: failed tasks are retried sequentially (once); if retry also fails, re-run them individually with generate(). Each task may declare files it will modify via `files: string[]` — overlapping files across tasks force sequential execution (limit=1).",
    schema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          description:
            "One entry per task to generate. All run in parallel (quota-aware; overlapping files force sequential execution).",
          items: {
            type: "object",
            properties: {
              id: { type: "number", description: "Task ID (must match the task_update ID)." },
              prompt: { type: "string", description: "The generation prompt for this task." },
              files: {
                type: "array",
                description:
                  "Files this task will MODIFY. Required when tasks might touch the same files — overlapping files force sequential execution.",
                items: { type: "string", description: "Relative file path." },
              },
            },
            required: ["id", "prompt"],
            additionalProperties: false,
          },
        },
        max_steps: {
          type: "number",
          description: "Maximum sub-session steps per task before timeout (default 30).",
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
  },

  grade: {
    description: "Run the GRADER model on a prompt. Returns PASS/FAIL on the first line + a [usage-coach NEXT] directive. Falls back to generator if grader quota is out. For MECHANICAL tasks (conversions, extraction, scaffolds), pass `checks` instead — deterministic file/grep verification runs locally in milliseconds and the grader model is skipped entirely.",
    schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "What is being graded (context for the verdict; shown in the result).",
        },
        checks: {
          type: "array",
          description:
            "Deterministic checks — when present, ALL are evaluated locally and the verdict is computed without a model call. Use for mechanical verifications; keep model grading for judgment calls.",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: CHECK_TYPE_ENUM, description: "Check type." },
              path: {
                type: "string",
                description:
                  "Relative path (file for file-exists/line-count; file OR dir for grep, default '.' = recursive scan skipping node_modules/.git/dist).",
              },
              pattern: { type: "string", description: "Regex for grep / grep-absent." },
              minCount: { type: "number", description: "grep: minimum total matches (default 1)." },
              min: { type: "number", description: "line-count: minimum non-empty lines." },
              max: { type: "number", description: "line-count: maximum non-empty lines." },
            },
            required: ["type"],
            additionalProperties: false,
          },
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },

  grade_batch: {
    description: "Run the GRADER model on MULTIPLE tasks IN PARALLEL. Quota-aware: GO = full parallel; THROTTLE = concurrency capped at 2; STOP = refused. Use after generate_batch returns results for all INDEPENDENT tasks — grade them all at once instead of one-by-one. Each result includes a per-task PASS/FAIL verdict + NEXT directive. Resilient: failed grades are retried sequentially (once).",
    schema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          description: "One entry per task to grade. All run in parallel on GO.",
          items: {
            type: "object",
            properties: {
              id: { type: "number", description: "Task ID (must match the task_update ID)." },
              prompt: { type: "string", description: "The grading prompt for this task (same format as grade())." },
              checks: {
                type: "array",
                description: "Deterministic checks — when present, the model call is skipped (see grade()).",
                items: {
                  type: "object",
                  properties: {
                    type: { type: "string", enum: CHECK_TYPE_ENUM, description: "Check type." },
                    path: { type: "string", description: "Relative path." },
                    pattern: { type: "string", description: "Regex for grep / grep-absent." },
                    minCount: { type: "number", description: "grep: minimum total matches." },
                    min: { type: "number", description: "line-count: minimum non-empty lines." },
                    max: { type: "number", description: "line-count: maximum non-empty lines." },
                  },
                  required: ["type"],
                  additionalProperties: false,
                },
              },
            },
            required: ["id", "prompt"],
            additionalProperties: false,
          },
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
  },

  reverse_interview: {
    description: "Reverse interview: identify ambiguities in the task and ask the user one question at a time, highest design-impact first. Call WITHOUT answer to start or get the next question. Call WITH answer to record the user's response and advance. Returns the next question or a completion summary. ALWAYS present the question to the user verbatim — do NOT answer it yourself.",
    schema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The current task description (what the user asked for)." },
        context: {
          type: "string",
          description:
            "Additional context from unknown_scan, codebase exploration, or prior turns. Injected into the question-generation prompt for better prioritization.",
        },
        answer: {
          type: "string",
          description: "The user's response to the previous question. Omit on the first call (or when there is no answer to record).",
        },
        force_complete: {
          type: "boolean",
          description: "Force-complete the interview now, returning a summary of the recorded answers.",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },

  coach_config: {
    description: 'View or update harness model configuration (generator, grader, lighterModel, provider, maxSteps, domainMaxNodes). Call with no args to view current config. Pass any combination of fields to update. Example: coach_config({ generator: "anthropic/claude-sonnet-4-20250514", grader: "opencode/mimo-v2.5-free", maxSteps: 15 })',
    schema: {
      type: "object",
      properties: {
        generator: { type: "string", description: "Generator model (provider/model id)." },
        grader: { type: "string", description: "Grader model (provider/model id)." },
        lighterModel: { type: "string", description: "Fallback model switched to under throttle." },
        provider: { type: "string", description: "Provider used for generate/grade sub-sessions." },
        maxSteps: {
          type: "number",
          description: "Max steps per generate/grade sub-session (default 30). Lower = faster but may timeout on complex tasks.",
        },
        domainMaxNodes: {
          type: "number",
          description: "Max domain DB nodes injected into a generate prompt (default 12). Lower keeps prompts small; 0 or unset uses the default.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },

  coach_analyze: {
    description: "Analyze knowledge injection effectiveness — compares grade PASS rates for tasks WITH injected knowledge (rules, impl-notes, domain DB, scan findings) vs WITHOUT. Run after 20+ harness tasks to see if accumulated knowledge actually helps.",
    schema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
};
