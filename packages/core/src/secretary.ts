/**
 * The Secretary (grant gr_kdlogzzo5s, design dc_8gbluwrdgi; town hall mt_v09cn7a8yr decision 3): a Town Hall resident
 * beside the Planner (who stays its manager) that keeps the humans' in-tray digestible. Mitchell: "can i get a secretary
 * resident in the town hall to help me with the intray? … rolling up the rollups into something more digestable".
 *
 * The digest card: "Decisions needed" is assembled here in code from the same data as the review deck (checkpoints,
 * proposals, goal proposals, captain asks, retainer asks, rollup calls; open outbox requests as one "Asked of you" line),
 * as yes/no lines. "Shipped since last digest" is written by the Secretary's run (a cheap-model session on a daily
 * retainer schedule it takes itself, `takerId`): one line per Shipped item of every rollup filed since the last digest.
 * `fileDigest` files the card (doc type `digest` in the Town Hall, the covered rollups in provenance) and archives those
 * rollups that ask nothing (every call None), so they leave the in-tray's main list and stay one click away under the
 * card; a rollup with a real "Your call" stays pending (its call is a "Decisions needed" line until a human decides it). At most one card per UTC day,
 * and only when a new rollup arrived: otherwise the due run is skipped before any session (`digestIdleReason`).
 */
import { isNoCall, NOT_GONE, parseRollup, Agent, type Doc, type GrantView, type Meeting, type Schedule } from "@muster-town/schema";
import { archiveReport } from "./archive.ts";
import { createDoc, grantsAwaitingDecision, townHallIntray } from "./domain.ts";
import { AppError, badRequest } from "./errors.ts";
import { newId, nowIso } from "./util.ts";
import { TOWN_HALL_ID } from "./world/layout.ts";
import { createSchedule } from "./schedules.ts";
import type { World } from "./world.ts";

const SECRETARY_TITLE = "Secretary";
/** One digest run on the Town Hall's cheapModel reads 3-6 rollups and writes a handful of lines: est. 10,000 Bank tokens. */
export const DIGEST_TOKENS_PER_RUN = 10_000;
/** The daily run (UTC): before Mitchell's morning. */
const DIGEST_AT = "07:00";
const DIGEST_SCHEDULE_TITLE = "Daily in-tray digest";
/** A Shipped line: at most this many words (the run is asked for ≤ 20; a few more pass, a paragraph does not). */
const MAX_LINE_WORDS = 30;

const DIRECTION = "Keep the humans' Town Hall in-tray digestible: a daily digest card of what needs their yes or no and what shipped, and a 1:1 that acts only on what the human said.";

const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
const oneLine = (s: string, max = 140) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
const utcDay = (iso: string | Date) => new Date(iso).toISOString().slice(0, 10);

/** The run's instructions: the schedule's description, so each fired assignment carries them. */
const DIGEST_RUN_PROMPT = `Write today's in-tray digest card for the humans (you are the Secretary; grant gr_kdlogzzo5s).
1. Call \`digest\` with no arguments. It returns the "Decisions needed" lines (built in code: leave them as they are) and every rollup filed since the last digest, each Shipped item with its id, title, what it is, what you'd see and its first picture. If it says there is nothing to digest, submit_report at once (verdict stop) and end.
2. For every Shipped item write one plain line of at most 20 words: what a human would now see or can now do. No ids, no jargon, no "Your call". Keep its picture (the src it gave) when it has one.
3. Call \`digest\` with \`shipped\`: one entry per item, {rollupId, line, picture?}. It files the card first in the Town Hall in-tray and archives the covered rollups under it.
4. submit_report (verdict stop): the digest doc id and how many rollups it covered. Nothing else: don't read other docs, don't write pages.`;

/** The Secretary's 1:1 prompt (it answers 1:1s like the Planner; manage.ts appends it to the brief). */
const ONE_ON_ONE = `You are the Secretary, a resident of the Town Hall beside the Planner (the Town Hall's manager). Your job is to keep the human's Town Hall in-tray digestible. In this 1:1, answer from the in-tray as it is now (the \`digest\` tool with no arguments lists what needs a yes or no and what shipped since the last digest card). Act only on what the human said in this 1:1, never on your own judgment: use \`act_in_1on1\` if available, citing their words; without it, say which button in the Town Hall in-tray does it. You never fund, stop or approve anything yourself.`;

export class Secretary {
  constructor(private world: World) {}

  /** The Secretary, if it has been created. */
  agent(): Agent | undefined {
    return this.world.agents.first(`homeBuildingId = ? AND kind = 'resident' AND title = ? AND forkOf IS NULL AND ${NOT_GONE}`, [TOWN_HALL_ID, SECRETARY_TITLE], "ORDER BY createdAt");
  }

