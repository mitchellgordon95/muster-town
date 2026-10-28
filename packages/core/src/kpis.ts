import { KPI_FRAMING, type Kpi, type KpiKey, type KpiView } from "@muster-town/schema";
import type { World } from "./world.ts";

/**
 * The town KPIs (docs/goal-directed-budgets.md "Objectives and KPIs"): Fund, Join and Trust, standing indicators that
 * are never met or missed. Each value is computed live from town data for a 7-day window, never typed in. "The owner"
 * is every user holding a town-scope admin role: what they do doesn't count, since the KPIs measure strangers.
 */
export const KPI_WEEKS = 8;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
/** Join: a newcomer counts once they are active again on a later day within this many days of their first activity. */
export const JOIN_RETURN_DAYS = 14;

interface Window { from: string; to: string }
interface Week { value: number; detail: string }

/** GET /api/kpis: the framing and every town KPI with this week, last week and the last KPI_WEEKS weeks (oldest first). */
export function townKpis(world: World, now = Date.now()): { framing: string; kpis: KpiView[] } {
  const windows: Window[] = Array.from({ length: KPI_WEEKS }, (_, i) => {
    const end = now - (KPI_WEEKS - 1 - i) * WEEK;
    return { from: new Date(end - WEEK).toISOString(), to: new Date(end).toISOString() };
  });
  const owner = ownerCheck(world);
  const kpis = world.kpis.all().sort((a, b) => a.position - b.position).map((k): KpiView => {
    const weeks = windows.map((w) => measure(world, k.key, w, owner));
    const last = weeks[weeks.length - 1], prev = weeks[weeks.length - 2];
    return { ...k, thisWeek: last.value, lastWeek: prev?.value ?? 0, weeks: weeks.map((w) => w.value), detail: last.detail };
  });
  return { framing: KPI_FRAMING, kpis };
}

/** The KPI an objective moves, by key (null if the town has none by that key). */
export function kpiByKey(world: World, key: KpiKey): Kpi | null {
  return world.kpis.first("key = ?", [key]) ?? null;
}

function ownerCheck(world: World): (userId: string | null | undefined) => boolean {
  const memo = new Map<string, boolean>();
  return (id) => {
    if (!id) return true; // the system acted: not a stranger
    if (!memo.has(id)) memo.set(id, world.users.get(id) ? world.permissions.isAdmin({ kind: "user", id }) : true);
    return memo.get(id)!;
  };
}

function measure(world: World, key: KpiKey, w: Window, isOwner: (id: string | null | undefined) => boolean): Week {
  if (key === "fund") return fund(world, w, isOwner);
  if (key === "join") return join(world, w, isOwner);
  return trust(world, w, isOwner);
}

/** Fund: distinct non-owner humans who funded a grant or added a Bank input in the window, and the tokens they put in. */
function fund(world: World, w: Window, isOwner: (id: string | null | undefined) => boolean): Week {
  const grants = world.grants.where("fundedAt >= ? AND fundedAt < ? AND fundedBy IS NOT NULL", [w.from, w.to]).filter((g) => !isOwner(g.fundedBy));
  const inputs = (world.db.prepare("SELECT userId FROM bank_inputs WHERE createdAt >= ? AND createdAt < ?").all(w.from, w.to) as { userId: string }[])
    .filter((i) => !isOwner(i.userId));
  const funders = new Set([...grants.map((g) => g.fundedBy!), ...inputs.map((i) => i.userId)]);
  // a grant closed early as done gave back its unspent rest, so it counts what it spent
  const granted = grants.reduce((n, g) => n + (g.outcome === "done" ? Math.min(g.grantTokens ?? 0, world.grantDesk.spent(g.id)) : g.grantTokens ?? 0), 0);
  return {
    value: funders.size,
    detail: `${funders.size} funder${funders.size === 1 ? "" : "s"} other than the owner: ${grants.length} grant${grants.length === 1 ? "" : "s"} funded (${granted.toLocaleString("en-US")} adjusted tokens), ${inputs.length} Bank input${inputs.length === 1 ? "" : "s"} added`,
  };
}

/**
 * Join: non-owner humans whose first activity (their user record, or the first event of an avatar or visitor they own)
 * fell in the window and who were active again on a later day within JOIN_RETURN_DAYS. A fork's events don't count:
 * it copies its manager's ownerUserId, and a ghost doing building-queue work is not its owner coming back.
 */
function join(world: World, w: Window, isOwner: (id: string | null | undefined) => boolean): Week {
  const rows = world.db.prepare(
    `SELECT a.ownerUserId AS userId, substr(e.ts, 1, 10) AS day, MIN(e.ts) AS ts FROM events e JOIN agents a ON a.id = e.agentId
     WHERE a.ownerUserId IS NOT NULL AND a.forkOf IS NULL GROUP BY a.ownerUserId, day`,
  ).all() as { userId: string; day: string; ts: string }[];
  const seen = new Map<string, { day: string; ts: string }[]>();
  for (const r of rows) (seen.get(r.userId) ?? seen.set(r.userId, []).get(r.userId)!).push(r);
  let arrived = 0, returned = 0;
  for (const u of world.users.all()) {
    if (isOwner(u.id)) continue;
    const active = seen.get(u.id) ?? [];
    const firstTs = [u.createdAt, ...active.map((a) => a.ts)].sort()[0];
    if (firstTs < w.from || firstTs >= w.to) continue;
    arrived++;
    const first = firstTs.slice(0, 10);
    const until = new Date(Date.parse(firstTs) + JOIN_RETURN_DAYS * DAY).toISOString().slice(0, 10);
    if (active.some((a) => a.day > first && a.day <= until)) returned++;
  }
  return { value: returned, detail: `${returned} of ${arrived} newcomer${arrived === 1 ? "" : "s"} this week came back on a later day` };
}

/** Trust: distinct non-owner humans who in the window answered an outbox request, or funded a grant having funded one before. */
function trust(world: World, w: Window, isOwner: (id: string | null | undefined) => boolean): Week {
  const answers = world.docs.where("type = 'human-report' AND authorKind = 'user' AND createdAt >= ? AND createdAt < ?", [w.from, w.to]).filter((d) => !isOwner(d.authorId));
  const repeat = world.grants.where("fundedAt >= ? AND fundedAt < ? AND fundedBy IS NOT NULL", [w.from, w.to])
    .filter((g) => !isOwner(g.fundedBy) && world.grants.count("fundedBy = ? AND fundedAt < ?", [g.fundedBy, g.fundedAt]) > 0);
  const people = new Set([...answers.map((d) => d.authorId), ...repeat.map((g) => g.fundedBy!)]);
  return {
    value: people.size,
    detail: `${people.size} human${people.size === 1 ? "" : "s"} other than the owner: ${answers.length} outbox answer${answers.length === 1 ? "" : "s"}, ${repeat.length} repeat grant${repeat.length === 1 ? "" : "s"} funded`,
  };
}
