/**
 * Building schedules (Mitchell, 1:1 mt_w7z9k1z112; docs/scheduling.md): a timed job lives on its building, not on an
 * agent. `fireSchedules` (the runtime tick, next to `checkWaits`) turns each due schedule into one normal assignment for
 * the building queue (a fork of the manager runs it); a building with no manager agent has nobody to take it.
 * Each fire is ordinary work that ends in a report the manager decides; the schedule only saves re-typing the `assign`.
 */
import { CreateScheduleInput, EditScheduleInput, type Agent, type Assignment, type Building, type Origin, type Schedule, type ScheduleRepeat } from "@muster-town/schema";
import { createAssignment, createDoc, managerAgentOf } from "./domain.ts";
import { AppError, badRequest } from "./errors.ts";
import { checkForkModel } from "./forks.ts";
import { resolveLane } from "./lanes.ts";
import { MAX_ATTACHED_PAGES } from "./memory.ts";
import type { Holder } from "./permissions.ts";
import { newId, truncate } from "./util.ts";
import type { World } from "./world.ts";
import { stamp } from "./time.ts";

const HOUR = 3_600_000, DAY = 24 * HOUR;
/** A repeating schedule ends by default this long after it is made, and at most MAX_SCHEDULE_DAYS out. */
export const DEFAULT_SCHEDULE_DAYS = 14;
export const MAX_SCHEDULE_DAYS = 90;

/** The first run of the repeat strictly after `after` (null for a one-shot). `everyMinutes` steps from `anchor`. */
export function nextOccurrence(s: Pick<Schedule, "everyMinutes" | "dailyAt">, after: Date, anchor: Date = after): Date | null {
  if (s.everyMinutes) {
    const step = s.everyMinutes * 60_000;
    const n = Math.max(1, Math.floor((after.getTime() - anchor.getTime()) / step) + 1);
    return new Date(anchor.getTime() + n * step);
  }
  if (s.dailyAt?.length) {
    const day = Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate());
    const times = s.dailyAt.map((t) => { const [h, m] = t.split(":").map(Number); return (h * 60 + m) * 60_000; }).sort((a, b) => a - b);
    for (const d of [day, day + DAY]) for (const t of times) if (d + t > after.getTime()) return new Date(d + t);
  }
  return null;
}

/** "every 6 h", "daily 08:00, 20:00 UTC, 10 times", or "once" (UI, tools, events). */
export function describeRepeat(s: Pick<Schedule, "everyMinutes" | "dailyAt"> & { maxRuns?: number | null }): string {
  const times = s.maxRuns ? `, ${s.maxRuns} time${s.maxRuns === 1 ? "" : "s"}` : "";
  if (s.everyMinutes) return (s.everyMinutes % 60 ? `every ${s.everyMinutes} min` : `every ${s.everyMinutes / 60} h`) + times;
  if (s.dailyAt?.length) return `daily ${s.dailyAt.join(", ")} UTC${times}`;
  return "once";
}

/** A repeat's stored fields (all null = a one-shot): every N minutes or daily UTC times, and an optional run count. */
function repeatOf(r: ScheduleRepeat | null | undefined): Pick<Schedule, "everyMinutes" | "dailyAt" | "maxRuns"> {
  if (!r) return { everyMinutes: null, dailyAt: null, maxRuns: null };
  if (r.everyHours && r.dailyAt) throw badRequest("repeat: give everyHours or dailyAt, not both.");
  if (!r.everyHours && !r.dailyAt) throw badRequest("repeat: give everyHours (every N hours) or dailyAt ([\"HH:MM\"] UTC).");
  const everyMinutes = r.everyHours ? Math.round(r.everyHours * 60) : null;
  if (everyMinutes !== null && everyMinutes < 60) throw badRequest("repeat.everyHours: at least 1.");
  return { everyMinutes, dailyAt: r.dailyAt ? [...new Set(r.dailyAt)].sort() : null, maxRuns: r.times ?? null };
}

/** A run time a caller gave (or the first occurrence): not in the past, at most MAX_SCHEDULE_DAYS out. */
function checkRunsAt(next: Date, at: Date, given?: string): Date {
  if (next.getTime() < at.getTime() - 60_000) throw badRequest(`runsAt ${given ?? next.toISOString()} is in the past.`);
  if (next.getTime() > at.getTime() + MAX_SCHEDULE_DAYS * DAY) throw badRequest(`runsAt: at most ${MAX_SCHEDULE_DAYS} days ahead.`);
  return next.getTime() < at.getTime() ? at : next;
}

