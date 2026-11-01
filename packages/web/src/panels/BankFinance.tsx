/**
 * The Bank page's finance sections (1:1 mt_ew2d0mm7h9: one Bank page, the old Finance page folded into it), each over one
 * public read-only endpoint and each left out when its endpoint can't be loaded (`useFinance`, `BankPanel` lays them out):
 * Tokens from GET /api/finance: total received, used, expired and left with the sum check (used + expired + left = total +
 * overdrawn) and under the overdrawn figure its parts (overdrawnBreakdown, dc_4exx02zf9g), which sum to it; the 30-day
 * projection and the trailing burn it rests on. Sources (gr_gbpbbwy9b8 step 2) from GET /api/finance/sources: each Bank input
 * (open it for its dated credits) and each direct donation, the two subtotals and Total received, checked against /api/finance
 * `total`. Spending (gr_8gtgmd828o step 2)
 * from GET /api/finance/spend: `used` by building → grant → assignment, each level collapsible, with the no-grant, no-assignment
 * and unattributed, weight-mismatch (pre-conversion pricing, not spend; step 2b) and not-funded rows that make the top level
 * sum to `used`. Hosting (Fly.io) from GET /api/finance/fly (1:1 mt_s6f8mvjw9h): what the desks' Machines and the town Machine
 * cost in dollars, today and over the window, per building, estimated from desk sessions' wall time at Fly's list prices; the
 * daily desk cap when one is set. The Bank page opens from the Bank on the map, the HUD's "$", `#/bank` or the old `#/finance`.
 */
import { api, type Finance, type FinanceFly, type FinanceSources, type FinanceSpend, type SpendNode } from "../api";
import type { ReactNode } from "react";
import { ADJ, ADJ_HINT, Section, useLoad } from "./ui";
import { creditsLeftLine } from "./BankFunding";

const n = (x: number) => Math.round(x).toLocaleString("en-US");

