/**
 * The Secretary (grant gr_kdlogzzo5s, design dc_8gbluwrdgi; town hall mt_v09cn7a8yr decision 3): a Town Hall resident
 * beside the Planner (who stays its manager) that keeps the humans' in-tray digestible. Mitchell: "can i get a secretary
 * resident in the town hall to help me with the intray? … rolling up the rollups into something more digestable".
 *
 * The digest card: "Decisions needed" is assembled here in code from the same data as the review deck (checkpoints,
 * proposals, goal proposals, captain asks, retainer asks, rollup calls, open outbox requests), as yes/no lines grouped
 * by the kind of yes/no (Money, Go / no-go, Questions in words, Already overtaken, Errands; Mitchell, 1:1
 * mt_i50xwu4z2t). "Shipped since last digest" is written by the Secretary's run (a cheap-model session on a daily
 * retainer schedule it takes itself, `takerId`): one line per Shipped item of every rollup filed since the last digest,
 * grouped under 3-6 theme headings the run picks.
 * `fileDigest` files the card (doc type `digest` in the Town Hall, the covered rollups in provenance) and archives those
 * rollups that ask nothing (every call None), so they leave the in-tray's main list and stay one click away under the
 * card; a rollup with a real "Your call" stays pending (its call is a "Decisions needed" line until a human decides it). The schedule
 * files at most one card per UTC day, and only when a new rollup arrived: otherwise the due run is skipped before any
 * session (`digestIdleReason`). A human's "Daily digest" press (`pressDigest`) runs it now, once-a-day aside.
 */
import { isGone, NOT_GONE, parseRollup, rollupAsks, Agent, type Assignment, type DigestCard, type DigestGroup, type DigestRunView, type Doc, type GrantView, type Meeting, type Schedule } from "@muster-town/schema";
import { archiveReport } from "./archive.ts";
import { createAssignment, createDoc, grantsAwaitingDecision, townHallIntray } from "./domain.ts";
import { STARTER_MANAGER_MODEL } from "./entities.ts";
import { AppError, badRequest, forbidden } from "./errors.ts";
import { humanOrigin } from "./origin.ts";
import { holderOf } from "./permissions.ts";
import { canDecideRetainer } from "./retainers.ts";
import { waitingRowIds } from "./rollup-asks.ts";
import { newId, nowIso, truncate } from "./util.ts";
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
/** Theme headings on one card: the run is asked for 3-6. */
const MAX_THEMES = 8;

const DIRECTION = "Keep the humans' Town Hall in-tray digestible: a daily digest card of what needs their yes or no and what shipped, and a 1:1 that acts only on what the human said.";

const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
const oneLine = (s: string, max = 140) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
const utcDay = (iso: string | Date) => new Date(iso).toISOString().slice(0, 10);

