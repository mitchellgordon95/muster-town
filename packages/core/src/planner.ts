/**
 * The Planner's calibration run (docs/legible-delegation.md §7.4, build step 9). The Planner (the Town Hall's manager)
 * watches the §9 budget signals (measures.ts) on a weekly schedule of its own, on Fable, and when one crosses its line
 * files at most one policy ask (targetKind "rule") with the data and one concrete change to the step-size table: raise
 * or lower a size, or require a size to split. It never edits the table itself: a human decides the ask, and "Adopt"
 * applies the change through the same path `PUT /api/town/defaults` uses (`World.setGrantPricing`) and logs it. A run
 * with no line crossed (or with a calibration ask still waiting) is skipped before any session starts.
 */
import { askStructure, grantPricingOf, type Agent, type Ask, type CalibrationProposal, type Schedule, type StepSize, type StepSizeTable } from "@muster-town/schema";
import { refuseMissingStructure } from "./asks.ts";
import { askOnOwnNeed } from "./ask-verb.ts";
import { AppError, badRequest } from "./errors.ts";
import { holdSample, type HoldSample } from "./grant-estimate.ts";
import { legibleMeasures, type LegibleMeasures } from "./measures.ts";
import { holderOf } from "./permissions.ts";
import { createSchedule } from "./schedules.ts";
import { stamp } from "./time.ts";
import { TOWN_HALL_ID } from "./world/layout.ts";
import type { World } from "./world.ts";

/** The Planner's lines (§12 question 6 defaults): crossing one files a calibration ask. */
export const PLANNER_LINES = {
  /** a size's spent over size outside this band… */
  sizeRatioLow: 0.7,
  sizeRatioHigh: 1.3,
  /** …over at least this many completed steps of that size */
  sizeMinSample: 30,
  /** more than this share of the grants closed in the window held before they closed */
  holdShareMax: 0.25,
  /** more than this many adjust asks (holds and projected overruns) per grant funded in the window */
  topUpsPerGrantMax: 0.5,
} as const;

/** The calibration run's model: Fable, for the judgment work (§10). */
const PLANNER_MODEL = "claude-fable-5-1";
/** One run reads the measures and writes one card: est. 50,000 Bank tokens on Fable. */
const CALIBRATION_TOKENS_PER_RUN = 50_000;
const CALIBRATION_TITLE = "Weekly calibration";
/** The schedule runs this many days, then is renewed on purpose (MAX_SCHEDULE_DAYS). */
const CALIBRATION_DAYS = 90;
/** The one live calibration ask's target: a second run's ask would fold into it, so a run waits while it is open. */
const CALIBRATION_TARGET = "step-sizes";
const ADOPT = "adopt-calibration";

const fmt = (n: number) => n.toLocaleString("en-US");
const SIZES: readonly StepSize[] = ["S", "M", "L"];
const round10k = (n: number) => Math.max(10_000, Math.round(n / 10_000) * 10_000);

/** The lines crossed now, each in words; [] = none. */
function crossedLines(m: LegibleMeasures): string[] {
  const L = PLANNER_LINES;
  const out: string[] = [];
  for (const s of SIZES) {
    const r = m.spentOverSize[s];
    if (r.ratio !== null && r.sample >= L.sizeMinSample && (r.ratio < L.sizeRatioLow || r.ratio > L.sizeRatioHigh)) {
      out.push(`${s} steps spend ${r.ratio.toFixed(2)}× their size over ${r.sample} completed steps, outside ${L.sizeRatioLow}-${L.sizeRatioHigh}`);
    }
  }
  const h = m.holdShare;
  if (h.share !== null && h.share > L.holdShareMax) out.push(`${h.held} of ${h.closed} grants closed in ${m.windowDays} days held before they closed (${Math.round(h.share * 100)}%), over ${Math.round(L.holdShareMax * 100)}%`);
  const t = m.topUpsPerFundedGrant;
  if (t.ratio !== null && t.ratio > L.topUpsPerGrantMax) out.push(`${t.topUps} adjust asks for ${t.funded} grants funded in ${m.windowDays} days (${t.ratio} per grant), over ${L.topUpsPerGrantMax}`);
  return out;
}

/** Draws per grant in the hold projection; the seed is fixed so every candidate table meets the same draws. */
const HOLD_DRAWS = 400;
const HOLD_SEED = 20261123;
/** mulberry32: a small deterministic PRNG, so the same data always projects the same share. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * The share of grants a table would hold (gr_1ilvotnzta): a bootstrap over the grants funded in the last 30 days, each
 * with its real step mix. Each draw prices every step at a done step's real spend of its size (spent ÷ size × today's
 * table, drawn with replacement; a size with no done step spends its price) and holds when the steps' spend passes the
 * ceiling `table` (× 1 + `margin`) would give. Step spend only: PR-fix and resume sessions booked outside a step are not
 * in it. Null with no grant to draw from.
 */
