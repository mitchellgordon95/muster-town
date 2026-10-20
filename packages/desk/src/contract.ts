/**
 * Agent-scoped payloads between a desk and the town (architecture.md, "Desks as sandboxes").
 * TODO: switch to @agent-town/schema when exported (DeskBrief, DeskActivityInput, DeskControl, DeskSessionEndInput).
 */
import { z } from "zod";

// TODO: switch to @agent-town/schema when exported
export const DeskWorkspace = z.object({
  repoUrl: z.string(),
  base: z.string(),
  branch: z.string(),
  branchPrefix: z.string(),
  dir: z.string(),
  /** v1.2: green → after a session that ends with a report, run `checks` and squash-merge the branch's open PR */
  merge: z.enum(["human", "green"]).default("human"),
  checks: z.array(z.string()).default([]),
});
/** Input type: `merge`/`checks` are optional (defaults human / none) so older briefs and callers still fit. */
export type DeskWorkspace = z.input<typeof DeskWorkspace>;

// TODO: switch to @agent-town/schema when exported
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

// TODO: switch to @agent-town/schema when exported
export const DeskActivityInput = z.object({
  session: z.string(),
  kind: z.enum(["tool", "thought", "status"]),
  tool: z.string().optional(),
  input: z.unknown().optional(),
  text: z.string().optional(),
});
export type DeskActivityInput = z.infer<typeof DeskActivityInput>;

// TODO: switch to @agent-town/schema when exported
export const DeskControl = z.object({
  interrupts: z.array(z.object({ id: z.string(), text: z.string(), from: z.string(), now: z.boolean().optional() })),
  stop: z.boolean(),
});
export type DeskControl = z.infer<typeof DeskControl>;

// TODO: switch to @agent-town/schema when exported
export const DeskSessionEndInput = z.object({
  session: z.string(),
  tokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  turns: z.number().int().nonnegative(),
  sdkSessionId: z.string().optional(),
  finalText: z.string().optional(),
  error: z.string().optional(),
  reportSubmitted: z.boolean(),
  /** v1.2 merge=green: whether the PR was merged after the checks (absent = no merge attempted) */
  merged: z.boolean().optional(),
  prNumber: z.number().int().positive().optional(),
});
export type DeskSessionEndInput = z.infer<typeof DeskSessionEndInput>;
