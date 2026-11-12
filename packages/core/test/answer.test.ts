/**
 * The pure core of the one loop (core answer.ts; 1:1 mt_msnjkpgwdb decisions 14-15): its invariants, stated over every
 * combination of facts. The space is finite (5 rules × 3 verdicts × 2^9 flags = 7,680 reports, plus the other kinds), so
 * the properties are checked exhaustively, not sampled.
 */
import { describe, expect, it } from "vitest";
import { answer, asksSomething, type EntryFacts } from "../src/index.ts";
import type { ReportFacts } from "../src/answer.ts";

const RULES = ["chunk", "ceiling", "per-run", "pocket", "building"] as const;
const VERDICTS = ["continue", "pivot", "stop"] as const;
const FLAGS = ["step", "nextStep", "parked", "needs", "proposed", "overCeiling", "forHumans", "outsider", "byManager"] as const;
const LEVELS = ["code", "manager", "human", "none"];

/** Every report the town can file, as facts. */
function everyReport(): ReportFacts[] {
  const out: ReportFacts[] = [];
  for (const rule of RULES) for (const verdict of VERDICTS) {
    for (let bits = 0; bits < 1 << FLAGS.length; bits++) {
      const f = Object.fromEntries(FLAGS.map((k, i) => [k, !!(bits & (1 << i))])) as Record<(typeof FLAGS)[number], boolean>;
      out.push({ kind: "report", rule, verdict, ...f });
    }
  }
  return out;
}
const REPORTS = everyReport();
const GRANT_ACTIONS = ["propose", "fund", "continue", "adjust", "cut", "stop", "close", "counter", "reject", "withdraw", "checkpoint"];
const KR_ACTIONS = ["created", "edited", "moved", "deleted", "marked"];
const KR_STATUSES = ["not-started", "on-track", "at-risk", "claimed", "met", "missed"];
const OTHERS: EntryFacts[] = [
  ...RULES.flatMap((rule) => [true, false].map((stopped): EntryFacts => ({ kind: "dead-session", rule, stopped }))),
  { kind: "flag" }, { kind: "message" }, { kind: "meeting-decision" },
  ...GRANT_ACTIONS.map((action): EntryFacts => ({ kind: "decision", action })),
  ...KR_ACTIONS.flatMap((action) => KR_STATUSES.map((status): EntryFacts => ({ kind: "decision", action, status }))),
];