/** Dollars to the cent with thousands separators; a minus sign for the rows taken off ("−$2.00"). */
export const dollars = (x: number) => `${x < 0 ? "−" : ""}$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** A token figure's dollar twin at API list price, as shown after it: "≈ $1,234.56". */
export const approxUsd = (x: number) => `≈ ${dollars(x)}`;
/** The one footnote under every "≈ $" figure (gr_gmzli3f96j). */
export const USD_NOTE = "Dollars are at API list price; a subscription pays a flat fee instead.";
const Usd = ({ x }: { x: number | undefined }) => (x === undefined ? null : <span className="muted finance-usd"> {approxUsd(x)}</span>);

/** The sum check in words: what the four figures add up to, and by how much it misses when it does. */
export function sumCheckLine(f: Finance): { ok: boolean; text: string } {
  const lhs = f.used + f.expired + f.left, rhs = f.total + f.overdrawn;
  const used = `used ${n(f.used)} + expired ${n(f.expired)} + left ${n(f.left)}`, total = `total ${n(f.total)}${f.overdrawn ? ` + overdrawn ${n(f.overdrawn)}` : ""}`;
  return f.sumCheck.ok
    ? { ok: true, text: `The server checked that ${used} equals ${total} (${n(rhs)}).` }
    : { ok: false, text: `Does not add up (off by ${n(f.sumCheck.diff)}): ${used} comes to ${n(lhs)}, but ${total} comes to ${n(rhs)}.` };
}

/** Net per day in plain words: burn − inflow, a surplus when more comes in than is used, a shortfall when less does. */
export function netPerDay(p: Finance["projection"]): string {
  if (p.netDailyBurn < 0) return `+${n(-p.netDailyBurn)} / day surplus`;
  if (p.netDailyBurn > 0) return `−${n(p.netDailyBurn)} / day shortfall`;
  return "0 / day (inflow equals burn)";
}

/** How long the tokens left last, from the API's runway (gr_rdzg83m0al). */
export function runwayText(p: Finance["projection"]): string {
  if (p.runway === "covered") return "covered by the daily inflow";
  if (p.runway === "no-usage" || p.runwayDays === null) return "nothing used lately";
  return `${n(p.runwayDays)} day${p.runwayDays === 1 ? "" : "s"}`;
}

/** The non-zero parts of `overdrawn`, labelled, in a fixed order; they sum to `overdrawn`. */
export function overdrawnParts(f: Finance): { key: string; label: string; tokens: number; note?: string }[] {
  const b = f.overdrawnBreakdown;
  if (!b) return [];
  return [
    { key: "durableOvershoot", label: "sessions that ran past the permanent tokens the Bank had (a debt, paid back from later API-key credits)", tokens: b.durableOvershoot },
    { key: "subscriptionOverdrawn", label: "subscription credits drawn past their size", tokens: b.subscriptionOverdrawn,
      note: "Left over from the Bank's switch to adj. tokens on 2026-10-27: before it, Fable sessions drew on credits sized in raw tokens, and converting those credits left the draws past their new size." },
    { key: "deletedCreditDebits", label: "drawn from credits since deleted", tokens: b.deletedCreditDebits },
    { key: "allocationOverspent", label: "donations to buildings spent past their size (a building used more than was donated to it)", tokens: b.allocationOverspent },
  ].filter((p) => p.tokens > 0);
}

/** A share of `used` as a percentage, one decimal ("12.3%"); negative for the not-funded row. */
export const pct = (share: number) => `${(share * 100).toFixed(1)}%`;

/** The spend check in words: the top-level rows vs `used`. */
export function spendCheckLine(sp: FinanceSpend): { ok: boolean; text: string } {
  const sum = sp.rows.reduce((t, r) => t + r.tokens, 0);
  return sp.check.ok
    ? { ok: true, text: `The server checked that the building rows, plus usage no session recorded, less the pricing difference and the unfunded part, equal used ${n(sp.used)}.` }
    : { ok: false, text: `Does not add up (off by ${n(sp.check.diff)}): the rows come to ${n(sum)}, but used is ${n(sp.used)}.` };
}

/** The dollar check in words: the top-level rows' dollars vs used dollars (`usdSumCheck`); null when the server sent no dollars. */
export function spendUsdCheckLine(sp: FinanceSpend): { ok: boolean; text: string } | null {
  if (!sp.usd || !sp.usdSumCheck) return null;
  const sum = sp.rows.reduce((t, r) => t + (r.usd ?? 0), 0);
  return sp.usdSumCheck.ok
    ? { ok: true, text: `The server checked that the rows' dollars add up to the used dollars, ${dollars(sp.usd.used)} at API list price.` }
    : { ok: false, text: `Dollars do not add up (off by ${dollars(sp.usdSumCheck.diff)}): the rows come to ${dollars(sum)}, but used is ${dollars(sp.usd.used)}.` };
}

/**
 * The Not funded row's note (gr_wp2rg302qu step 2), from GET /api/finance/spend's own fields: what the row is, why (sessions
 * the runtime skipped the debit for before PR #131; rule dc_cvp89lj91o), when it stopped (`notFundedLastAt`), the split by
 * building (`notFundedSplit`, largest first) and that it is written off. When the split's sum differs from `notFunded` both
 * are shown: with the server's `reason` as a plain line, else as a red \"These differ\" line; what donations paid only when above 0.
 */
export function notFundedNote(sp: Pick<FinanceSpend, "notFunded" | "notFundedSplit" | "notFundedLastAt" | "notFundedAllocationPaid" | "notFundedSplitCheck">): {
  lines: string[]; split: { name: string; tokens: number; usageRows: number }[]; differ: string | null; reason: string | null; after: string[];
} {
  const split = [...(sp.notFundedSplit ?? [])].sort((a, b) => b.tokens - a.tokens)
    .map((b) => ({ name: b.buildingId === null ? "unattributed" : b.buildingName, tokens: b.tokens, usageRows: b.usageRows }));
  const c = sp.notFundedSplitCheck;
  const lines = [
    `Usage the Bank never debited: work sessions ran, but no debit was recorded for them, so no Bank credit or donation paid for them. Taken off here so the rows sum to Used, which counts only what was paid.`,
    `Why: before PR #131 (chargeUsage) the runtime left some sessions' usage recorded but not charged. Fixed on 2026-10-31. A usage row counts as unpaid when no debit for the same agent lies within 2 seconds of it.`,
    sp.notFundedLastAt ? `No new unpaid usage since ${sp.notFundedLastAt.slice(0, 10)}.` : `No usage row is unpaid by that rule.`,
  ];
  const reason = c && !c.ok && c.reason
    ? `The rows by building come to ${n(c.sum)} ${ADJ} and Not funded to ${n(c.notFunded)} ${ADJ}. ${c.reason}`
    : null;
  const differ = c && !c.ok && !reason
    ? `These differ: the rows by building come to ${n(c.sum)} ${ADJ}, but Not funded is ${n(c.notFunded)} ${ADJ}. Not funded is exact (what sessions counted, less what was paid); the split by building is an estimate by the 2-second rule.`
    : null;
  const after = [`Written off: not charged to any building. The Bank's balance already reflects the real spend.`];
  if (sp.notFundedAllocationPaid > 0) after.push(`Donations straight to those buildings paid ${n(sp.notFundedAllocationPaid)} ${ADJ} of their undebited usage (a donation is spent without a Bank debit); that part is left out of the rows by building.`);
  return { lines, split, differ, reason, after };
}

