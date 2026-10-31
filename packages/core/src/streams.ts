import type { Assignment, BankInput, BankStream, BankStreams } from "@muster-town/schema";
import { STREAM_IDLE_DAYS } from "./bank.ts";
import { sendMessage } from "./domain.ts";
import type { World } from "./world.ts";

const DAY_MS = 86_400_000;
const DAYS_PER: Record<BankInput["recurrence"], number | null> = { once: null, daily: 1, weekly: 7, monthly: 30 };

/**
 * Funding streams and the draw order (docs/goals.md "Streams", goal tree build step 7; 1:1 mt_cz11aqe81a). A Bank input
 * is a stream; one with a `goalId` is an earmark: it pays only for sessions whose work sits in that goal's subtree. At
 * session start the Bank picks, in order: the grant's own input (member funding), then the nearest earmark above the
 * session's node (walking up from its key result's goal, else its building's attachment) whose balance covers one
 * expected session, then the general balance. One key per session (1:1 mt_kh0zaqui0w): an earmark too small for a whole
 * session is never picked; it accrues. An earmark with no draw for 7 days tells its donor in town (no email).
 */
export class Streams {
  constructor(private world: World) {}

  /** The goal a session's work sits on, the same attribution as the Bank's Spend by goal: its grant's or named key result's goal, else its building's attachment. */
  nodeOf(a: Pick<Assignment, "buildingId" | "grantId" | "keyResultId"> | null | undefined, buildingId: string): string {
    const grant = a?.grantId ? this.world.grants.get(a.grantId) : undefined;
    const krId = grant?.keyResultId ?? a?.keyResultId ?? null;
    const kr = krId ? this.world.keyResults.get(krId) : undefined;
    if (kr?.goalId && this.world.goalTree.get(kr.goalId)) return kr.goalId;
    return this.world.goalTree.attachmentOf(a?.buildingId ?? buildingId);
  }

  /**
   * The earmark a session on `a` runs on: walking up from its node, the first goal with a live keyed earmark whose
   * balance covers the building's expected session (oldest earmark first at that goal); null = the general balance.
   */
  pick(a: Pick<Assignment, "buildingId" | "grantId" | "keyResultId"> | null | undefined, buildingId: string, now = new Date()): BankInput | null {
    const bank = this.world.bank;
    const need = bank.expectedSession(buildingId, now).tokens;
    for (const g of this.world.goalTree.ancestors(this.nodeOf(a, buildingId))) {
      for (const inp of bank.earmarksFor(g.id)) if (bank.inputBalance(inp.id, now) >= need) return inp;
    }
    return null;
  }

  /** GET /api/bank/streams: every live input (and cancelled earmarks), newest first, with what it can still pay. */
  list(now = new Date()): BankStreams {
    const bank = this.world.bank;
    const expected = bank.expectedSession(null, now);
    const rows = bank.streamInputs();
    return { expectedSessionTokens: expected.tokens, sampleSessions: expected.sample, idleDays: STREAM_IDLE_DAYS, streams: rows.map((i) => this.view(i, expected.tokens, now)) };
  }

  private view(i: BankInput, need: number, now: Date): BankStream {
    const balance = this.world.bank.inputBalance(i.id, now);
    const per = DAYS_PER[i.recurrence];
    const short = Math.max(0, need - balance);
    const lastDrawAt = this.world.bank.lastDrawAt(i.id);
    return {
      inputId: i.id, label: i.label, userId: i.userId, userName: this.world.users.get(i.userId)?.name ?? i.userId, source: i.source,
      recurrence: i.recurrence, tokens: i.tokens, goalId: i.goalId ?? null, goalPath: i.goalId ? this.world.goalTree.pathText(i.goalId, 40) : null,
      balance, coversSession: balance >= need,
      daysToCover: short > 0 && per && !i.cancelledAt ? Math.ceil(short / i.tokens) * per : null,
      lastDrawAt, idle: i.goalId && !i.cancelledAt ? this.idleReason(i, balance >= need, lastDrawAt, now) : null,
      cancelledAt: i.cancelledAt, createdAt: i.createdAt,
    };
  }

  /** An earmark idle for 7 days (no draw since, and at least 7 days old): why; null when it was drawn lately. */
  private idleReason(i: BankInput, covers: boolean, lastDrawAt: string | null, now: Date): BankStream["idle"] {
    const since = now.getTime() - STREAM_IDLE_DAYS * DAY_MS;
    if (Date.parse(lastDrawAt ?? i.createdAt) > since) return null;
    return covers ? "no-session-in-scope" : "below-one-session";
  }

  /**
   * The runtime tick: tell the donor of each earmark with no draw for 7 days, once per 7 days, by an in-town message to
   * their avatar (the server sends no email or SMS: 1:1 mt_kh0zaqui0w, c45eaeb). Returns how many were told.
   */
  tick(now = new Date()): number {
    const need = this.world.bank.expectedSession(null, now).tokens;
    let told = 0;
    for (const i of this.world.bank.earmarks()) {
      if (i.cancelledAt) continue;
      if (i.idleNotifiedAt && Date.parse(i.idleNotifiedAt) > now.getTime() - STREAM_IDLE_DAYS * DAY_MS) continue;
      const balance = this.world.bank.inputBalance(i.id, now);
      const why = this.idleReason(i, balance >= need, this.world.bank.lastDrawAt(i.id), now);
      if (!why) continue;
      this.world.bank.setIdleNotified(i.id, now.toISOString());
      const goal = i.goalId ? this.world.goalTree.get(i.goalId)?.text ?? i.goalId : "";
      const reason = why === "below-one-session"
        ? `its balance (${fmt(balance)} adj. tokens) is below one session (${fmt(need)}, the p90 of recent work sessions), so it is accruing`
        : `no session under "${goal}" has run on it`;
      const body = `No session has run on your Bank stream "${i.label}" (earmarked for "${goal}") for ${STREAM_IDLE_DAYS} days: ${reason}. Nothing is lost; you can keep it, earmark a new one higher up the goal tree, or cancel it at the Bank.`;
      const avatar = this.world.agents.first("kind = 'human' AND ownerUserId = ?", [i.userId]);
      if (avatar) sendMessage(this.world, { kind: "system", fromId: "system", fromKind: "system", toId: avatar.id, body });
      this.world.events.append({ type: "bank.input", text: `${i.label} (earmark) had no draw for ${STREAM_IDLE_DAYS} days; its donor was told`, payload: { inputId: i.id, userId: i.userId, goalId: i.goalId, idle: why, notified: !!avatar } });
      told++;
    }
    return told;
  }
}

const fmt = (n: number) => n.toLocaleString("en-US");
