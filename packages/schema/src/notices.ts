import { z } from "zod";

/**
 * Notices (docs/legible-delegation.md §8, build step 5): a state change with nothing to do, in a feed beside the asks.
 * shipped (one per Shipped item of a rollup, its "What you'd see" line and picture), closed-loop (a funded grant closed:
 * what it was funded for, what it spent, what it bought), verified (a key result a human or a passed check verified),
 * slate (the Secretary's money slate), pattern (the Secretary's weekly convergences and repeats), gate (a grant's step
 * gate, wired by a later step). Written in code by core notices.ts and secretary.ts; never decided.
 */
export const NoticeKind = z.enum(["shipped", "closed-loop", "verified", "slate", "pattern", "gate"]);
export type NoticeKind = z.infer<typeof NoticeKind>;
export const Notice = z.object({
  id: z.string().min(1),
  kind: NoticeKind,
  buildingId: z.string().nullable().default(null),
  goalId: z.string().nullable().default(null),
  title: z.string(),
  body: z.string().default(""),
  /** a picture: a media id (mf_…) or the src a rollup gave, or null */
  picture: z.string().nullable().default(null),
  /** the ids it is about: a rollup, a grant, a key result, the asks a slate cites */
  refs: z.array(z.string()).default([]),
  createdAt: z.string(),
});
export type Notice = z.infer<typeof Notice>;
