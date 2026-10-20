/**
 * v1.4 visitor presence. A visitor's loop runs outside the town (someone's Claude Code session) and reaches it only
 * through authenticated agent calls (MCP tools, `/api/verbs/*`). Every such call `touch`es the agent: `lastSeenAt`
 * is written at most every 10 s. The runtime's presence tick (`sweep`, every 30 s) marks visitors with no call in
 * the last 90 s `offline` and sends their bodies home (desk or the Town Hall visitor bench). The next call from an
 * offline visitor is the "back" transition: status idle (working while it holds an active assignment), an
 * `agent.status` event "<name> is back", and a mailbox digest for its next `look`. Residents are never offline.
 *
 * Assignments to visitors are offers (`offered: true`): never scheduled; `accept_assignment` takes one. Offers left
 * for 24 h are cancelled by `expireOffers` with a note in the building's in-tray.
 */
import type { Agent, Assignment, MailboxDigest, Mailbox, Tile } from "@muster-town/schema";
import { createDoc, setAssignmentStatus } from "./domain.ts";
import { nowIso } from "./util.ts";
import type { World } from "./world.ts";

export const STAMP_EVERY_MS = 10_000;
export const OFFLINE_AFTER_MS = 90_000;
export const PRESENCE_TICK_MS = 30_000;
export const OFFER_TTL_MS = 24 * 3_600_000;

/** Statuses the offline sweep leaves alone. */
const KEEP = new Set(["offline", "stopped", "banned", "retired", "walking"]);

export interface TouchResult { agent: Agent; back: boolean; offlineSince?: string }

export class Presence {
  /** last `lastSeenAt` write per agent (ms), so we write at most every STAMP_EVERY_MS */
  private stamped = new Map<string, number>();
  /** the most recent offline window per visitor; `fresh` until a `look` has shown it */
  private windows = new Map<string, { since: string; until: string; fresh: boolean }>();

  constructor(private world: World) {}

  /**
   * An authenticated agent call (MCP tool call or `/api/verbs/*`). Stamps `lastSeenAt` (throttled) and, for an
   * offline visitor, runs the "back" transition. Unknown agents are ignored.
   */
  touch(agentId: string, at: Date = new Date()): TouchResult | null {
    const w = this.world;
    const a = w.agents.get(agentId);
    if (!a) return null;
    const t = at.getTime();
    const iso = at.toISOString();
    if (a.status === "offline") {
      const since = a.lastSeenAt ?? a.createdAt;
      this.windows.set(a.id, { since, until: iso, fresh: true });
      this.stamped.set(a.id, t);
      const holding = !!w.assignments.count("agentId = ? AND status = 'active'", [a.id]);
      w.agents.upsert({ ...a, lastSeenAt: iso }, { silent: true });
      const agent = w.setStatus(a.id, holding ? "working" : "idle", `${a.name} is back`);
      return { agent, back: true, offlineSince: since };
    }
    const last = this.stamped.get(a.id) ?? (a.lastSeenAt ? Date.parse(a.lastSeenAt) : 0);
    if (t - last < STAMP_EVERY_MS) return { agent: a, back: false };
    this.stamped.set(a.id, t);
    // silent: no WS churn every 10 s; the offline transition broadcasts the agent with its final lastSeenAt
    return { agent: w.agents.upsert({ ...a, lastSeenAt: iso }, { silent: true }), back: false };
  }

  /** Presence tick: visitors quiet for OFFLINE_AFTER_MS go offline and their bodies go home. Returns their ids. */
  sweep(at: Date = new Date()): string[] {
    const w = this.world;
    const t = at.getTime();
    const out: string[] = [];
    for (const a of w.agents.where("kind = 'visitor'")) {
      if (KEEP.has(a.status)) continue;
      const seen = Math.max(this.stamped.get(a.id) ?? 0, Date.parse(a.lastSeenAt ?? a.createdAt));
      if (t - seen < OFFLINE_AFTER_MS) continue;
      w.movement.cancel(a.id, "Went offline.");
      const home = this.homeSpot(a);
      const lastSeenAt = a.lastSeenAt ?? a.createdAt;
      // body back at its desk/bench (teleport: nobody is driving it), then the status change broadcasts it
      w.agents.upsert({ ...a, lastSeenAt, pos: home, buildingId: w.layout.buildingAt(home)?.id ?? null }, { silent: true });
      w.setStatus(a.id, "offline", `${a.name} went offline`);
      out.push(a.id);
    }
    return out;
  }

  /** Where a visitor sits: its desk (registered into a building), else a seat at the Town Hall visitor bench. */
  homeSpot(a: Agent): Tile {
    const desk = this.world.layout.deskOf(a.id);
    if (desk) return { ...desk.pos };
    return this.benchSeat(a.id);
  }

