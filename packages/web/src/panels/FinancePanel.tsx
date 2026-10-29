/**
 * Finance (public, gr_gi5jbgzv4k step 2): the town's tokens at a glance from GET /api/finance: total received, used,
 * expired and left with the sum check (used + expired + left = total + overdrawn), the 30-day projection and the
 * trailing burn it rests on; then each Bank pool's permanent tokens as max(0, durable), with "overdrawn by N" when a
 * pool's durable balance is negative (overshoot debt, dc_myhlhsevgz). Under the overdrawn figure, its parts
 * (overdrawnBreakdown, dc_4exx02zf9g), which sum to it. Then Spending (gr_8gtgmd828o step 2) from GET /api/finance/spend:
 * `used` by building → grant → assignment, each level collapsible, with the no-grant, no-assignment and unattributed,
 * weight-mismatch (pre-conversion pricing, not spend; step 2b) and not-funded rows that make the top level sum to
 * `used`. Above it, Sources (gr_gbpbbwy9b8 step 2) from GET /api/finance/sources: each Bank input (open it for its
 * dated credits) and each direct donation, the two subtotals and Total received, checked against /api/finance `total`.
 * Between Sources and Spending, Pools (gr_mijwhoiy2f step 2) from GET /api/finance/pools: each pool's share, what it has left
 * (expiring today, permanent) and drew, its overdrawn debt on its own row, checked against the Bank balance; then each
 * building's draws, donations, held tokens and exploration allowance, its draws checked against the Bank's debits. When
 * the endpoint can't be loaded, the older "Bank pools" table from /api/bank stands in for it.
 * Opened from the HUD's "$" or `#/finance`.
 */
import { api, type BankPoolSummary, type Finance, type FinancePools, type FinanceSources, type FinanceSpend, type SpendNode } from "../api";
import type { ReactNode } from "react";
import { Glyph, PanelShell } from "./PanelShell";
import { ADJ, ADJ_HINT, ErrorLine, Loading, Section, useLoad } from "./ui";

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
      note: "Left over from the Bank's switch to adj. tokens on 2026-10-27: before it, Fable sessions drew on credits sized in raw tokens, and converting those credits left the draws past their new size." },
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
  "unattributed": "Paid for from the Bank or donations but not traceable to any one work session: work from before sessions counted their own tokens.",
  "weight-mismatch": sp.weightMismatchNote,
  "not-funded": "Work sessions that were never charged to the Bank or a donation: the sessions counted more than was paid for, even after the weight mismatch above. Taken off here so the rows sum to Used, which counts only what was paid.",
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

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");
const SOURCE_NAME = { subscription: "subscription", "api-key": "API key" } as const;
type SourceInputRow = FinanceSources["inputs"][number];
type SourceDonationRow = FinanceSources["donations"][number];

/** An input's name: its label, else its source and who added it. */
export const inputName = (i: SourceInputRow) => i.label || [i.source ? SOURCE_NAME[i.source] : "input", i.who && `from ${i.who}`].filter(Boolean).join(" ");

/** A donation counted under its size (retired, or spent less): the title saying so; null when it counts at its size. */
export const donationNote = (d: SourceDonationRow) => (d.retired || d.tokens < d.sizeTokens ? `counted at what it spent (size ${n(d.sizeTokens)})` : null);

/** The sources check in words: the subtotals vs Total received, and Total received vs the Tokens section's total. */
export function sourcesCheckLine(s: FinanceSources): { ok: boolean; text: string } {
  const sum = `credited ${n(s.creditedTokens)} + donated ${n(s.donatedTokens)} = ${n(s.creditedTokens + s.donatedTokens)}`;
  if (!s.sumCheck.ok) return { ok: false, text: `Does not add up (off by ${n(s.sumCheck.diff)}): ${sum}, total received ${n(s.totalReceived)}` };
  if (!s.matchesFinance) return { ok: false, text: `Does not match the Tokens total (off by ${n(s.totalReceived - s.financeTotal)}): ${sum}, Tokens total ${n(s.financeTotal)}` };
  return { ok: true, text: `Adds up: ${sum}, the Tokens section's total` };
}

