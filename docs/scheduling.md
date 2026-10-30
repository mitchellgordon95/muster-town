# Scheduled work: building schedules

Mitchell, 1:1 mt_w7z9k1z112 (2026-10-29): "scheduled jobs shouldn't live on residents, they should live in a schedule
object similar to the one in the townhall. I would attach it to the building, and let whoever is around at the time it
fires take the assignment." This replaces step 1 (74ea055, town hall mt_xywhisvdcm decision 10), where a timed job was an
assignment on one agent's queue with `waitFor {after}`; the recurring design of draft PR #78 is folded in here.

## What it is

A **schedule** belongs to a building (table `schedules`, migration `057_schedules.sql`; `Schedule` in
`packages/schema`). It stores what `assign` takes (title, description, lane fields `lane`/`grantId`/`keyResultId`/`gap`/
`sourceId`, `pages`, `model`), the human `origin` it traces to, and when:

- `nextRunAt`: the next (or only) run;
- a repeat, at most one of `everyMinutes` (at least 60; tools take `everyHours`) or `dailyAt` (`["HH:MM", …]` UTC);
  neither = one-shot;
- `endsAt` on a repeat: default 14 days out, at most 90, so a recurring job is renewed on purpose;
- `maxRuns` on a repeat (tools take `repeat.times`): it also ends after that many fires (skipped runs don't count);
- `paused` (migration 058): it keeps `nextRunAt` but does not fire until resumed.

Status is `active` or `ended` with `endedReason` (`ran`, `past its end`, `ran N times`, `cancelled by …`, or the lane problem), plus
`runs`, `lastRunAt`, `lastAssignmentId`.

## How it fires (`packages/core/src/schedules.ts`)

The runtime tick calls `fireSchedules(world, now)` after `checkWaits`. For each active, unpaused schedule with `nextRunAt <= now`:

1. **Who takes it** (`scheduleTaker`): the building queue (the manager holds it until a fork takes it); a building
   with no manager agent has nobody, and the schedule ends. Nothing is pinned to an agent before this moment.
2. It creates one normal assignment (`createAssignment`, `createdBy` = the schedule id, the stored lane re-checked by
   `resolveLane`, its origin, pages, and the model on the building queue). Event `schedule.fired`.
3. **No pile-up:** if the last fire's assignment is still pending or active (queued or running), the run is skipped
   and the schedule moves to its next occurrence (`schedule.skipped`, its text says which).
4. **No catch-up burst:** `nextRunAt` is in the table, so a restart picks it up; the next run is the first occurrence
   after now, so runs missed during downtime collapse into one.
5. A one-shot ends (`ran`); a repeat ends once its next occurrence is past `endsAt` or it has fired `maxRuns` times.
6. A lane that no longer holds (grant closed, key result now proposed) ends the schedule and files a town-written report
   (tag `schedule-ended`) in the building's in-tray.

Each fire is ordinary work that ends in a report the manager decides, so "nothing continues without a decision" holds.

## How it is made and seen

- **Town tool** `schedule` (managers and reviewers, `building.assign`): title, description, `runsAt` and/or `repeat
  {everyHours | dailyAt, until, times}`, lane fields, pages, model. `schedule {scheduleId, …}` edits one (title,
  description, `runsAt`, a new `repeat` that replaces the old one or `null` for a one-shot, pages, model; the lane stays)
  and `paused: true|false` pauses or resumes it (a run that passed while paused is not fired late: a repeat moves to its
  next occurrence, a one-shot fires on the next tick). Event `schedule.edited`. `cancel {scheduleId}` deletes one. `assign waitFor {after}` is
  refused with a pointer to `schedule`. The manager's "## Your team" block lists the building's active schedules.
- **API**: `GET /api/scheduled` → `{schedules}` (every active schedule, soonest first); `GET /api/buildings/:id/schedules`
  (active, then the 20 most recently ended); `POST /api/buildings/:id/schedules` (`CreateScheduleInput`, building.assign);
  `POST /api/schedules/:id` (`EditScheduleInput`: edit, pause, resume); `POST /api/schedules/:id/cancel`.
- **Web**: building panel → Overview → **Schedule**: title, next run (your time · UTC), repeat and end (date and
  run count), runs so far, a "paused" pill, the last fired assignment and its state (queued, running, done), what it
  creates (lane, who takes it), Pause/Resume and Cancel for `building.assign`. On the map, a blue **scheduled N** badge by the
  building's in-tray; hover lists the next runs, click opens the Overview.
- `scripts/town-blockers.py`: the "Scheduled, not a blocker" line reads `GET /api/scheduled` and `schedule.fired`.

## What stays a wait

`submit_report resumeWhen {after}` still parks an agent's own continuation on a time (at most 24 h); it is not a block
(`waitsOnTime` in `blockers.ts`) and shows as "parked: until …" on the queue row. `review` / meeting `decide` `waitFor`
and the human `POST /api/agents/:id/work` keep accepting `{after}` for now. Assignments queued with `waitFor {after}` before
this change run out on their time as before (none were migrated).
