/**
 * Finance (public, gr_gi5jbgzv4k step 2): the town's tokens at a glance from GET /api/finance: total received, used,
 * expired and left with the sum check (used + expired + left = total + overdrawn), the 30-day projection and the
 * trailing burn it rests on; then each Bank pool's permanent tokens as max(0, durable), with "overdrawn by N" when a
 * pool's durable balance is negative (overshoot debt, dc_myhlhsevgz). Under the overdrawn figure, its parts
 * (overdrawnBreakdown, dc_4exx02zf9g), which sum to it. Then Spending (gr_8gtgmd828o step 2) from GET /api/finance/spend:
 * `used` by building → grant → assignment, each level collapsible, with the no-grant, no-assignment and unattributed,
 * weight-mismatch (pre-conversion pricing, not spend; step 2b) and not-funded rows that make the top level sum to
 * `used`. Opened from the HUD's "$" or `#/finance`.
 */
import { api, type BankPoolSummary, type Finance, type FinanceSpend, type SpendNode } from "../api";
import { Glyph, PanelShell } from "./PanelShell";
import { ADJ, ErrorLine, Loading, Section, useLoad } from "./ui";

const n = (x: number) => Math.round(x).toLocaleString("en-US");

/** The sum check in words: what the four figures add up to, and by how much it misses when it does. */
export function sumCheckLine(f: Finance): { ok: boolean; text: string } {
  const lhs = f.used + f.expired + f.left, rhs = f.total + f.overdrawn;
  const sum = `used ${n(f.used)} + expired ${n(f.expired)} + left ${n(f.left)} = ${n(lhs)}; total ${n(f.total)}${f.overdrawn ? ` + overdrawn ${n(f.overdrawn)}` : ""} = ${n(rhs)}`;
  return f.sumCheck.ok ? { ok: true, text: `Adds up: ${sum}` } : { ok: false, text: `Does not add up (off by ${n(f.sumCheck.diff)}): ${sum}` };
}

/** Days the tokens left last at the trailing burn (null when nothing is being used). */
export const runwayDays = (f: Finance): number | null => (f.projection.trailingDailyBurn > 0 ? Math.floor(f.left / f.projection.trailingDailyBurn) : null);

/** A pool's permanent tokens as shown: never below 0, the debt on its own line. */
export const poolDurable = (p: Pick<BankPoolSummary, "durableTokens">) => ({ shown: Math.max(0, p.durableTokens), overdrawnBy: Math.max(0, -p.durableTokens) });

/** The non-zero parts of `overdrawn`, labelled, in a fixed order; they sum to `overdrawn`. */
export function overdrawnParts(f: Finance): { key: string; label: string; tokens: number; note?: string }[] {
  const b = f.overdrawnBreakdown;
  if (!b) return [];
  return [
    { key: "durableOvershoot", label: "permanent pools drawn past their credits (overshoot debt)", tokens: b.durableOvershoot },
    { key: "subscriptionOverdrawn", label: "subscription credits drawn past their size", tokens: b.subscriptionOverdrawn,
      note: "Pre-conversion Fable draw: credits capped in raw tokens, converted to adjusted tokens by migration 037." },
    { key: "deletedCreditDebits", label: "drawn from credits since deleted", tokens: b.deletedCreditDebits },
    { key: "allocationOverspent", label: "donations to buildings spent past their size", tokens: b.allocationOverspent },
  ].filter((p) => p.tokens > 0);
}

/** A share of `used` as a percentage, one decimal ("12.3%"); negative for the not-funded row. */
export const pct = (share: number) => `${(share * 100).toFixed(1)}%`;

/** The spend check in words: the top-level rows vs `used`. */
export function spendCheckLine(sp: FinanceSpend): { ok: boolean; text: string } {
  const sum = sp.rows.reduce((t, r) => t + r.tokens, 0);
  return sp.check.ok
    ? { ok: true, text: `Adds up: the rows sum to used, ${n(sp.used)}` }
    : { ok: false, text: `Does not add up (off by ${n(sp.check.diff)}): the rows sum to ${n(sum)}, used is ${n(sp.used)}` };
}

/** The note under a synthetic row; the weight-mismatch one is the API's own line. */
export const spendNotes = (sp: Pick<FinanceSpend, "weightMismatchNote">): Partial<Record<SpendNode["kind"], string>> => ({
  "unattributed": "Used from the Bank or donations but counted by no session (sessions from before the token counters).",
  "weight-mismatch": sp.weightMismatchNote,
  "not-funded": "Sessions counted more than the Bank and donations paid for, once the weight mismatch is set aside: usage the Bank recorded with no debit or donation behind it, taken off so the rows sum to used.",
});

