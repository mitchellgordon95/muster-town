import type { BankInput, FunderSessionLine, FunderStreamLine, FunderWeek, Session } from "@muster-town/schema";
import { adjustedOfUsage } from "./bank.ts";
import type { World } from "./world.ts";

/**
 * The funder filter (docs/goals.md "Funder attribution: one deck, two filters", goal tree build step 8; go-ahead in 1:1
 * mt_cz11aqe81a): what one funder's money bought over a window, read from session rows and the Bank's inputs and credits.
 * Nothing here books, draws or writes; it reads which credential each session ran on (step 7's `credentialInputId`).
 *
 * Every session in the window is either
 *   - **literal**: it ran on a donated api-key input (general or an earmark), or on a grant funded from a member's own
 *     input (`fundedWith`): it belongs to that input's donor, whole;
 *   - **pooled**: it ran on no donated key (a subscription, or nothing recorded): each subscription donor owns a pro rata
 *     share of it, their subscription credits in the window ÷ everyone's.
 */

const DAY = 86_400_000;
const PURPOSE: Record<Session["purpose"], string> = { work: "work session", manage: "manager session", review: "review session", facilitate: "meeting facilitation", summary: "meeting summary", "meeting-reply": "meeting reply" };

interface Attribution {
  from: string; to: string;
  /** the funder's inputs, oldest first */
  inputs: BankInput[];
  /** literal sessions: the funder's input each ran on */
  literal: { s: Session; inputId: string }[];
  pooled: Session[];
  share: number; yourCredited: number; poolCredited: number;
  creditedBy: Map<string, number>;
}

const at = (s: Session) => s.endedAt ?? s.startedAt;

function attribute(world: World, userId: string, days: number, now: Date): Attribution {
  const to = now.toISOString(), from = new Date(now.getTime() - days * DAY).toISOString();
  const inputs = world.bank.inputsOf(userId);
  const mine = new Set(inputs.map((i) => i.id));
  const keys = world.bank.apiKeyInputIds();
  const fundedWith = new Map(world.grants.where("fundedWith IS NOT NULL").map((g) => [g.id, g.fundedWith!]));
  const literal: Attribution["literal"] = [], pooled: Session[] = [];
  for (const s of world.sessions.where("COALESCE(endedAt, startedAt) > ? AND COALESCE(endedAt, startedAt) <= ?", [from, to], "ORDER BY COALESCE(endedAt, startedAt), rowid")) {
    const cred = s.credentialInputId ?? null;
    const grantInput = s.grantId ? fundedWith.get(s.grantId) ?? null : null;
    if (cred && mine.has(cred) && keys.has(cred)) literal.push({ s, inputId: cred });
    else if (grantInput && mine.has(grantInput)) literal.push({ s, inputId: grantInput });
    if (!cred || !keys.has(cred)) pooled.push(s);
  }
  // the pro rata share: subscription credits only (a key's credits are its own literal story)
  const subs = new Set(world.bank.inputsOfSource("subscription").map((i) => i.id));
  const creditedBy = new Map<string, number>();
  let yourCredited = 0, poolCredited = 0;
  for (const c of world.bank.creditsSince(from)) {
    if (c.createdAt > to) continue;
    creditedBy.set(c.inputId, (creditedBy.get(c.inputId) ?? 0) + c.tokens);
    if (!subs.has(c.inputId)) continue;
    poolCredited += c.tokens;
    if (mine.has(c.inputId)) yourCredited += c.tokens;
  }
  const share = poolCredited > 0 ? yourCredited / poolCredited : 0;
  return { from, to, inputs, literal, pooled, share, yourCredited, poolCredited, creditedBy };
}

/**
 * Per session, the part of it the funder paid (1 = literal, `share` = pooled): the Bank's Spend by goal "Funded by me" filter.
 * A session that is both (a grant funded from the funder's own subscription input) counts whole.
 */
export function funderWeights(world: World, userId: string, days = 7, now = new Date()): Map<string, number> {
  const a = attribute(world, userId, days, now);
  const w = new Map<string, number>();
  if (a.share > 0) for (const s of a.pooled) w.set(s.id, a.share);
  for (const { s } of a.literal) w.set(s.id, 1);
  return w;
}