/** The run's instructions: the schedule's description, so each fired assignment carries them. */
const DIGEST_RUN_PROMPT = `Write today's in-tray digest card for the humans (you are the Secretary; grant gr_kdlogzzo5s).
1. Call \`digest\` with no arguments. It returns the "Decisions needed" lines (built in code: leave them as they are) and every rollup filed since the last digest, each Shipped item with its id, title, what it is, what you'd see and its first picture. If it says there is nothing to digest, submit_report at once (verdict stop) and end.
2. For every Shipped item write one plain line of at most 20 words: what a human would now see or can now do. No ids, no jargon, no "Your call". Keep its picture (the src it gave) when it has one. Sort the items into 3-6 plain theme headings of your own (e.g. "Joining and letting people in", "What a stranger sees", "Bank and speed", "Town Hall and in-tray"): a theme is what the items have in common for a human, not which building did them.
3. Call \`digest\` with \`shipped\`: one entry per item, {rollupId, line, theme, picture?}. It files the card first in the Town Hall in-tray, the lines grouped under your themes, and archives the covered rollups under it.
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
   * The Secretary, created on first call (server boot, after the seed): a Town Hall resident holding a mod-station desk slot, drawn beside the Town Hall in-tray (TOWN_HALL_RESTS) (else
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
        title: SECRETARY_TITLE, sprite: 6, direction: DIRECTION, model: STARTER_MANAGER_MODEL, pos: this.world.layout.door(th.id) ?? { x: 0, y: 0 }, status: "idle", createdAt: nowIso(),
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
   * Hall's cheapModel. Never made again once any schedule of the Secretary's exists (ended or rejected included); its
   * description (the run's instructions) is kept equal to DIGEST_RUN_PROMPT.
   */
  ensureDigestSchedule(at: Date = new Date()): Schedule | null {
    const sec = this.agent();
    const th = this.world.buildings.get(TOWN_HALL_ID);
    if (!sec || !th) return null;
    const had = this.world.schedules.first("takerId = ?", [sec.id], "ORDER BY createdAt");
    // the run's instructions live on the schedule: a boot after they changed rewrites them (the live schedule predates the themed form)
    if (had) return had.description === DIGEST_RUN_PROMPT ? had : this.world.schedules.patch(had.id, { description: DIGEST_RUN_PROMPT });
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
    const { decisions } = digestDecisions(this.world);
    // act_in_1on1 (step 1, PR #300) cites a human line by its exact ISO `at` and refuses lines older than 30 min
    const since = Date.now() - 30 * 60_000;
    const said = m.transcript.filter((u) => u.speakerId === m.withUserId && Date.parse(u.at) >= since)
      .map((u) => `- at ${u.at}: "${oneLine(u.text, 300)}"`).join("\n");
    return `${ONE_ON_ONE}\n\nThe human's lines from the last 30 min (cite one by its exact \`at\` as utteranceAt; for anything newer read \`meeting\` status):\n${said || "(none)"}\n\nDecisions needed now:\n${groupsText(decisions, "(none)")}`;
  }
}

// ---- the digest ----

/** The newest digest card, if any. */
function lastDigest(world: World): Doc | undefined {
  return world.docs.first("type = 'digest' AND buildingId = ?", [TOWN_HALL_ID], "ORDER BY createdAt DESC, rowid DESC");
}