function NotFundedNote({ sp }: { sp: FinanceSpend }) {
  const { lines, split, differ, reason, after } = notFundedNote(sp);
  return (
    <div className="muted not-funded-note">
      {lines.map((l) => <p key={l}>{l}</p>)}
      {split.length ? (
        <>
          <p>By building (usage rows with no debit):</p>
          <ul className="not-funded-split">
            {split.map((b) => <li key={b.name}>{b.name}: {n(b.tokens)} {ADJ} ({n(b.usageRows)} usage row{b.usageRows === 1 ? "" : "s"})</li>)}
          </ul>
        </>
      ) : null}
      {differ ? <p className="error-line">{differ}</p> : null}
      {reason ? <p>{reason}</p> : null}
      {after.map((l) => <p key={l}>{l}</p>)}
    </div>
  );
}

/** The note under a synthetic row; the weight-mismatch one is the API's own line, the not-funded one `notFundedNote`. */
const spendNotes = (sp: FinanceSpend): Partial<Record<SpendNode["kind"], ReactNode>> => ({
  "unattributed": "Paid for from the Bank or donations but not traceable to any one work session: work from before sessions counted their own tokens.",
  "weight-mismatch": sp.weightMismatchNote,
  "not-funded": <NotFundedNote sp={sp} />,
});

function SpendRow({ node, notes, top = false }: { node: SpendNode; notes: Partial<Record<SpendNode["kind"], ReactNode>>; top?: boolean }) {
  const line = (
    <span className="spend-line">
      <span className="spend-name" title={node.id ?? node.name}>{node.kind === "grant" && node.id
        ? <a className="spend-grant" href={`#/grant/${node.id}`} title={node.objective ?? node.name}>{node.name}</a>
        : node.name}{node.sessions ? <span className="muted"> · {n(node.sessions)} session{node.sessions === 1 ? "" : "s"}</span> : null}</span>
      <span className="spend-tokens">{n(node.tokens)}</span>
      {top && node.usd !== undefined ? <span className="spend-usd muted" title="At API list price">{dollars(node.usd)}</span> : null}
      <span className="spend-share muted">{pct(node.share)}</span>
    </span>
  );
  const note = notes[node.kind];
  if (!node.children?.length) return <div className={`spend-row spend-${node.kind}`}>{line}{note ? (typeof note === "string" ? <div className="muted">{note}</div> : note) : null}</div>;
  return (
    <details className={`spend-row spend-${node.kind}`}>
      <summary>{line}</summary>
      <div className="spend-children">{node.children.map((c, i) => <SpendRow key={c.id ?? `${c.kind}-${i}`} node={c} notes={notes} />)}</div>
    </details>
  );
}

