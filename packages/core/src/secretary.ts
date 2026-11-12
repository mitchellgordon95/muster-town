/**
 * The Secretary (grant gr_kdlogzzo5s, design dc_8gbluwrdgi; town hall mt_v09cn7a8yr decision 3): a Town Hall resident
 * beside the Planner (who stays its manager) that keeps the humans' in-tray digestible. Since legible delegation step 5
 * (docs/legible-delegation.md §6) it operates the stream of asks instead of writing a digest card, on Fable (Mitchell:
 * "the secretary should be fable by default. this kind of high-level judgment work i think requires that level of
 * competence."):
 *
 * - **Rank** (the daily run, `RANK_RUN_PROMPT`, a retainer schedule it takes itself): reads the open asks (`rank` with no
 *   arguments), sets each one's `rank`, defers an ask that is moot until another resolves (`deferAsk`), and files the
 *   money slate (fund now, hold until, skip) as a `slate` notice citing ask ids (`applyRank`). A human's "Rank now"
 *   press (`pressRank`) runs the same job. The due run is skipped before any session when nothing changed since the
 *   last ranking (`rankNothingNew`).
 * - **Surface patterns** (the weekly run, `PATTERN_RUN_PROMPT`): reads the week's asks, rollups and events and files one
 *   `pattern` notice of convergences and repeats (`filePattern`), with an optional rule as a policy ask.
 * - **Propose a rule**: only from the pattern note's rule (never after a decided policy ask or `act_in_1on1`), the policy
 *   ask "Add this rule to the ledger?" (`proposeRule`); deciding "Add" appends the line to the policy ledger (a Town Hall doc
 *   of type `policy`, `policyLedgerBlock` pins it in managers' prompts). It never appends on its own.
 * - **Settle a rollup** on submit (`settleRollup`): a `shipped` notice per Shipped item, the closed loop of a grant it
 *   closes, and archiving a rollup that asks nothing of its own (every ask folded, or none), as the digest used to.
 *
 * It never funds, continues, cuts or approves anything: the humans decide every ask. The `digest` doc type stays
 * readable for old cards; nothing writes one any more. `overtakenReason` and `rollupCalls` (the old digest's reading of a
 * rollup's prose) stay: the asks backfill reads untyped rollups through them, and the hooks are tested against them.
 */
import { grantName, isGone, NOT_GONE, parseRollup, rollupAsks, Agent, type Ask, type Assignment, type DigestRunView, type Doc, type Grant, type Meeting, type Notice, type Schedule } from "@muster-town/schema";
import { archiveReport } from "./archive.ts";
import { createAsk, deferAsk, overtakeAsk, rankedAsks, setRank } from "./asks.ts";
import { createAssignment, createDoc, managerAgentOf, updateDoc } from "./domain.ts";
import { syncManagerRoles } from "./entities.ts";
import { AppError, badRequest, forbidden } from "./errors.ts";
import { closedLoopNotice, fileNotice, shippedNotices } from "./notices.ts";
import { appendEntry } from "./jobs.ts";
import { humanOrigin } from "./origin.ts";
import { overtakeCandidates, type AskFacts } from "./overtake.ts";
import { healthLine, townHealth } from "./health.ts";
import { holderOf } from "./permissions.ts";
import { canDecideRetainer } from "./retainers.ts";
import { foldRollup } from "./rollup-asks.ts";
import { createSchedule, raiseRetainerPerRun } from "./schedules.ts";
import { stamp, utcDate, whenFor } from "./time.ts";
import { newId, nowIso, truncate } from "./util.ts";
import { TOWN_HALL_ID } from "./world/layout.ts";
import type { World } from "./world.ts";

const SECRETARY_TITLE = "Secretary";
/** The Secretary and its runs: Fable (docs/legible-delegation.md §6, §10). Its judgment is the product; never the cheap model. */
export const SECRETARY_MODEL = "claude-fable-5-1";
/** One ranking run on Fable reads the open asks and the money history and writes ranks and a slate: est. 40,000 Bank tokens. */
export const RANK_TOKENS_PER_RUN = 40_000;
/** One weekly pattern run reads a week of asks, rollups and events and writes one notice: est. 60,000 Bank tokens. */
const PATTERN_TOKENS_PER_RUN = 60_000;
/** The daily run (UTC): before Mitchell's morning. */
const RANK_AT = "07:00";
const RANK_SCHEDULE_TITLE = "Daily ask ranking";
const PATTERN_SCHEDULE_TITLE = "Weekly pattern note";
/** The weekly schedule runs this long (a schedule is renewed on purpose; MAX_SCHEDULE_DAYS is 90). */
const PATTERN_DAYS = 84;
const WEEK_MS = 7 * 24 * 3_600_000;

const DIRECTION = "Keep the humans' Town Hall in-tray in order: rank the open asks daily with a money slate (fund, hold, skip), note the week's patterns, propose rules for the policy ledger, and in a 1:1 act only on what the human said.";

const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
const oneLine = (s: string, max = 140) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

/** The daily run's instructions: the schedule's description, so each fired assignment carries them. */
const RANK_RUN_PROMPT = `Rank the humans' open asks (you are the Secretary; docs/legible-delegation.md §6). You never fund, continue, cut, approve or decide anything yourself: the humans decide every ask; you put them in order and say why.
1. Call \`rank\` with no arguments. It lists every open ask (id, type, building, how long it has waited, body, branches, recommendation, the records it came from) and the humans' recent money decisions with their notes. If it says there is nothing to rank, submit_report at once (verdict stop) and end.
2. Order every open ask, most urgent first: what work is parked on, then money a building waits on, then a click that unblocks another ask, then the rest by age, and the do asks last (a do asks a human to leave the queue and act in the world). The humans' past fund and reject decisions, with their notes, are how they weigh: follow them. A do ask that a button or an agent could carry out should not be in the queue: \`tell\` its building (its bl_ id) to withdraw it and say what would do it instead.
3. Defer an ask that is moot until another ask or event resolves (e.g. the continue on a grant whose captain-accept click is still open waits behind that click): an entry of \`defer\` with the blocking ask's id. A deferred ask stays listed; it is not decided.
4. Write the money slate over the money asks: fund these now (why), hold these until X (what it waits for, and why), skip these (the overlap, or why). Every money ask goes in exactly one of the three; cite only ask ids from the list. In each why, name a grant by its title (the short name on its ask), never by its objective.
5. Call \`rank\` once with \`order\` (every open ask id), \`slate\` and \`defer\`. It sets the ranks, files the slate as a notice beside the asks and parks the deferred asks. It funds nothing.
6. submit_report (verdict stop): the slate notice id and how many asks you ranked. Nothing else: don't read other docs, don't write pages.`;

