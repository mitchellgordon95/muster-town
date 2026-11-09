/**
 * The Planner's calibration run (docs/legible-delegation.md §7.4, build step 9). The Planner (the Town Hall's manager)
 * watches the §9 budget signals (measures.ts) on a weekly schedule of its own, on Fable, and when one crosses its line
 * files at most one policy ask (targetKind "rule") with the data and one concrete change to the step-size table: raise
 * or lower a size, or require a size to split. It never edits the table itself: a human decides the ask, and "Adopt"
 * applies the change through the same path `PUT /api/town/defaults` uses (`World.setGrantPricing`) and logs it. A run
 * with no line crossed (or with a calibration ask still waiting) is skipped before any session starts.
 */
import { grantPricingOf, vetAsk, type Agent, type Ask, type CalibrationProposal, type Schedule, type StepSize, type StepSizeTable } from "@muster-town/schema";
import { createAsk, refuseOrFlag } from "./asks.ts";
import { dictionaryPairs } from "./dictionary.ts";
import { AppError, badRequest } from "./errors.ts";
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

/**
 * The one change the town proposes for the crossed lines (null with none crossed). A size outside its band: set it to
 * its table value × its ratio (to the nearest 10,000), the size furthest out first. Holds or adjust asks over their
 * line: raise the hottest size that has a sample (ratio above 1) to its ratio; when that size is L, or no size runs
 * hot, require L steps to split (sizes priced right but steps too big, §7.3's slicing rule).
 */
export function calibrationProposal(m: LegibleMeasures, table: StepSizeTable): CalibrationProposal | null {
  const L = PLANNER_LINES;
  const lines = crossedLines(m);
  if (!lines.length) return null;
  const out = SIZES.filter((s) => { const r = m.spentOverSize[s]; return r.ratio !== null && r.sample >= L.sizeMinSample && (r.ratio < L.sizeRatioLow || r.ratio > L.sizeRatioHigh); })
    .sort((a, b) => Math.abs(m.spentOverSize[b].ratio! - 1) - Math.abs(m.spentOverSize[a].ratio! - 1));
  if (out.length) {
    const s = out[0]!, r = m.spentOverSize[s].ratio!;
    return { kind: "step-size", change: r > 1 ? "raise" : "lower", size: s, from: table[s], to: round10k(table[s] * r), line: lines[0]! };
  }
  const hot = SIZES.filter((s) => (m.spentOverSize[s].ratio ?? 0) > 1 && m.spentOverSize[s].sample >= 3).sort((a, b) => m.spentOverSize[b].ratio! - m.spentOverSize[a].ratio!)[0];
  if (hot && hot !== "L") return { kind: "step-size", change: "raise", size: hot, from: table[hot], to: round10k(table[hot] * m.spentOverSize[hot].ratio!), line: lines[0]! };
  return { kind: "step-size", change: "split", size: "L", from: table.L, to: null, line: lines[0]! };
}

/** The proposal as one sentence: "Raise M from 150,000 to 210,000 tokens." / "Require every L step to be split in two." */
function proposalSentence(p: CalibrationProposal): string {
  return p.change === "split" ? `Require every ${p.size} step to be split in two.` : `${p.change === "raise" ? "Raise" : "Lower"} ${p.size} from ${fmt(p.from)} to ${fmt(p.to!)} tokens.`;
}

const liveCalibrationAsk = (world: World) => world.asks.first("targetKind = 'rule' AND targetId = ? AND status IN ('open', 'deferred')", [CALIBRATION_TARGET]);

/** What a calibration run reads: the measures, the lines, which are crossed and the town's one proposed change. */
function calibrationBrief(world: World, at: Date): string {
  const m = legibleMeasures(world, at);
  const table = grantPricingOf(world.town.get()).stepSizes;
  const L = PLANNER_LINES;
  const lines = crossedLines(m);
  const p = calibrationProposal(m, table);
  const size = (s: StepSize) => { const r = m.spentOverSize[s]; return r.ratio === null ? `${s} no completed step` : `${s} ${r.ratio.toFixed(2)}× over ${r.sample} steps`; };
  const pct = (x: number | null) => (x === null ? "none" : `${Math.round(x * 100)}%`);
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
The data: which line was crossed, by how much, over how many steps or grants.
What I did: I applied nothing. The table stays as it is until you decide.
Reversing it: what changing it back costs.
If you adopt: what changes for the next proposals.
If you keep it: what stays, and when you will hear about it again.
The recommendation names the branch you recommend and why, in one sentence.
3. If \`calibrate\` refuses the card, fix the rules it names and call it again. Then submit_report (verdict stop) naming the ask id. File at most one ask. Don't read other docs or write pages.`;

/**
 * The Planner's weekly calibration schedule, made once: on the Town Hall, taken by the Planner, on Fable, on a retainer of
 * CALIBRATION_TOKENS_PER_RUN per run (asked in the Town Hall in-tray: its runs start once a human approves). Never made
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
 * policy contract and the linter (refused with the failing rules, the third try filed flagged). Refused when no line
 * is crossed or a calibration ask already waits.
 */
export function calibrate(world: World, me: Agent, input: { title?: string; body?: string; recommendation?: string }, at: Date = new Date()): { brief: string } | { askId: string; proposal: CalibrationProposal; note: string } {
  if (!world.reorgs.isPlanner(me)) throw new AppError("forbidden", "Only the Town Hall's Planner files a calibration ask.");
  if (!input.body?.trim()) return { brief: calibrationBrief(world, at) };
  if (!input.title?.trim() || !input.recommendation?.trim()) throw badRequest("Give title, body and recommendation to file the ask, or nothing to read the data.");
  const live = liveCalibrationAsk(world);
  if (live) throw new AppError("conflict", `A calibration ask already waits for a human (${live.id}): file at most one.`);
  const table = grantPricingOf(world.town.get()).stepSizes;
  const proposal = calibrationProposal(legibleMeasures(world, at), table);
  if (!proposal) throw new AppError("conflict", "No line is crossed: there is nothing to propose. submit_report (verdict stop).");
  const branches = [{ label: "Adopt", action: ADOPT }, { label: "Keep as is", action: "keep" }];
  const card = { body: input.body, recommendation: input.recommendation, claims: [], branches, targetKind: "rule" };
  refuseOrFlag(world, me, "calibration", vetAsk("policy", { ...card, dictionary: dictionaryPairs(world) }));
  const { ask } = createAsk(world, {
    type: "policy", targetKind: "rule", targetId: CALIBRATION_TARGET, buildingId: TOWN_HALL_ID, sourceDocId: null, by: me.id,
    title: input.title, body: input.body, branches, recommendation: input.recommendation, proposal, line: proposalSentence(proposal),
  });
  return { askId: ask.id, proposal, note: `Filed ${ask.id} in the Town Hall in-tray. Now submit_report (verdict stop) naming it.` };
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