export function SpendingView({ sp }: { sp: FinanceSpend }) {
  const check = spendCheckLine(sp), usdCheck = spendUsdCheckLine(sp);
  const notes = spendNotes(sp);
  return (
    <Section title="Spending">
      <p className="muted">Where the {n(sp.used)} used went{sp.usd ? <> ({approxUsd(sp.usd.used)})</> : null}: by building, then grant, then assignment ({ADJ}{sp.usd ? ", dollars" : ""}, share of used). Open a row for its parts.</p>
      <div className="spend-tree">
        {sp.rows.map((r, i) => <SpendRow key={r.id ?? `${r.kind}-${i}`} node={r} notes={notes} top />)}
      </div>
      <div className={check.ok ? "finance-check ok" : "error-line"} role="status">{check.ok ? "✓ " : "✗ "}{check.text}</div>
      {usdCheck ? <Check c={usdCheck} /> : null}
      {sp.usd ? <p className="muted finance-usd-note">{USD_NOTE} Each session is priced at the output price of the model its tokens are booked in (Opus 5.5, $20 per million, for every new session; older Fable sessions at Fable's $50 per million); rows with no session at $20 per million.</p> : null}
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
  const sum = `credited ${n(s.creditedTokens)} + donated ${n(s.donatedTokens)}`;
  if (!s.sumCheck.ok) return { ok: false, text: `Does not add up (off by ${n(s.sumCheck.diff)}): ${sum} comes to ${n(s.creditedTokens + s.donatedTokens)}, but total received is ${n(s.totalReceived)}.` };
  if (!s.matchesFinance) return { ok: false, text: `Does not match the Tokens total (off by ${n(s.totalReceived - s.financeTotal)}): ${sum} comes to ${n(s.totalReceived)}, but the Tokens total is ${n(s.financeTotal)}.` };
  return { ok: true, text: `The server checked that ${sum} equals total received ${n(s.totalReceived)}, the same as the Tokens total.` };
}

function SourceInputLine({ i }: { i: SourceInputRow }) {
  const meta = [i.source ? SOURCE_NAME[i.source] : null, i.recurrence, creditsLeftLine(i), i.who && i.label ? `from ${i.who}` : null, i.cancelledAt ? "cancelled" : null].filter(Boolean).join(" · ");
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

const Check = ({ c }: { c: { ok: boolean; text: string } }) => <div className={c.ok ? "finance-check ok" : "error-line"} role="status">{c.ok ? "✓ " : "✗ "}{c.text}</div>;

/** Dollars: cents for amounts, four places for an hourly rate. */
const usd = (x: number, places = 2) => `$${x.toFixed(places)}`;
const hours = (ms: number) => { const h = ms / 3_600_000; return h >= 10 ? `${Math.round(h)} h` : h >= 1 ? `${h.toFixed(1)} h` : `${Math.round(ms / 60_000)} min`; };

/** Desk, town and total dollars over the newest `n` days of the window (today included). */
export function flyWindowTotals(fly: Pick<FinanceFly, "days">, n: number): { days: number; deskUsd: number; townUsd: number; totalUsd: number } {
  const ds = fly.days.slice(0, n);
  const sum = (k: "deskUsd" | "townUsd" | "totalUsd") => Math.round(ds.reduce((s, d) => s + d[k], 0) * 1e6) / 1e6;
  return { days: ds.length, deskUsd: sum("deskUsd"), townUsd: sum("townUsd"), totalUsd: sum("totalUsd") };
}

/** The Fly check in words: each day's desk + town = total, and the buildings' desk time = the days'. */
export function flyCheckLine(fly: Pick<FinanceFly, "sumCheck" | "totals"> & Partial<Pick<FinanceFly, "townPaidBy">>): { ok: boolean; text: string } {
  const c = fly.sumCheck;
  if (c.ok && fly.townPaidBy === "host") return { ok: true, text: `The server checked that each day's desks equal that day's total, and that the buildings' desk time adds up to the days' (${hours(fly.totals.deskMs)}).` };
  if (c.ok) return { ok: true, text: `The server checked that each day's desks + town Machine equals that day's total, and that the buildings' desk time adds up to the days' (${hours(fly.totals.deskMs)}).` };
  return { ok: false, text: c.daysOk ? `Does not add up: the buildings' desk time misses the days' by ${hours(Math.abs(c.diff))}` : `Does not add up: a day's desks + town Machine misses its total by ${usd(Math.abs(c.diff), 6)}` };
}

const rateLine = (r: FinanceFly["rates"]["desk"]) => (r ? `${r.preset}, ${r.memoryMb >= 1024 ? `${r.memoryMb / 1024} GB` : `${r.memoryMb} MB`}: ${usd(r.usdPerHour, 4)}/h (${usd(r.usdPerMonth)} per 30 days)` : null);

/** The window's label: "Last N days (from → to)", or for a hosted collective younger than the window "Since it was created (from → to)". */
export function flyWindowLabel(fly: Pick<FinanceFly, "from" | "to" | "createdAt"> & { days: unknown[] }): string {
  const created = fly.createdAt?.slice(0, 10);
  return created && created === fly.from ? `Since it was created (${fly.from} → ${fly.to})` : `Last ${fly.days.length} days (${fly.from} → ${fly.to})`;
}

export const HOSTED_FLY_NOTE = "The server is run by muster.town; this collective pays only for its own desks.";

export function FlyView({ fly }: { fly: FinanceFly }) {
  const week = flyWindowTotals(fly, 7), all = flyWindowTotals(fly, fly.days.length);
  const t = fly.today;
  const desk = rateLine(fly.rates.desk), town = rateLine(fly.rates.town);
  // a hosted collective: the hub's town Machine is not its cost, so no Town Machine column or size row
  const own = fly.townPaidBy !== "host";
  const townCell = (x: number) => (own ? <td>{usd(x)}</td> : null);
  const windowLabel = flyWindowLabel(fly);
  return (
    <Section title="Hosting (Fly.io)">
      <p className="muted">
        What the town's servers cost, in US dollars: an estimate from the town's own records at Fly's list prices ({fly.rates.region}, read {fly.rates.pricedAt}),
        not Fly's bill. Each desk session runs on its own Machine for as long as it lasts{own ? "; the town Machine runs all day" : ""}.
      </p>
      {own ? null : <p className="fly-hosted">{HOSTED_FLY_NOTE}</p>}
      <table className="table finance-summary">
        <thead><tr><th /><th>Desks</th>{own ? <th>Town Machine</th> : null}<th>Total</th></tr></thead>
        <tbody>
          <tr title={`${t.day} UTC, so far`}><td>Today (so far)</td><td>{usd(t.deskUsd)}</td>{townCell(t.townUsd)}<td><b>{usd(t.totalUsd)}</b></td></tr>
          {all.days > 7 ? <tr><td>Last 7 days</td><td>{usd(week.deskUsd)}</td>{townCell(week.townUsd)}<td><b>{usd(week.totalUsd)}</b></td></tr> : null}
          <tr><td>{windowLabel}</td><td>{usd(all.deskUsd)}</td>{townCell(all.townUsd)}<td><b>{usd(all.totalUsd)}</b></td></tr>
          <tr className="sub-row" title="A town-wide limit on what the desks may cost in one day (Prod's desk performance work); the desks stop moving to faster Machines past it">
            <td>Daily desk cap</td><td colSpan={own ? 3 : 2}>{t.capUsdPerDay == null ? "none set" : `${usd(t.capUsdPerDay)} per day · today ${t.underCap ? "under" : "over"} the cap`}</td>
          </tr>
        </tbody>
      </table>
      <table className="table">
        <tbody>
          <tr><td>Desk Machine size</td><td>{desk ?? (fly.desksBackend === "fly" ? "no list price for this size" : `desks are not on Fly (${fly.desksBackend}): desk time shown, $0`)}</td></tr>
          {own ? <tr><td>Town Machine size</td><td>{town ?? "the server is not on a Fly Machine: $0"}</td></tr> : null}
          <tr><td>Desk time, last {all.days} days</td><td>{hours(fly.totals.deskMs)} over {n(fly.totals.sessions)} session{fly.totals.sessions === 1 ? "" : "s"}{fly.totals.unmeasuredSessions ? <span className="muted"> · {n(fly.totals.unmeasuredSessions)} timed from start and end, not measured on the desk</span> : null}</td></tr>
        </tbody>
      </table>
      {fly.buildings.length ? (
        <div className="spend-tree">
          {fly.buildings.map((b) => (
            <div key={b.id ?? "none"} className="spend-row spend-building" title={b.id ?? undefined}>
              <span className="spend-line">
                <span className="spend-name">{b.name}<span className="muted"> · {hours(b.deskMs)} · {n(b.sessions)} session{b.sessions === 1 ? "" : "s"}</span></span>
                <span className="spend-tokens">{usd(b.deskUsd)}</span>
              </span>
            </div>
          ))}
          <div className="spend-row"><span className="spend-line"><span className="spend-name"><b>Desks, last {all.days} days</b></span><span className="spend-tokens"><b>{usd(all.deskUsd)}</b></span></span></div>
        </div>
      ) : null}
      <p className="muted">Not counted: {fly.notCounted.join("; ")}.</p>
      <details className="spend-row"><summary className="muted">How this is estimated</summary><ul className="muted">{fly.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul></details>
      <Check c={flyCheckLine(fly)} />
    </Section>
  );
}

/** One line above the sections: the unit every amount is in (and the Hosting exception when that section is there), and what a ✓ line means. */
export const FinanceIntro = ({ hosting = false }: { hosting?: boolean }) => (
  <p className="muted finance-intro">
    Every amount here is in <abbr title={ADJ_HINT}>{ADJ}</abbr> (adjusted output tokens): the unit the town pays for AI model work in, where
    one Opus 5.5 output token counts 1, other models count at their price relative to it (Fable 2.5, Haiku 0.025), and input and cached tokens count at their lower price (1 adj. token ≈ 30 raw tokens on Opus).
    {hosting ? " Hosting (Fly.io), in its own tab, is in US dollars." : ""} A figure marked ≈ $ is the same tokens in dollars at API list price. A ✓ line under a section means the server checked that its numbers add up; ✗ would say by how much they are off.
  </p>
);

/** Tokens: total received, used, expired, left, overdrawn and its parts, with the sum check in words. */
export function TokensView({ f }: { f: Finance }) {
  const check = sumCheckLine(f);
  return (
    <Section title="Tokens">
      <table className="table finance-summary">
        <thead><tr><th /><th title={ADJ_HINT}>{ADJ}</th></tr></thead>
        <tbody>
          <tr><td>Total received</td><td><b>{n(f.total)}</b></td></tr>
          <tr className="sub-row"><td>credited to the Bank (subscriptions, API keys)</td><td>{n(f.credited)}</td></tr>
          <tr className="sub-row"><td>donated straight to buildings</td><td>{n(f.donated)}</td></tr>
          <tr><td>Used</td><td><b>{n(f.used)}</b><Usd x={f.usd?.used} /></td></tr>
          <tr title="Daily subscription tokens that renewed before they were drawn"><td>Expired (not drawn before renewal)</td><td>{n(f.expired)}</td></tr>
          <tr><td>Left</td><td><b>{n(f.left)}</b><Usd x={f.usd?.left} /></td></tr>
          {f.overdrawn ? <tr className="finance-overdrawn" title="Spent past what was received; the lines under it say where"><td>Overdrawn (used past what was received)</td><td>{n(f.overdrawn)}</td></tr> : null}
          {overdrawnParts(f).map((p) => (
            <tr key={p.key} className="sub-row"><td>{p.label}{p.note ? <div className="muted">{p.note}</div> : null}</td><td>{n(p.tokens)}</td></tr>
          ))}
        </tbody>
      </table>
      <div className={check.ok ? "finance-check ok" : "error-line"} role="status">{check.ok ? "✓ " : "✗ "}{check.text}</div>
      {f.usd ? <p className="muted finance-usd-note">{USD_NOTE}</p> : null}
    </Section>
  );
}

/** Next N days (on the Overview): used and left so far, the trailing burn, the expected inflow, the net per day, the projection and the runway at the net rate; used, left, burn and inflow with their "≈ $" twins and one footnote. */
export function ProjectionView({ f }: { f: Finance }) {
  const p = f.projection;
  return (
    <Section title={`Next ${p.days} days`}>
      <table className="table">
        <tbody>
          <tr><td>Used so far</td><td>{n(f.used)}<Usd x={f.usd?.used} /></td></tr>
          <tr><td>Left</td><td>{n(f.left)}<Usd x={f.usd?.left} /></td></tr>
          <tr><td>Burn rate (average of the last {p.burnDays} day{p.burnDays === 1 ? "" : "s"})</td><td>{n(p.trailingDailyBurn)} / day<Usd x={f.usd?.burnPerDay} /></td></tr>
          <tr><td>Coming in (expected from recurring inputs)</td><td>{n(p.dailyInflow)} / day<Usd x={f.usd?.inflowPerDay} /></td></tr>
          <tr><td>Net per day (burn − coming in)</td><td>{netPerDay(p)}</td></tr>
          <tr><td>Projected use, next {p.days} days at that rate</td><td><b>{n(p.projectedUse30d)}</b></td></tr>
          <tr><td>Tokens left last</td><td>{runwayText(p)}</td></tr>
        </tbody>
      </table>
      <p className="muted">Coming in is what the active recurring Bank inputs are expected to credit per day (a subscription at most its weekly cap / 7); one-off donations and one-time inputs are not counted. Tokens left last is what is left divided by the net per day.</p>
      {f.usd ? <p className="muted finance-usd-note">{USD_NOTE}</p> : null}
    </Section>
  );
}

/** What the Bank page's finance sections show: `f` from GET /api/finance, the rest null when its endpoint couldn't be loaded. */
export interface FinanceData { f: Finance; spend: FinanceSpend | null; sources: FinanceSources | null; fly: FinanceFly | null }

/** The four finance endpoints in parallel; only GET /api/finance is required (`error`), the others leave their section out. */
export function useFinance(): { data: FinanceData | null; error: string | null; loading: boolean } {
  const d = useLoad(() => Promise.all([api().finance(), api().financeSpend().catch(() => null), api().financeSources().catch(() => null), api().financeFly().catch(() => null)]), []);
  return { data: d.data ? { f: d.data[0], spend: d.data[1], sources: d.data[2], fly: d.data[3] } : null, error: d.error, loading: d.loading };
}

/** The footer: when the figures were read and which endpoints they came from. */
export const FinanceFooter = ({ f, spend, sources, fly }: FinanceData) => (
  <p className="muted">As of {f.at.slice(0, 16).replace("T", " ")} UTC · in adjusted output tokens{fly ? " (Hosting in US dollars)" : ""} · from <code>GET /api/bank</code>, <code>/api/finance</code>{sources ? <>, <code>/api/finance/sources</code></> : null}{spend ? <>, <code>/api/finance/spend</code></> : null}{fly ? <> and <code>/api/finance/fly</code></> : null}</p>
);

/** Every term the Bank page uses, in plain words (kr_zjawesqcyp): one list a stranger can read, at the foot of every tab. */
export const FINANCE_TERMS: [term: string, meaning: string][] = [
  ["Adjusted token (adj. token)", "The unit every amount is in, except Hosting (US dollars): one output token counts 1, and input and cached tokens count at their lower price. 1 adj. token ≈ 30 raw tokens on Opus, 24 on Fable."],
  ["Expiring and permanent", "Subscription tokens are credited each day and expire at the next renewal if nobody used them. API-key tokens are permanent: kept until used."],
  ["Overdrawn", "Tokens spent past what was received. Its parts: sessions that ran past the permanent tokens the Bank had (a debt, paid back from later API-key credits); subscription credits drawn past their size when the Bank switched to adjusted tokens on 2026-10-27; draws on credits since deleted; and donations a building spent past their size."],
  ["Held", "The unspent part of donations made straight to a building: only that building can spend them."],
  ["Claimed", "Tokens already promised: funded grants' remaining tokens, open grant proposals' asks and open exploration reservations. Claimed tokens are still in the Bank but no new work may count on them."],
  ["Free tokens", "What exploration (work no grant covers and no human asked for) may still claim: the general balance plus any earmarks at or above a goal, less funded grants' remaining tokens, open proposals' asks and open reservations. Never below zero; at zero nothing new is explored there."],
  ["Earmark", "A Bank input given for one goal: it pays only for work under that goal, nearest earmark first."],
  ["Exploration cap", "An optional limit on what exploration under a goal may spend per UTC day, inherited down the tree; on the top goal it is town-wide. None set: uncapped."],
  ["Not funded", "Work sessions the Bank never charged: tokens a session used that no Bank credit or donation paid for."],
  ["≈ $ (API list price)", "What the tokens would cost on an Anthropic API key at list price: each session at the output price of the model it is booked in (Opus 5.5, $20 per million, for every new session; older Fable sessions at $50 per million). A subscription pays a flat fee instead, so on a subscription-funded town this is not cash spent."],
  ["Grant", "Tokens a human approves for one building to reach one dated, checkable target; each grant's row opens the grant's page."],
];

/** The Terms block: FINANCE_TERMS as a definition list, closed until opened. */
export const FinanceTerms = () => (
  <details className="finance-terms">
    <summary className="muted">Terms used on this page</summary>
    <dl className="muted">{FINANCE_TERMS.map(([t, d]) => <div key={t}><dt><b>{t}</b></dt><dd>{d}</dd></div>)}</dl>
  </details>
);
