/**
 * Finance (public, gr_gi5jbgzv4k step 2): the town's tokens at a glance from GET /api/finance: total received, used,
 * expired and left with the sum check (used + expired + left = total + overdrawn), the 30-day projection and the
 * trailing burn it rests on; then each Bank pool's permanent tokens as max(0, durable), with "overdrawn by N" when a
 * pool's durable balance is negative (overshoot debt, dc_myhlhsevgz). Opened from the HUD's "$" or `#/finance`.
 */
import { api, type BankPoolSummary, type Finance } from "../api";
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

export function FinanceView({ f, pools }: { f: Finance; pools: BankPoolSummary[] | null }) {
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
    <p className="muted">As of {f.at.slice(0, 16).replace("T", " ")} UTC · in adjusted output tokens · from <code>GET /api/finance</code></p>
  </>;
}

export function FinancePanel() {
  const d = useLoad(() => Promise.all([api().finance(), api().bank().then((b) => b.pools, () => null)]), []);
  return (
    <PanelShell icon={<Glyph kind="bank" />} title="Finance" subtitle="What the town received, used, let expire and has left">
      {d.loading && !d.data ? <Loading /> : null}
      <ErrorLine error={d.error} />
      {d.data ? <FinanceView f={d.data[0]} pools={d.data[1]} /> : null}
    </PanelShell>
  );
}