export function projectHoldShare(sample: HoldSample, today: StepSizeTable, table: StepSizeTable, margin = 0): number | null {
  if (!sample.mixes.length) return null;
  const next = rng(HOLD_SEED);
  let held = 0;
  for (const mix of sample.mixes) {
    const ceiling = mix.reduce((n, s) => n + table[s], 0) * (1 + margin);
    for (let d = 0; d < HOLD_DRAWS; d++) {
      let spent = 0;
      for (const s of mix) { const xs = sample.ratios[s]; spent += (xs.length ? xs[Math.floor(next() * xs.length)]! : 1) * today[s]; }
      if (spent > ceiling) held++;
    }
  }
  return Math.round((held / (sample.mixes.length * HOLD_DRAWS)) * 100) / 100;
}

/** How hot a size runs: its mean spent ÷ size (a ceiling is a sum, and a sum follows the mean), else its median. */
const heat = (r: LegibleMeasures["spentOverSize"][StepSize]) => r.mean ?? r.ratio;

/** The smallest raise of `size`, in 10,000 steps up to the next size's price, that projects a hold share at or under the line (null: none does). */
function smallestRaise(sample: HoldSample, table: StepSizeTable, size: StepSize): { to: number; after: number } | null {
  const cap = size === "S" ? table.M : size === "M" ? table.L : table.L * 2;
  for (let to = round10k(table[size]) + 10_000; to <= cap; to += 10_000) {
    if (to <= table[size]) continue;
    const after = projectHoldShare(sample, table, { ...table, [size]: to });
    if (after !== null && after <= PLANNER_LINES.holdShareMax) return { to, after };
  }
  return null;
}

/** The smallest ceiling margin, in 5% steps up to 100%, that projects a hold share at or under the line, with the ceiling tokens it adds over the sample (null: none does). */
export function cheapestMargin(sample: HoldSample, table: StepSizeTable): { margin: number; after: number; tokens: number } | null {
  const ceilings = sample.mixes.reduce((n, mix) => n + mix.reduce((k, s) => k + table[s], 0), 0);
  for (let pct = 5; pct <= 100; pct += 5) {
    const after = projectHoldShare(sample, table, table, pct / 100);
    if (after !== null && after <= PLANNER_LINES.holdShareMax) return { margin: pct / 100, after, tokens: Math.round((ceilings * pct) / 100) };
  }
  return null;
}

/** The ceiling tokens a size change adds over the sample: its steps in the sampled mixes × the change. */
const raiseTokens = (sample: HoldSample, p: CalibrationProposal) => (p.to === null ? 0 : sample.mixes.reduce((n, mix) => n + mix.filter((s) => s === p.size).length, 0) * (p.to - p.from));

/**
 * The one change the town proposes for the crossed lines (null with none crossed). A size outside its band: set it to
 * its table value × its median ratio (to the nearest 10,000), the size furthest out first. Holds or adjust asks over
 * their line: raise the hottest S or M (by mean spent ÷ size, sample of 3 or more) by the smallest step of 10,000 whose
 * projected hold share (`projectHoldShare` over `sample`) meets the hold line; with no sample, price it at its mean.
 * It never proposes a size's current value: when no raise does it, or L runs hottest, or no size runs hot, it requires
 * L steps to split (sizes priced right but steps too big, §7.3's slicing rule). Each proposal carries the projected
 * hold share before and after (null without a sample; after is null for a split).
 */
