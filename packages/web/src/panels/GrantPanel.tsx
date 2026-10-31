/**
 * One grant or proposal (`gr_…`), reached from any link to its id (in-tray rows, reports, meeting notes, chat; the
 * shareable `/#/grant/<id>`). The same row as the Town Hall in-tray, with its decision controls when a human has to
 * decide, plus what the row leaves out: the approach, the findings it draws on and the negotiation history.
 */
import type { GrantView } from "@muster-town/schema";
import { api } from "../api";
import { store, useTown } from "../state";
import { DocText } from "./Markdown";
import { GrantRow } from "./Places";
import { Glyph, PanelShell } from "./PanelShell";
import { ADJ, Empty, ErrorLine, Loading, Section, clock, fmtTokens, nameOf, timeAgo, useLoad } from "./ui";

export function GrantPanel({ id }: { id: string }) {
  const rev = useTown((s) => s.rev);
  const r = useLoad(() => api().grant(id), [id, rev]);
  const g = r.data;
  const building = useTown((s) => s.buildings.find((b) => b.id === g?.buildingId));
  const hall = useTown((s) => s.buildings.find((b) => b.kind === "town-hall"));
  const title = g ? g.objective : "Grant";
  const subtitle = g ? <>{building ? <button className="link" onClick={() => store.open({ kind: "building", id: building.id })}>{building.name}</button> : g.buildingId} · {g.status === "proposed" || g.status === "countered" ? "proposal" : "grant"} · {id}</> : id;
  return (
    <PanelShell icon={<Glyph kind="intray" />} title={title} subtitle={subtitle}>
      <div className="grant-panel">
        <ErrorLine error={r.error} />
        {r.loading && !g ? <Loading /> : !g ? (r.error ? null : <Empty>No grant with id {id}.</Empty>) : (
          <>
            <GrantRow grant={g} onDecided={r.reload} onOpenDoc={(docId) => store.open({ kind: "library", docId })} />
            {g.approach ? <Section title="Approach"><div className="asg-desc"><DocText text={g.approach} /></div></Section> : null}
            {g.testingPlan.length ? (
              <Section title="Testing plan (from before key results moved onto grants)">
                <ul className="kr-list">{g.testingPlan.map((t, i) => <li key={i}>{t.text}<div className="muted kr-check">How to check: {t.howToCheck}</div></li>)}</ul>
              </Section>
            ) : null}
            {g.keyResults.some((k) => k.statusNote) ? <Section title="Key result notes"><ul className="kr-list">{g.keyResults.filter((k) => k.statusNote).map((k) => <li key={k.id}>{k.text}<div className="muted">{k.status.replace(/-/g, " ")}: <DocText text={k.statusNote} /></div></li>)}</ul></Section> : null}
            {g.findingsDocIds.length ? <Section title="Findings it draws on"><ul className="kr-list">{g.findingsDocIds.map((d) => <li key={d}><FindingLink id={d} /></li>)}</ul></Section> : null}
            <History grant={g} />
            <div className="actions">
              {building ? <button className="btn" onClick={() => store.open({ kind: "board", id: building.id })}>Building board</button> : null}
              {hall ? <button className="btn" onClick={() => store.open({ kind: "intray", id: hall.id })}>Town Hall in-tray</button> : null}
            </div>
          </>
        )}
      </div>
    </PanelShell>
  );
}

/** A findings doc by title once the store has it, else by id; opens it in the library. */
function FindingLink({ id }: { id: string }) {
  const title = useTown((s) => s.docs[id]?.title);
  return <button className="link" onClick={() => store.open({ kind: "library", docId: id })}>{title ?? id}</button>;
}

/** Every propose / counter / fund / checkpoint decision / close, oldest first, as the grant records it. */
function History({ grant: g }: { grant: GrantView }) {
  if (!g.history.length) return null;
  return (
    <Section title="History">
      <ul className="grant-history">
        {g.history.map((h, i) => (
          <li key={i}>
            <time title={h.at}>{clock(h.at)}</time>
            <span>
              <b>{nameOf(h.byId)}</b> {h.action === "close" && h.tokens != null ? `closed, returned ${fmtTokens(h.tokens)} ${ADJ} unspent to the Bank` : `${h.action}${h.tokens != null ? ` ${fmtTokens(h.tokens)} ${ADJ}` : ""}`} <span className="muted">· {timeAgo(h.at)}</span>
              {h.note ? <div className="muted"><DocText text={h.note} /></div> : null}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