  isSecretary(a: Agent | null | undefined): boolean {
    const s = a ? this.agent() : undefined;
    return !!s && (a!.id === s.id || a!.forkOf === s.id);
  }

  /**
   * The Secretary, created on first call (server boot, after the seed): a Town Hall resident at a free desk there (else
   * by the door). Not the manager (the Planner stays it) and no role: it acts on decisions only with the human as actor.
   * A stopped Secretary stays stopped (a human stopped it on purpose).
   */
  ensure(): Agent | null {
    const have = this.agent();
    if (have) return have;
    const th = this.world.buildings.get(TOWN_HALL_ID);
    if (!th) return null;
    return this.world.transaction(() => {
      const id = newId("ag");
      this.world.agents.upsert(Agent.parse({
        id, name: SECRETARY_TITLE, kind: "resident", buildingId: th.id, homeBuildingId: th.id, ownerUserId: th.createdBy ?? null,
        title: SECRETARY_TITLE, sprite: 6, direction: DIRECTION, pos: this.world.layout.door(th.id) ?? { x: 0, y: 0 }, status: "idle", createdAt: nowIso(),
      }), { silent: true });
      let agent = this.world.agents.require(id, "agent");
      try { agent = this.world.agents.patch(id, { pos: this.world.layout.claimDesk(th.id, id).pos }); }
      catch (e) { if (!(e instanceof AppError) || e.code !== "conflict") throw e; }
      this.world.events.append({ type: "agent.created", agentId: id, buildingId: th.id, text: `${agent.name} joined the Town Hall (keeps the in-tray digestible)`, payload: { kind: "resident", secretary: true } });
      return agent;
    });
  }

  /**
   * The daily digest schedule, made once: on the Town Hall, taken by the Secretary, on a retainer of
   * DIGEST_TOKENS_PER_RUN per run (asked in the Town Hall in-tray: its runs start once a human approves), on the Town
   * Hall's cheapModel. Never made again once any schedule of the Secretary's exists (ended or rejected included).
   */
  ensureDigestSchedule(at: Date = new Date()): Schedule | null {
    const sec = this.agent();
    const th = this.world.buildings.get(TOWN_HALL_ID);
    if (!sec || !th) return null;
    const had = this.world.schedules.first("takerId = ?", [sec.id], "ORDER BY createdAt");
    if (had) return had;
    return createSchedule(this.world, th.id, { kind: "agent", id: sec.id }, {
      title: DIGEST_SCHEDULE_TITLE, description: DIGEST_RUN_PROMPT, repeat: { dailyAt: [DIGEST_AT] },
      tokensPerRun: DIGEST_TOKENS_PER_RUN, takerId: sec.id, model: th.cheapModel,
      gap: "Mitchell's in-tray needs a daily digest card (town hall mt_v09cn7a8yr decision 3, grant gr_kdlogzzo5s)",
    }, null, at);
  }

  /** The Secretary's part of a 1:1 prompt (null when the 1:1 is with anyone else). */
  brief(m: Meeting): string | null {
    const s = this.agent();
    if (!s || m.facilitatorId !== s.id) return null;
    const { decisions, askedOfYou } = digestDecisions(this.world);
    // act_in_1on1 (step 1, PR #300) cites a human line by its exact ISO `at` and refuses lines older than 30 min
    const since = Date.now() - 30 * 60_000;
    const said = m.transcript.filter((u) => u.speakerId === m.withUserId && Date.parse(u.at) >= since)
      .map((u) => `- at ${u.at}: "${oneLine(u.text, 300)}"`).join("\n");
    return `${ONE_ON_ONE}\n\nThe human's lines from the last 30 min (cite one by its exact \`at\` as utteranceAt; for anything newer read \`meeting\` status):\n${said || "(none)"}\n\nDecisions needed now:\n${decisions.map((l) => `- ${l}`).join("\n") || "(none)"}${askedOfYou ? `\n\n${askedOfYou}` : ""}`;
  }
}

// ---- the digest ----

/** The newest digest card, if any. */
function lastDigest(world: World): Doc | undefined {
  return world.docs.first("type = 'digest' AND buildingId = ?", [TOWN_HALL_ID], "ORDER BY createdAt DESC, rowid DESC");
}

/** Rollups filed since `since` (every one when null), oldest first, decided or not. */
function rollupsSince(world: World, since: string | null): Doc[] {
  return world.docs.where(`type = 'report' AND tags LIKE '%"rollup"%'${since ? " AND createdAt > ?" : ""}`, since ? [since] : [], "ORDER BY createdAt, rowid")
    .filter((d) => d.tags.includes("rollup"));
}

/** Why a digest run now has nothing to do (null = it has): a card was filed today (UTC), or no rollup arrived since the last. */
export function digestIdleReason(world: World, at: Date = new Date()): string | null {
  const last = lastDigest(world);
  if (last && utcDay(last.createdAt) === utcDay(at)) return "a digest was already filed today";
  return rollupsSince(world, last?.createdAt ?? null).length ? null : "no new rollup since the last digest";
}