export function calibrationProposal(m: LegibleMeasures, table: StepSizeTable, sample: HoldSample | null = null): CalibrationProposal | null {
  const L = PLANNER_LINES;
  const lines = crossedLines(m);
  if (!lines.length) return null;
  const holdBefore = sample ? projectHoldShare(sample, table, table) : null;
  const change = (size: StepSize, to: number, after?: number | null): CalibrationProposal => ({
    kind: "step-size", change: to > table[size] ? "raise" : "lower", size, from: table[size], to, line: lines[0]!,
    holdBefore, holdAfter: after !== undefined ? after : sample ? projectHoldShare(sample, table, { ...table, [size]: to }) : null,
  });
  const out = SIZES.filter((s) => { const r = m.spentOverSize[s]; return r.ratio !== null && r.sample >= L.sizeMinSample && (r.ratio < L.sizeRatioLow || r.ratio > L.sizeRatioHigh); })
    .sort((a, b) => Math.abs(m.spentOverSize[b].ratio! - 1) - Math.abs(m.spentOverSize[a].ratio! - 1));
  for (const s of out) {
    const to = round10k(table[s] * m.spentOverSize[s].ratio!);
    if (to !== table[s]) return change(s, to);
  }
  const hot = SIZES.filter((s) => (heat(m.spentOverSize[s]) ?? 0) > 1 && m.spentOverSize[s].sample >= 3).sort((a, b) => heat(m.spentOverSize[b])! - heat(m.spentOverSize[a])!)[0];
  if (hot && hot !== "L") {
    // the step-only bootstrap already under the line explains none of the holds: no raise is priced from it
    if (sample?.mixes.length && holdBefore !== null && holdBefore > L.holdShareMax) {
      const r = smallestRaise(sample, table, hot);
      if (r) return change(hot, r.to, r.after);
    } else {
      const to = round10k(table[hot] * heat(m.spentOverSize[hot])!);
      if (to > table[hot]) return change(hot, to);
    }
  }
  return { kind: "step-size", change: "split", size: "L", from: table.L, to: null, line: lines[0]!, holdBefore, holdAfter: null };
}

const pct = (x: number | null) => (x === null ? "none" : `${Math.round(x * 100)}%`);

/** The proposal as one sentence: "Raise S from 50,000 to 120,000 tokens. Projected hold share 46% → 23%." / "Require every L step to be split in two." */
function proposalSentence(p: CalibrationProposal): string {
  const head = p.change === "split" ? `Require every ${p.size} step to be split in two.` : `${p.change === "raise" ? "Raise" : "Lower"} ${p.size} from ${fmt(p.from)} to ${fmt(p.to!)} tokens.`;
  return p.holdBefore !== null && p.holdBefore !== undefined && p.holdAfter !== null && p.holdAfter !== undefined ? `${head} Projected hold share ${pct(p.holdBefore)} → ${pct(p.holdAfter)}.` : head;
}

const liveCalibrationAsk = (world: World) => world.asks.first("targetKind = 'rule' AND targetId = ? AND status IN ('open', 'deferred')", [CALIBRATION_TARGET]);

/** What a calibration run reads: the measures, the lines, which are crossed and the town's one proposed change. */
function calibrationBrief(world: World, at: Date): string {
  const m = legibleMeasures(world, at);
  const table = grantPricingOf(world.town.get()).stepSizes;
  const L = PLANNER_LINES;
  const lines = crossedLines(m);
  const sample = holdSample(world, at);
  const p = calibrationProposal(m, table, sample);
  const size = (s: StepSize) => {
    const r = m.spentOverSize[s];
    if (r.ratio === null) return `${s} no completed step`;
    const more = [r.mean != null && `mean ${r.mean.toFixed(2)}×`, r.p75 != null && `p75 ${r.p75.toFixed(2)}×`].filter(Boolean).join(", ");
    return `${s} median ${r.ratio.toFixed(2)}×${more ? `, ${more}` : ""} over ${r.sample} steps`;
  };
  const margin = p && p.change !== "split" && p.holdBefore !== null ? cheapestMargin(sample, table) : null;
  const projected = p?.holdBefore != null
    ? `Projected hold share, a bootstrap of the ${sample.mixes.length} grants funded in 30 days with their real step mixes (step spend only): ${pct(p.holdBefore)} with today's table${p.holdAfter != null ? `, ${pct(p.holdAfter)} with the change (it adds ${fmt(raiseTokens(sample, p))} ceiling tokens over those grants)` : ""}.${margin ? ` A ${Math.round(margin.margin * 100)}% margin on every ceiling instead would project ${pct(margin.after)} and add ${fmt(margin.tokens)} ceiling tokens${margin.tokens < raiseTokens(sample, p!) ? ": cheaper, but the table has no margin to adopt, so it is for the card's words only" : ""}.` : ""}`
    : null;
  return [
    `## Calibration data (computed ${stamp(at)})`,
    `Lines: a size spending outside ${L.sizeRatioLow}-${L.sizeRatioHigh}× its table value over at least ${L.sizeMinSample} completed steps; more than ${Math.round(L.holdShareMax * 100)}% of the grants closed in ${m.windowDays} days holding before they closed; more than ${L.topUpsPerGrantMax} adjust asks per grant funded in ${m.windowDays} days.`,
    `Size table: S ${fmt(table.S)}, M ${fmt(table.M)}, L ${fmt(table.L)}.`,
    `Spent over size, last 30 days: ${SIZES.map(size).join("; ")}.`,
    `Hold share, ${m.windowDays} days: ${m.holdShare.held} of ${m.holdShare.closed} closed grants held (${pct(m.holdShare.share)}).`,
    `Adjust asks per funded grant, ${m.windowDays} days: ${m.topUpsPerFundedGrant.topUps} for ${m.topUpsPerFundedGrant.funded} funded (${m.topUpsPerFundedGrant.ratio ?? "none"}).`,
    `Sessions per completed step: median ${m.sessionsPerStep.median ?? "none"} over ${m.sessionsPerStep.steps} steps. At gates now: ${m.heldAtGates.grants} grants holding ${fmt(m.heldAtGates.tokens)} tokens${m.heldAtGates.oldestHours !== null ? `, the oldest for ${m.heldAtGates.oldestHours} h` : ""}.`,
    `Crossed: ${lines.length ? lines.join("; ") : "none"}.`,
    `Proposed change: ${p ? proposalSentence(p) : "none"}`,
    ...(projected ? [projected] : []),
  ].join("\n");
}

