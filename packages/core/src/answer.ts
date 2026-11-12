/**
 * The one loop (plan dc_uwx045472m A2; grant gr_9mp6v6vv8k step 3): every new entry on a job's thread is answered at
 * the lowest level that can settle it. Code settles what needs no judgment, the manager what does, the human at the
 * nearest captained goal what needs money, permission or a rule.
 *
 * This file is the pure core (1:1 mt_msnjkpgwdb decisions 14-15): facts in, an answer out. No World, no database, no
 * clock. The shell around it (`jobs.ts`: `appendEntry`, `settle`) reads the facts from the town and applies the result.
 *
 * What it holds, stated by test/answer.test.ts over every combination of facts:
 * - every entry gets exactly one level, and it is total (no combination throws);
 * - a pivot, a dead session, a flag, a visitor's report, a report that asks its reader for something, and a report on
 *   work the manager gave (outside a grant's plan) are never settled by code;
 * - a report for the humans (a rollup, an unhomed visitor's) is never the manager's;
 * - the code only acts on a report that ended its work (never on a parked one), and only queues a next step that exists.
 */

export type JobRule = "chunk" | "ceiling" | "per-run" | "pocket" | "building";
export type EntryLevel = "code" | "manager" | "human" | "none";
type Verdict = "continue" | "pivot" | "stop";

/** What the code does for an entry, by itself, in the transaction that wrote it. */
type CodeAct =
  | "acknowledge"       // the report needs nobody: its doc leaves the in-tray
  | "queue-next-step"   // a ceiling job's step said continue and the plan has a next step
  | "file-forecast"     // every finished step of a ceiling job files the grant's forecast
  | "raise-resize"      // the forecast projects past the ceiling: the money ask to the human
  | "credit-proposal"   // a chunk's session ended in a proposal
  | "close-job"         // a chunk or a pocket whose work ended
  | "close-run";        // a per-run job's session ended

/** A session's report, as the facts `answer` needs. */
export interface ReportFacts {
  kind: "report";
  rule: JobRule;
  verdict: Verdict;
  /** it is a step of its grant's plan */
  step: boolean;
  /** the plan has a step after it and the grant can still run it */
  nextStep: boolean;
  /** its author parked the work (`resumeWhen`): it resumes by itself */
  parked: boolean;
  /** its "What I need from you" asks its reader for something */
  needs: boolean;
  /** its session filed a grant proposal */
  proposed: boolean;
  /** the grant's forecast after it projects past the ceiling */
  overCeiling: boolean;
  /** it is for the humans: a manager's rollup, an unhomed visitor's report */
  forHumans: boolean;
  /** its author is a visitor (someone's own agent, working from outside the town): whoever works the in-tray reads it */
  outsider: boolean;
  /** the manager gave this work itself (`assign`, a review's continue or redirect): its report is the answer the manager asked for */
  byManager: boolean;
}

/** A session that ended without a report: the runtime writes the entry for it. */
export interface DeadSessionFacts { kind: "dead-session"; rule: JobRule; stopped: boolean }

/** A human's flag in a building: it opens a pocket job, and the manager delegates it. */
export interface FlagFacts { kind: "flag" }

/** A human's decision on a grant or a key result, as an entry on the job's thread. */
export interface DecisionFacts {
  kind: "decision";
  /** grant: fund, continue, adjust, cut, stop, close, counter, reject. key result: created, edited, moved, deleted, marked */
  action: string;
  /** a key result's new status when `action` is "marked" */
  status?: string;
}

/** A human's words for the manager: a relayed tell, an @mention, an outbox answer. */
export interface MessageFacts { kind: "message" }

/** A meeting decision recorded on the job it made or amended work for. */
export interface MeetingFacts { kind: "meeting-decision" }

export type EntryFacts = ReportFacts | DeadSessionFacts | FlagFacts | DecisionFacts | MessageFacts | MeetingFacts;

export interface Answer {
  /** who still owes this entry an answer: `code` = settled here, `none` = a record that needs none */
  level: EntryLevel;
  /** what the code does now, whoever answers */
  acts: CodeAct[];
  /** one plain line: why it sits at that level */
  why: string;
}

/** A human's decision the manager must move on (plan A2.3): the proposal came back, the grant was cut, a key result was missed. */
const MANAGER_MOVES = new Set(["counter", "reject", "cut", "stop"]);