function SourceInputLine({ i }: { i: SourceInputRow }) {
  const meta = [i.source ? SOURCE_NAME[i.source] : null, i.recurrence, i.who && i.label ? `from ${i.who}` : null, i.cancelledAt ? "cancelled" : null].filter(Boolean).join(" · ");
  const title = i.cancelledAt ? `Cancelled ${day(i.cancelledAt)}` : (i.id ?? undefined);
  const line = (
    <span className="spend-line" title={title}>
      <span className="spend-name">{inputName(i)}{meta ? <span className="muted"> · {meta}</span> : null}</span>
      <span className="spend-share spend-date muted">{i.firstAt ? (i.firstAt.slice(0, 10) === i.lastAt?.slice(0, 10) ? <span className="day">{day(i.firstAt)}</span> : <><span className="day">{day(i.firstAt)} →</span> <span className="day">{day(i.lastAt)}</span></>) : "never credited"}</span>
      <span className="spend-tokens">{n(i.tokens)}</span>
    </span>
  );
  const cls = `spend-row${i.cancelledAt ? " muted" : ""}`;
  if (!i.credits.length) return <div className={cls}>{line}</div>;
  return (
    <details className={cls}>
      <summary>{line}</summary>
      <div className="spend-children">
        {i.credits.map((c) => (
          <div key={c.id} className="spend-row">
            <span className="spend-line">
              <span className="spend-name">{day(c.createdAt)}<span className="muted"> · {c.expiresAt ? `expires ${c.expiresAt.slice(0, 16).replace("T", " ")}` : "permanent"}{c.expiredTokens > 0 ? ` · ${n(c.expiredTokens)} expired undrawn` : ""}</span></span>
              <span className="spend-tokens">{n(c.tokens)}</span>
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}

export function SourcesView({ s }: { s: FinanceSources }) {
  const check = sourcesCheckLine(s);
  return (
    <Section title="Sources">
      <p className="muted">What the town received and from whom: each Bank input (subscriptions and API keys; open one for its dated credits) and each donation straight to a building ({ADJ}).</p>
      <div className="spend-tree">
        {s.inputs.map((i) => <SourceInputLine key={i.id ?? "deleted"} i={i} />)}
        <div className="spend-row spend-building"><span className="spend-line"><span className="spend-name"><b>Credited through the Bank</b></span><span className="spend-tokens"><b>{n(s.creditedTokens)}</b></span></span></div>
        {s.donations.map((d) => {
          const note = donationNote(d);
          return (
            <div key={d.id} className="spend-row" title={note ?? d.id}>
              <span className="spend-line">
                <span className="spend-name">{d.label || (d.who ? `from ${d.who}` : "donation")}<span className="muted"> · to {d.buildingName}{d.label && d.who ? ` · from ${d.who}` : ""}{note ? ` · ${note}` : ""}</span></span>
                <span className="spend-share spend-date muted"><span className="day">{day(d.createdAt)}</span></span>
                <span className="spend-tokens">{n(d.tokens)}</span>
              </span>
            </div>
          );
        })}
        <div className="spend-row"><span className="spend-line"><span className="spend-name"><b>Donated to buildings</b></span><span className="spend-tokens"><b>{n(s.donatedTokens)}</b></span></span></div>
        <div className="spend-row"><span className="spend-line"><span className="spend-name"><b>Total received</b></span><span className="spend-tokens"><b>{n(s.totalReceived)}</b></span></span></div>
      </div>
      <div className={check.ok ? "finance-check ok" : "error-line"} role="status">{check.ok ? "✓ " : "✗ "}{check.text}</div>
    </Section>
  );
}

/** The pools' balance check in words: pools left − overdrawn + unshared vs the Bank balance − overshoot. */
export function poolsBalanceLine(fp: FinancePools): { ok: boolean; text: string } {
  const lhs = fp.poolsLeftTokens - fp.poolsOverdrawnTokens + fp.unsharedTokens, rhs = fp.balanceTokens - fp.overshootTokens;
  const pools = `pools left ${n(fp.poolsLeftTokens)} − overdrawn ${n(fp.poolsOverdrawnTokens)}${fp.unsharedTokens ? ` + unshared ${n(fp.unsharedTokens)}` : ""} = ${n(lhs)}`;
  const bank = `Bank balance ${n(fp.balanceTokens)}${fp.overshootTokens ? ` − overshoot ${n(fp.overshootTokens)}` : ""} = ${n(rhs)}`;
  return fp.sumCheck.balanceOk ? { ok: true, text: `Adds up: ${pools}; ${bank}` } : { ok: false, text: `Does not add up (off by ${n(fp.sumCheck.balanceDiff)}): ${pools}; ${bank}` };
}

/** The draws check in words: Σ building draws and Σ pool draws vs every Bank debit. */
export function poolsDrawsLine(fp: FinancePools): { ok: boolean; text: string } {
  const b = fp.buildings.reduce((s, x) => s + x.drawn, 0), p = fp.pools.reduce((s, x) => s + x.drawn, 0);
  const sum = `building draws ${n(b)}, pool draws ${n(p)}, Bank debits ${n(fp.usedBank)}`;
  return fp.sumCheck.drawsOk ? { ok: true, text: `Adds up: building draws = pool draws = Bank debits = ${n(fp.usedBank)}` } : { ok: false, text: `Does not add up (off by ${n(fp.sumCheck.drawsDiff)}): ${sum}` };
}

const Check = ({ c }: { c: { ok: boolean; text: string } }) => <div className={c.ok ? "finance-check ok" : "error-line"} role="status">{c.ok ? "✓ " : "✗ "}{c.text}</div>;

/** A label and its number, never broken apart. */
const Pair = ({ children }: { children: ReactNode }) => <span className="nowrap">{children}</span>;

const Total = ({ label, tokens }: { label: string; tokens: number }) => (
  <div className="spend-row"><span className="spend-line"><span className="spend-name"><b>{label}</b></span><span className="spend-tokens"><b>{n(tokens)}</b></span></span></div>
);

export function PoolsView({ fp }: { fp: FinancePools }) {
  return (
    <Section title="Pools">
      <p className="muted">Each pool owns its share of every Bank credit; its buildings draw from it first come, first served. Left ({ADJ}) splits into expiring (subscription tokens: what is not used before the daily renewal is lost) and permanent (API-key tokens: kept until used).</p>
      <div className="spend-tree">
        {fp.pools.map((p) => (
          <div key={p.id ?? "deleted"} className="pool-group">
            <div className="spend-row spend-building" title={p.buildings.length ? `Buildings: ${p.buildings.map((b) => b.name).join(", ")}` : (p.id ?? undefined)}>
              <span className="spend-line">
                <span className="spend-name"><b>{p.name}</b>{p.buildings.length ? <span className="muted"> · {p.buildings.map((b) => b.name).join(", ")}</span> : null}</span>
                <span className="spend-share">{p.id ? `${p.pct}%` : "—"}</span>
                <span className="spend-tokens">{n(p.left)}</span>
              </span>
              <div className="muted"><Pair>expiring {n(p.expiringLeft)}</Pair> · <Pair>permanent {n(p.durableLeft)}</Pair> · <Pair>drawn all time {n(p.drawn)}</Pair></div>
            </div>
            {p.overdrawn ? (
              <div className="spend-row finance-overdrawn pool-overdrawn" title="Permanent tokens drawn past the pool's share (overshoot debt), paid back from later API-key credits">
                <span className="spend-line"><span className="spend-name">{p.name} overdrawn: permanent tokens drawn past its share</span><span className="spend-tokens">−{n(p.overdrawn)}</span></span>
              </div>
            ) : null}
          </div>
        ))}
        {fp.unsharedTokens ? (
          <div className="spend-row" title="Credit tokens no pool owns: shares under 100% and rounding">
            <span className="spend-line"><span className="spend-name">Unshared: tokens no pool owns</span><span className="spend-share">{fp.sharedPct < 100 ? `${Math.round((100 - fp.sharedPct) * 100) / 100}%` : ""}</span><span className="spend-tokens">{n(fp.unsharedTokens)}</span></span>
          </div>
        ) : null}
        <Total label="Bank balance less overshoot" tokens={fp.poolsLeftTokens - fp.poolsOverdrawnTokens + fp.unsharedTokens} />
      </div>
      <Check c={poolsBalanceLine(fp)} />
      <p className="muted">What each building drew from its pool, all time; under it, donations straight to it, what of them it still holds, and today&apos;s exploration allowance.</p>
      <div className="spend-tree">
        {fp.buildings.map((b) => (
          <div key={b.id ?? "deleted"} className="spend-row" title={b.id ?? undefined}>
            <span className="spend-line">
              <span className="spend-name">{b.name}{b.poolName ? <span className="muted"> · {b.poolName}</span> : null}</span>
              <span className="spend-tokens">{n(b.drawn)}</span>
            </span>
            <div className="muted">{b.drawsFromBank ? <><Pair>donated {n(b.donated)}</Pair> · <Pair>held {n(b.held)}</Pair> · <Pair>exploration {n(b.explorationTokensPerDay)} / day</Pair></> : b.id ? "draws nothing from the Bank" : "debits of buildings since deleted"}</div>
          </div>
        ))}
        <Total label="Drawn from pools" tokens={fp.buildings.reduce((s, b) => s + b.drawn, 0)} />
      </div>
      <Check c={poolsDrawsLine(fp)} />
    </Section>
  );
}

export function FinanceView({ f, pools, spend = null, sources = null, poolsFin = null }: { f: Finance; pools: BankPoolSummary[] | null; spend?: FinanceSpend | null; sources?: FinanceSources | null; poolsFin?: FinancePools | null }) {
  const check = sumCheckLine(f);
  const runway = runwayDays(f);
  const p = f.projection;
  return <>
    <p className="muted finance-intro">
      Every amount here is in <abbr title={ADJ_HINT}>{ADJ}</abbr> (adjusted output tokens): the unit the town pays for AI model work in, where
      one output token counts 1 and input and cached tokens count at their lower price (1 adj. token ≈ 30 raw tokens on Opus, 24 on Fable).
      A ✓ line under a section means the server checked that its numbers add up; ✗ would say by how much they are off.
    </p>
    <Section title="Tokens">
      <table className="table finance-summary">
        <thead><tr><th /><th title={ADJ_HINT}>{ADJ}</th></tr></thead>
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
    {!poolsFin && pools && pools.length ? (
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
    {sources ? <SourcesView s={sources} /> : null}
    {poolsFin ? <PoolsView fp={poolsFin} /> : null}
    {spend ? <SpendingView sp={spend} /> : null}
    <p className="muted">As of {f.at.slice(0, 16).replace("T", " ")} UTC · in adjusted output tokens · from <code>GET /api/finance</code>{sources ? <>, <code>/api/finance/sources</code></> : null}{poolsFin ? <>, <code>/api/finance/pools</code></> : null}{spend ? <> and <code>/api/finance/spend</code></> : null}</p>
  </>;
}

export function FinancePanel() {
  const d = useLoad(() => Promise.all([api().finance(), api().bank().then((b) => b.pools, () => null), api().financeSpend().catch(() => null), api().financeSources().catch(() => null), api().financePools().catch(() => null)]), []);
  return (
    <PanelShell icon={<Glyph kind="bank" />} title="Finance" subtitle="What the town received, used, let expire and has left">
      {d.loading && !d.data ? <Loading /> : null}
      <ErrorLine error={d.error} />
      {d.data ? <FinanceView f={d.data[0]} pools={d.data[1]} spend={d.data[2]} sources={d.data[3]} poolsFin={d.data[4]} /> : null}
    </PanelShell>
  );
}