/** A repeat's end date: `until` (default DEFAULT_SCHEDULE_DAYS out), at most MAX_SCHEDULE_DAYS, not before its first run. */
function endOf(r: ScheduleRepeat | null | undefined, next: Date, at: Date): string | null {
  if (!r) return null;
  const until = r.until ? Date.parse(r.until) : at.getTime() + DEFAULT_SCHEDULE_DAYS * DAY;
  if (until > at.getTime() + MAX_SCHEDULE_DAYS * DAY) throw badRequest(`repeat.until: at most ${MAX_SCHEDULE_DAYS} days ahead (a schedule is renewed on purpose, not left running).`);
  if (until < next.getTime()) throw badRequest("repeat.until is before the first run.");
  return new Date(until).toISOString();
}

/** `assign … pages`, a schedule's pages: distinct topic pages of the building, at most MAX_ATTACHED_PAGES. */
export function attachablePages(world: World, bid: string | null, ids: string[]): string[] {
  const uniq = [...new Set(ids)];
  if (uniq.length > MAX_ATTACHED_PAGES) throw badRequest(`Attach at most ${MAX_ATTACHED_PAGES} topic pages.`);
  for (const id of uniq) {
    const d = world.docs.get(id);
    if (!d || d.type !== "wiki" || !d.topicOf || d.topicOf !== bid) throw badRequest(`${id} isn't a topic page of this building (\`write\` type "wiki" with topicOf).`);
  }
  return uniq;
}

/**
 * Make a schedule on a building (the caller checked `building.assign`). Validates the lane as `assign` does, the pages
 * and model, and the time: `runsAt` ahead and at most MAX_SCHEDULE_DAYS out; a repeat ends at `until` (default
 * DEFAULT_SCHEDULE_DAYS). Without `runsAt` a repeat starts at its first occurrence.
 */
