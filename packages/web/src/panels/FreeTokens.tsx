/**
 * Free tokens and the exploration cap (docs/how-work-gets-done.md §7, §8): the one number exploration reads, per goal,
 * and the optional per-day cap inherited down the tree. Shown in the goal tree's Funding block, the Bank's Overview
 * (town-wide, the root's) and the Bank's Free tokens tab (the fountain: every goal with its free tokens and cap).
 */
import type { FreeTokens, GoalTreeNode } from "@muster-town/schema";
import { api } from "../api";
import { store } from "../state";
import { goalShortName } from "../purpose";
import { findGoal, treeRows } from "./goalTree";
import { ADJ, Empty, Loading, Section, fmtTokens, useLoad } from "./ui";

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

/** "uncapped", or "N / day (from goal X), M used today". `root` names the capping goal when it isn't `node` itself. */
export function capText(node: Pick<GoalTreeNode, "id" | "funding">, root: GoalTreeNode | null): string {
  const cap = node.funding.exploreCap;
  if (!cap) return "uncapped";
  const from = cap.goalId === node.id ? "" : ` (from goal ${goalShortName(root ? findGoal(root, cap.goalId)?.text ?? cap.goalId : cap.goalId)})`;
  return `${fmtTokens(cap.tokensPerDay)} / day${from}, ${fmtTokens(node.funding.exploreSpentTodayTokens)} used today`;
}

/** The Bank Overview's town-wide free tokens (GET /api/bank `free`, the root goal's): each term of the sum, then the total. */
export function BankFreeTokens({ free }: { free: FreeTokens }) {
  const unavailable = free.unavailableTokens ?? 0;
  const overdraft = free.overdraftTokens ?? 0;
  return (
    <Section title="Free tokens">
      <table className="table">
        <tbody>
          {unavailable > 0 ? <>
            <tr className="sub-row" title="Every live credit: what the inputs promised"><td>promised by the inputs</td><td>{(free.promisedTokens ?? 0).toLocaleString("en-US")}</td></tr>
            <tr className="sub-row" title="Credit no session can draw on now: the input is broken, or its limit lasts past the credit's expiry (docs/bank.md, Promised and available)"><td>less unavailable now</td><td>−{unavailable.toLocaleString("en-US")}</td></tr>
            {(free.unavailable ?? []).map((u) => <tr key={u.inputId} className="sub-row muted"><td style={{ paddingLeft: 24 }}>{u.text}</td><td>−{u.tokens.toLocaleString("en-US")}</td></tr>)}
          </> : null}
          {freeTerms(free).map(([label, t]) => <tr key={label} className="sub-row"><td>{label === RETAINERS ? <span title="Standing money for scheduled jobs a human approved: tokens per run × the runs due within the lookahead (default 6 h), plus what a run under way may still spend">less {retainersLine(free)}</span> : <>{t < 0 ? "less " : ""}{label}</>}</td><td>{t < 0 ? "−" : ""}{Math.abs(t).toLocaleString("en-US")}</td></tr>)}
          <tr><td>Free tokens: what exploration may still claim (never below 0)</td><td><b>{free.freeTokens.toLocaleString("en-US")}</b></td></tr>
          {overdraft > 0 ? <>
            <tr title="Approved claims the usable balance doesn't cover, walked in order: retainers, funded grants by funding time, reservations. Work on a claim with nothing covered waits for funding."><td style={{ color: "#c0392b" }}>Overdraft: claimed, but not backed by anything usable</td><td style={{ color: "#c0392b" }}><b>{overdraft.toLocaleString("en-US")}</b></td></tr>
            {(free.overdrafted ?? []).map((o) => <tr key={o.id} className="sub-row muted"><td style={{ paddingLeft: 24 }}>{o.kind === "funded" ? "grant" : o.kind} {o.title.slice(0, 80)}{o.shortTokens >= o.tokens ? " (waits)" : " (partly covered, runs)"}</td><td>{o.shortTokens.toLocaleString("en-US")} short</td></tr>)}
          </> : null}
        </tbody>
      </table>
    </Section>
  );
}

/** The Bank's Free tokens tab (the fountain): every active goal, indented, with its free tokens and exploration cap. */
export function FreeTokensTree() {
  const tree = useLoad(() => api().goalTree(), []);
  const root = tree.data;
  const rows = root ? treeRows(root, false) : [];
  return (
    <Section title="Free tokens by goal">
      <p className="muted">
        What exploration (work no grant covers and no human asked for) may still claim under each goal, in {ADJ}: the general
        balance plus the earmarks at or above the goal, less funded grants&apos; remaining tokens, open proposals&apos; asks and open
        reservations. At zero nothing new is explored there. A goal&apos;s exploration cap is set in the goal tree (Funding).
      </p>
      {tree.loading && !root ? <Loading /> : !rows.length ? <Empty>No goals yet.</Empty> : (
        <table className="table free-table">
          <thead><tr><th>Goal</th><th title="Free tokens under the goal">Free</th><th>Exploration cap</th></tr></thead>
          <tbody>
            {rows.map(({ node, depth }) => (
              <tr key={node.id}>
                <td style={{ paddingLeft: 8 + depth * 14 }}>
                  <a className="link" href="#" title={node.text} onClick={(e) => { e.preventDefault(); store.open({ kind: "goals", id: node.id }); }}>{goalShortName(node.text)}</a>
                </td>
                <td title={freeBreakdown(node.funding.free)}>{fmtTokens(node.funding.free.freeTokens)}</td>
                <td className={node.funding.exploreCap ? undefined : "muted"}>{capText(node, root)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}