/** A checkpoint's or proposal's yes/no line. */
function grantLine(world: World, g: GrantView): string {
  const b = world.buildings.get(g.buildingId)?.name ?? g.buildingId;
  const what = `${b}: "${oneLine(g.objective, 90)}"`;
  if (g.status === "checkpoint") {
    const spent = `spent ${fmt(g.spentTokens)} of ${fmt(g.grantTokens ?? 0)}`;
    const buys = g.whatTopUpBuys ? `; a top-up buys: ${oneLine(g.whatTopUpBuys, 120)}` : "";
    return g.topUpTokens
      ? `Continue ${g.id} (${what}) with a ${fmt(g.topUpTokens)} top-up (${spent}${buys})?`
      : `Continue ${g.id} (${what}) (${spent}${buys})?`;
  }
  return `Fund ${g.id} (${what}) at its ${fmt(g.askTokens)} ask?`;
}

/**
 * "Decisions needed" as yes/no lines, from the data the review deck reads (checkpoints first, then proposals, goal
 * proposals, captain asks, retainer asks, then rollups' real "Your call"s), and open outbox requests as one "Asked of
 * you" line (they are errands in the world, not yes/no). Zero tokens, current at every read.
 */
export function digestDecisions(world: World): { decisions: string[]; askedOfYou: string | null } {
  const intray = townHallIntray(world);
  const grants = grantsAwaitingDecision(world).filter((g) => g.status !== "countered");
  const lines = [
    ...grants.filter((g) => g.status === "checkpoint").map((g) => grantLine(world, g)),
    ...grants.filter((g) => g.status === "proposed").map((g) => grantLine(world, g)),
    ...intray.goalProposals.map((p) => `Accept ${world.buildings.get(p.buildingId ?? "")?.name ?? p.proposedByName}'s goal proposal ${p.id} (${p.action}${p.fields.text ? `: "${oneLine(p.fields.text, 90)}"` : p.targetId ? ` ${p.targetId}` : ""})?`),
    ...intray.captains.map((r) => `Make ${r.githubLogin ? `@${r.githubLogin}` : r.name} captain of "${oneLine(r.goalText, 80)}" (${r.goalId}; request ${r.id})?`),
    ...intray.retainers.filter((v) => v.retainer === "asked").map((v) => `Approve ${v.buildingName ?? world.buildings.get(v.buildingId)?.name ?? v.buildingId}'s retainer "${oneLine(v.title, 60)}" (${v.id}): ${fmt(v.tokensPerRun)} per run, ${fmt(v.askTokens)} in all?`),
  ];
  for (const d of intray.reports.filter((r) => r.tags.includes("rollup"))) {
    const b = world.buildings.get(d.buildingId ?? "")?.name ?? "A building";
    for (const it of parseRollup(d.body).items) if (it.yourCall && !isNoCall(it.yourCall)) lines.push(`${b} asks (${d.id}, "${oneLine(it.title, 60)}"): ${oneLine(it.yourCall, 160)}`);
  }
  const open = world.docs.where("type = 'request' AND requestStatus = 'open'", [], "ORDER BY createdAt");
  const askedOfYou = open.length ? `Asked of you: ${open.length} outbox request${open.length === 1 ? "" : "s"} (${open.slice(0, 3).map((r) => `"${oneLine(r.title, 60)}"`).join(", ")}${open.length > 3 ? ", …" : ""}).` : null;
  return { decisions: lines, askedOfYou };
}

/** Whether a rollup's Shipped items ask the human a real call (not "None"). */
const asksACall = (d: Doc) => parseRollup(d.body).items.some((it) => !!it.yourCall && !isNoCall(it.yourCall));

/** One Shipped item of a covered rollup, as the run reads it. */
interface DigestItem { rollupId: string; building: string; title: string; whatItIs: string; whatYoudSee: string; picture: string | null }

/** What a digest run reads: idle (why), else the decision lines and every Shipped item of the rollups since the last card. */
export function digestInputs(world: World, at: Date = new Date()): { idle: string | null; since: string | null; rollupIds: string[]; items: DigestItem[]; decisions: string[]; askedOfYou: string | null } {
  const last = lastDigest(world);
  const rollups = rollupsSince(world, last?.createdAt ?? null);
  const items = rollups.flatMap((d): DigestItem[] => {
    const building = world.buildings.get(d.buildingId ?? "")?.name ?? "Town";
    const parsed = parseRollup(d.body).items;
    // a rollup without parsed items still counts: one line from its title
    if (!parsed.length) return [{ rollupId: d.id, building, title: d.title, whatItIs: oneLine(d.body, 300), whatYoudSee: "", picture: null }];
    return parsed.map((it) => ({ rollupId: d.id, building, title: it.title, whatItIs: oneLine(it.whatItIs, 300), whatYoudSee: oneLine(it.whatYoudSee, 300), picture: it.pictures[0]?.src ?? null }));
  });
  return { idle: digestIdleReason(world, at), since: last?.createdAt ?? null, rollupIds: rollups.map((d) => d.id), items, ...digestDecisions(world) };
}