/** The decision run's title: one pending run at a time is found by it (the debounce). */
const DECISION_RUN_TITLE = "Settle and re-rank after a decision";
/** A run of human decisions this close together is one Secretary wake (1:1 mt_msnjkpgwdb decision 10). */
export const DECISION_RUN_DEBOUNCE_MS = 3 * 60_000;
/**
 * At most this many decision runs a UTC day: they draw on the ranking schedule's retainer (each capped at its
 * tokensPerRun), which a human approved for the daily ranking, so a busy day can't spend it down. Past the cap a
 * decision waits for the next ranking, whose read lists it under "Decided since the last ranking" all the same.
 */
export const DECISION_RUNS_PER_DAY = 8;
const DECIDED_HEAD = "The human's decisions this run follows (oldest first):";

/** The decision run's instructions (1:1 mt_msnjkpgwdb decisions 10 and 20a): the lines under DECIDED_HEAD are added as decisions land. */
const DECISION_RUN_PROMPT = `A human just decided on the Town Hall queue (you are the Secretary; docs/legible-delegation.md §6). Take that decision and do what follows from it. You never fund, continue, cut or approve anything, and you decide nothing a human has not already decided.
1. Call \`rank\` with no arguments. It lists the open asks and, under "Decided since the last ranking", each human decision with the open asks it may have overtaken (candidates: the same item, or an ask whose words name the decided item).
2. Settle what the decision made moot: for each candidate, and any other open ask the decision plainly answers, judge whether a human would still have anything to decide on it. If not, close it with \`rank\` \`overtaken\`: its ask id, \`because\` (the decided ask or item by id, or the 1:1 and their words) and a one-sentence \`note\`. Only click and policy asks close this way; money, credentials, meetings and requests a human must carry out stay theirs (the tool refuses them): rank or defer those. When in doubt, leave it open.
3. Re-rank what is left: \`order\` (every open ask id, most urgent first) and \`defer\` for an ask that is now moot until another resolves. File a \`slate\` only if the decision changed the money picture. One \`rank\` call can carry overtaken, order, defer and slate together.
4. Send back what the decision implies for a building when the building's own decision message would not say it (it hears "cut", not why, or not that a second ask of its went with it): \`tell\` the building (to: its bl_ id) in one or two plain lines. Skip this when there is nothing to add.
5. submit_report (verdict stop): what you closed as overtaken and why, how many asks you ranked, whom you told. Nothing else: don't read other docs, don't write pages.`;

/** The weekly run's instructions. */
const PATTERN_RUN_PROMPT = `Write this week's pattern note for the humans (you are the Secretary; docs/legible-delegation.md §6, "Surface patterns"). You never fund, decide or approve anything.
1. Call \`rank\` with \`week: true\`. It lists the last 7 days of asks (with how each ended), rollups and their Shipped items, and the town's events by kind with the notable ones. If it says the week was empty, submit_report at once (verdict stop) and end.
2. Find the convergences and repeats a single building can't see: several buildings blocked on the same thing ("four buildings hit the test account's permissions"), a burst with one cause ("ten proposals landed in one day because the explore tick fired after a deploy"), the same ask raised again and again, a kind of ask the humans always answer the same way.
3. Call \`rank\` with \`pattern\`: a title, a short body (one plain line per pattern, the ids it rests on cited), and, only when one pattern is a standing answer the humans keep giving, \`rule\`: one line the managers should follow. The rule is filed as a policy ask "Add this rule to the ledger?"; the humans decide it.
4. submit_report (verdict stop): the notice id. Nothing else.`;