  /** First visitor-bench seat (the place tile, then the one right of it) no other body occupies; the place tile when both are taken. */
  benchSeat(agentId: string): Tile {
    const w = this.world;
    const bench = w.layout.place("visitor-bench");
    if (!bench) return w.layout.place("plaza")?.pos ?? { x: 1, y: 1 };
    const taken = new Set(w.agents.where("status NOT IN ('retired','banned') AND id != ?", [agentId]).map((o) => `${o.pos.x},${o.pos.y}`));
    for (const p of [bench.pos, { x: bench.pos.x + 1, y: bench.pos.y }]) {
      if (w.layout.isWalkable(p.x, p.y) && !taken.has(`${p.x},${p.y}`)) return { ...p };
    }
    return { ...bench.pos };
  }

  /** What arrived for the agent between `since` and `until` (default now). */
  digest(agentId: string, since: string, until: string = nowIso()): MailboxDigest {
    const w = this.world;
    const a = w.agents.require(agentId, "agent");
    const n = (sql: string, p: unknown[]) => (w.db.prepare(sql).get(...p) as { n: number }).n;
    const messages = n("SELECT COUNT(*) AS n FROM messages WHERE toId = ? AND createdAt >= ? AND createdAt <= ?", [a.id, since, until]);
    const mentions = n("SELECT COUNT(*) AS n FROM messages WHERE toId = ? AND kind = 'mention' AND createdAt >= ? AND createdAt <= ?", [a.id, since, until]);
    const assignmentsOffered = n("SELECT COUNT(*) AS n FROM assignments WHERE agentId = ? AND offered = 1 AND createdAt >= ? AND createdAt <= ?", [a.id, since, until]);
    const home = a.homeBuildingId;
    const meetingsMissed = w.meetings.where(
      "endedAt IS NOT NULL AND endedAt >= ? AND endedAt <= ? AND phase = 'done' AND ((buildingId IS NOT NULL AND buildingId = ?) OR attendeeIds LIKE ?)",
      [since, until, home ?? "-", `%"${a.id}"%`], "ORDER BY endedAt",
    ).map((m) => ({ id: m.id, title: m.title, notesDocId: m.notesDocId }));
    return { offlineSince: since, messages, mentions, assignmentsOffered, meetingsMissed };
  }

  /** For `look`: the digest of the offline window that just ended, once. */
  takeDigest(agentId: string): MailboxDigest | null {
    const win = this.windows.get(agentId);
    if (!win?.fresh) return null;
    win.fresh = false;
    return this.digest(agentId, win.since, win.until);
  }

  /**
   * For `GET /api/agents/me/digest`: the last offline window's digest (not consumed), or since `since` when given.
   * Null when the agent has not been offline since this server started and no `since` was given.
   */
  lastDigest(agentId: string, since?: string): MailboxDigest | null {
    if (since) return this.digest(agentId, since);
    const win = this.windows.get(agentId);
    return win ? this.digest(agentId, win.since, win.until) : null;
  }

  /** Unread inbox messages, unread mentions, open offers (agent panel). */
  mailbox(agentId: string): Mailbox {
    const w = this.world;
    return {
      unread: w.messages.count("toId = ? AND readAt IS NULL", [agentId]),
      mentions: w.messages.count("toId = ? AND readAt IS NULL AND kind = 'mention'", [agentId]),
      offered: w.assignments.count("agentId = ? AND status = 'pending' AND offered = 1", [agentId]),
    };
  }

  /**
   * Offers older than OFFER_TTL_MS are cancelled, each with a note in its building's in-tray ("<visitor> didn't pick
   * up: <title>"; a pending report, so the manager can acknowledge it or redirect it to offer the work again).
   */
  expireOffers(at: Date = new Date()): Assignment[] {
    const w = this.world;
    const cutoff = new Date(at.getTime() - OFFER_TTL_MS).toISOString();
    const out: Assignment[] = [];
    for (const a of w.assignments.where("status = 'pending' AND offered = 1 AND createdAt <= ?", [cutoff], "ORDER BY createdAt")) {
      const agent = w.agents.get(a.agentId);
      const name = agent?.name ?? a.agentId;
      w.transaction(() => {
        const cancelled = setAssignmentStatus(w, a.id, "cancelled");
        createDoc(w, {
          type: "report", state: "building", decision: "pending", buildingId: a.buildingId,
          authorId: a.agentId, authorKind: "agent", assignmentId: a.id, tags: ["offer-expired"],
          title: `${name} didn't pick up: ${a.title}`,
          body: [
            `Written by the town, not by ${name}: this assignment was offered to ${name} (a visitor) on ${a.createdAt.slice(0, 16).replace("T", " ")} UTC and nobody accepted it within 24 hours, so the offer was cancelled.`,
            `## Summary\n\nOffer expired: ${a.title}`,
            `## The offer\n\n${a.description}`,
            `## Proposal for next session\n\n${a.title}`,
            "Acknowledge to drop it, Continue to offer it again, or Redirect it with a note.",
          ].join("\n\n"),
        }, `${name} didn't pick up: ${a.title}`);
        out.push(cancelled);
      });
    }
    return out;
  }
}
