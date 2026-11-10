/**
 * Free tokens and the exploration cap (docs/how-work-gets-done.md §7, §8): the one number exploration reads, per goal,
 * and the optional per-day cap inherited down the tree. Per goal in the goal editor's Funding block; town-wide (the root's)
 * on the Bank's Balance tab as one line, "Free for exploration: N", with its sum in the sidebar (gr_567tikzitl step 2:
 * the Bank's Free tokens tab and its fountain are gone).
 */
import type { FreeTokens, GoalTreeNode } from "@muster-town/schema";
import { goalShortName } from "../purpose";
import { findGoal } from "./goalTree";
import { Section, fmtTokens } from "./ui";

const RETAINERS = "retainers";
/** "Retainers: N tokens across M jobs" (1:1 mt_cyd2t5ioob decision 2): funded schedules' runs due within the lookahead (default 6 h), its own line on the Bank. */
function retainersLine(f: Pick<FreeTokens, "retainerTokens" | "retainerJobs">): string {
  const jobs = f.retainerJobs ?? 0;
  return `Retainers: ${(f.retainerTokens ?? 0).toLocaleString("en-US")} tokens across ${jobs} job${jobs === 1 ? "" : "s"}`;
}

/** The free-tokens sum as signed terms: general − operating reserve + earmarks at or above − funded grants' remaining − open asks − reservations. */
function freeTerms(f: FreeTokens): [label: string, tokens: number][] {
  return [
    ["general balance", f.generalTokens],
    ["operating reserve", -(f.reserveTokens ?? 0)],
    ["earmarks at or above", f.earmarkTokens],
    ["funded grants' remaining", -f.fundedRemainingTokens],
    ["open proposals' asks", -f.openAsksTokens],
    ["reservations", -f.reservedTokens],
    [RETAINERS, -(f.retainerTokens ?? 0)],
  ];
}

/** "general balance 1.2M − funded grants' remaining 300k − …": the general balance, then every term that isn't zero. */
export function freeBreakdown(f: FreeTokens): string {
  return freeTerms(f)
    .filter(([, t], i) => i === 0 || t !== 0)
    .map(([label, t], i) => `${i ? (t < 0 ? " − " : " + ") : ""}${label} ${fmtTokens(Math.abs(t))}`)
    .join("");
}

/** "Free tokens: N" with the sum under it. */
export function FreeTokensLine({ free }: { free: FreeTokens }) {
  return (
    <span title="What exploration may still claim; never below zero, and at zero nothing new is explored there">
      <b>{fmtTokens(free.freeTokens)}</b> <span className="muted">= {freeBreakdown(free)}</span>
    </span>
  );
}

/**
 * "uncapped", or "N / day, set on X, M used today": the binding cap is the smallest on the path to the root
 * (core free-tokens.ts `exploreCapAt`), so X names the goal it comes from ("this goal" when it is `node` itself).
 */
export function capText(node: Pick<GoalTreeNode, "id" | "funding">, root: GoalTreeNode | null): string {
  const cap = node.funding.exploreCap;
  if (!cap) return "uncapped";
  const from = cap.goalId === node.id ? "this goal" : `goal ${goalShortName(root ? findGoal(root, cap.goalId)?.text ?? cap.goalId : cap.goalId)}`;
  return `${fmtTokens(cap.tokensPerDay)} / day, set on ${from}, ${fmtTokens(node.funding.exploreSpentTodayTokens)} used today`;
}

/**
 * "Desks: N of M (set on goal X)" when a desk total is in force (1:1 mt_a6wb51enia, gr_yu6qw3j9x5): N is the sum of the
 * headcounts under the goal that sets it, M the smallest total on the path to the root (core free-tokens.ts
 * `desksTotalAt`). Null when none is set anywhere above.
 */
export function desksText(node: Pick<GoalTreeNode, "id" | "funding">, root: GoalTreeNode | null): string | null {
  const d = node.funding.desksTotal;
  if (!d) return null;
  const from = d.goalId === node.id ? "this goal" : `goal ${goalShortName(root ? findGoal(root, d.goalId)?.text ?? d.goalId : d.goalId)}`;
  return `Desks: ${d.desks} of ${d.total} (set on ${from})`;
}

/** The sum behind the Balance tab's "Free for exploration" line (GET /api/bank `free`, the root goal's), for the sidebar: each term, then the total and any overdraft. */
export function FreeTokensSum({ free }: { free: FreeTokens }) {
  const unavailable = free.unavailableTokens ?? 0;
  const overdraft = free.overdraftTokens ?? 0;
  return (
    <Section title="Free for exploration: the sum">
      <table className="table">
        <tbody>
          {unavailable > 0 ? <>
            <tr className="sub-row" title="Every live credit: what the inputs promised"><td>promised by the inputs</td><td>{(free.promisedTokens ?? 0).toLocaleString("en-US")}</td></tr>
            <tr className="sub-row" title="Credit no session can draw on now: the input is broken, or its limit lasts past the credit's expiry (docs/bank.md, Promised and available)"><td>less unavailable now</td><td>−{unavailable.toLocaleString("en-US")}</td></tr>
            {(free.unavailable ?? []).map((u) => <tr key={u.inputId} className="sub-row muted"><td style={{ paddingLeft: 24 }}>{u.text}</td><td>−{u.tokens.toLocaleString("en-US")}</td></tr>)}
          </> : null}
          {freeTerms(free).map(([label, t]) => <tr key={label} className="sub-row"><td>{label === RETAINERS ? <span title="Standing money for scheduled jobs a human approved: tokens per run × the runs due within the lookahead (default 6 h), plus what a run under way may still spend">less {retainersLine(free)}</span> : <>{t < 0 ? "less " : ""}{label}</>}</td><td>{t < 0 ? "−" : ""}{Math.abs(t).toLocaleString("en-US")}</td></tr>)}
          <tr><td>Free for exploration (never below 0)</td><td><b>{free.freeTokens.toLocaleString("en-US")}</b></td></tr>
          {overdraft > 0 ? <>
            <tr title="Approved claims the usable balance doesn't cover, walked in order: retainers, funded grants by funding time, reservations. Work on a claim with nothing covered waits for funding."><td style={{ color: "#c0392b" }}>Overdraft: claimed, but not backed by anything usable</td><td style={{ color: "#c0392b" }}><b>{overdraft.toLocaleString("en-US")}</b></td></tr>
            {(free.overdrafted ?? []).map((o) => <tr key={o.id} className="sub-row muted"><td style={{ paddingLeft: 24 }}>{o.kind === "funded" ? "grant" : o.kind} {o.title.slice(0, 80)}{o.shortTokens >= o.tokens ? " (waits)" : " (partly covered, runs)"}</td><td>{o.shortTokens.toLocaleString("en-US")} short</td></tr>)}
          </> : null}
        </tbody>
      </table>
    </Section>
  );
}
