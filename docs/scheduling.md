# Scheduled work

Mitchell, town hall mt_xywhisvdcm decision 10: "i've noticed some assignments waiting on specific days to run. they show
up as blocked, which isn't quite true. i think maybe we want a cron subsystem for scheduling work for later".

## 1. One-off: an assignment waiting on a time is *scheduled* (step 1, live)

An assignment with `waitFor {after: <iso>}` whose time is still ahead is scheduled, not blocked. Code: `scheduledAt` and
`townScheduled` in `packages/core/src/blockers.ts`; `blockedBy` returns null for it; `GET /api/scheduled` lists them,
soonest first. Web: a blue "scheduled" pill and "runs at <your time> · <UTC>" on the assignment card, a blue
"scheduled N" map badge, a Scheduled list on the building panel's Overview. `scripts/town-blockers.py` keeps it out of
the blocker rows. No schema change. `after` stays capped at 24 h ahead (`WAIT_TTL_MS`).

## 2. Recurring: building schedules (step 2, this design; migration 055 waits for Mitchell)

### What it is
A **schedule** belongs to a building and creates **one assignment on the building queue** each time it fires. It stores
what `assign` takes: title, description, lane fields (`lane`, `grantId`, `keyResultId`, `gap`, `sourceId`), `pages`
(at most 3 topic pages) and `model`. The recurrence is either a 5-field cron expression in UTC (`0 20 * * *` = every
day at 20:00 UTC) or a fixed interval (`everyMinutes`, at least 60; the tools take "every N hours").

Table `schedules` (migration `055_schedules.sql`, one new table, no change to existing ones): id, buildingId, title,
description, cron | everyMinutes (exactly one), the lane fields, pages (JSON), model, status (active | paused | ended),
endedReason, nextRunAt, lastRunAt, lastAssignmentId, runs, endsAt (required), createdBy, createdByKind, timestamps.

### How it fires
- The runtime tick calls `fireSchedules(world, now)` next to `checkWaits`: every active schedule with `nextRunAt <= now`.
- It creates the assignment with `createAssignment(... queue: "building", lane, pages, model, origin)` and
  `createdBy {kind: "system", id: <schedule id>}`, appends event `schedule.fired {scheduleId, assignmentId}`, sets
  `lastRunAt`, `lastAssignmentId`, `runs + 1`, and `nextRunAt` = the next occurrence **after now**. Missed fires during
  downtime collapse into one (no catch-up burst).
- **No pile-up:** if `lastAssignmentId` is still pending, the fire is skipped (event `schedule.skipped`) and nextRunAt
  moves on.
- **Lane re-check at every fire** (`resolveLane` as `assign` does): a grant schedule whose grant closed, or directed work
  whose key result a grant proposal now names, ends the schedule (`status ended`, `endedReason`) and files a short
  town-written report in the building's in-tray, like `wait-expired` does today.
- Past `endsAt` the schedule ends. Forks off in the building = the schedule pauses (the building queue doesn't exist).

### Why it doesn't break "nothing continues without a decision"
Each fire is a normal assignment: a fork runs it, it ends in a report, the manager decides the report. The schedule
only saves re-typing the same `assign`. Guards: a human or the manager creates it (`building.manage`); directed
schedules carry the human source; every schedule has an `endsAt` (default 14 days, at most 90), so a recurring job is
renewed on purpose rather than running forever; the in-tray report on an ended schedule says why it stopped.

### Where you see it
- **Building panel → Overview → Scheduled**: the one-off rows (step 1) plus a **Recurring** list: title, "every day
  20:00 UTC" / "every 6 h", next run (your time · UTC), runs so far, ends on, Pause / Resume / Cancel for
  `building.manage`.
- **API**: `GET /api/buildings/:id/schedules`, `POST /api/buildings/:id/schedules` (`ScheduleInput`), `PATCH
  /api/schedules/:id {status: active | paused}`, `POST /api/schedules/:id/cancel`. `GET /api/scheduled` gains each
  active schedule's next run (`kind: "recurring"`).
- **Town tools** (manager): `schedule` (create: title, description, cron | everyHours, lane fields, pages, model,
  endsAt), `schedules` (list the building's), `cancel_schedule {scheduleId}`. The manager's "Your team" block lists
  active schedules with their next run.

### Code plan (after the migration is approved)
1. `core/src/cron.ts`: parse and `nextAfter(expr, date)` for 5-field UTC cron (`*`, lists, ranges, `/step`), plus
   `everyMinutes`; unit tests with fixed dates. No new dependency.
2. `core/src/schedules.ts`: `createSchedule` (validates lane like `assign`, recurrence, endsAt ≤ 90 d, pages ≤ 3),
   `fireSchedules`, `setScheduleStatus`, `cancelSchedule`; entity in `world.ts`; schema `Schedule`, `ScheduleInput`.
   Tests: fires once per occurrence, skips while the last one is pending, collapses missed fires, ends on a closed
   grant with an in-tray report, ends at endsAt, pauses with forks off.
3. Runtime tick calls `fireSchedules`; server routes; town tools (`schedule`, `schedules`, `cancel_schedule`) in
   `VERB_DESCRIPTIONS`.
4. Web: the Recurring list with Pause / Resume / Cancel; docs/manual.md one line.

### Open questions for Mitchell
- Default `endsAt` 14 days, cap 90: right, or should schedules be open-ended?
- Should humans other than managers/admins (`building.assign`) be able to create schedules, or only `building.manage`?
