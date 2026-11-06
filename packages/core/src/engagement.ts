/**
 * Community engagement in one collective (Mitchell's flag dc_r7u6bkaei4): per UTC day over the last 30, what its signed-in
 * humans did here, read from its own event log, docs and join funnel. Counts only, never who: the reply carries no user or
 * agent id. GET <prefix>/api/engagement serves it, public; the User stats stand shows it first, for this collective only.
 * - humans: distinct signed-in humans who walked, spoke or decided anything that day (a human who only watches leaves no event)
 * - spoke: a human's say, tell or meeting line
 * - oneOnOnes: 1:1s a human opened with an agent
 * - flags: flags humans planted
 * - decisions: a human's decision on a report or flag, a grant (fund, counter, reject, continue, adjust, cut, stop),
 *   a retainer or a goal proposal
 * - asked, letIn, declined, acted: this collective's own join steps (join_funnel)
 */
import { FUNNEL_DAYS, joinFunnel } from "./join-funnel.ts";
import type { World } from "./world.ts";

const ENGAGEMENT_STEPS = ["humans", "spoke", "oneOnOnes", "flags", "decisions", "asked", "letIn", "declined", "acted"] as const;
type EngagementStep = (typeof ENGAGEMENT_STEPS)[number];
type EngagementCounts = Record<EngagementStep, number>;
interface EngagementDay extends EngagementCounts { day: string }
interface Engagement { days: number; from: string; to: string; daily: EngagementDay[]; totals: EngagementCounts; medianDecisionMs: number | null }

const DAY_MS = 86_400_000;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** The event types a human's own avatar posts when it decides something. */
const DECISION_TYPES = ["grant.funded", "grant.countered", "grant.rejected", "grant.closed", "retainer.decided", "goal.proposal"];
const zero = (): EngagementCounts => Object.fromEntries(ENGAGEMENT_STEPS.map((s) => [s, 0])) as EngagementCounts;

/** The last `days` UTC days (today included): one row per day with any count, newest last, and the totals. */
export function engagement(world: World, days = FUNNEL_DAYS, now = Date.now()): Engagement {
  const to = utcDay(now), from = utcDay(now - (days - 1) * DAY_MS);
  const since = `${from}T00:00:00.000Z`;
  const db = world.db;
  const rows = new Map<string, EngagementDay>();
  const row = (day: string) => { let r = rows.get(day); if (!r) rows.set(day, r = { day, ...zero() }); return r; };
  const active = new Map<string, Set<string>>();
  const seen = (day: string, who: string) => { let s = active.get(day); if (!s) active.set(day, s = new Set()); s.add(who); };

  // a human acts through its avatar (kind "human"): every event it posts is the human's own
  const avatars = db.prepare("SELECT id, ownerUserId FROM agents WHERE kind = 'human'").all() as { id: string; ownerUserId: string | null }[];
  const userOf = new Map(avatars.map((a) => [a.id, a.ownerUserId ?? a.id]));
  const byAvatar = db.prepare("SELECT substr(ts, 1, 10) AS day, type, COUNT(*) AS n FROM events WHERE agentId = ? AND ts >= ? GROUP BY day, type");
  for (const a of avatars) {
    for (const r of byAvatar.all(a.id, since) as { day: string; type: string; n: number }[]) {
      if (r.day > to) continue;
      seen(r.day, userOf.get(a.id)!);
      if (r.type === "agent.said" || r.type === "agent.told") row(r.day).spoke += r.n;
      else if (DECISION_TYPES.includes(r.type)) row(r.day).decisions += r.n;
    }
  }
  // a human's meeting line is posted with no agent (speakerKind "user", speakerId = the user)
  for (const r of db.prepare("SELECT substr(ts, 1, 10) AS day, json_extract(payload, '$.speakerId') AS who FROM events WHERE type = 'meeting.utterance' AND ts >= ? AND json_extract(payload, '$.speakerKind') = 'user'").all(since) as { day: string; who: string }[]) {
    if (r.day > to) continue;
    row(r.day).spoke++;
    seen(r.day, r.who);
  }
  // a report or flag decided by a human (decidedBy is the user)
  for (const r of db.prepare("SELECT substr(ts, 1, 10) AS day, json_extract(payload, '$.decidedBy') AS who FROM events WHERE type = 'doc.decision' AND ts >= ? AND json_extract(payload, '$.decidedBy') LIKE 'us\\_%' ESCAPE '\\'").all(since) as { day: string; who: string }[]) {
    if (r.day > to) continue;
    row(r.day).decisions++;
    seen(r.day, r.who);
  }
  for (const r of db.prepare("SELECT substr(ts, 1, 10) AS day, COUNT(*) AS n FROM events WHERE type = 'meeting.created' AND ts >= ? AND json_extract(payload, '$.kind') = 'one-on-one' AND json_extract(payload, '$.by') LIKE 'us\\_%' ESCAPE '\\' GROUP BY day").all(since) as { day: string; n: number }[]) {
    if (r.day <= to) row(r.day).oneOnOnes += r.n;
  }
  for (const r of db.prepare("SELECT substr(createdAt, 1, 10) AS day, COUNT(*) AS n FROM docs WHERE type = 'flag' AND createdAt >= ? GROUP BY day").all(since) as { day: string; n: number }[]) {
    if (r.day <= to) row(r.day).flags += r.n;
  }
  for (const [day, who] of active) row(day).humans = who.size;
  // this collective's own join steps
  const funnel = joinFunnel(world, days, now);
  for (const d of funnel.daily) {
    if (!(d.asked || d.letIn || d.declined || d.acted)) continue;
    const r = row(d.day);
    r.asked = d.asked; r.letIn = d.letIn; r.declined = d.declined; r.acted = d.acted;
  }

  const daily = [...rows.values()].sort((a, b) => a.day.localeCompare(b.day));
  const totals = Object.fromEntries(ENGAGEMENT_STEPS.map((s) => [s, daily.reduce((n, d) => n + d[s], 0)])) as EngagementCounts;
  // humans over the window: distinct people, not the sum of the days
  totals.humans = new Set([...active.values()].flatMap((s) => [...s])).size;
  return { days, from, to, daily, totals, medianDecisionMs: funnel.medianDecisionMs };
}