function line(world: World, s: Session, tokens: number, inputId: string | null): FunderSessionLine {
  const asg = s.assignmentId ? world.assignments.get(s.assignmentId) : undefined;
  const agent = world.agents.get(s.agentId);
  const buildingId = asg?.buildingId ?? agent?.homeBuildingId ?? agent?.buildingId ?? null;
  const grant = (s.grantId ?? asg?.grantId) ? world.grants.get((s.grantId ?? asg?.grantId)!) : undefined;
  const krId = grant?.keyResultId ?? asg?.keyResultId ?? null;
  const kr = krId ? world.keyResults.get(krId) : undefined;
  const reportId = s.reportId ?? asg?.reportId ?? null;
  return {
    sessionId: s.id, at: at(s), purpose: s.purpose, tokens: Math.round(tokens), assignmentId: asg?.id ?? null,
    title: asg?.title ?? `${agent?.name ?? s.agentId}: ${PURPOSE[s.purpose] ?? s.purpose}`,
    buildingId, buildingName: buildingId ? world.buildings.get(buildingId)?.name ?? buildingId : null,
    goalId: buildingId ? world.streams.nodeOf(asg, buildingId) : null, keyResultId: kr?.id ?? null, keyResultText: kr?.text ?? null,
    reportId, reportTitle: reportId ? world.docs.get(reportId)?.title ?? null : null, inputId,
  };
}

/** GET /api/funders/:userId/week: one funder's window (default 7 days), the literal story and the pro rata story. */
export function funderWeek(world: World, userId: string, days = 7, now = new Date()): FunderWeek {
  const user = world.users.require(userId, "user");
  const a = attribute(world, userId, days, now);
  const tok = (s: Session) => adjustedOfUsage(s.model, s, s.byModel);
  const literal = a.literal.map(({ s, inputId }) => line(world, s, tok(s), inputId)).reverse();
  const streams: FunderStreamLine[] = a.inputs.map((i) => {
    const mineLines = literal.filter((l) => l.inputId === i.id);
    return {
      inputId: i.id, label: i.label, source: i.source, story: i.source === "subscription" ? "pro-rata" as const : "literal" as const,
      goalId: i.goalId ?? null, goalPath: i.goalId && world.goalTree.get(i.goalId) ? world.goalTree.pathText(i.goalId, 40) : null,
      balance: world.bank.inputBalance(i.id, now), cancelledAt: i.cancelledAt, creditedTokens: a.creditedBy.get(i.id) ?? 0,
      sessions: mineLines.length, tokens: mineLines.reduce((n, l) => n + l.tokens, 0),
    };
  }).filter((x) => !x.cancelledAt || x.sessions || x.creditedTokens || x.balance);
  const poolTokens = a.pooled.reduce((n, s) => n + tok(s), 0);
  const byAsg = new Map<string, FunderSessionLine>();
  if (a.share > 0) for (const s of a.pooled) {
    const l = line(world, s, tok(s) * a.share, null);
    const k = l.assignmentId ?? `${l.buildingId}:${s.purpose}`;
    const cur = byAsg.get(k);
    if (cur) { cur.tokens += l.tokens; if (l.at > cur.at) { cur.at = l.at; cur.sessionId = l.sessionId; } cur.reportId ??= l.reportId; cur.reportTitle ??= l.reportTitle; }
    else byAsg.set(k, l.assignmentId ? l : { ...l, title: `${l.buildingName ?? "Town"}: ${PURPOSE[s.purpose] ?? s.purpose}s` });
  }
  // the goals the money reached: each earmark's subtree, and the goal of each literal session
  const goals = new Set<string>();
  for (const i of a.inputs) if (i.goalId && !i.cancelledAt && world.goalTree.get(i.goalId)) for (const g of world.goalTree.subtreeIds(i.goalId)) goals.add(g);
  for (const l of literal) if (l.goalId) goals.add(l.goalId);
  return {
    userId, userName: user.name, days, from: a.from, to: a.to, streams,
    literal: { tokens: literal.reduce((n, l) => n + l.tokens, 0), sessions: literal },
    proRata: {
      share: a.share, yourCreditedTokens: a.yourCredited, poolCreditedTokens: a.poolCredited, poolSessions: a.pooled.length,
      poolTokens: Math.round(poolTokens), tokens: Math.round(poolTokens * a.share),
      byAssignment: [...byAsg.values()].sort((x, y) => y.tokens - x.tokens),
    },
    goalIds: [...goals], everything: a.share > 0,
  };
}