/** The Secretary's 1:1 prompt (it answers 1:1s like the Planner; manage.ts appends it to the brief). */
const ONE_ON_ONE = `You are the Secretary, a resident of the Town Hall beside the Planner (the Town Hall's manager). Your job is to keep the human's Town Hall in-tray in order: you rank the open asks, write the money slate and propose rules for the policy ledger. In this 1:1, answer from the asks as they are now (the \`rank\` tool with no arguments lists them, ranked, with the humans' recent money decisions). Act only on what the human said in this 1:1, never on your own judgment: use \`act_in_1on1\` if available, citing their words; without it, say which button in the Town Hall in-tray does it. You never fund, stop or approve anything yourself. The item open on the human's screen is shown with each of their lines; 'this', 'it' or 'this one' means that item; act_in_1on1 on it only with their words.`;

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
   * The Secretary, created on first call (server boot, after the seed): a Town Hall resident holding a mod-station desk slot, drawn beside the hydrant (TOWN_HALL_RESTS) (else
   * by the door), on SECRETARY_MODEL. It is the Town Hall's manager (Mitchell, 1:1 mt_db6itzy2br 20:52 UTC; the Planner
   * stays a resident that runs calibration and reorgs): `seatAsManager` names it and grants the Town Hall's manager role
   * (assign, schedule), every boot. It still decides no ask: building.fund is never an agent's, and it acts on decisions
   * only with the human as actor. A stopped Secretary stays stopped (a human stopped it on purpose). An existing one
   * moves to SECRETARY_MODEL (step 5).
   */
  ensure(): Agent | null {
    const have = this.agent();
    if (have) {
      const sec = have.model === SECRETARY_MODEL ? have : this.world.agents.patch(have.id, { model: SECRETARY_MODEL });
      this.seatAsManager(sec);
      return sec;
    }
    const th = this.world.buildings.get(TOWN_HALL_ID);
    if (!th) return null;
    const made = this.world.transaction(() => {
      const id = newId("ag");
      this.world.agents.upsert(Agent.parse({
        id, name: SECRETARY_TITLE, kind: "resident", buildingId: th.id, homeBuildingId: th.id, ownerUserId: th.createdBy ?? null,
        title: SECRETARY_TITLE, sprite: 6, direction: DIRECTION, model: SECRETARY_MODEL, pos: this.world.layout.door(th.id) ?? { x: 0, y: 0 }, status: "idle", createdAt: nowIso(),
      }), { silent: true });
      let agent = this.world.agents.require(id, "agent");
      try { agent = this.world.agents.patch(id, { pos: this.world.layout.claimDesk(th.id, id).pos }); }
      catch (e) { if (!(e instanceof AppError) || e.code !== "conflict") throw e; }
      this.world.events.append({ type: "agent.created", agentId: id, buildingId: th.id, text: `${agent.name} joined the Town Hall (keeps the in-tray in order)`, payload: { kind: "resident", secretary: true } });
      return agent;
    });
    this.seatAsManager(made);
    return made;
  }

  /** Name the Secretary the Town Hall's manager (unless it already is) and grant it the Town Hall's manager role. */
  private seatAsManager(sec: Agent): void {
    const th = this.world.buildings.get(TOWN_HALL_ID);
    if (!th) return;
    if (th.managerAgentId !== sec.id) {
      this.world.buildings.upsert({ ...th, managerAgentId: sec.id });
      this.world.events.append({ type: "building.updated", buildingId: th.id, text: `${sec.name} is now the Town Hall's manager`, payload: { fields: ["managerAgentId"] } });
    }
    syncManagerRoles(this.world);
  }

  /**
   * The daily ranking schedule, made once: on the Town Hall, taken by the Secretary, on a retainer of RANK_TOKENS_PER_RUN
   * per run (asked in the Town Hall in-tray: its runs start once a human approves), on SECRETARY_MODEL. It is the
   * Secretary's first schedule: never made again once any exists (ended or rejected included). The live one (the old
   * "Daily in-tray digest") is kept in step with the code at boot: its title, its description (RANK_RUN_PROMPT) and its
   * model; a per-run amount below RANK_TOKENS_PER_RUN is raised to it through `raiseRetainerPerRun`, which asks the
   * retainer again (the new total runs only once a human approves it).
   */
  ensureRankSchedule(at: Date = new Date()): Schedule | null {
    const sec = this.agent();
    const th = this.world.buildings.get(TOWN_HALL_ID);
    if (!sec || !th) return null;
    const had = this.world.schedules.first("takerId = ? AND title != ?", [sec.id, PATTERN_SCHEDULE_TITLE], "ORDER BY createdAt");
    if (had) {
      // a run on Fable needs RANK_TOKENS_PER_RUN: below it the retainer watch stops every run short, so it is raised and asked again
      const cur = had.status !== "ended" && had.lane === "retainer" && had.tokensPerRun < RANK_TOKENS_PER_RUN
        ? raiseRetainerPerRun(this.world, had, RANK_TOKENS_PER_RUN, `the ranking run moved to ${SECRETARY_MODEL} and needs ${RANK_TOKENS_PER_RUN.toLocaleString("en-US")} per run`, at)
        : had;
      if (cur !== had) console.log(`[secretary] raised "${cur.title}" (${cur.id}) from ${had.tokensPerRun} to ${cur.tokensPerRun} tokens per run; retainer ${cur.retainer}`);
      if (cur.description === RANK_RUN_PROMPT && cur.model === SECRETARY_MODEL && cur.title === RANK_SCHEDULE_TITLE) return cur;
      return this.world.schedules.patch(cur.id, { title: RANK_SCHEDULE_TITLE, description: RANK_RUN_PROMPT, model: SECRETARY_MODEL });
    }
    const s = createSchedule(this.world, th.id, { kind: "agent", id: sec.id }, {
      title: RANK_SCHEDULE_TITLE, description: RANK_RUN_PROMPT, repeat: { dailyAt: [RANK_AT] },
      tokensPerRun: RANK_TOKENS_PER_RUN, takerId: sec.id,
      gap: "The humans' open asks need a daily order and a money slate (docs/legible-delegation.md §6; grant gr_kdlogzzo5s)",
    }, null, at);
    // the Town Hall's fork models don't name Fable: the Secretary's own runs are on it by design, so it is set here
    return this.world.schedules.patch(s.id, { model: SECRETARY_MODEL });
  }

  /** The weekly pattern schedule, made once (never again once one exists), on SECRETARY_MODEL, its own retainer. */
  ensurePatternSchedule(at: Date = new Date()): Schedule | null {
    const sec = this.agent();
    const th = this.world.buildings.get(TOWN_HALL_ID);
    if (!sec || !th) return null;
    const had = this.world.schedules.first("takerId = ? AND title = ?", [sec.id, PATTERN_SCHEDULE_TITLE], "ORDER BY createdAt");
    if (had) return had.description === PATTERN_RUN_PROMPT ? had : this.world.schedules.patch(had.id, { description: PATTERN_RUN_PROMPT });
    const s = createSchedule(this.world, th.id, { kind: "agent", id: sec.id }, {
      title: PATTERN_SCHEDULE_TITLE, description: PATTERN_RUN_PROMPT, repeat: { everyHours: 24 * 7, until: new Date(at.getTime() + PATTERN_DAYS * 24 * 3_600_000).toISOString() },
      tokensPerRun: PATTERN_TOKENS_PER_RUN, takerId: sec.id,
      gap: "The \"step back\" work never comes from a leaf: a weekly note of convergences and repeats (docs/legible-delegation.md §6)",
    }, null, at);
    return this.world.schedules.patch(s.id, { model: SECRETARY_MODEL });
  }

  /** The policy ledger, created once (server boot): a Town Hall doc of type `policy`. Null before the Town Hall exists. */
  ensurePolicyLedger(): Doc | null {
    const have = policyLedger(this.world);
    if (have) return have;
    const th = this.world.buildings.get(TOWN_HALL_ID);
    if (!th) return null;
    const by = this.agent();
    return createDoc(this.world, {
      type: "policy", state: "building", buildingId: th.id, title: "Policy ledger", tags: ["policy-ledger"],
      authorId: by?.id ?? th.createdBy ?? "system", authorKind: by ? "agent" : "user",
      body: `${LEDGER_HEAD}\n`,
    }, "The policy ledger opened in the Town Hall");
  }

  /**
   * A human decided on a Town Hall ask (1:1 mt_msnjkpgwdb decision 10: "take every user decision made on this queue …
   * potentially answer some cards that logically follow from the decision, rerank"): one Secretary run, debounced. The
   * first decision queues a run that waits DECISION_RUN_DEBOUNCE_MS; decisions that land while it waits add a line to
   * it (one pending run at a time); a decision during a run queues one more. It is a run of the ranking schedule's
   * retainer (lane retainer, capped per run, at most DECISION_RUNS_PER_DAY a day), so nothing is queued while that
   * retainer is not approved, the Secretary is stopped, or no ask is left open. Returns the run, or null.
   */
  afterDecision(d: { askId?: string | null; targetKind?: string | null; targetId?: string | null; text: string; by?: string | null }, at: Date = new Date()): Assignment | null {
    const world = this.world;
    const sec = this.agent();
    const s = rankSchedule(world);
    if (!sec || sec.status === "stopped" || isGone(sec) || !s || s.retainer !== "funded") return null;
    if (!rankedAsks(world).length) return null;
    const line = `- ${stamp(at.toISOString())}: ${oneLine(d.text, 300)}${d.askId ? ` (ask ${d.askId})` : ""}${d.targetId ? ` (about ${d.targetId})` : ""}`;
    const pending = world.assignments.first("agentId = ? AND status = 'pending' AND title = ?", [sec.id, DECISION_RUN_TITLE], "ORDER BY createdAt DESC, rowid DESC");
    if (pending) return pending.description.includes(line) ? pending : world.assignments.upsert({ ...pending, description: `${pending.description}\n${line}`.slice(0, 20_000), updatedAt: at.toISOString() });
    const today = `${at.toISOString().slice(0, 10)}T00:00:00.000Z`;
    if (world.assignments.count("agentId = ? AND title = ? AND createdAt >= ?", [sec.id, DECISION_RUN_TITLE, today]) >= DECISION_RUNS_PER_DAY) return null;
    const user = d.by?.startsWith("us_") ? d.by : null;
    return createAssignment(world, {
      agentId: sec.id, title: DECISION_RUN_TITLE, description: `${DECISION_RUN_PROMPT}\n\n${DECIDED_HEAD}\n${line}`, createdBy: { kind: "system", id: s.id }, buildingId: s.buildingId,
      lane: { lane: "retainer", gap: s.gap ?? undefined, sourceId: s.id }, origin: user ? humanOrigin(user, d.askId ?? d.targetId ?? s.id, at.toISOString()) : null, model: s.model,
      waitFor: { after: new Date(at.getTime() + DECISION_RUN_DEBOUNCE_MS).toISOString() },
    });
  }

  /** The Secretary's part of a 1:1 prompt (null when the 1:1 is with anyone else). */
  brief(m: Meeting): string | null {
    const s = this.agent();
    if (!s || m.facilitatorId !== s.id) return null;
    // act_in_1on1 (step 1, PR #300) cites a human line by its exact ISO `at` and refuses lines older than 30 min
    const since = Date.now() - 30 * 60_000;
    const said = m.transcript.filter((u) => u.speakerId === m.withUserId && Date.parse(u.at) >= since)
      .map((u) => `- at ${u.at}: "${oneLine(u.text, 300)}"`).join("\n");
    const asks = rankedAsks(this.world);
    const lines = asks.slice(0, 30).map((a) => `- ${a.id} (${a.type}${a.rank ? `, #${a.rank}` : ""}${a.status === "deferred" ? `, deferred until ${a.deferredUntil}` : ""}): ${oneLine(a.title, 140)}`);
    if (asks.length > 30) lines.push(`… and ${asks.length - 30} more (\`rank\` lists them all).`);
    return `${ONE_ON_ONE}\n\nThe human's lines from the last 30 min (cite one by its exact \`at\` as utteranceAt; for anything newer read \`meeting\` status):\n${said || "(none)"}\n\nOpen asks now, in rank order:\n${lines.join("\n") || "(none)"}`;
  }
}