export function createSchedule(world: World, buildingId: string, by: Holder, raw: unknown, origin: Origin | null = null, at: Date = new Date()): Schedule {
  const parsed = CreateScheduleInput.safeParse(raw);
  if (!parsed.success) throw badRequest(`Invalid schedule: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
  const input = parsed.data;
  const b = world.buildings.require(buildingId, "building");
  if (b.kind === "town-hall") throw badRequest("The Town Hall has no workers to run a schedule; schedule work on a building.");
  const r = input.repeat;
  const rep = repeatOf(r);
  let next: Date | null = input.runsAt ? new Date(input.runsAt) : nextOccurrence(rep, at);
  if (!next) throw badRequest("A schedule needs runsAt (when it runs), a repeat, or both.");
  next = checkRunsAt(next, at, input.runsAt);
  const endsAt = endOf(r, next, at);
  const lane = resolveLane(world, b.id, by, input);
  const pages = input.pages?.length ? attachablePages(world, b.id, input.pages) : [];
  const model = input.model ? checkForkModel(b, input.model) : null;
  const ts = at.toISOString();
  const s = world.schedules.upsert({
    id: newId("sc"), buildingId: b.id, title: input.title, description: input.description, nextRunAt: next.toISOString(),
    ...rep, endsAt, paused: false, lane: lane.lane, grantId: lane.grantId, keyResultId: lane.keyResultId, gap: lane.gap, sourceId: lane.sourceId,
    pages, model, origin, status: "active", endedReason: null, lastRunAt: null, lastAssignmentId: null, runs: 0,
    createdBy: by.id, createdByKind: by.kind === "agent" ? "agent" : "user", createdAt: ts, updatedAt: ts,
  });
  world.events.append({ type: "schedule.created", buildingId: b.id, text: `${world.nameOf(by.id)} scheduled "${truncate(s.title, 80)}" in ${b.name}: ${describeRepeat(s)}, next ${stamp(s.nextRunAt!)}`, payload: { scheduleId: s.id, nextRunAt: s.nextRunAt, ...rep, endsAt, lane: s.lane } });
  return s;
}

/** End a schedule (cancelled, ran, past its end, lane gone): it never fires again. */
export function endSchedule(world: World, id: string, reason: string, at: Date = new Date()): Schedule {
  const s = world.schedules.require(id, "schedule");
  if (s.status === "ended") return s;
  const e = world.schedules.upsert({ ...s, status: "ended", endedReason: reason, nextRunAt: null, updatedAt: at.toISOString() });
  world.events.append({ type: "schedule.ended", buildingId: s.buildingId, text: `Schedule "${truncate(s.title, 80)}" ended: ${reason}`, payload: { scheduleId: s.id, reason, runs: s.runs } });
  return e;
}

/** `cancel scheduleId` / POST /api/schedules/:id/cancel: the caller holds building.assign on the schedule's building. */
export function cancelSchedule(world: World, actor: Agent, id: string): Schedule {
  const s = world.schedules.require(id, "schedule");
  if (!world.permissions.can(actor, "building.assign", s.buildingId)) throw new AppError("forbidden", "You need building.assign on the schedule's building to cancel it.");
  if (s.status === "ended") throw new AppError("conflict", `Schedule "${s.title}" already ended (${s.endedReason ?? "ended"}).`);
  return endSchedule(world, id, `cancelled by ${actor.name}`);
}

/**
 * `schedule scheduleId` / POST /api/schedules/:id: edit, pause or resume a schedule (building.assign on its building).
 * A new repeat replaces the old one (null = one-shot) and, without runsAt, starts at its first occurrence from now. Pausing
 * keeps the next run; resuming a schedule whose next run passed while paused moves a repeat to its next occurrence (a
 * one-shot fires on the next tick). The lane stays: cancel and schedule again to change it.
 */
export function editSchedule(world: World, actor: Agent, id: string, raw: unknown, at: Date = new Date()): Schedule {
  const parsed = EditScheduleInput.safeParse(raw);
  if (!parsed.success) throw badRequest(`Invalid schedule edit: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
  const input = parsed.data;
  const s = world.schedules.require(id, "schedule");
  if (!world.permissions.can(actor, "building.assign", s.buildingId)) throw new AppError("forbidden", "You need building.assign on the schedule's building to change it.");
  if (s.status === "ended") throw new AppError("conflict", `Schedule "${s.title}" already ended (${s.endedReason ?? "ended"}); schedule it again.`);
  const rep = input.repeat !== undefined ? repeatOf(input.repeat) : { everyMinutes: s.everyMinutes, dailyAt: s.dailyAt, maxRuns: s.maxRuns };
  let next = s.nextRunAt ? new Date(s.nextRunAt) : at;
  if (input.runsAt) next = checkRunsAt(new Date(input.runsAt), at, input.runsAt);
  else if (input.repeat) next = nextOccurrence(rep, at)!;
  const paused = input.paused ?? s.paused;
  if (!paused && next.getTime() < at.getTime() && (rep.everyMinutes || rep.dailyAt?.length)) next = nextOccurrence(rep, at, next)!;
  const endsAt = input.repeat !== undefined ? endOf(input.repeat, next, at) : s.endsAt;
  if (rep.maxRuns && s.runs >= rep.maxRuns) throw badRequest(`repeat.times: it has already run ${s.runs} time(s); give more, or cancel it.`);
  const changed = Object.keys(input).filter((k) => k !== "paused" || input.paused !== s.paused);
  const e = world.schedules.upsert({
    ...s, ...rep, endsAt, paused, nextRunAt: next.toISOString(), updatedAt: at.toISOString(),
    ...(input.title !== undefined ? { title: input.title } : {}), ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.pages !== undefined ? { pages: attachablePages(world, s.buildingId, input.pages) } : {}),
    ...(input.model !== undefined ? { model: input.model ? checkForkModel(world.buildings.require(s.buildingId, "building"), input.model) : null } : {}),
  });
  const what = input.paused !== undefined && input.paused !== s.paused ? (input.paused ? "paused" : "resumed") : "edited";
  world.events.append({ type: "schedule.edited", buildingId: s.buildingId, text: `${actor.name} ${what} schedule "${truncate(e.title, 80)}": ${describeRepeat(e)}${e.paused ? ", paused" : `, next ${stamp(e.nextRunAt!)}`}`, payload: { scheduleId: s.id, changed, paused: e.paused, nextRunAt: e.nextRunAt } });
  return e;
}

/**
 * Who takes a fired schedule's work: the building queue (held by the manager until a fork takes it); a building with no
 * manager agent: nobody (null). One named manager per building, no standing residents (1:1 mt_wngibcr98b decision 1).
 */
export function scheduleTaker(world: World, b: Building): { agentId: string; queue: "agent" | "building" } | null {
  const manager = managerAgentOf(world, b);
  return manager ? { agentId: manager.id, queue: "building" } : null;
}

/**
 * Fire every due schedule: one assignment each for whoever is around. Missed runs during downtime collapse into one; a
 * fire is skipped while the last one's assignment is still queued (no pile-up). A one-shot ends after it runs; a repeat
 * moves to its next occurrence and ends past `endsAt` or after `maxRuns` fires. A lane that no longer holds ends it with an in-tray report.
 */
