import { z } from "zod";

/**
 * Minimal Zod → JSON Schema (draft 2020-12 subset) for the verb inputs: objects, strings, numbers, booleans, enums,
 * arrays, records, unions, optional/nullable/default and `.describe()`. Unknown types become `{}` (anything).
 * Used by `GET /api/verbs` so a client can self-document without a dependency on zod-to-json-schema.
 */
export function toJsonSchema(t: z.ZodTypeAny): Record<string, unknown> {
  const out = convert(t);
  if (t.description && !out.description) out.description = t.description;
  return out;
}

function convert(t: z.ZodTypeAny): Record<string, unknown> {
  const def = t._def as { typeName?: string; description?: string };
  const withDesc = (o: Record<string, unknown>) => (def.description ? { ...o, description: def.description } : o);
  if (t instanceof z.ZodOptional) return withDesc(toJsonSchema(t.unwrap()));
  if (t instanceof z.ZodDefault) return withDesc({ ...toJsonSchema(t._def.innerType), default: t._def.defaultValue() });
  if (t instanceof z.ZodNullable) {
    const inner = toJsonSchema(t.unwrap());
    return withDesc({ anyOf: [inner, { type: "null" }] });
  }
  if (t instanceof z.ZodEffects) return withDesc(toJsonSchema(t.innerType()));
  if (t instanceof z.ZodLazy) return withDesc(toJsonSchema(t.schema));
  if (t instanceof z.ZodString) {
    const o: Record<string, unknown> = { type: "string" };
    for (const c of t._def.checks) {
      if (c.kind === "min") o.minLength = c.value;
      else if (c.kind === "max") o.maxLength = c.value;
      else if (c.kind === "datetime") o.format = "date-time";
    }
    return withDesc(o);
  }
  if (t instanceof z.ZodNumber) {
    const o: Record<string, unknown> = { type: "number" };
    for (const c of t._def.checks) {
      if (c.kind === "int") o.type = "integer";
      else if (c.kind === "min") o[c.inclusive ? "minimum" : "exclusiveMinimum"] = c.value;
      else if (c.kind === "max") o[c.inclusive ? "maximum" : "exclusiveMaximum"] = c.value;
    }
    return withDesc(o);
  }
  if (t instanceof z.ZodBoolean) return withDesc({ type: "boolean" });
  if (t instanceof z.ZodEnum) return withDesc({ type: "string", enum: [...t.options] });
  if (t instanceof z.ZodLiteral) return withDesc({ const: t.value });
  if (t instanceof z.ZodArray) return withDesc({ type: "array", items: toJsonSchema(t.element) });
  if (t instanceof z.ZodRecord) return withDesc({ type: "object", additionalProperties: toJsonSchema(t._def.valueType) });
  if (t instanceof z.ZodUnion) return withDesc({ anyOf: (t.options as z.ZodTypeAny[]).map(toJsonSchema) });
  if (t instanceof z.ZodObject) {
    const shape = t.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(shape)) {
      properties[k] = toJsonSchema(v);
      if (!v.isOptional()) required.push(k);
    }
    return withDesc({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
  }
  return withDesc({});
}
