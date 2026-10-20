// schema-convert.ts — JSON Schema → V1 `tool.schema` (zod-style) converter.
//
// The V1 plugin host provides `tool.schema` at runtime (from @opencode-ai/plugin),
// which cannot be imported under `node --test` (peer dep, no CJS export map).
// Therefore the schema library is INJECTED: the plugin passes the real
// `tool.schema`; tests pass a tiny mock. `makeConverter(S)` returns a bound
// converter for direct use in the plugin's tool table.
//
// Mapping rules (recursive):
//   object                          -> S.object({ ...props })   (per-property describe/optional)
//   object w/ additionalProperties  -> S.record(S.string(), convert(valueSchema))
//     being a schema and no properties
//   string/number/boolean           -> S.string()/number()/boolean()
//   enum: [...]                     -> S.enum(values)
//   array                           -> S.array(convert(items))
// Property decoration order: convert -> .describe(desc) -> .optional()
// (when the property is not listed in the parent's `required`).
// Unsupported nodes throw loudly so plugin init fails fast.

import type { tool } from "@opencode-ai/plugin";

/** The real schema library (V1: `tool.schema` from @opencode-ai/plugin, i.e. zod). */
export type SchemaLib = typeof tool.schema;

/**
 * Permissive structural view of the schema library. Method syntax keeps
 * parameter checking bivariant, so both the real zod namespace and test
 * mocks (returning chainable nodes) are assignable.
 */
export interface SchemaLibLike {
  string(): SchemaLike;
  number(): SchemaLike;
  boolean(): SchemaLike;
  enum(values: string[]): SchemaLike;
  array(items: SchemaLike): SchemaLike;
  object(props: Record<string, SchemaLike>): SchemaLike;
  record(key: SchemaLike, value: SchemaLike): SchemaLike;
}

type SchemaLike = {
  describe(desc: string): SchemaLike;
  optional(): SchemaLike;
};

function isSchemaNode(v: any): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v) && typeof v.type === "string";
}

function unsupported(toolName: string, node: any): never {
  throw new Error(`schema-convert: unsupported node for ${toolName}: ${JSON.stringify(node)}`);
}

/** Decorate a converted node with its description (if any), zod-safe order: describe first. */
function describe(node: SchemaLike, raw: any): SchemaLike {
  return raw && typeof raw.description === "string" ? node.describe(raw.description) : node;
}

function convertNode(toolName: string, node: any, S: SchemaLibLike): SchemaLike {
  if (!node || typeof node !== "object" || Array.isArray(node)) unsupported(toolName, node);

  // record<string, T>: an object whose additionalProperties IS a schema (and no named properties).
  if (node.type === "object" && isSchemaNode(node.additionalProperties) && !node.properties) {
    return S.record(S.string(), describe(convertNode(toolName, node.additionalProperties, S), node.additionalProperties));
  }

  // enum wins over the plain scalar type so { type: "string", enum: [...] } maps to S.enum.
  if (Array.isArray(node.enum)) {
    if (!node.enum.every((v: any) => typeof v === "string")) unsupported(toolName, node);
    return S.enum(node.enum as string[]);
  }

  switch (node.type) {
    case "string":
      return S.string();
    case "number":
      return S.number();
    case "boolean":
      return S.boolean();
    case "array": {
      if (!isSchemaNode(node.items)) unsupported(toolName, node);
      return S.array(describe(convertNode(toolName, node.items, S), node.items));
    }
    case "object": {
      const props: Record<string, SchemaLike> = {};
      const required = new Set<string>(Array.isArray(node.required) ? node.required : []);
      for (const [name, raw] of Object.entries<any>(node.properties ?? {})) {
        if (!isSchemaNode(raw)) unsupported(toolName, raw);
        let converted = convertNode(toolName, raw, S);
        converted = describe(converted, raw);
        if (!required.has(name)) converted = converted.optional();
        props[name] = converted;
      }
      return S.object(props);
    }
    default:
      unsupported(toolName, node);
  }
}

/**
 * Convert a JSON Schema (from TOOL_SCHEMAS) into a V1 `tool.schema` args shape.
 * @param toolName tool name — used in error messages only.
 * @param schema   the JSON Schema node (top level must be an object schema).
 * @param S        the schema library (real `tool.schema`, or a mock in tests).
 */
export function convertSchema(toolName: string, schema: any, S: SchemaLibLike): any {
  if (!schema || typeof schema !== "object" || schema.type !== "object") {
    throw new Error(
      `schema-convert: top-level schema must be an object for ${toolName}: got ${JSON.stringify(schema?.type ?? schema)}`,
    );
  }
  return convertNode(toolName, schema, S);
}

/** Bind a schema library once; returns a (toolName, schema) converter. */
export function makeConverter(S: SchemaLibLike): (toolName: string, schema: any) => any {
  return (toolName: string, schema: any) => convertSchema(toolName, schema, S);
}