export function fireSchedules(world: World, at: Date = new Date()): { fired: Assignment[]; ended: Schedule[] } {
  const fired: Assignment[] = [], ended: Schedule[] = [];
  for (const s of world.schedules.where("status = 'active' AND paused = 0 AND nextRunAt <= ?", [at.toISOString()], "ORDER BY nextRunAt")) {
    const b = world.buildings.get(s.buildingId);
    if (!b) { ended.push(endSchedule(world, s.id, "its building is gone", at)); continue; }
    const next = nextOccurrence(s, at, new Date(s.nextRunAt!));
    const past = (d: Date | null) => !d || (s.endsAt ? d.getTime() > Date.parse(s.endsAt) : true);
    const advance = (patch: Partial<Schedule>) => {
      const counted = !!s.maxRuns && (patch.runs ?? s.runs) >= s.maxRuns;
      const u = world.schedules.upsert({ ...s, ...patch, nextRunAt: past(next) || counted ? null : next!.toISOString(), updatedAt: at.toISOString() });
      if (counted) ended.push(endSchedule(world, s.id, `ran ${s.maxRuns} time${s.maxRuns === 1 ? "" : "s"}`, at));
      else if (past(next)) ended.push(endSchedule(world, s.id, s.everyMinutes || s.dailyAt?.length ? "past its end" : "ran", at));
      return u;
    };
    if (s.endsAt && Date.parse(s.nextRunAt!) > Date.parse(s.endsAt)) { ended.push(endSchedule(world, s.id, "past its end", at)); continue; }
    const last = s.lastAssignmentId ? world.assignments.get(s.lastAssignmentId) : undefined;
    if (last?.status === "pending" || last?.status === "active") {
      world.events.append({ type: "schedule.skipped", buildingId: s.buildingId, text: `Schedule "${truncate(s.title, 80)}" skipped a run: its last assignment is still ${last.status === "pending" ? "queued" : "running"}`, payload: { scheduleId: s.id, assignmentId: last.id, status: last.status } });
      advance({});
      continue;
    }
    const taker = scheduleTaker(world, b);
    if (!taker) { ended.push(endSchedule(world, s.id, `${b.name} has nobody to take it (no manager or residents)`, at)); continue; }
    let a: Assignment;
    try {
      a = world.transaction(() => {
        const made = createAssignment(world, {
          agentId: taker.agentId, title: s.title, description: s.description, createdBy: { kind: "system", id: s.id }, buildingId: b.id,
          lane: { lane: s.lane ?? undefined, grantId: s.grantId ?? undefined, keyResultId: s.keyResultId ?? undefined, gap: s.gap ?? undefined, sourceId: s.sourceId ?? undefined },
          origin: s.origin, queue: taker.queue, model: taker.queue === "building" ? s.model : null,
        });
        return s.pages.length ? world.assignments.patch(made.id, { pages: s.pages }) : made;
      });
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      ended.push(endSchedule(world, s.id, `its lane no longer holds: ${e.message}`, at));
      const manager = managerAgentOf(world, b);
      if (manager) createDoc(world, {
        type: "report", state: "building", decision: "pending", buildingId: b.id, authorId: manager.id, authorKind: "agent", tags: ["schedule-ended"],
        title: `Schedule ended: ${s.title}`,
        body: [
          `Written by the town: the schedule "${s.title}" (${s.id}, ${describeRepeat(s)}) was due at ${stamp(s.nextRunAt!)} but its lane no longer holds, so it ended without creating work: ${e.message}`,
          `## The work it created\n\n${s.description}`,
          "Acknowledge to drop it, or schedule it again in a lane that holds.",
        ].join("\n\n"),
      }, `Schedule ended: ${s.title}`);
      continue;
    }
    advance({ runs: s.runs + 1, lastRunAt: at.toISOString(), lastAssignmentId: a.id });
    world.events.append({ type: "schedule.fired", agentId: a.agentId, buildingId: b.id, text: `Schedule "${truncate(s.title, 80)}" fired: ${taker.queue === "building" ? `queued to ${b.name} (a fork runs it)` : `${world.nameOf(a.agentId)} takes it`}`, payload: { scheduleId: s.id, assignmentId: a.id, queue: taker.queue } });
    fired.push(a);
  }
  return { fired, ended };
}

/** A building's schedules, active first (soonest run first), then the 20 most recently ended. */
export function buildingSchedules(world: World, buildingId: string): Schedule[] {
  return [
    ...world.schedules.where("buildingId = ? AND status = 'active'", [buildingId], "ORDER BY nextRunAt"),
    ...world.schedules.where("buildingId = ? AND status = 'ended'", [buildingId], "ORDER BY updatedAt DESC LIMIT 20"),
  ];
}

/** Every active schedule in the town, soonest run first (GET /api/scheduled; the map's schedule boards). */
export function townSchedules(world: World): Schedule[] {
  return world.schedules.where("status = 'active'", [], "ORDER BY nextRunAt");
}