/** Why a due calibration run has nothing to do (null = it has): a calibration ask still waits, or no line is crossed. */
function calibrationIdle(world: World, at: Date): string | null {
  if (liveCalibrationAsk(world)) return "a calibration ask is still waiting for a human";
  return crossedLines(legibleMeasures(world, at)).length ? null : "no line is crossed";
}

const isCalibrationSchedule = (world: World, s: Pick<Schedule, "takerId" | "title">) => !!s.takerId && s.takerId === world.reorgs.planner()?.id && s.title === CALIBRATION_TITLE;

/** fireSchedules: why the Planner's due calibration run is skipped (null for any other schedule, or when it has work). */
export function calibrationIdleReason(world: World, s: Schedule, at: Date): string | null {
  return isCalibrationSchedule(world, s) ? calibrationIdle(world, at) : null;
}

/** fireSchedules: the calibration run's instructions with the measures appended as they are when it fires (null for any other schedule). */
export function calibrationRunText(world: World, s: Schedule, at: Date): string | null {
  return isCalibrationSchedule(world, s) ? `${s.description}\n\n${calibrationBrief(world, at)}` : null;
}

/** The run's instructions: the schedule's description; the live data is appended when it fires. */
const CALIBRATION_RUN_PROMPT = `Weekly calibration run (you are the Planner, docs/legible-delegation.md §7.4). You watch the town's budget signals. When one crosses its line you file one policy ask for a human, with the data and one concrete change to the step-size table. You never change the table yourself.
1. Read "## Calibration data" below: the measures, the lines, which are crossed and the town's one proposed change (\`calibrate\` with no arguments reads them again now). If nothing is crossed, submit_report at once (verdict stop) and end.
2. Otherwise call \`calibrate\` with title, body and recommendation. It files one policy ask with the branches Adopt and Keep as is and the town's proposed change. The body is the card a human reads: sentences of at most 20 words, no ids, no semicolons, no parentheses. Say "adjust asks", never "top-ups". Write it as:
Rule: the change as one sentence, for example "Price an M step at 190,000 tokens."
The data: which line was crossed, by how much, over how many steps or grants, and the projected hold share before and after the change.
What I did: I applied nothing. The table stays as it is until you decide.
Reversing it: what changing it back costs.
If you adopt: what changes for the next proposals.
If you keep it: what stays, and when you will hear about it again.
The recommendation names the branch you recommend and why, in one sentence.
3. If \`calibrate\` refuses the card, fix the rules it names and call it again. Then submit_report (verdict stop) naming the ask id. File at most one ask. Don't read other docs or write pages.`;

/**
 * The Planner's weekly calibration schedule, made once: on the Town Hall, taken by the Planner, on Fable, on a retainer of
 * CALIBRATION_TOKENS_PER_RUN per run (asked in the decision queue: its runs start once a human approves). Never made
 * again once any calibration schedule of the Planner's exists; its description is kept equal to CALIBRATION_RUN_PROMPT.
 */