describe("answer(entry): who settles an entry (pure core)", () => {
  it("is total: every entry gets exactly one level, a reason, and a list of acts; the same facts give the same answer", () => {
    for (const e of [...REPORTS, ...OTHERS]) {
      const a = answer(e);
      expect(LEVELS).toContain(a.level);
      expect(a.why.length).toBeGreaterThan(0);
      expect(new Set(a.acts).size).toBe(a.acts.length);
      expect(answer({ ...e })).toEqual(a);
    }
    expect(REPORTS).toHaveLength(5 * 3 * 2 ** FLAGS.length);
  });

  it("what needs judgment is never settled by code: a pivot, a report that asks something, a visitor's report, work the manager gave, a dead session, a flag, a human's words", () => {
    for (const e of REPORTS) {
      if (e.forHumans) continue;
      if (e.verdict === "pivot" || e.needs || e.outsider) expect(answer(e).level, JSON.stringify(e)).toBe("manager");
      // who asked gets the answer: the manager's own work comes back to it, unless it is a (retried) step of a grant's plan or parked
      if (e.byManager && !e.parked && !(e.rule === "ceiling" && e.step)) expect(answer(e).level, JSON.stringify(e)).toBe("manager");
    }
    for (const rule of RULES) expect(answer({ kind: "dead-session", rule, stopped: false }).level).toBe("manager");
    expect(answer({ kind: "flag" }).level).toBe("manager");
    expect(answer({ kind: "message" }).level).toBe("manager");
  });

  it("a report written for the humans is theirs, whatever else it says, and the code does nothing with it", () => {
    for (const e of REPORTS.filter((r) => r.forHumans)) expect(answer(e)).toMatchObject({ level: "human", acts: [] });
  });

  it("a report is acknowledged by the code exactly when the manager owes it nothing", () => {
    for (const e of REPORTS.filter((r) => !r.forHumans)) {
      const a = answer(e);
      expect(a.acts.includes("acknowledge"), JSON.stringify(e)).toBe(a.level !== "manager");
      // the only way past the manager to a human is a forecast over the ceiling
      if (a.level === "human") expect(a.acts).toContain("raise-resize");
      expect(a.level).not.toBe("none");
    }
  });

  it("a parked report ended nothing: the code queues, files and closes nothing for it", () => {
    for (const e of REPORTS.filter((r) => r.parked && !r.forHumans)) expect(answer(e).acts.filter((x) => x !== "acknowledge")).toEqual([]);
  });

  it("the next step is queued only for a ceiling job's finished step that has one and did not pivot; every such step files the forecast", () => {
    for (const e of REPORTS.filter((r) => !r.forHumans && !r.parked)) {
      const a = answer(e);
      const step = e.rule === "ceiling" && e.step;
      expect(a.acts.includes("queue-next-step"), JSON.stringify(e)).toBe(step && e.nextStep && e.verdict !== "pivot");
      expect(a.acts.includes("file-forecast")).toBe(step);
      expect(a.acts.includes("raise-resize")).toBe(step && e.overCeiling);
    }
  });

  it("the key result of the grant: a step that says continue with a step behind it, asking nothing, needs no manager", () => {
    const step = { kind: "report" as const, rule: "ceiling" as const, verdict: "continue" as const, step: true, nextStep: true, parked: false, needs: false, proposed: false, overCeiling: false, forHumans: false, outsider: false, byManager: false };
    expect(answer(step)).toEqual({ level: "code", acts: ["file-forecast", "queue-next-step", "acknowledge"], why: "the next step is queued" });
    // a step the manager put back on the queue after its session died is still the plan's step
    expect(answer({ ...step, byManager: true }).level).toBe("code");
    // the plan's last step is the manager's: closing a grant is a judgment
    expect(answer({ ...step, nextStep: false }).level).toBe("manager");
  });

  it("work that says continue with nothing queued behind it is the manager's, on every rule but a per-run job (the schedule fires the next run)", () => {
    for (const e of REPORTS.filter((r) => !r.forHumans && !r.parked && !r.needs && !r.outsider && !r.byManager && r.verdict === "continue")) {
      const queued = e.rule === "ceiling" && e.step && e.nextStep;
      const proposed = e.rule === "chunk" && e.proposed;
      expect(answer(e).level === "manager", JSON.stringify(e)).toBe(!(queued || proposed || e.rule === "per-run"));
    }
  });

  it("jobs close by code: a chunk that found nothing, a pocket that is done, a per-run job's run", () => {
    const base = { kind: "report" as const, step: false, nextStep: false, parked: false, needs: false, proposed: false, overCeiling: false, forHumans: false, outsider: false, byManager: false };
    expect(answer({ ...base, rule: "chunk", verdict: "stop" }).acts).toContain("close-job");
    expect(answer({ ...base, rule: "chunk", verdict: "stop", proposed: true }).acts).toEqual(["credit-proposal", "acknowledge"]);
    expect(answer({ ...base, rule: "pocket", verdict: "stop" }).acts).toContain("close-job");
    expect(answer({ ...base, rule: "per-run", verdict: "stop" }).acts).toContain("close-run");
  });

  it("a human's decision wakes the manager only when a move is needed: counter, reject, cut, stop, a key result marked missed", () => {
    for (const action of GRANT_ACTIONS) expect(answer({ kind: "decision", action }).level, action).toBe(["counter", "reject", "cut", "stop"].includes(action) ? "manager" : "none");
    for (const action of KR_ACTIONS) for (const status of KR_STATUSES) {
      expect(answer({ kind: "decision", action, status }).level, `${action} ${status}`).toBe(action === "marked" && status === "missed" ? "manager" : "none");
    }
    // a human's decision is never passed back up to a human, and never needs the code
    for (const e of OTHERS.filter((o) => o.kind === "decision")) expect(["manager", "none"]).toContain(answer(e).level);
  });

  it("a session someone stopped is a record; a meeting decision too (its assignment is the act)", () => {
    for (const rule of RULES) expect(answer({ kind: "dead-session", rule, stopped: true }).level).toBe("none");
    expect(answer({ kind: "meeting-decision" }).level).toBe("none");
  });
});

describe("asksSomething: does a report's \"What I need from you\" ask anything", () => {
  it("empty, Nothing needed, None, N/A (in any dress) ask nothing", () => {
    for (const s of ["", "  \n", "Nothing needed.", "nothing needed", "**Nothing needed.**", "- Nothing needed", "None.", "None", "N/A", "Nothing.", "Nothing is needed.", "Nothing from you.", "No."]) {
      expect(asksSomething(s), JSON.stringify(s)).toBe(false);
    }
  });
  it("anything else asks, also when it starts with Nothing needed and goes on", () => {
    for (const s of ["Merge PR #12.", "Nothing needed unless the task still matters: re-assign it once the cause is fixed.", "Nothing needed.\n\nBut decide whether to ship it.", "A decision on the rename", "None of the three options works; pick one."]) {
      expect(asksSomething(s), JSON.stringify(s)).toBe(true);
    }
  });
});