function SpendRow({ node, notes }: { node: SpendNode; notes: Partial<Record<SpendNode["kind"], string>> }) {
  const line = (
    <span className="spend-line">
      <span className="spend-name" title={node.id ?? node.name}>{node.name}{node.sessions ? <span className="muted"> · {n(node.sessions)} session{node.sessions === 1 ? "" : "s"}</span> : null}</span>
      <span className="spend-tokens">{n(node.tokens)}</span>
      <span className="spend-share muted">{pct(node.share)}</span>
    </span>
  );
  const note = notes[node.kind];
  if (!node.children?.length) return <div className={`spend-row spend-${node.kind}`}>{line}{note ? <div className="muted">{note}</div> : null}</div>;
  return (
    <details className={`spend-row spend-${node.kind}`}>
      <summary>{line}</summary>
      <div className="spend-children">{node.children.map((c, i) => <SpendRow key={c.id ?? `${c.kind}-${i}`} node={c} notes={notes} />)}</div>
    </details>
  );
}

export function SpendingView({ sp }: { sp: FinanceSpend }) {
  const check = spendCheckLine(sp);
  const notes = spendNotes(sp);
  return (
    <Section title="Spending">
      <p className="muted">Where the {n(sp.used)} used went: by building, then grant, then assignment ({ADJ}, share of used). Open a row for its parts.</p>
      <div className="spend-tree">
        {sp.rows.map((r, i) => <SpendRow key={r.id ?? `${r.kind}-${i}`} node={r} notes={notes} />)}
      </div>
      <div className={check.ok ? "finance-check ok" : "error-line"} role="status">{check.ok ? "✓ " : "✗ "}{check.text}</div>
    </Section>
  );
}

export function FinanceView({ f, pools, spend = null }: { f: Finance; pools: BankPoolSummary[] | null; spend?: FinanceSpend | null }) {
  const check = sumCheckLine(f);
  const runway = runwayDays(f);
  const p = f.projection;
  return <>
    <Section title="Tokens">
      <table className="table finance-summary">
        <thead><tr><th /><th>{ADJ}</th></tr></thead>
        <tbody>
          <tr><td>Total received</td><td><b>{n(f.total)}</b></td></tr>
          <tr className="sub-row"><td>credited to the Bank (subscriptions, API keys)</td><td>{n(f.credited)}</td></tr>
          <tr className="sub-row"><td>donated straight to buildings</td><td>{n(f.donated)}</td></tr>
          <tr><td>Used</td><td><b>{n(f.used)}</b></td></tr>
          <tr title="Daily subscription tokens that renewed before they were drawn"><td>Expired (not drawn before renewal)</td><td>{n(f.expired)}</td></tr>
          <tr><td>Left</td><td><b>{n(f.left)}</b></td></tr>
          {f.overdrawn ? <tr className="finance-overdrawn" title="Usage past what was received: overshoot debt, carried against future permanent credits"><td>Overdrawn (used past what was received)</td><td>{n(f.overdrawn)}</td></tr> : null}
          {overdrawnParts(f).map((p) => (
            <tr key={p.key} className="sub-row"><td>{p.label}{p.note ? <div className="muted">{p.note}</div> : null}</td><td>{n(p.tokens)}</td></tr>
          ))}
        </tbody>
      </table>
      <div className={check.ok ? "finance-check ok" : "error-line"} role="status">{check.ok ? "✓ " : "✗ "}{check.text}</div>
    </Section>
    <Section title={`Next ${p.days} days`}>
      <table className="table">
        <tbody>
          <tr><td>Burn rate (average of the last {p.burnDays} day{p.burnDays === 1 ? "" : "s"})</td><td>{n(p.trailingDailyBurn)} / day</td></tr>
          <tr><td>Projected use, next {p.days} days at that rate</td><td><b>{n(p.projectedUse30d)}</b></td></tr>
          <tr><td>Tokens left last at that rate</td><td>{runway === null ? "nothing used lately" : `${n(runway)} day${runway === 1 ? "" : "s"}`}</td></tr>
        </tbody>
      </table>
      <p className="muted">A straight line from the trailing burn: new credits, donations and renewals are not counted.</p>
    </Section>
    {pools && pools.length ? (
      <Section title="Bank pools">
        <table className="table">
          <thead><tr><th>Pool</th><th>Expires today</th><th>Permanent</th></tr></thead>
          <tbody>
            {pools.map((pl) => {
              const d = poolDurable(pl);
              return (
                <tr key={pl.id}>
                  <td>{pl.name}</td>
                  <td>{n(pl.expiringTokens)}</td>
                  <td>{n(d.shown)}{d.overdrawnBy ? <div className="finance-overdrawn">overdrawn by {n(d.overdrawnBy)}</div> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>
    ) : null}
    {spend ? <SpendingView sp={spend} /> : null}
    <p className="muted">As of {f.at.slice(0, 16).replace("T", " ")} UTC · in adjusted output tokens · from <code>GET /api/finance</code>{spend ? <> and <code>/api/finance/spend</code></> : null}</p>
  </>;
}

export function FinancePanel() {
  const d = useLoad(() => Promise.all([api().finance(), api().bank().then((b) => b.pools, () => null), api().financeSpend().catch(() => null)]), []);
  return (
    <PanelShell icon={<Glyph kind="bank" />} title="Finance" subtitle="What the town received, used, let expire and has left">
      {d.loading && !d.data ? <Loading /> : null}
      <ErrorLine error={d.error} />
      {d.data ? <FinanceView f={d.data[0]} pools={d.data[1]} spend={d.data[2]} /> : null}
    </PanelShell>
  );
}
