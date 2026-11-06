/**
 * "Plans paid for" on the Bank's Inputs tab (gr_qggxximtru step 1, kr_au6pcldl3c): what the town pays in cash for a
 * subscription plan, $ per month from a first day to an optional last one (GET /api/bank/fees; docs/bank.md "Plans paid
 * for"). Anyone sees the rows; an admin also sees a small add form and an "End" action per ongoing row. A hosted
 * collective runs on API keys only (1:1 mt_pr3347g2w2): no plans is its normal case, so the section says so and has no form.
 * collective.json `plans` seeds the Workshop's own plan (core seed.ts).
 */
import { useState } from "react";
import type { BankFee } from "@muster-town/schema";
import { api } from "../api";
import { useTown } from "../state";
import { useHosted } from "./BankFunding";
import { Act, Empty, Loading, Section, useLoad } from "./ui";

const today = () => new Date().toISOString().slice(0, 10);
const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export function PlansPaidFor() {
  const admin = useTown((s) => !!s.me?.isAdmin);
  const hosted = useHosted();
  const [rev, setRev] = useState(0);
  const r = useLoad(() => api().bankFees(), [rev]);
  return <PlansPaidForView fees={r.data?.fees ?? null} admin={admin} hosted={hosted} onChange={() => setRev((x) => x + 1)} />;
}

/** The section given its rows (null = loading): the table, or "None recorded yet."; an admin also gets the add form. A hosted collective: no plans by design, no form. */
export function PlansPaidForView({ fees, admin, hosted = false, onChange: reload }: { fees: BankFee[] | null; admin: boolean; hosted?: boolean; onChange: () => void }) {
  if (hosted && !fees?.length) return <Section title="Plans paid for"><Empty>None: a hosted collective runs on API keys, not a subscription plan.</Empty></Section>;
  return (
    <Section title="Plans paid for">
      {!fees ? <Loading /> : !fees.length ? <Empty>None recorded yet.</Empty> : (
        <table className="table" aria-label="Plans paid for">
          <thead><tr><th>Plan</th><th>$ / month</th><th>From</th><th>To</th></tr></thead>
          <tbody>{fees.map((f) => <FeeRow key={f.id} f={f} admin={admin} onChange={reload} />)}</tbody>
        </table>
      )}
      {admin && !hosted ? <AddFee onChange={reload} /> : null}
    </Section>
  );
}

function FeeRow({ f, admin, onChange }: { f: BankFee; admin: boolean; onChange: () => void }) {
  const [end, setEnd] = useState<string | null>(null);
  return (
    <tr>
      <td>{f.label}</td>
      <td>{usd(f.usdPerMonth)}</td>
      <td>{f.fromDate}</td>
      <td>
        {end === null ? <>
          {f.toDate ?? <span className="muted">ongoing</span>}
          {admin && !f.toDate ? <> <button type="button" className="btn sm" onClick={() => setEnd(today())}>End</button></> : null}
        </> : <>
          <input type="date" aria-label="Last paid day" value={end} min={f.fromDate} onChange={(e) => setEnd(e.target.value)} />
          {" "}<Act small tone="primary" disabled={!end} run={async () => { await api().endBankFee(f.id, end); setEnd(null); onChange(); }}>Save</Act>
          {" "}<button type="button" className="btn sm" onClick={() => setEnd(null)}>Cancel</button>
        </>}
      </td>
    </tr>
  );
}

/** The admin's add form: label, $ per month, first day, optional last day (one line). */
function AddFee({ onChange }: { onChange: () => void }) {
  const [label, setLabel] = useState("");
  const [usdText, setUsd] = useState("");
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState("");
  const amount = Number(usdText);
  const ready = label.trim().length > 0 && label.trim().length <= 80 && Number.isFinite(amount) && amount > 0 && !!from && (!to || to >= from);
  return (
    <form className="bank-fee-form" aria-label="Record a plan" onSubmit={(e) => e.preventDefault()} style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: 6 }}>
      <input aria-label="Plan" placeholder="Plan, e.g. Max 20x" maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} style={{ width: 150 }} />
      <input aria-label="$ per month" type="number" min={0} step="any" placeholder="$ / month" value={usdText} onChange={(e) => setUsd(e.target.value)} style={{ width: 90 }} />
      <input aria-label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      <input aria-label="To (optional)" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
      <Act small tone="primary" disabled={!ready} run={async () => {
        await api().addBankFee({ label: label.trim(), usdPerMonth: amount, from, ...(to ? { to } : {}) });
        setLabel(""); setUsd(""); setTo(""); onChange();
      }}>Add plan</Act>
    </form>
  );
}