// ---- the policy ledger ----

const LEDGER_HEAD = "# Policy ledger\n\nOne rule per line, with where it came from. The managers read it in every session, so they don't ask what a rule already answers. A line is added only when a human decides \"Add this rule to the ledger?\" (the Secretary proposes them); a human edits or deletes a line here to change the rule.";
const LEDGER_ADD = "ledger-add";

function policyLedger(world: World): Doc | undefined {
  return world.docs.first("type = 'policy' AND buildingId = ?", [TOWN_HALL_ID], "ORDER BY createdAt, rowid");
}

/** The ledger's rules, one `- ` line each. */
function ledgerRules(world: World): string[] {
  return (policyLedger(world)?.body ?? "").split("\n").filter((l) => l.startsWith("- "));
}

/**
 * The ledger as pinned in every manager's prompt (docs/legible-delegation.md §6): its rules, or "" when it has none. It
 * changes only when a human adds or edits a rule, so it may sit in a cached prompt (docs/prompt-caching.md).
 */
export function policyLedgerBlock(world: World): string {
  const rules = ledgerRules(world);
  if (!rules.length) return "";
  return `## Policy ledger (rules the humans set; follow them and don't ask what a rule already answers)\n${rules.join("\n")}`;
}

/**
 * File the policy ask "Add this rule to the ledger?" (the Secretary's; it never appends on its own): the proposed line
 * `- <rule> (origin: <id>, <date>)` as its body, branches Add / Skip. One live ask per origin (a second folds in).
 */
function proposeRule(world: World, p: { rule: string; origin: string; buildingId?: string | null; sourceDocId?: string | null; why: string }): Ask {
  const line = `- ${oneLine(p.rule, 300)} (origin: ${p.origin}, ${utcDate(nowIso())})`;
  return createAsk(world, {
    type: "policy", targetKind: "rule", targetId: `ledger:${p.origin}`, buildingId: p.buildingId ?? null, sourceDocId: p.sourceDocId ?? null,
    by: world.secretary.agent()?.id ?? "system", title: `Add this rule to the ledger? ${oneLine(p.rule, 150)}`, line: p.why,
    body: line, branches: [{ label: "Add", action: LEDGER_ADD }, { label: "Skip", action: "ledger-skip" }],
    recommendation: "",
  }).ask;
}

const isLedgerAsk = (a: Ask) => a.branches.some((b) => b.action === LEDGER_ADD);