/** One `## <title>` section of a digest card's body (without its heading), "" when absent. */
function section(body: string, title: string): string {
  const at = body.indexOf(`## ${title}\n`);
  if (at < 0) return "";
  const rest = body.slice(at + title.length + 4);
  const end = rest.search(/^## /m);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

/**
 * The latest digest card as the in-tray and the deck show it (step 3): its "Decisions needed" read live (the card's
 * own copy goes stale as humans decide), its Shipped lines, and the rollups it covers. Null before the first card.
 */
export function digestCard(world: World): DigestCard | null {
  const doc = lastDigest(world);
  if (!doc) return null;
  const covered = doc.provenance.sourceIds.flatMap((id) => {
    const d = world.docs.get(id);
    return d ? [{ id, title: d.title, buildingId: d.buildingId, buildingName: world.buildings.get(d.buildingId ?? "")?.name ?? "Town", pending: d.decision === "pending" }] : [];
  });
  return { doc, decisions: digestDecisions(world).decisions, shipped: section(doc.body, "Shipped since last digest"), covered };
}

/** Rollups filed since `since` (every one when null), oldest first, decided or not. */
function rollupsSince(world: World, since: string | null): Doc[] {
  return world.docs.where(`type = 'report' AND tags LIKE '%"rollup"%'${since ? " AND createdAt > ?" : ""}`, since ? [since] : [], "ORDER BY createdAt, rowid")
    .filter((d) => d.tags.includes("rollup"));
}

/** Why there is nothing to digest (null = there is): no rollup arrived since the last card. A pressed run is refused only for this. */
function digestNothingNew(world: World): string | null {
  return rollupsSince(world, lastDigest(world)?.createdAt ?? null).length ? null : "no new rollup since the last digest";
}

/**
 * Why the schedule's due run has nothing to do (null = it has): a card was filed today (UTC), or nothing new. The
 * once-a-day rule is the schedule's only: a human's press ("Daily digest" button, `pressDigest`) files another card.
 */
export function digestIdleReason(world: World, at: Date = new Date()): string | null {
  const last = lastDigest(world);
  if (last && utcDay(last.createdAt) === utcDay(at)) return "a digest was already filed today";
  return digestNothingNew(world);
}

/** The Secretary's digest schedule, if it is still active. */
function digestSchedule(world: World): Schedule | undefined {
  const sec = world.secretary.agent();
  return sec ? world.schedules.first("takerId = ? AND status = 'active'", [sec.id], "ORDER BY createdAt") : undefined;
}

/** The digest run under way (queued, running or parked), if any: its schedule's or a pressed one. */
function liveDigestRun(world: World, s: Pick<Schedule, "id">): Assignment | undefined {
  return world.assignments.first("lane = 'retainer' AND sourceId = ? AND status IN ('pending', 'active')", [s.id], "ORDER BY createdAt");
}

/** The "Daily digest" button for a viewer who may press it (null for anyone else, or with no active digest schedule). */
export function digestRunView(world: World, viewer: Agent | undefined): DigestRunView | null {
  const s = digestSchedule(world);
  if (!s || !canDecideRetainer(world, viewer, s)) return null;
  const live = liveDigestRun(world, s);
  const refused = live ? "a digest run is under way: its card lands here when it finishes"
    : s.retainer !== "funded" ? `the digest's retainer is ${s.retainer}, not approved`
    : digestNothingNew(world);
  return { scheduleId: s.id, runningId: live?.id ?? null, refused };
}

/**
 * The in-tray's "Daily digest" button (Mitchell, 1:1 mt_i50xwu4z2t: "let's make the 'daily digest' also a button on the
 * intray that just does the same"): one run of the Secretary's digest now, the schedule's own prompt and model, booked
 * as a run of its retainer (lane retainer, sourceId = the schedule: its approved total pays for it, as for a fired run;
 * the schedule's next run does not move). Only a human who can decide the retainer presses it; refused while a run is
 * under way, while the retainer isn't funded, or when no rollup arrived since the last card (its Decisions needed is
 * live already). The once-a-day rule doesn't apply: the run files a new card, which supersedes today's.
 */
export function pressDigest(world: World, actor: Agent, at: Date = new Date()): Assignment {
  const sec = world.secretary.agent();
  const s = digestSchedule(world);
  if (!sec || !s) throw new AppError("conflict", "There is no active daily digest schedule to run.");
  if (!canDecideRetainer(world, actor, s)) throw forbidden("building.fund", "Only a human who can decide the Town Hall's retainers runs the digest.");
  if (sec.status === "stopped" || isGone(sec)) throw new AppError("conflict", `${sec.name} is stopped: nobody can run the digest.`);
  if (s.retainer !== "funded") throw new AppError("conflict", `The digest's retainer is ${s.retainer}, not approved: approve it in the in-tray first.`);
  const live = liveDigestRun(world, s);
  if (live) throw new AppError("conflict", `A digest run is already under way (${live.id}): its card lands in the in-tray when it finishes.`);
  const idle = digestNothingNew(world);
  if (idle) throw new AppError("conflict", `Nothing to digest: ${idle}. The card's "Decisions needed" is already live.`);
  const by = holderOf(actor);
  return world.transaction(() => {
    const a = createAssignment(world, {
      agentId: sec.id, title: `${s.title} (run now)`, description: s.description, createdBy: { kind: "system", id: s.id }, buildingId: s.buildingId,
      lane: { lane: "retainer", gap: s.gap ?? undefined, sourceId: s.id }, origin: humanOrigin(by.id, s.id, at.toISOString()), queue: "agent", model: s.model,
    });
    // the schedule's next fire skips while this run is under way (fireSchedules checks lastAssignmentId)
    world.schedules.patch(s.id, { lastAssignmentId: a.id, updatedAt: at.toISOString() });
    world.events.append({ type: "schedule.fired", agentId: sec.id, buildingId: s.buildingId, text: `${world.nameOf(actor.id)} ran "${truncate(s.title, 80)}" now: ${sec.name} takes it`, payload: { scheduleId: s.id, assignmentId: a.id, queue: "agent", pressedBy: by.id } });
    return a;
  });
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

const idsIn = (text: string, prefix: string) => [...new Set([...text.matchAll(new RegExp(`\\b${prefix}_[a-z0-9]+\\b`, "g"))].map((m) => m[0]))];
const GO_NO_GO = /\bgo\s*(\/|-|or)\s*no[- ]?go\b/i;
const MARK_MET = /\bmark(ed|ing)?\b[^.]*\b(met|missed)\b/i;
const FUND_ASK = /\b(fund|counter|reject|proposal|retainer|approve)\b/i;
/** A call that asks the money question of a checkpoint or proposal (its row's Money line asks it already). */
const MONEY_CALL = /\b(continue|adjust|cut|top[- ]?up|fund|counter|reject)\b/i;

/**
 * Why a pending rollup's "Your call" is already overtaken (null = it still asks): its frozen text names a key result
 * since met or missed, a "mark … met" on a grant since closed (closing marks its key results met, migration 087), a
 * proposal or retainer since decided, or a checkpoint since continued or cut. Only ids in the item itself count (its
 * title, what it is, its call), so a rollup's Key results table naming other grants doesn't retire it.
 */
export function overtakenReason(world: World, it: { title: string; whatItIs: string; yourCall: string }, d: Doc): string | null {
  const text = `${it.title} ${it.whatItIs} ${it.yourCall}`;
  const call = it.yourCall;
  for (const id of idsIn(text, "kr")) {
    const kr = world.keyResults.get(id);
    if (kr && (kr.status === "met" || kr.status === "missed") && MARK_MET.test(call)) return `${id} is already ${kr.status}`;
  }
  const askedAbout = idsIn(`${it.title} ${call}`, "gr").map((id) => world.grants.get(id)).filter((g): g is NonNullable<typeof g> => !!g);
  for (const g of askedAbout) {
    if (g.status === "closed") {
      if (MARK_MET.test(call)) return `${g.id} closed as ${g.outcome ?? "done"}: its key results are set`;
      if (FUND_ASK.test(call) || /\bcontinue|adjust|cut|top[- ]up\b/i.test(call)) return `${g.id} is closed (${g.outcome ?? "done"})`;
    }
    if (FUND_ASK.test(call) && (g.status === "funded" || g.status === "checkpoint")) {
      // the ask was to fund it; a decision after the rollup did
      const decided = g.history.some((h) => h.action === "fund" && h.at > d.createdAt);
      if (decided) return `${g.id} was funded after this ask`;
    }
    if (g.status === "funded" && g.history.some((h) => (h.action === "continue" || h.action === "adjust") && h.at > d.createdAt)) return `${g.id}'s checkpoint was decided after this ask`;
  }
  for (const id of idsIn(text, "sc")) {
    const sc = world.schedules.get(id);
    if (sc && (sc.retainer === "funded" || sc.retainer === "rejected" || sc.retainer === "ended") && FUND_ASK.test(call)) return `retainer ${id} is ${sc.retainer}`;
  }
  return null;
}

const DECIDED_AS = { fund: "funded", reject: "rejected", continue: "continued", adjust: "adjusted", cut: "cut", close: "closed", stop: "stopped", withdraw: "withdrawn" } as const;

/**
 * Why a "## Needs from Mitchell" line is already overtaken (null = it still asks): it names a grant decided after the
 * rollup (funded, rejected, continued, adjusted, cut, closed, stopped or withdrawn) or a retainer since funded, rejected
 * or ended. A line naming no grant or schedule is a question in words and never overtaken here.
 */
function needsOvertaken(world: World, line: string, d: Doc): string | null {
  for (const id of idsIn(line, "gr")) {
    const g = world.grants.get(id);
    const h = g?.history.filter((x) => x.at > d.createdAt && x.action in DECIDED_AS).at(-1);
    if (h) return `${id} was ${DECIDED_AS[h.action as keyof typeof DECIDED_AS]} after this ask`;
  }
  for (const id of idsIn(line, "sc")) {
    const sc = world.schedules.get(id);
    if (sc && (sc.retainer === "funded" || sc.retainer === "rejected" || sc.retainer === "ended")) return `retainer ${id} is ${sc.retainer}`;
  }
  return null;
}

/**
 * A pending rollup's asks as the review deck and in-tray read them (rollupAsks: each Shipped item's real "Your call",
 * then its Needs lines), each with why it is overtaken (null = it still asks). A Needs line has no title.
 */
function rollupCalls(world: World, d: Doc): { title: string; call: string; overtaken: string | null }[] {
  const p = parseRollup(d.body);
  return rollupAsks(p).map((a) => {
    const it = a.n ? p.items[a.n - 1] : undefined;
    return { title: a.title, call: a.call, overtaken: it ? overtakenReason(world, it, d) : needsOvertaken(world, a.call, d) };
  });
}

/** Whether a pending rollup still asks the human anything live: a real call not overtaken. */
export const stillAsks = (world: World, d: Doc) => rollupCalls(world, d).some((c) => !c.overtaken);

/** The headings of "Decisions needed", in the card's order. */
const DIGEST_GROUPS = { money: "Money", goNoGo: "Go / no-go", questions: "Questions in words", overtaken: "Already overtaken", errands: "Errands" } as const;

/**
 * "Decisions needed" grouped by the kind of yes/no (Mitchell, 1:1 mt_i50xwu4z2t), from the data the review deck reads,
 * zero tokens and current at every read: Money (checkpoints with their top-up, proposals at their ask, retainer asks;
 * a rollup's call about one of them, or its checkpoint report's continue / cut, is not repeated but named on that line as
 * "Also asked in dc_…"); each other in-tray rollup gives at most one line (its first live call, "and N more"); Go / no-go (a rollup's call that says so); Questions in words (every other real
 * "Your call" or Needs line); Already overtaken (calls whose grant, key result or retainer has since been decided: one Approve-all,
 * `docIds`); Errands (open outbox requests). `count` is the yes/no lines (errands aside), for the card's title.
 */
export function digestDecisions(world: World): { decisions: DigestGroup[]; count: number; overtakenIds: string[] } {
  const intray = townHallIntray(world);
  const grants = grantsAwaitingDecision(world).filter((g) => g.status !== "countered");
  const rows = waitingRowIds(world);
  // a rollup's live calls first, so a call that a grant or retainer row's own Money line already carries is left out
  // (as_6gnydlwpf7): each in-tray row gives at most one line, and the row names the rollups that also asked it
  const askedIn = new Map<string, string[]>();
  const noteAsk = (id: string, docId: string) => { const l = askedIn.get(id) ?? []; if (!l.includes(docId)) askedIn.set(id, [...l, docId]); };
  const goNoGo: string[] = [];
  const questions: string[] = [];
  const overtaken: string[] = [];
  const overtakenIds: string[] = [];
  for (const d of intray.reports.filter((r) => r.tags.includes("rollup"))) {
    const b = world.buildings.get(d.buildingId ?? "")?.name ?? "A building";
    const calls = rollupCalls(world, d);
    if (!calls.length) continue;
    if (calls.every((c) => c.overtaken)) {
      overtakenIds.push(d.id);
      overtaken.push(`${b} (${d.id}, "${oneLine(calls[0]!.title || calls[0]!.call, 50)}"${calls.length > 1 ? ` and ${calls.length - 1} more` : ""}): ${calls.map((c) => c.overtaken).filter((r, i, a) => a.indexOf(r) === i).join("; ")}.`);
      continue;
    }
    // the rows this rollup is about: the grant it is the checkpoint report of, and the waiting rows its title names
    const own = [...grants.filter((g) => g.checkpointDocId === d.id).map((g) => g.id), ...idsIn(d.title, "gr").concat(idsIn(d.title, "sc")).filter((id) => rows.has(id))];
    const left = calls.filter((c) => {
      if (c.overtaken) return false;
      const named = idsIn(`${c.title} ${c.call}`, "gr").concat(idsIn(c.call, "sc")).filter((id) => rows.has(id));
      if (named.length) { named.forEach((id) => noteAsk(id, d.id)); return false; }
      if (own.length && MONEY_CALL.test(c.call)) { own.forEach((id) => noteAsk(id, d.id)); return false; }
      return true;
    });
    if (!left.length) continue;
    const c = left[0]!;
    const more = left.length > 1 ? ` (and ${left.length - 1} more ask${left.length > 2 ? "s" : ""} in ${d.id})` : "";
    const line = `${b} asks (${d.id}${c.title ? `, "${oneLine(c.title, 60)}"` : ""}): ${oneLine(c.call, 160)}${more}`;
    if (left.some((x) => GO_NO_GO.test(`${x.title} ${x.call}`))) goNoGo.push(line);
    else questions.push(line);
  }
  const asked = (id: string) => (askedIn.has(id) ? ` Also asked in ${askedIn.get(id)!.join(", ")}.` : "");
  const money = [
    ...grants.filter((g) => g.status === "checkpoint").map((g) => grantLine(world, g) + asked(g.id)),
    ...grants.filter((g) => g.status === "proposed").map((g) => grantLine(world, g) + asked(g.id)),
    ...intray.retainers.filter((v) => v.retainer === "asked").map((v) => `Approve ${v.buildingName ?? world.buildings.get(v.buildingId)?.name ?? v.buildingId}'s retainer "${oneLine(v.title, 60)}" (${v.id}): ${fmt(v.tokensPerRun)} per run, ${fmt(v.askTokens)} in all?${asked(v.id)}`),
  ];
  questions.unshift(
    ...intray.goalProposals.map((p) => `Accept ${world.buildings.get(p.buildingId ?? "")?.name ?? p.proposedByName}'s goal proposal ${p.id} (${p.action}${p.fields.text ? `: "${oneLine(p.fields.text, 90)}"` : p.targetId ? ` ${p.targetId}` : ""})?`),
    ...intray.captains.map((r) => `Make ${r.githubLogin ? `@${r.githubLogin}` : r.name} captain of "${oneLine(r.goalText, 80)}" (${r.goalId}; request ${r.id})?`),
  );
  const open = world.docs.where("type = 'request' AND requestStatus = 'open'", [], "ORDER BY createdAt");
  const errands = open.slice(0, 6).map((r) => `"${oneLine(r.title, 80)}" (${r.id})`);
  if (open.length > 6) errands.push(`… and ${open.length - 6} more in the outbox.`);
  const group = (heading: string, lines: string[], note: string | null = null, docIds?: string[]): DigestGroup[] =>
    lines.length ? [{ heading: `${heading} (${docIds ? docIds.length : lines.length})`, note, lines, ...(docIds ? { docIds } : {}) }] : [];
  const decisions = [
    ...group(DIGEST_GROUPS.money, money),
    ...group(DIGEST_GROUPS.goNoGo, goNoGo),
    ...group(DIGEST_GROUPS.questions, questions),
    ...group(DIGEST_GROUPS.overtaken, overtaken, `Approve these ${overtaken.length} and they drop out; nothing to decide.`, overtakenIds),
    ...group(DIGEST_GROUPS.errands, errands, `${open.length} open outbox request${open.length === 1 ? "" : "s"}: do or decline when you have time.`),
  ];
  return { decisions, count: money.length + goNoGo.length + questions.length + overtaken.length, overtakenIds };
}

/** The groups as markdown: a bold heading, its note, then one `- ` line each. */
export function groupsText(groups: DigestGroup[], empty = "Nothing waits on a yes or no."): string {
  if (!groups.length) return empty;
  return groups.map((g) => `**${g.heading}**${g.note ? `\n${g.note}` : ""}\n\n${g.lines.map((l) => `- ${l}`).join("\n")}`).join("\n\n");
}

/** One Shipped item of a covered rollup, as the run reads it. */
interface DigestItem { rollupId: string; building: string; title: string; whatItIs: string; whatYoudSee: string; picture: string | null }

/** What a digest run reads: idle (why), else the decision lines and every Shipped item of the rollups since the last card. */
export function digestInputs(world: World, at: Date = new Date()): { idle: string | null; since: string | null; rollupIds: string[]; items: DigestItem[]; decisions: DigestGroup[]; count: number } {
  const last = lastDigest(world);
  const rollups = rollupsSince(world, last?.createdAt ?? null);
  const items = rollups.flatMap((d): DigestItem[] => {
    const building = world.buildings.get(d.buildingId ?? "")?.name ?? "Town";
    const parsed = parseRollup(d.body).items;
    // a rollup without parsed items still counts: one line from its title
    if (!parsed.length) return [{ rollupId: d.id, building, title: d.title, whatItIs: oneLine(d.body, 300), whatYoudSee: "", picture: null }];
    return parsed.map((it) => ({ rollupId: d.id, building, title: it.title, whatItIs: oneLine(it.whatItIs, 300), whatYoudSee: oneLine(it.whatYoudSee, 300), picture: it.pictures[0]?.src ?? null }));
  });
  const { decisions, count } = digestDecisions(world);
  return { idle: digestNothingNew(world), since: last?.createdAt ?? null, rollupIds: rollups.map((d) => d.id), items, decisions, count };
}

/** The `digest` tool's read: the inputs as text for the run. */
export function digestInputsText(world: World, at: Date = new Date()): string {
  const x = digestInputs(world, at);
  if (x.idle) return `Nothing to digest: ${x.idle}. submit_report (verdict stop) now.`;
  return [
    `Decisions needed (built in code, grouped by kind; the card carries them as they are):\n${groupsText(x.decisions, "(none)")}`,
    `Shipped items to write one line each for, under 3-6 plain theme headings of your own (${x.rollupIds.length} rollup${x.rollupIds.length === 1 ? "" : "s"} since ${x.since ?? "the start"}):`,
    ...x.items.map((it, i) => `${i + 1}. rollupId ${it.rollupId} · ${it.building} · ${it.title}\n   What it is: ${it.whatItIs}${it.whatYoudSee ? `\n   What you'd see: ${it.whatYoudSee}` : ""}${it.picture ? `\n   picture: ${it.picture}` : ""}`),
  ].join("\n\n");
}

interface ShippedLine { rollupId: string; line: string; picture?: string; theme?: string }

/** Themes with no name given go last under this heading (a run that gave none leaves the list flat). */
const OTHER_THEME = "Other";

/**
 * The Shipped lines grouped under the run's theme headings in first-use order (Mitchell, 1:1 mt_i50xwu4z2t: "can you
 * cluster the shipped stuff?"), one `- ` line per item with its picture and rollup id; flat when no line has a theme.
 */
function shippedText(shipped: ShippedLine[]): string {
  if (!shipped.length) return "Nothing shipped.";
  const line = (s: ShippedLine) => `- ${oneLine(s.line, 400)}${s.picture ? ` ![](${s.picture})` : ""} (${s.rollupId})`;
  if (!shipped.some((s) => s.theme?.trim())) return shipped.map(line).join("\n");
  const themes = new Map<string, ShippedLine[]>();
  for (const s of shipped) {
    const t = s.theme?.trim() || OTHER_THEME;
    themes.set(t, [...(themes.get(t) ?? []), s]);
  }
  const other = themes.get(OTHER_THEME);
  if (other) { themes.delete(OTHER_THEME); themes.set(OTHER_THEME, other); }
  return [...themes].map(([t, lines]) => `**${t}**\n\n${lines.map(line).join("\n")}`).join("\n\n");
}

/** The card's body: the decision groups, then the Shipped lines under their themes, then the covered rollups. */
function digestBody(decisions: DigestGroup[], shipped: ShippedLine[], rollups: Doc[], world: World): string {
  const name = (d: Doc) => world.buildings.get(d.buildingId ?? "")?.name ?? "Town";
  return [
    `## Decisions needed\n\n${groupsText(decisions)}`,
    `## Shipped since last digest\n\n${shippedText(shipped)}`,
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
  const themes = new Set(shipped.map((s) => s.theme?.trim()).filter(Boolean));
  if (themes.size > MAX_THEMES) throw badRequest(`At most ${MAX_THEMES} theme headings (3-6 is the aim): ${themes.size} given.`);
  const rollups = x.rollupIds.map((id) => world.docs.require(id, "doc"));
  return world.transaction(() => {
    const doc = createDoc(world, {
      type: "digest", state: "building", buildingId: TOWN_HALL_ID, authorId: by.forkOf ?? by.id, authorKind: "agent", tags: ["digest"],
      title: `Digest ${utcDay(at)}: ${x.count} decision${x.count === 1 ? "" : "s"}, ${rollups.length} rollup${rollups.length === 1 ? "" : "s"}`,
      body: digestBody(x.decisions, shipped, rollups, world),
      provenance: { sourceIds: x.rollupIds, urls: [] }, createdAt: at.toISOString(),
    }, `The Secretary filed the in-tray digest: ${rollups.length} rollup(s) covered`);
    // a rollup that still asks a live "Your call" stays in the in-tray (its call is a "Decisions needed" line until decided);
    // one whose every call is None or overtaken (its grant, key result or retainer since decided) is archived under the card
    for (const d of rollups) if (d.decision === "pending" && !stillAsks(world, d)) archiveReport(world, null, d.id);
    return doc;
  });
}