/**
 * Who answers `e`, and what the code does for it. Pure and total.
 *
 * Reports. The code first does the mechanical part of a finished step (forecast, next step, the resize ask), then the
 * level is the lowest that can settle what is left: the human for a report written for them or a grant forecast past
 * its ceiling; the manager for a pivot, for anything the report asks its reader, for work that says "continue" with
 * nothing queued behind it, and for the end of a grant's plan (the close is a judgment); the code for the rest.
 */
export function answer(e: EntryFacts): Answer {
  switch (e.kind) {
    case "dead-session":
      return e.stopped
        ? { level: "none", acts: [], why: "the session was stopped by whoever stopped its agent: that decision is the answer" }
        : { level: "manager", acts: [], why: "the session ended without a report: retry, redirect or drop the work" };
    case "flag":
      return { level: "manager", acts: [], why: "a human asked for something: delegate it" };
    case "message":
      return { level: "manager", acts: [], why: "a human's words addressed to the manager" };
    case "meeting-decision":
      return { level: "none", acts: [], why: "the decision made its own assignment: this is the record" };
    case "decision": {
      const move = MANAGER_MOVES.has(e.action) || (e.action === "marked" && e.status === "missed");
      return move
        ? { level: "manager", acts: [], why: `a human's ${e.action === "marked" ? "missed key result" : e.action}: the next move is the manager's` }
        : { level: "none", acts: [], why: "a human's decision that asks no move: recorded" };
    }
    case "report":
      return answerReport(e);
  }
}

function answerReport(e: ReportFacts): Answer {
  if (e.forHumans) return { level: "human", acts: [], why: "written for the humans" };
  // a parked report ended nothing: its work resumes by itself, so the code has nothing to do but file it
  if (e.parked) {
    return e.needs || e.verdict === "pivot" || e.outsider
      ? { level: "manager", acts: [], why: "parked, and its reader has something to read" }
      : { level: "code", acts: ["acknowledge"], why: "parked: it resumes by itself" };
  }
  const acts: CodeAct[] = [];
  const ceilingStep = e.rule === "ceiling" && e.step;
  if (ceilingStep) acts.push("file-forecast");
  const queues = ceilingStep && e.nextStep && e.verdict !== "pivot";
  if (queues) acts.push("queue-next-step");
  if (ceilingStep && e.overCeiling) acts.push("raise-resize");
  if (e.rule === "chunk" && e.proposed) acts.push("credit-proposal");

  if (e.verdict === "pivot") return { level: "manager", acts, why: "a pivot: the plan changes, the manager decides" };
  if (e.outsider) return { level: "manager", acts, why: "a visitor's report: whoever works the in-tray reads it" };
  // who asked gets the answer: a plan's step was planned, an explorer and a schedule's run were started by the town, but
  // work the manager gave is the manager's question (a retried plan step stays a plan step)
  if (e.byManager && !ceilingStep) return { level: "manager", acts, why: "the manager gave this work: its report is the answer" };
  if (e.needs) return { level: "manager", acts, why: "it asks its reader for something" };

  let settled: string | null = null;
  switch (e.rule) {
    case "ceiling":
      if (queues) settled = "the next step is queued";
      else if (!e.step && e.verdict === "stop") settled = "finished work on a grant, nothing asked";
      break;
    case "chunk":
      if (e.proposed) settled = "the exploration ended in a proposal";
      else if (e.verdict === "stop") { acts.push("close-job"); settled = "the exploration found nothing to propose"; }
      break;
    case "per-run":
      acts.push("close-run");
      settled = "the run ended; the schedule fires the next one";
      break;
    case "pocket":
      if (e.verdict === "stop") { acts.push("close-job"); settled = "the request is done"; }
      break;
    case "building":
      if (e.verdict === "stop") settled = "finished work, nothing asked";
      break;
  }
  if (settled === null) {
    const why = ceilingStep ? "the plan's last step: closing the grant is a judgment" : "it says continue and nothing is queued behind it";
    return { level: "manager", acts, why };
  }
  // past the ceiling the money question is the human's; the report itself needs nobody else
  if (acts.includes("raise-resize")) return { level: "human", acts: [...acts, "acknowledge"], why: `${settled}; the forecast is past the ceiling` };
  return { level: "code", acts: [...acts, "acknowledge"], why: settled };
}

/** Whether a report's "What I need from you" section asks for something: empty, "Nothing needed", "None", "N/A" do not. */
export function asksSomething(need: string): boolean {
  const t = need.replace(/[*_`>#-]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  if (!t) return false;
  return !/^(nothing( (is |was )?(needed|required))?|none|no|n\/a|not applicable|nothing (from you|to do|right now|for now|at this time))\b[\s.!:;,)]*$/.test(t.slice(0, 80)) || t.length > 80;
}
