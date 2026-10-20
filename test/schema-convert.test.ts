// schema-convert.test.ts — rigorous tests for the JSON Schema single source
// (tool-schemas.ts) and the JSON Schema -> tool.schema converter
// (schema-convert.ts). The schema library is injected as a mock (`S`) that
// builds Chain trees we can assert on, since @opencode-ai/plugin is a
// host-provided peer dep that cannot be imported under `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOL_SCHEMAS, TOOL_NAMES } from "../src/tool-schemas.js";
import { convertSchema, makeConverter } from "../src/schema-convert.js";

// ---------------------------------------------------------------------------
// Mock schema library: builds inspectable Chain trees with chained
// .describe()/.optional() (both return `this`, like zod).
// ---------------------------------------------------------------------------
class Chain {
  kind: string;
  desc: string | undefined;
  opt = false;
  props: Record<string, Chain> = {};
  items: Chain | undefined;
  values: string[] | undefined;
  key: Chain | undefined;
  value: Chain | undefined;
  constructor(kind: string, init: Partial<Chain> = {}) {
    this.kind = kind;
    Object.assign(this, init);
  }
  describe(d: string): this {
    this.desc = d;
    return this;
  }
  optional(): this {
    this.opt = true;
    return this;
  }
}

function makeS() {
  return {
    string: () => new Chain("string"),
    number: () => new Chain("number"),
    boolean: () => new Chain("boolean"),
    enum: (values: string[]) => new Chain("enum", { values }),
    array: (items: Chain) => new Chain("array", { items }),
    object: (props: Record<string, Chain>) => new Chain("object", { props }),
    record: (key: Chain, value: Chain) => new Chain("record", { key, value }),
  };
}
const S = makeS();

// ---------------------------------------------------------------------------
// Manual JSON Schema walker (type checks only — no ajv) for structural sanity.
// ---------------------------------------------------------------------------
function isSchemaNode(v: any): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v) && typeof v.type === "string";
}

function validate(value: any, schema: any, path = "$"): string[] {
  const errs: string[] = [];
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) errs.push(`${path}: ${JSON.stringify(value)} not in enum [${schema.enum.join(", ")}]`);
    return errs;
  }
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errs.push(`${path}: expected object, got ${Array.isArray(value) ? "array" : typeof value}`);
        return errs;
      }
      for (const r of schema.required ?? []) if (!(r in value)) errs.push(`${path}: missing required "${r}"`);
      for (const k of Object.keys(value)) {
        if (value[k] === undefined) continue; // JSON semantics: undefined = absent
        const child = schema.properties?.[k];
        if (child) errs.push(...validate(value[k], child, `${path}.${k}`));
        else if (schema.additionalProperties === false) errs.push(`${path}: additional property "${k}" not allowed`);
        else if (isSchemaNode(schema.additionalProperties)) errs.push(...validate(value[k], schema.additionalProperties, `${path}.${k}`));
        else errs.push(`${path}: no schema for property "${k}"`);
      }
      return errs;
    }
    case "array": {
      if (!Array.isArray(value)) {
        errs.push(`${path}: expected array, got ${typeof value}`);
        return errs;
      }
      value.forEach((v, i) => errs.push(...validate(v, schema.items, `${path}[${i}]`)));
      return errs;
    }
    case "string":
      if (typeof value !== "string") errs.push(`${path}: expected string, got ${typeof value}`);
      return errs;
    case "number":
      if (typeof value !== "number") errs.push(`${path}: expected number, got ${typeof value}`);
      return errs;
    case "boolean":
      if (typeof value !== "boolean") errs.push(`${path}: expected boolean, got ${typeof value}`);
      return errs;
    default:
      errs.push(`${path}: unsupported schema type ${schema.type}`);
      return errs;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("TOOL_SCHEMAS covers exactly the 16 TOOL_NAMES, all strict objects", () => {
  assert.equal(TOOL_NAMES.length, 16, "exactly 16 tool names");
  assert.deepEqual(
    [...TOOL_NAMES].sort(),
    Object.keys(TOOL_SCHEMAS).sort(),
    "TOOL_NAMES matches Object.keys(TOOL_SCHEMAS)",
  );
  for (const name of TOOL_NAMES) {
    const entry = TOOL_SCHEMAS[name];
    assert.ok(entry, `${name}: entry exists`);
    assert.equal(typeof entry.description, "string", `${name}: has a description`);
    assert.ok((entry.description ?? "").length > 0, `${name}: description non-empty`);
    assert.equal(entry.schema.type, "object", `${name}: schema type object`);
    assert.ok(entry.schema.properties && typeof entry.schema.properties === "object", `${name}: has properties`);
    assert.ok(Array.isArray(entry.schema.required), `${name}: has required array`);
    assert.equal(entry.schema.additionalProperties, false, `${name}: strict at top level`);
  }
});

test("converts every tool schema without throwing; every root is an object node", () => {
  for (const name of TOOL_NAMES) {
    const root = convertSchema(name, TOOL_SCHEMAS[name].schema, S) as Chain;
    assert.equal(root.kind, "object", `${name}: root is S.object`);
    assert.deepEqual(
      Object.keys(root.props).sort(),
      Object.keys(TOOL_SCHEMAS[name].schema.properties).sort(),
      `${name}: props match schema properties`,
    );
  }
});

