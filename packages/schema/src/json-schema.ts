import { z } from "zod";

/**
 * Zod → JSON Schema (draft 2020-12) for the verb inputs, via zod 4's own `z.toJSONSchema`. Describes what a caller
 * may send (`io: "input"`: fields with a default are optional), and anything JSON Schema can't express becomes `{}`.
 * Objects stay closed (`additionalProperties: false`) as the hand-written zod-3 walker this replaced had them.
 * Used by `GET /api/verbs` so a client can self-document.
 */
export function toJsonSchema(t: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...out } = z.toJSONSchema(t, {
    io: "input",
    unrepresentable: "any",
    override: ({ jsonSchema: s }) => {
      if (s.type === "object" && s.properties && s.additionalProperties === undefined) s.additionalProperties = false;
    },
  }) as Record<string, unknown>;
  return out;
}
