/**
 * The Waker (docs/wakes.md §2, §4 step 4): one subscriber over the event log that decides which events wake whom.
 * The event log is the stream (append-only, id-ordered); `WAKE_RULES` is the table of subscriptions, by role. The
 * Waker keeps a cursor (the last event id it has handled) in the DB, so an event that a durable rule acts on and that
 * arrived while the server was down (between the old runtime's stop and the new one's boot) is delivered once on boot.
 *
 * The safety rule: a durable rule (`replay`) only writes state (a town-written in-tray report, a pending assignment)
 * under a unique wakeKey `wake:<rule>:<eventId>:<id>`, so a replay or a double delivery writes nothing. Kick rules
 * (start or feed a session through the runtime's own starters, which keep their own in-memory state) are not replayed:
 * the tick's level-triggered sweeps (`wakeManagers`, `scheduleMeetings`, `scheduleWork`) already make up for a restart,
 * as before. Nothing here starts work past `canStart` / `ManageGate`: the starters it calls check them.
 */
import { managerIntrayRow, type World } from "@muster-town/core";
import type { Event } from "@muster-town/schema";

/** What a rule can reach in the runtime. */
export interface WakeCtx {
  world: World;
  /** start summary sessions for a meeting that entered collecting */
  meetingStart(meetingId: string): Promise<unknown>;
  /** start the facilitation of a meeting that entered discussing */
  facilitate(meetingId: string): Promise<unknown>;
  /** a reply session for an attendee @mentioned in a live meeting */
  meetingMention(meetingId: string, toId: string, byId: string, byKind: string): Promise<unknown>;
  /** offer the building's in-tray and open 1:1s to its manager (start or feed its manage session) */
  wakeManagers(buildingId: string): void;
  /** stop an agent's live work */
  abort(agentId: string): void;
}

export interface WakeRule {
  name: string;
  /** whose wake it is (the role default it belongs to, docs/wakes.md §2) */
  who: "attendee" | "mentioned" | "manager" | "agent";
  /** the kind of wake: M meetings, T the manager's in-tray, Q the queue, or a negative wake (stop) */
  kind: "M" | "T" | "Q" | "stop";
  /** durable: it writes state under a wakeKey, so it is replayed on boot for events since the cursor */
  replay: boolean;
  /** run inside the event dispatch instead of after it */
  sync?: boolean;
  match(e: Event, world: World): boolean;
  run(w: WakeCtx, e: Event): unknown;
}

const pl = (e: Event) => e.payload as Record<string, unknown>;

/**
 * The rules, first match wins (the order of the old `onEvent` branches, so one event still triggers one of them).
 * Not here: step 2's `relayWake`, which the `tell` verb calls itself, because its reply says whether the tell woke the
 * recipient and its conditions (idle now, no session running) hold at the moment of the tell, not at a later replay.
 */
export const WAKE_RULES: WakeRule[] = [
  { name: "meeting-summaries", who: "attendee", kind: "M", replay: false,
    match: (e) => (e.type === "meeting.created" || e.type === "meeting.phase") && pl(e).phase === "collecting",
    run: (w, e) => w.meetingStart(String(pl(e).meetingId)) },
  { name: "facilitation", who: "agent", kind: "M", replay: false,
    match: (e) => e.type === "meeting.phase" && pl(e).phase === "discussing",
    run: (w, e) => w.facilitate(String(pl(e).meetingId)) },
  { name: "meeting-reply", who: "mentioned", kind: "M", replay: false,
    match: (e) => e.type === "agent.mentioned" && !!pl(e).meetingId,
    run: (w, e) => { const p = pl(e); return w.meetingMention(String(p.meetingId), String(p.toId), String(p.byId), String(p.byKind)); } },
  // the manager's 1:1 opened, the human spoke, or it ended: start, feed or wrap up the manager's session
  { name: "manager-1:1", who: "manager", kind: "T", replay: false,
    match: (e, world) => (e.type === "meeting.created" || e.type === "meeting.utterance" || e.type === "meeting.phase") && !!e.buildingId
      && world.meetings.get(String(pl(e).meetingId))?.kind === "one-on-one",
    run: (w, e) => w.wakeManagers(e.buildingId!) },
  // a resident's report (or a human's flag, or a town-written row) landed in a managed building's in-tray
  { name: "manager-intray", who: "manager", kind: "T", replay: false,
    match: (e) => e.type === "doc.created" && (pl(e).docType === "report" || pl(e).docType === "flag") && !!e.buildingId,
    run: (w, e) => w.wakeManagers(e.buildingId!) },
  // step 3: a human decided a grant or wrote a key result: one town-written in-tray row (core/src/wakes.ts), whose doc.created wakes the manager
  { name: "manager-intray-row", who: "manager", kind: "T", replay: true,
    match: (e) => e.type === "grant.funded" || e.type === "grant.closed" || e.type === "kr.created" || e.type === "kr.updated" || e.type === "kr.deleted",
    run: (w, e) => { managerIntrayRow(w.world, e); } },
  { name: "stop", who: "agent", kind: "stop", replay: false, sync: true,
    match: (e) => (e.type === "agent.status" && (pl(e).status === "stopped" || pl(e).status === "banned")) || e.type === "agent.banned",
    run: (w, e) => { if (e.agentId) w.abort(e.agentId); } },
];