test("task_update: required vs optional mapping + status/score descriptions", () => {
  const root = convertSchema("task_update", TOOL_SCHEMAS.task_update.schema, S) as Chain;
  const p = root.props;
  assert.equal(p.id.kind, "number");
  assert.equal(p.id.opt, false, "id required");
  assert.equal(p.title.kind, "string");
  assert.equal(p.title.opt, false, "title required");
  assert.equal(p.status.kind, "string");
  assert.equal(p.status.opt, false, "status required");
  assert.ok(p.status.desc!.includes("pending"), "status desc lists pending");
  assert.ok(p.status.desc!.includes("timed_out"), "status desc lists timed_out");
  assert.equal(p.revisions.kind, "number");
  assert.equal(p.revisions.opt, true, "revisions optional");
  assert.equal(p.score.opt, true, "score optional");
  assert.equal(p.score.desc, "PASS | FAIL");
  assert.equal(p.model.kind, "string");
  assert.equal(p.model.opt, true, "model optional");
});

test("grade: checks.type maps to a 4-value enum; checks itself is optional+described", () => {
  const root = convertSchema("grade", TOOL_SCHEMAS.grade.schema, S) as Chain;
  assert.equal(root.props.prompt.kind, "string");
  assert.equal(root.props.prompt.opt, false, "prompt required");
  const checks = root.props.checks;
  assert.equal(checks.kind, "array");
  assert.equal(checks.opt, true, "checks optional");
  assert.ok(checks.desc!.startsWith("Deterministic checks"), "checks desc preserved");
  const item = checks.items!;
  assert.equal(item.kind, "object");
  assert.deepEqual(item.props.type.values, ["file-exists", "grep", "grep-absent", "line-count"]);
  assert.equal(item.props.type.opt, false, "check type required");
  for (const f of ["path", "pattern", "minCount", "min", "max"]) {
    assert.equal(item.props[f].opt, true, `check ${f} optional`);
  }
  assert.equal(item.props.path.kind, "string");
  assert.equal(item.props.minCount.kind, "number");
});

test("generate_batch: nested array-of-object with files array of string", () => {
  const root = convertSchema("generate_batch", TOOL_SCHEMAS.generate_batch.schema, S) as Chain;
  const tasks = root.props.tasks;
  assert.equal(tasks.kind, "array");
  assert.equal(tasks.opt, false, "tasks required");
  const item = tasks.items!;
  assert.equal(item.kind, "object");
  assert.equal(item.props.id.kind, "number");
  assert.equal(item.props.id.opt, false, "task id required");
  assert.equal(item.props.prompt.kind, "string");
  assert.equal(item.props.prompt.opt, false, "task prompt required");
  const files = item.props.files;
  assert.equal(files.kind, "array");
  assert.equal(files.opt, true, "files optional");
  assert.equal(files.items!.kind, "string", "files items are strings");
  assert.ok(files.desc!.includes("MODIFY"), "files desc preserved");
  assert.equal(root.props.max_steps.kind, "number");
  assert.equal(root.props.max_steps.opt, true, "max_steps optional");
});

test("question.answers maps to record(string, string), optional, described", () => {
  const root = convertSchema("question", TOOL_SCHEMAS.question.schema, S) as Chain;
  assert.deepEqual(Object.keys(root.props), ["answers"]);
  const answers = root.props.answers;
  assert.equal(answers.kind, "record", "answers is a record");
  assert.equal(answers.key!.kind, "string", "record key string");
  assert.equal(answers.value!.kind, "string", "record value string");
  assert.equal(answers.opt, true, "answers optional");
  assert.ok(answers.desc!.includes("question ID"), "answers desc preserved");
});

test("descriptions survive conversion on field level", () => {
  const gen = convertSchema("generate", TOOL_SCHEMAS.generate.schema, S) as Chain;
  assert.equal(gen.props.max_steps.desc, TOOL_SCHEMAS.generate.schema.properties.max_steps.description);
  assert.ok(gen.props.max_steps.desc!.startsWith("Maximum sub-session steps before timeout (default 30)"));
  const ri = convertSchema("reverse_interview", TOOL_SCHEMAS.reverse_interview.schema, S) as Chain;
  assert.equal(ri.props.task.desc, "The current task description (what the user asked for).");
  assert.equal(ri.props.task.opt, false, "task required");
  assert.equal(ri.props.context.opt, true, "context optional");
  assert.equal(ri.props.answer.opt, true, "answer optional");
  const us = convertSchema("unknown_scan", TOOL_SCHEMAS.unknown_scan.schema, S) as Chain;
  assert.equal(us.props.skip_scan.kind, "boolean");
  assert.equal(us.props.skip_scan.opt, true, "skip_scan optional");
  assert.equal(us.props.tasks.items!.props.id.opt, false, "scan task id required");
});