/** Append a decided line to the ledger (`policy.added`). */
function appendRule(world: World, line: string, askId: string): void {
  const doc = world.secretary.ensurePolicyLedger();
  if (!doc) throw new AppError("conflict", "There is no Town Hall to keep the policy ledger in.");
  if (ledgerRules(world).includes(line)) return;
  updateDoc(world, doc.id, { body: `${doc.body.trimEnd()}\n${line}\n` });
  world.events.append({ type: "policy.added", buildingId: TOWN_HALL_ID, text: `Policy ledger: ${oneLine(line.slice(2), 200)}`, payload: { docId: doc.id, askId, line } });
}

/**
 * After a human decides an ask (`decideAsk`): an "Add this rule?" ask decided "Add" appends its line (or "Add: <words>"
 * appends their words with the same origin). Deciding any other policy ask files no ledger ask: a ledger line is
 * proposed only when a human asks for a standing rule (Mitchell's 1:1 mt_msnjkpgwdb, decisions 6 and 8).
 */
export function onAskDecided(world: World, a: Ask): void {
  const said = (a.decision ?? "").trim();
  if (isLedgerAsk(a)) {
    const add = /^add\b(?:\s*:\s*(.+))?/is.exec(said);
    if (!add) return;
    const words = (add[1] ?? "").trim();
    const line = words ? a.body.replace(/^- .*? \(origin: /, `- ${oneLine(words, 300)} (origin: `) : a.body;
    appendRule(world, line.split("\n")[0]!, a.id);
  }
}

// ---- settling a rollup on submit ----

/**
 * After a rollup is filed (`submit_report` with `rollup: true`, after its asks): a `shipped` notice per Shipped item,
 * the closed loop of each grant it closes as done (its close report now linked), and archive it (system) when it asks
 * nothing of its own (no live ask has it as its record: every ask folded into another, or none) and it is no grant's
 * close or checkpoint report. A rollup that still asks something stays pending until its asks are decided. Returns
 * whether it archived it.
 */
export function settleRollup(world: World, doc: Doc, closed: Grant[]): boolean {
  shippedNotices(world, doc);
  for (const g of closed) closedLoopNotice(world, world.grants.require(g.id, "grant"), world.grantDesk.spent(g.id));
  const d = world.docs.require(doc.id, "doc");
  if (d.decision !== "pending" || closed.length || world.grants.exists("checkpointDocId = ?", [d.id])) return false;
  if (world.asks.exists("sourceDocId = ? AND status IN ('open', 'deferred')", [d.id])) return false;
  // its asks folded into asks already open on their targets: acknowledged as folded (the targets' rows show its line)
  const into = [...new Set(world.asks.where("status IN ('open', 'deferred') AND sources LIKE ?", [`%"${d.id}"%`]).map((a) => a.targetId ?? a.id))];
  if (into.length) foldRollup(world, d, into);
  else archiveReport(world, null, d.id);
  return true;
}

// ---- the ranking run ----

/** Why a ranking run has nothing to do (null = it has): no open asks, or no ask arrived since the last ranking. */
export function rankNothingNew(world: World): string | null {
  const asks = rankedAsks(world);
  if (!asks.length) return "no open asks";
  const last = world.events.latestWith("ask.ranked", "ranked");
  if (last && !asks.some((a) => a.createdAt > last.ts || a.updatedAt > last.ts)) return "no ask arrived or changed since the last ranking";
  return null;
}

/** Why the Secretary's due run has nothing to do (fireSchedules skips it before any session), or null. */
export function secretaryIdleReason(world: World, s: Schedule, at: Date): string | null {
  if (s.title === PATTERN_SCHEDULE_TITLE) return weekIsEmpty(world, at) ? "nothing happened this week" : null;
  return rankNothingNew(world);
}

/** The Secretary's ranking schedule, if it is still active. */
function rankSchedule(world: World): Schedule | undefined {
  const sec = world.secretary.agent();
  return sec ? world.schedules.first("takerId = ? AND status = 'active' AND title != ?", [sec.id, PATTERN_SCHEDULE_TITLE], "ORDER BY createdAt") : undefined;
}

/** The ranking run under way (queued, running or parked), if any: its schedule's or a pressed one. */
function liveRankRun(world: World, s: Pick<Schedule, "id">): Assignment | undefined {
  return world.assignments.first("lane = 'retainer' AND sourceId = ? AND status IN ('pending', 'active')", [s.id], "ORDER BY createdAt");
}

/** The "Rank now" button for a viewer who may press it (null for anyone else, or with no active ranking schedule). */
export function rankRunView(world: World, viewer: Agent | undefined): DigestRunView | null {
  const s = rankSchedule(world);
  if (!s || !canDecideRetainer(world, viewer, s)) return null;
  const live = liveRankRun(world, s);
  const refused = live ? "a ranking run is under way: the ranks and the slate land here when it finishes"
    : s.retainer !== "funded" ? `the ranking's retainer is ${s.retainer}, not approved`
    : rankNothingNew(world);
  return { scheduleId: s.id, runningId: live?.id ?? null, refused };
}

/**
 * The in-tray's "Rank now" button (it was "Daily digest", Mitchell 1:1 mt_i50xwu4z2t): one ranking run now, the
 * schedule's own prompt and model, booked as a run of its retainer (lane retainer, sourceId = the schedule; the
 * schedule's next run does not move). Only a human who can decide the retainer presses it; refused while a run is under
 * way, while the retainer isn't funded, or when nothing changed since the last ranking.
 */
export function pressRank(world: World, actor: Agent, at: Date = new Date()): Assignment {
  const sec = world.secretary.agent();
  const s = rankSchedule(world);
  if (!sec || !s) throw new AppError("conflict", "There is no active ranking schedule to run.");
  if (!canDecideRetainer(world, actor, s)) throw forbidden("building.fund", "Only a human who can decide the Town Hall's retainers runs the ranking.");
  if (sec.status === "stopped" || isGone(sec)) throw new AppError("conflict", `${sec.name} is stopped: nobody can run the ranking.`);
  if (s.retainer !== "funded") throw new AppError("conflict", `The ranking's retainer is ${s.retainer}, not approved: approve it in the in-tray first.`);
  const live = liveRankRun(world, s);
  if (live) throw new AppError("conflict", `A ranking run is already under way (${live.id}): its ranks and slate land in the in-tray when it finishes.`);
  const idle = rankNothingNew(world);
  if (idle) throw new AppError("conflict", `Nothing to rank: ${idle}.`);
  const by = holderOf(actor);
  return world.transaction(() => {
    const a = createAssignment(world, {
      agentId: sec.id, title: `${s.title} (run now)`, description: s.description, createdBy: { kind: "system", id: s.id }, buildingId: s.buildingId,
      lane: { lane: "retainer", gap: s.gap ?? undefined, sourceId: s.id }, origin: humanOrigin(by.id, s.id, at.toISOString()), model: s.model,
    });
    // the schedule's next fire skips while this run is under way (fireSchedules checks lastAssignmentId)
    world.schedules.patch(s.id, { lastAssignmentId: a.id, updatedAt: at.toISOString() });
    world.events.append({ type: "schedule.fired", agentId: sec.id, buildingId: s.buildingId, text: `${world.nameOf(actor.id)} ran "${truncate(s.title, 80)}" now: ${sec.name} takes it`, payload: { scheduleId: s.id, assignmentId: a.id, queue: "agent", pressedBy: by.id } });
    return a;
  });
}

const MONEY_ACTIONS: Record<string, string> = { fund: "funded", reject: "rejected", counter: "countered", continue: "continued", adjust: "adjusted", cut: "cut", stop: "stopped" };

/** The `rank` tool's read: every live ask in rank order, then the humans' recent money decisions with their notes. */
export function rankInputsText(world: World, now: Date = new Date()): string {
  const asks = rankedAsks(world);
  if (!asks.length) return "Nothing to rank: no open asks. submit_report (verdict stop) now.";
  const name = (id: string | null) => (id ? world.buildings.get(id)?.name ?? id : "Town");
  const list = asks.map((a, i) => [
    `${i + 1}. ${a.id} · ${a.type} · ${name(a.buildingId)} · waiting since ${whenFor(a.createdAt, "agent", now)}${a.rank ? ` · now #${a.rank}` : ""}${a.status === "deferred" ? ` · deferred until ${a.deferredUntil}` : ""}${a.targetId ? ` · about ${a.targetId}` : ""}`,
    `   ${oneLine(a.title, 200)}`,
    a.body.trim() ? `   ${oneLine(a.body, 400)}` : "",
    `   Branches: ${a.branches.map((b) => b.label).join(" / ") || "(none)"}${a.recommendation ? ` · Recommended: ${oneLine(a.recommendation, 200)}` : ""}`,
    a.sources.length ? `   Raised in: ${a.sources.map((s) => `${s.docId} "${oneLine(s.line, 100)}"`).join("; ")}` : "",
  ].filter(Boolean).join("\n"));
  const decisions = world.grants.where("history LIKE '%\"byKind\":\"user\"%'", [], "ORDER BY updatedAt DESC LIMIT 60")
    .flatMap((g) => g.history.filter((h) => h.byKind === "user" && MONEY_ACTIONS[h.action]).map((h) => ({ g, h })))
    .sort((a, b) => b.h.at.localeCompare(a.h.at)).slice(0, 30)
    .map(({ g, h }) => `- ${utcDate(h.at)} ${world.nameOf(h.byId)} ${MONEY_ACTIONS[h.action]} ${g.id} (${name(g.buildingId)}, "${grantName(g)}")${h.tokens ? ` at ${fmt(h.tokens)}` : ""}${h.note.trim() ? `: "${oneLine(h.note, 200)}"` : ""}`);
  const decided = world.asks.where("status = 'decided'", [], "ORDER BY decidedAt DESC LIMIT 15").map((a) => `- ${a.id} (${a.type}) "${oneLine(a.title, 100)}": ${oneLine(a.decision ?? "", 120)}`);
  const since = decidedSinceRanking(world, asks);
  return [
    `Open asks (${asks.length}), in their current order:\n\n${list.join("\n\n")}`,
    `Decided since the last ranking, and the open asks each may have overtaken (candidates: judge each; close one only when a human has nothing left to decide on it):\n${since.join("\n") || "(none)"}`,
    `The humans' recent money decisions (newest first):\n${decisions.join("\n") || "(none yet)"}`,
    `Asks the humans decided lately:\n${decided.join("\n") || "(none yet)"}`,
  ].join("\n\n");
}

/**
 * The humans' decisions since the last ranking (an ask decided, or retired by a human's decision on its item), oldest
 * first, each with the open asks it may have overtaken (`overtakeCandidates`, pure). At most the last 30.
 */
function decidedSinceRanking(world: World, open: Ask[]): string[] {
  const last = world.events.latestWith("ask.ranked", "ranked");
  const facts: AskFacts[] = open.map((a) => ({ id: a.id, type: a.type, status: a.status, targetKind: a.targetKind, targetId: a.targetId, title: a.title, body: a.body, deferredUntil: a.deferredUntil }));
  const events = world.events.list({ types: ["ask.decided", "ask.retired"], since: last?.id ?? 0, limit: 1000 })
    .filter((e) => e.type === "ask.decided" || (e.payload.human === true && e.payload.overtaken !== true)).slice(-30);
  return events.map((e) => {
    const p = e.payload as { askId?: string; targetKind?: string | null; targetId?: string | null };
    const ask = p.askId ? world.asks.get(p.askId) : undefined;
    const d = { askId: p.askId ?? null, targetKind: p.targetKind ?? ask?.targetKind ?? null, targetId: p.targetId ?? ask?.targetId ?? null };
    const c = overtakeCandidates(d, facts);
    return `- ${stamp(e.ts)} ${oneLine(e.text, 220)}${d.askId ? ` (ask ${d.askId}${d.targetId ? `, about ${d.targetId}` : ""})` : ""}\n  → ${c.length ? `may have overtaken: ${c.map((a) => `${a.id} (${a.type}) "${oneLine(a.title, 80)}"`).join("; ")}` : "no open ask is on the same item or names it"}`;
  });
}

interface RankInput {
  overtaken?: { askId: string; because: string; note: string }[];
  order?: string[];
  slate?: { fund: { askId: string; why: string }[]; hold: { askId: string; until: string; why: string }[]; skip: { askId: string; why: string }[] };
  defer?: { askId: string; until: string }[];
}

/**
 * Apply a ranking run (the `rank` tool with order, slate or defer; only the Secretary), all or nothing: `order` sets each
 * listed live ask's rank 1..n and clears the rank of every live ask left out; `defer` parks each ask behind the ask or
 * item it is moot without (`deferAsk`); `slate` files the money slate as a `slate` notice citing the ask ids. Decides,
 * funds and approves nothing. Logs one `ask.ranked`.
 */
export function applyRank(world: World, by: Agent, input: RankInput, at: Date = new Date()): { ranked: number; deferred: string[]; slateId: string | null; note: string } {
  if (!world.secretary.isSecretary(by)) throw forbidden("building.fund", "Only the Town Hall's Secretary ranks the asks.");
  const live = new Map(rankedAsks(world).map((a) => [a.id, a]));
  // asks closed as overtaken in this call leave the queue first: they are in no order, slate or defer
  const closing = new Set<string>();
  for (const o of input.overtaken ?? []) {
    if (!live.has(o.askId)) throw badRequest(`overtaken: ${o.askId} is not an open ask.`);
    if (closing.has(o.askId)) throw badRequest(`overtaken: ${o.askId} is listed twice.`);
    closing.add(o.askId);
  }
  const order = input.order ?? [];
  const seen = new Set<string>();
  for (const id of order) {
    if (closing.has(id)) throw badRequest(`order: ${id} is being closed as overtaken in this call; leave it out of the order.`);
    if (!live.has(id)) throw badRequest(`order: ${id} is not an open ask (read \`rank\` again: it may have been decided or retired).`);
    if (seen.has(id)) throw badRequest(`order: ${id} is listed twice.`);
    seen.add(id);
  }
  for (const d of input.defer ?? []) {
    const a = live.get(d.askId);
    if (!a || a.status !== "open" || closing.has(d.askId)) throw badRequest(`defer: ${d.askId} is not an open ask.`);
    if (d.until === d.askId) throw badRequest(`defer: ${d.askId} can't wait behind itself.`);
    if (d.until.startsWith("ak_") && !live.has(d.until)) throw badRequest(`defer: ${d.until} is not a live ask to wait behind.`);
  }
  const s = input.slate;
  const slated = s ? [...s.fund, ...s.hold, ...s.skip].map((x) => x.askId) : [];
  const onSlate = new Set<string>();
  for (const id of slated) {
    const a = live.get(id);
    if (!a || closing.has(id)) throw badRequest(`slate: ${id} is not an open ask.`);
    if (a.type !== "money") throw badRequest(`slate: ${id} is a ${a.type} ask; the slate is for money asks only.`);
    if (onSlate.has(id)) throw badRequest(`slate: ${id} is on the slate twice (fund, hold and skip are exclusive).`);
    onSlate.add(id);
  }
  return world.transaction(() => {
    // decisions 10 and 20a: close what a human's decision made moot (click and policy asks only; `overtakeAsk` refuses the rest)
    const overtaken = (input.overtaken ?? []).map((o) => ({ ask: overtakeAsk(world, by, o.askId, o.because, o.note), ...o }));
    tellBuildingsOvertaken(world, by, overtaken);
    if (input.order) {
      order.forEach((id, i) => setRank(world, id, i + 1));
      for (const id of live.keys()) if (!seen.has(id) && !closing.has(id)) setRank(world, id, null);
    }
    const deferred = (input.defer ?? []).map((d) => deferAsk(world, by, d.askId, d.until).id);
    let slate: Notice | null = null;
    if (s && slated.length) {
      const t = (id: string) => `${oneLine(live.get(id)!.title, 140)} (${id})`;
      const unslated = [...live.values()].filter((a) => a.type === "money" && !onSlate.has(a.id));
      const body = [
        s.fund.length ? `**Fund now**\n${s.fund.map((x) => `- ${t(x.askId)}: ${oneLine(x.why, 300)}`).join("\n")}` : "",
        s.hold.length ? `**Hold**\n${s.hold.map((x) => `- ${t(x.askId)} until ${oneLine(x.until, 200)}: ${oneLine(x.why, 300)}`).join("\n")}` : "",
        s.skip.length ? `**Skip**\n${s.skip.map((x) => `- ${t(x.askId)}: ${oneLine(x.why, 300)}`).join("\n")}` : "",
        unslated.length ? `_Not on the slate: ${unslated.map((a) => a.id).join(", ")}._` : "",
        "_A recommendation only: nothing is funded until you decide each ask._",
        // the town's health over the last 24 h (gr_8bxoy2heif), built here: no Secretary tokens
        healthLine(townHealth(world, at)),
      ].filter(Boolean).join("\n\n");
      slate = fileNotice(world, {
        kind: "slate", buildingId: TOWN_HALL_ID, goalId: null, picture: null, refs: slated, body,
        title: `Money slate ${utcDate(at)}: fund ${s.fund.length}, hold ${s.hold.length}, skip ${s.skip.length}`,
      });
    }
    world.events.append({ type: "ask.ranked", agentId: by.id, buildingId: TOWN_HALL_ID, text: `${by.name} ranked ${order.length} open ask${order.length === 1 ? "" : "s"}${overtaken.length ? `, closed ${overtaken.length} as overtaken` : ""}${deferred.length ? `, deferred ${deferred.length}` : ""}${slate ? `, filed the money slate ${slate.id}` : ""}`, payload: { ranked: order.length, deferred, slateId: slate?.id ?? null, overtaken: overtaken.map((o) => o.askId) } });
    return { ranked: order.length, deferred, overtaken: overtaken.map((o) => o.askId), slateId: slate?.id ?? null, note: `Done${overtaken.length ? `: closed ${overtaken.length} as overtaken` : ""}${slate ? `; the slate is ${slate.id}` : ""}. Now submit_report (verdict stop).` };
  });
}

/**
 * The filing building hears that the Secretary closed its asks as overtaken: one entry per building on its own thread
 * at level manager (it may be waiting on them), listing each ask, the decision that overtook it and the note.
 */
function tellBuildingsOvertaken(world: World, by: Agent, closed: { ask: Ask; because: string; note: string }[]): void {
  const byBuilding = new Map<string, typeof closed>();
  for (const c of closed) {
    const b = c.ask.buildingId;
    if (!b || b === TOWN_HALL_ID || !managerAgentOf(world, world.buildings.get(b))) continue;
    byBuilding.set(b, [...(byBuilding.get(b) ?? []), c]);
  }
  for (const [b, list] of byBuilding) {
    appendEntry(world, {
      jobId: `jb_${b}`, authorKind: "secretary", authorId: by.id, level: "manager",
      note: `${by.name} closed ${list.length} of your ask${list.length === 1 ? "" : "s"} as overtaken by a human's decision`,
      body: `${list.map((c) => `- ${c.ask.id} "${oneLine(c.ask.title, 120)}": overtaken by ${oneLine(c.because, 160)}. ${oneLine(c.note, 300)}`).join("\n")}\n\nNothing waits on a human for these any more. If one still needs a human, file it again with what changed.`,
      moved: { kind: "message", rule: "overtaken", askIds: list.map((c) => c.ask.id) },
    });
  }
}

/** Today's slate (UTC), the newest, if the Secretary filed one today: the review deck's first slide. */
export function todaysSlate(world: World, now: Date = new Date()): Notice | undefined {
  const n = world.notices.first("kind = 'slate'", [], "ORDER BY createdAt DESC, rowid DESC");
  return n && utcDate(n.createdAt) === utcDate(now) ? n : undefined;
}

// ---- the weekly pattern run ----

function weekIsEmpty(world: World, at: Date): boolean {
  const from = new Date(at.getTime() - WEEK_MS).toISOString();
  return !world.asks.exists("createdAt >= ?", [from]) && !world.docs.exists("type = 'report' AND tags LIKE '%\"rollup\"%' AND createdAt >= ?", [from]);
}

const NOTABLE = ["grant.proposed", "grant.checkpoint", "grant.closed", "ask.retired", "ask.folded", "ask.deferred", "schedule.skipped", "building.blocked", "kr.updated"] as const;

/** The `rank` tool's weekly read: the last 7 days of asks (and how each ended), rollups with their Shipped items, and events. */
export function weekInputsText(world: World, at: Date = new Date()): string {
  if (weekIsEmpty(world, at)) return "Nothing happened this week (no asks, no rollups). submit_report (verdict stop) now.";
  const from = new Date(at.getTime() - WEEK_MS).toISOString();
  const name = (id: string | null) => (id ? world.buildings.get(id)?.name ?? id : "Town");
  const asks = world.asks.where("createdAt >= ?", [from], "ORDER BY createdAt, rowid").map((a) =>
    `- ${utcDate(a.createdAt)} ${a.id} ${a.type} · ${name(a.buildingId)} · ${a.status}${a.decision ? ` "${oneLine(a.decision, 80)}"` : a.retiredBy ? ` (${oneLine(a.retiredBy, 80)})` : ""}${a.sources.length > 1 ? ` · raised ${a.sources.length} times` : ""}: ${oneLine(a.title, 140)}`);
  const rollups = world.docs.where("type = 'report' AND tags LIKE '%\"rollup\"%' AND createdAt >= ?", [from], "ORDER BY createdAt, rowid").map((d) => {
    const items = parseRollup(d.body).items.map((it) => oneLine(it.title, 80));
    return `- ${utcDate(d.createdAt)} ${d.id} ${name(d.buildingId)}: ${oneLine(d.title, 100)}${items.length ? ` · shipped: ${items.join("; ")}` : ""}`;
  });
  const events = world.events.list({ from, types: [...NOTABLE], limit: 400 });
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const notable = events.filter((e) => e.type !== "kr.updated").slice(-60).map((e) => `- ${utcDate(e.ts)} ${e.type} · ${name(e.buildingId)}: ${oneLine(e.text, 160)}`);
  return [
    `The week since ${whenFor(from, "agent", at)}.`,
    `Asks (${asks.length}):\n${asks.join("\n") || "(none)"}`,
    `Rollups (${rollups.length}):\n${rollups.join("\n") || "(none)"}`,
    `Events by kind: ${[...counts].map(([k, n]) => `${k} ${n}`).join(", ") || "(none)"}\n${notable.join("\n")}`,
  ].join("\n\n");
}

const CITED = /\b(?:ak|gr|dc|sc|kr|mt|cr|ar|nt)_[a-z0-9]+\b/g;

/** File the weekly pattern notice (the `rank` tool with `pattern`; only the Secretary); its rule, if any, as a policy ask. */
export function filePattern(world: World, by: Agent, p: { title: string; body: string; rule?: string }): { noticeId: string; askId: string | null; note: string } {
  if (!world.secretary.isSecretary(by)) throw forbidden("building.fund", "Only the Town Hall's Secretary files the pattern note.");
  return world.transaction(() => {
    const n = fileNotice(world, { kind: "pattern", buildingId: TOWN_HALL_ID, goalId: null, picture: null, title: oneLine(p.title, 160), body: p.body.trim(), refs: [...new Set(p.body.match(CITED) ?? [])] });
    const ask = p.rule ? proposeRule(world, { rule: p.rule, origin: n.id, sourceDocId: null, why: `The week's pattern note ${n.id}: ${oneLine(p.title, 120)}` }) : null;
    return { noticeId: n.id, askId: ask?.id ?? null, note: `Filed ${n.id}${ask ? ` and the policy ask ${ask.id}` : ""}. Now submit_report (verdict stop).` };
  });
}

// ---- reading a rollup's prose (the asks backfill and untyped rollups; kept from the digest) ----

const idsIn = (text: string, prefix: string) => [...new Set([...text.matchAll(new RegExp(`\\b${prefix}_[a-z0-9]+\\b`, "g"))].map((m) => m[0]))];
const MARK_MET = /\bmark(ed|ing)?\b[^.]*\b(met|missed)\b/i;
const FUND_ASK = /\b(fund|counter|reject|proposal|retainer|approve)\b/i;

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
    if (kr && (kr.status === "met" || kr.status === "met-unverified" || kr.status === "missed") && MARK_MET.test(call)) return `${id} is already ${kr.status === "met-unverified" ? "met, unverified" : kr.status}`;
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
 * A pending rollup's asks as read from its prose (rollupAsks: each Shipped item's real "Your call", then its Needs
 * lines), each with why it is overtaken (null = it still asks). A Needs line has no title.
 */
export function rollupCalls(world: World, d: Doc): { title: string; call: string; overtaken: string | null }[] {
  const p = parseRollup(d.body);
  return rollupAsks(p).map((a) => {
    const it = a.n ? p.items[a.n - 1] : undefined;
    return { title: a.title, call: a.call, overtaken: it ? overtakenReason(world, it, d) : needsOvertaken(world, a.call, d) };
  });
}