export const ruleFor = (e: Event, world: World, rules: WakeRule[] = WAKE_RULES): WakeRule | undefined => rules.find((r) => r.match(e, world));

export interface WakerDeps {
  world: World;
  wake: WakeCtx;
  /** run `fn` after the current (possibly transactional) dispatch, tracked; resolves when it settled */
  later(fn: () => Promise<unknown>, what: string): Promise<void>;
  stopped(): boolean;
  rules?: WakeRule[];
}

export interface Waker {
  /** Replay the durable rules over events since the persisted cursor (resolves when done); then live events only. */
  booted: Promise<void>;
  /** Persist the cursor now. */
  flush(): void;
  stop(): void;
  /** The cursor as persisted. */
  cursor(): number | null;
}

/**
 * Subscribe first, then replay `(cursor, bootId]` for the durable rules; events after bootId arrive live. A first boot
 * (no cursor yet) starts at the end of the log: history is not replayed. The cursor only passes an event once the
 * durable rule it triggered has settled; kick rules don't hold it.
 */
export function startWaker(d: WakerDeps): Waker {
  const { world } = d;
  const rules = d.rules ?? WAKE_RULES;
  const town = world.town;
  const saved = town.wakeCursor();
  const bootId = world.events.lastId();
  /** ids of durable deliveries not settled yet */
  const inflight = new Set<number>();
  let seen = saved ?? bootId;
  let persisted = saved;
  let replaying = saved !== null && saved < bootId;
  const flush = () => {
    if (replaying) return;
    const c = inflight.size ? Math.min(...inflight) - 1 : seen;
    if (c !== persisted) { town.setWakeCursor(c); persisted = c; }
  };
  const deliver = (e: Event, r: WakeRule): Promise<void> => {
    if (!r.replay) return d.later(async () => r.run(d.wake, e), r.name);
    inflight.add(e.id);
    return d.later(async () => r.run(d.wake, e), r.name).finally(() => { inflight.delete(e.id); flush(); });
  };
  const onEvent = (e: Event) => {
    if (d.stopped()) return;
    seen = Math.max(seen, e.id);
    const r = ruleFor(e, world, rules);
    if (r?.sync) r.run(d.wake, e);
    else if (r) void deliver(e, r);
  };
  const unsubscribe = world.events.subscribe(onEvent);
  if (saved === null) flush();
  const booted = (async () => {
    if (!replaying) return;
    let from = saved!;
    while (from < bootId && !d.stopped()) {
      const page = world.events.list({ since: from, limit: 1000 }).filter((e) => e.id <= bootId);
      if (!page.length) break;
      for (const e of page) {
        const r = ruleFor(e, world, rules);
        if (r?.replay) await deliver(e, r);
      }
      from = page.at(-1)!.id;
    }
    // stopped mid-replay: keep the old cursor, so the next boot replays the rest (the rules' wakeKeys make that safe)
    if (d.stopped()) return;
    replaying = false;
    seen = Math.max(seen, bootId);
    flush();
  })();
  return { booted, flush, stop: () => { unsubscribe(); flush(); }, cursor: () => town.wakeCursor() };
}