test("unknown/unsupported node throws loudly with the tool name", () => {
  assert.throws(
    () => convertSchema("bogus_tool", { type: "object", properties: { x: { type: "websocket" } } }, S),
    (e: Error) => e.message.includes("bogus_tool") && e.message.includes("unsupported node") && e.message.includes("websocket"),
  );
  assert.throws(
    () => convertSchema("weird_tool", { type: "object", properties: { x: { type: "teleport" } } }, S),
    (e: Error) => e.message.includes("weird_tool") && e.message.includes("unsupported node") && e.message.includes("teleport"),
  );
  // enum values must be strings
  assert.throws(
    () => convertSchema("num_enum", { type: "object", properties: { x: { type: "string", enum: [1, 2] } } }, S),
    (e: Error) => e.message.includes("num_enum"),
  );
  // array without an items schema
  assert.throws(
    () => convertSchema("no_items", { type: "object", properties: { x: { type: "array" } } }, S),
    (e: Error) => e.message.includes("no_items"),
  );
});

test("non-object top level throws", () => {
  assert.throws(
    () => convertSchema("flat_tool", { type: "string" }, S),
    (e: Error) => e.message.includes("flat_tool") && e.message.includes("object"),
  );
  assert.throws(
    () => convertSchema("null_tool", null, S),
    (e: Error) => e.message.includes("null_tool"),
  );
});

test("makeConverter binds the schema lib and matches direct conversion", () => {
  const conv = makeConverter(S);
  const viaFactory = conv("task_update", TOOL_SCHEMAS.task_update.schema) as Chain;
  const direct = convertSchema("task_update", TOOL_SCHEMAS.task_update.schema, S) as Chain;
  assert.equal(viaFactory.kind, direct.kind);
  assert.equal(viaFactory.props.status.kind, direct.props.status.kind);
  assert.equal(viaFactory.props.revisions.opt, direct.props.revisions.opt);
  assert.equal(viaFactory.props.score.desc, direct.props.score.desc);
  const gb = conv("generate_batch", TOOL_SCHEMAS.generate_batch.schema) as Chain;
  assert.equal(gb.props.tasks.items!.props.files.items!.kind, "string");
});

test("structural sanity: hand-written args validate against the schemas (manual walk)", () => {
  const grade = TOOL_SCHEMAS.grade.schema;
  const goodChecks = [
    { type: "file-exists", path: "src/rt.ts" },
    { type: "grep", pattern: "SessionOps", minCount: 2 },
    { type: "grep-absent" },
    { type: "line-count", path: "src/rt.ts", min: 3, max: 100 },
  ];
  assert.deepEqual(validate({ prompt: "grade the port", checks: goodChecks }, grade), [], "good grade args validate");
  assert.deepEqual(validate({ prompt: "model-only grade" }, grade), [], "grade without checks validates");

  // bad samples must be rejected by the schema (not silently accepted)
  assert(validate({ prompt: "x", checks: [{ type: "nope" }] }, grade).some((e) => e.includes("not in enum")));
  assert(validate({ prompt: "x", checks: [{ type: "grep", path: 123 }] }, grade).some((e) => e.includes("expected string")));
  assert(validate({ prompt: "x", checks: [{ type: "grep", surprise: 1 }] }, grade).some((e) => e.includes("additional property")));
  assert(validate({ prompt: "x", checks: [{ path: "a.ts" }] }, grade).some((e) => e.includes('missing required "type"')));
  assert(validate({ prompt: 42 }, grade).some((e) => e.includes("expected string")));
  assert(validate({ prompt: "x", bogus: true }, grade).some((e) => e.includes("additional property")));

  const gb = TOOL_SCHEMAS.grade_batch.schema;
  const goodBatch = {
    tasks: [
      { id: 1, prompt: "Evaluate task 1" },
      { id: 2, prompt: "Evaluate task 2", checks: [{ type: "file-exists", path: "out.md" }] },
    ],
  };
  assert.deepEqual(validate(goodBatch, gb), [], "good grade_batch args validate");
  assert(validate({ tasks: [{ prompt: "no id" }] }, gb).some((e) => e.includes('missing required "id"')));

  const q = TOOL_SCHEMAS.question.schema;
  assert.deepEqual(validate({ answers: { Q1: "yes", Q2: "node" } }, q), [], "answers record accepts string map");
  assert(validate({ answers: { Q1: 7 } }, q).some((e) => e.includes("expected string")), "record values must be strings");
  assert.deepEqual(validate({}, q), [], "empty question args validate");

  const hd = TOOL_SCHEMAS.harness_done.schema;
  const ca = TOOL_SCHEMAS.coach_analyze.schema;
  assert.deepEqual(validate({}, hd), [], "harness_done accepts {}");
  assert.deepEqual(validate({}, ca), [], "coach_analyze accepts {}");
  assert(validate({ foo: 1 }, hd).some((e) => e.includes("additional property")), "harness_done rejects extras");
  assert.deepEqual(validate({ answers: undefined }, q), [], "explicit undefined answer treated as absent");

  const hs = TOOL_SCHEMAS.harness_start.schema;
  assert(validate({ name: "port" }, hs).some((e) => e.includes('missing required "total"')));
});
