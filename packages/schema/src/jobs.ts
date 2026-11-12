import { z } from "zod";

/**
 * The job abstraction (plan dc_uwx045472m §A1; grant gr_9mp6v6vv8k): every piece of work is a job with one budget rule,
 * and its record is a thread of entries. Step 1 is read only: core jobs.ts back-fills both tables at boot and
 * GET /api/jobs/:id reads a job and its thread; nothing else writes them yet.
 */
export const JobStatus = z.enum(["proposed", "countered", "open", "held", "closed"]);
export type JobStatus = z.infer<typeof JobStatus>;
export const JobClosedAs = z.enum(["done", "cut", "stopped", "rejected", "nothing-found", "withdrawn"]);
export type JobClosedAs = z.infer<typeof JobClosedAs>;
/** The budget rule that replaces the lane: chunk (exploration), ceiling (grant), per-run (retainer), pocket (directed), building (the manager's thread). */
export const JobRule = z.enum(["chunk", "ceiling", "per-run", "pocket", "building"]);
export type JobRule = z.infer<typeof JobRule>;
export const Job = z.object({
  id: z.string().min(1),
  buildingId: z.string().min(1),
  goalId: z.string().nullable().default(null),
  title: z.string(),
  status: JobStatus,
  closedAs: JobClosedAs.nullable().default(null),
  rule: JobRule,
  /** the lifecycle object: a grant (gr_), a schedule (sc_), a reservation or chain (chunk), the human source (pocket), the building id */
  pocketRef: z.string().min(1),
  createdBy: z.string().min(1),
  createdAt: z.string(),
});
export type Job = z.infer<typeof Job>;

export const EntryAuthorKind = z.enum(["fork", "manager", "human", "secretary", "code"]);
export const EntryLevel = z.enum(["code", "manager", "human", "none"]);
export const EntryProposes = z.enum(["continue", "pivot", "stop", "close", "nothing"]);
/** What an entry moved. Back-filled entries carry what the old records hold: a grant history action, a report decision. */
export const EntryMoved = z.object({
  stepsDone: z.number().int().nonnegative().optional(),
  krClaimed: z.array(z.string()).optional(),
  /** what is left (required on a ceiling step entry from step 2 of the plan on; none before) */
  left: z.string().optional(),
  topUp: z.number().int().nonnegative().optional(),
  proposed: z.string().optional(),
  shipped: z.array(z.string()).optional(),
  /** an answer's action: a grant history action (fund, counter, cut…) or a report decision (approve, continue…) */
  action: z.string().optional(),
  /** a grant action's tokens (fund, adjust, counter) */
  actionTokens: z.number().int().optional(),
  /** the report doc this entry was read from (kept beside it until the plan's step 9b) */
  docId: z.string().optional(),
}).passthrough();
export type EntryMoved = z.infer<typeof EntryMoved>;
export const Entry = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  seq: z.number().int().positive(),
  authorKind: EntryAuthorKind,
  authorId: z.string().nullable().default(null),
  assignmentId: z.string().nullable().default(null),
  sessionId: z.string().nullable().default(null),
  pocket: z.string().nullable().default(null),
  tokens: z.number().int().nonnegative().default(0),
  moved: EntryMoved.default({}),
  proposes: EntryProposes.nullable().default(null),
  answers: z.string().nullable().default(null),
  level: EntryLevel.default("none"),
  note: z.string().default(""),
  body: z.string().default(""),
  ref: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type Entry = z.infer<typeof Entry>;
