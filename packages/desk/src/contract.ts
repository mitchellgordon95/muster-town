/**
 * Agent-scoped payloads between a desk and the town (architecture.md, "Desks as sandboxes").
 * TODO: switch to @muster-town/schema when exported (DeskBrief, DeskActivityInput, DeskControl, DeskSessionEndInput).
 */
import { z } from "zod";

// TODO: switch to @muster-town/schema when exported
export const DeskWorkspace = z.object({
  repoUrl: z.string(),
  base: z.string(),
  branch: z.string(),
  branchPrefix: z.string(),
  dir: z.string(),
});
export type DeskWorkspace = z.infer<typeof DeskWorkspace>;

// TODO: switch to @muster-town/schema when exported
export const DeskBrief = z.object({
  agent: z.object({ id: z.string(), name: z.string() }).passthrough(),
  building: z.object({ id: z.string(), name: z.string(), maxTurnsPerSession: z.number().int().positive().optional() }).passthrough(),
  town: z.object({}).passthrough(),
  assignment: z.object({ id: z.string() }).passthrough().nullable().optional(),
  session: z.object({ id: z.string(), model: z.string() }).passthrough(),
  system: z.string(),
  prompt: z.string(),
  workspace: DeskWorkspace.nullable().optional(),
});
export type DeskBrief = z.infer<typeof DeskBrief>;

// TODO: switch to @muster-town/schema when exported
export const DeskActivityInput = z.object({
  session: z.string(),
  kind: z.enum(["tool", "thought", "status"]),
  tool: z.string().optional(),
  input: z.unknown().optional(),
  text: z.string().optional(),
});
export type DeskActivityInput = z.infer<typeof DeskActivityInput>;

// TODO: switch to @muster-town/schema when exported
export const DeskControl = z.object({
  interrupts: z.array(z.object({ id: z.string(), text: z.string(), from: z.string(), now: z.boolean().optional() })),
  stop: z.boolean(),
});
export type DeskControl = z.infer<typeof DeskControl>;

// TODO: switch to @muster-town/schema when exported (the desk's zod is not the schema's, so the shape is copied)
const count = z.number().int().nonnegative();
const TokenCounts = z.object({ input: count, output: count, cacheRead: count, cacheWrite5m: count, cacheWrite1h: count });

// TODO: switch to @muster-town/schema when exported
export const DeskSessionEndInput = z.object({
  session: z.string(),
  /** raw total: the sum of `counts` (read by a server older than Bank step 1) */
  tokens: z.number().int().nonnegative(),
  /** the five token counters (sdkTokenCounts), summed over models, and per model id */
  counts: TokenCounts,
  byModel: z.record(z.string(), TokenCounts),
  costUsd: z.number().nonnegative(),
  turns: z.number().int().nonnegative(),
  sdkSessionId: z.string().optional(),
  finalText: z.string().optional(),
  error: z.string().optional(),
  reportSubmitted: z.boolean(),
  /** what paid: `api-key` with `fallback` when the subscription hit its limit and the session reran on the API key */
  fundingUsed: z.enum(["subscription", "api-key", "donor-key"]).optional(),
  fallback: z.boolean().optional(),
});
export type DeskSessionEndInput = z.infer<typeof DeskSessionEndInput>;