export function ensureCalibrationSchedule(world: World, at: Date = new Date()): Schedule | null {
  const th = world.buildings.get(TOWN_HALL_ID);
  if (!th) return null;
  const planner = world.reorgs.planner() ?? world.reorgs.ensurePlanner();
  const had = world.schedules.first("takerId = ? AND title = ?", [planner.id, CALIBRATION_TITLE], "ORDER BY createdAt");
  if (had) return had.description === CALIBRATION_RUN_PROMPT ? had : world.schedules.patch(had.id, { description: CALIBRATION_RUN_PROMPT });
  const s = createSchedule(world, th.id, { kind: "agent", id: planner.id }, {
    title: CALIBRATION_TITLE, description: CALIBRATION_RUN_PROMPT, repeat: { everyHours: 24 * 7, until: new Date(at.getTime() + CALIBRATION_DAYS * 24 * 3_600_000).toISOString() },
    tokensPerRun: CALIBRATION_TOKENS_PER_RUN, takerId: planner.id,
    gap: "The step-size table is recalibrated from data, proposed by the Planner and decided by a human (docs/legible-delegation.md §7.4)",
  }, null, at);
  // Fable whatever the Town Hall's fork models are (the Planner is a resident, not a fork)
  return world.schedules.patch(s.id, { model: PLANNER_MODEL });
}

/**
 * The `calibrate` verb (the Planner only). No card: the brief (measures, lines, crossed, proposal). With title, body and
 * recommendation: file the one policy ask on the step-size table with the town's proposal, its card vetted against the
 * policy contract's structure (refused when the rule is missing; style rules are warnings in its history). Refused when no line
 * is crossed or a calibration ask already waits.
 */
export function calibrate(world: World, me: Agent, input: { title?: string; body?: string; recommendation?: string }, at: Date = new Date()): { brief: string } | { askId: string; proposal: CalibrationProposal; note: string } {
  if (!world.reorgs.isPlanner(me)) throw new AppError("forbidden", "Only the Town Hall's Planner files a calibration ask.");
  if (!input.body?.trim()) return { brief: calibrationBrief(world, at) };
  if (!input.title?.trim() || !input.recommendation?.trim()) throw badRequest("Give title, body and recommendation to file the ask, or nothing to read the data.");
  const live = liveCalibrationAsk(world);
  if (live) throw new AppError("conflict", `A calibration ask already waits for a human (${live.id}): file at most one.`);
  const table = grantPricingOf(world.town.get()).stepSizes;
  const proposal = calibrationProposal(legibleMeasures(world, at), table, holdSample(world, at));
  if (!proposal) throw new AppError("conflict", "No line is crossed: there is nothing to propose. submit_report (verdict stop).");
  const branches = [{ label: "Adopt", action: ADOPT }, { label: "Keep as is", action: "keep" }];
  const card = { body: input.body, recommendation: input.recommendation, claims: [], branches, targetKind: "rule" };
  refuseMissingStructure("calibration", askStructure("policy", card));
  // the Planner is its card's author: its need goes on the Town Hall's thread and is rendered at once (decision 7)
  const ask = askOnOwnNeed(world, {
    need: "rule", targetKind: "rule", targetId: CALIBRATION_TARGET, type: "policy", branches, jobId: `jb_${TOWN_HALL_ID}`, authorKind: "manager",
    note: proposalSentence(proposal), body: input.body,
  }, { title: input.title, body: input.body, recommendation: input.recommendation, claims: [] }, me.id, proposal);
  return { askId: ask.id, proposal, note: `Filed ${ask.id} in the decision queue. Now submit_report (verdict stop) naming it.` };
}

const adopts = (a: Ask, said: string) => !!a.proposal && a.targetKind === "rule" && /^adopt\b/i.test(said);

/** decideAsk, before it decides: adopting a table change is an admin's (it is `PUT /api/town/defaults`' change). */
export function requireRuleDecider(world: World, actor: Agent, a: Ask, said: string): void {
  if (adopts(a, said) && !world.permissions.isAdmin(holderOf(actor))) throw new AppError("forbidden", "Only an admin adopts a change to the step-size table.");
}

/**
 * decideAsk, after it decides: a rule ask carrying a proposal, decided "Adopt", applies it: raise or lower through
 * `World.setGrantPricing` (logged as PUT /api/town/defaults logs it); split changes no price and is logged as the rule.
 * Each adopt appends `calibration.adopted`. "Keep as is" (or anything else) changes nothing.
 */
export function onRuleAskDecided(world: World, actor: Agent, a: Ask): void {
  const p = a.proposal;
  if (!p || !adopts(a, a.decision ?? "")) return;
  if (p.change !== "split" && p.to) {
    const table = grantPricingOf(world.town.get()).stepSizes;
    world.setGrantPricing({ stepSizes: { ...table, [p.size]: p.to } }, actor.id);
  }
  world.events.append({
    type: "calibration.adopted", agentId: actor.id, buildingId: TOWN_HALL_ID,
    text: `${world.nameOf(actor.id)} adopted the Planner's calibration: ${proposalSentence(p)}${p.change === "split" ? " (no price changed)" : ""}`,
    payload: { askId: a.id, proposal: p },
  });
}
