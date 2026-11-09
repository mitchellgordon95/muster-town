/**
 * The funding view (docs/legible-delegation.md §6, UI / UX C): the money asks on proposals as a slate, in the
 * Secretary's rank, the newest slate notice on top. Each card has a fund / hold toggle and a live line above: the Bank's
 * free tokens before these asks, the toggled asks' sum, what is left after, and what the toggled grants are expected
 * to spend (their steps' sizes × the calibrated ratio). The toggle funds nothing: each card decides through its buttons.
 */
import { useState } from "react";
import type { GrantView, Notice } from "@muster-town/schema";
import { grantPricingOf } from "@muster-town/schema";
import { api, type AskView } from "../api";
import { useTown } from "../state";
import { AskCard } from "./AskCard";
import { latestSlate, slateAsks, slateLine } from "./asks";
import { Markdown } from "./Markdown";
import { ADJ, Empty, fmtTokens, useLoad } from "./ui";

export function FundingView({ asks, grants, notices, onDecided, onOpenRecord }: { asks: AskView[]; grants: GrantView[]; notices?: Notice[]; onDecided: () => void; onOpenRecord?: (id: string) => void }) {
  const items = slateAsks(asks, grants);
  const town = useTown((s) => s.town);
  const sizes = grantPricingOf(town ?? {}).stepSizes;
  const bank = useLoad(() => api().bank().then((b) => b.free ?? null).catch(() => null), []);
  // the calibration from the health cache (public, never computed on a request)
  const cal = useLoad(() => api().health().then((h) => h.stepCalibration ?? null).catch(() => null), []);
  // every card starts on fund when the slate says nothing; the toggle is the reader's scratch pad
  const [funded, setFunded] = useState<Set<string>>(() => new Set(items.map((x) => x.grant.id)));
  const line = slateLine(bank.data, items, funded, sizes, cal.data);
  const slate = latestSlate(notices);
  const toggle = (id: string) => setFunded((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return (
    <div className="funding-view">
      {slate ? <div className="callout funding-slate"><b>{slate.title}</b><Markdown text={slate.body} /></div> : null}
      <div className={line.after !== null && line.after < 0 ? "funding-line over" : "funding-line"} aria-live="polite">
        <span>Free {line.before === null ? "…" : fmtTokens(line.before)}</span>
        <span>− toggled {fmtTokens(line.toggled)} <span className="muted">({line.count} of {items.length})</span></span>
        <span>= left <b>{line.after === null ? "…" : line.after < 0 ? `−${fmtTokens(-line.after)}` : fmtTokens(line.after)}</b></span>
        <span>expected spend <b>{fmtTokens(line.expected)}</b> {ADJ}</span>
      </div>
      <p className="muted funding-note">The toggle funds nothing. Decide each card with its own buttons. Expected spend is each step's size at what that size really costs.</p>
      {!items.length ? <Empty>No proposal waits for money.</Empty> : items.map(({ ask, grant }) => (
        <AskCard key={ask.id} ask={ask} grant={grant} onDecided={onDecided} onOpenRecord={onOpenRecord}
          aside={<label className="funding-toggle"><input type="checkbox" checked={funded.has(grant.id)} onChange={() => toggle(grant.id)} /> {funded.has(grant.id) ? "fund" : "hold"}</label>} />
      ))}
    </div>
  );
}