/** The `digest` tool's read: the inputs as text for the run. */
export function digestInputsText(world: World, at: Date = new Date()): string {
  const x = digestInputs(world, at);
  if (x.idle) return `Nothing to digest: ${x.idle}. submit_report (verdict stop) now.`;
  return [
    `Decisions needed (built in code; the card carries them as they are):\n${x.decisions.map((l) => `- ${l}`).join("\n") || "(none)"}${x.askedOfYou ? `\n${x.askedOfYou}` : ""}`,
    `Shipped items to write one line each for (${x.rollupIds.length} rollup${x.rollupIds.length === 1 ? "" : "s"} since ${x.since ?? "the start"}):`,
    ...x.items.map((it, i) => `${i + 1}. rollupId ${it.rollupId} · ${it.building} · ${it.title}\n   What it is: ${it.whatItIs}${it.whatYoudSee ? `\n   What you'd see: ${it.whatYoudSee}` : ""}${it.picture ? `\n   picture: ${it.picture}` : ""}`),
  ].join("\n\n");
}

interface ShippedLine { rollupId: string; line: string; picture?: string }

/** The card's body: decision lines, then one Shipped line per item (with its picture), then the covered rollups. */
function digestBody(decisions: string[], askedOfYou: string | null, shipped: ShippedLine[], rollups: Doc[], world: World): string {
  const name = (d: Doc) => world.buildings.get(d.buildingId ?? "")?.name ?? "Town";
  return [
    `## Decisions needed\n\n${decisions.map((l) => `- ${l}`).join("\n") || "Nothing waits on a yes or no."}${askedOfYou ? `\n\n${askedOfYou}` : ""}`,
    `## Shipped since last digest\n\n${shipped.map((s) => `- ${oneLine(s.line, 400)}${s.picture ? ` ![](${s.picture})` : ""} (${s.rollupId})`).join("\n") || "Nothing shipped."}`,
    `## Covered rollups\n\n${rollups.map((d) => `- ${name(d)}: ${d.title} (${d.id})`).join("\n")}`,
  ].join("\n\n");
}

/**
 * File today's card (the `digest` tool with `shipped`; only the Secretary): a doc of type `digest` in the Town Hall,
 * state building, provenance = the covered rollups; then archive every covered rollup still pending that asks no real
 * call (system, so they leave the in-tray's main list and stay under the card). Refused when the run is idle or a line names a rollup it doesn't cover.
 */
export function fileDigest(world: World, by: Agent, shipped: ShippedLine[], at: Date = new Date()): Doc {
  if (!world.secretary.isSecretary(by)) throw new AppError("forbidden", "Only the Town Hall's Secretary files the digest card.");
  const x = digestInputs(world, at);
  if (x.idle) throw new AppError("conflict", `Nothing to digest: ${x.idle}.`);
  const covered = new Set(x.rollupIds);
  for (const s of shipped) {
    if (!covered.has(s.rollupId)) throw badRequest(`${s.rollupId} isn't a rollup filed since the last digest (covered: ${[...covered].join(", ")}).`);
    if (!s.line.trim()) throw badRequest(`The line for ${s.rollupId} is empty.`);
    if (s.line.trim().split(/\s+/).length > MAX_LINE_WORDS) throw badRequest(`One line per item, at most 20 words: "${oneLine(s.line, 60)}" is longer.`);
  }
  const rollups = x.rollupIds.map((id) => world.docs.require(id, "doc"));
  return world.transaction(() => {
    const doc = createDoc(world, {
      type: "digest", state: "building", buildingId: TOWN_HALL_ID, authorId: by.forkOf ?? by.id, authorKind: "agent", tags: ["digest"],
      title: `Digest ${utcDay(at)}: ${x.decisions.length} decision${x.decisions.length === 1 ? "" : "s"}, ${rollups.length} rollup${rollups.length === 1 ? "" : "s"}`,
      body: digestBody(x.decisions, x.askedOfYou, shipped, rollups, world),
      provenance: { sourceIds: x.rollupIds, urls: [] }, createdAt: at.toISOString(),
    }, `The Secretary filed the in-tray digest: ${rollups.length} rollup(s) covered`);
    // a rollup that still asks a real "Your call" stays in the in-tray (its call is a "Decisions needed" line until decided)
    for (const d of rollups) if (d.decision === "pending" && !asksACall(d)) archiveReport(world, null, d.id);
    return doc;
  });
}
