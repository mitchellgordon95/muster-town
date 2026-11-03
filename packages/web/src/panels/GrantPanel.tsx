/**
 * One grant or proposal (`gr_…`), reached from any link to its id (in-tray rows, reports, meeting notes, chat; the
 * shareable `/#/grant/<id>`). The same row as the Town Hall in-tray, with its decision controls when a human has to
 * decide, plus what the row leaves out: the approach, the findings it draws on and the negotiation history.
 */
import type { GrantView } from "@muster-town/schema";
import { api, type GrantSessions } from "../api";
import { store, useTown } from "../state";
import { DocText } from "./Markdown";
import { GrantRow } from "./Places";
import { Glyph, PanelShell } from "./PanelShell";
import { ADJ, Empty, ErrorLine, Loading, Section, clock, dayClock, fmtTokens, nameOf, timeAgo, useLoad } from "./ui";

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
            <Sessions grant={g} />
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
              <b>{nameOf(h.byId)}</b> {h.action === "close" && h.tokens != null ? `closed, returned ${fmtTokens(h.tokens)} ${ADJ} unspent to the Bank` : `${h.action === "withdraw" ? "withdrew the proposal" : h.action}${h.tokens != null ? ` ${fmtTokens(h.tokens)} ${ADJ}` : ""}`} <span className="muted">· {timeAgo(h.at)}</span>
              {h.note ? <div className="muted"><DocText text={h.note} /></div> : null}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

const n = (x: number) => x.toLocaleString("en-US");

/** The sessions the grant paid for (GET /api/sessions?grantId=, gr_4tf9hd64d5); loads once the grant has spent anything. */
function Sessions({ grant: g }: { grant: GrantView }) {
  const rev = useTown((s) => s.rev);
  const r = useLoad(() => (g.spentTokens > 0 || g.status === "funded" ? api().grantSessions(g.id) : Promise.resolve(null)), [g.id, g.spentTokens, rev]);
  if (!r.data && !r.error) return null;
  return <Section title="Sessions"><ErrorLine error={r.error} />{r.data ? <GrantSessionList data={r.data} spentTokens={g.spentTokens} /> : null}</Section>;
}

/**
 * One row per session, newest first: when, who, which assignment, the model, its adj. tokens and ≈ $ at list price, and
 * the report it filed (or "error, no report" / "running"); a row opens the session panel. The footer sums the rows and
 * says whether they equal the grant's spentTokens (a visible ✗ with both numbers when they don't).
 */
export function GrantSessionList({ data, spentTokens }: { data: GrantSessions; spentTokens: number }) {
  if (!data.sessions.length) return <Empty>No sessions yet.</Empty>;
  const total = data.sessions.reduce((t, s) => t + s.adjustedOutputTokens, 0);
  const usd = data.sessions.reduce((t, s) => t + s.usd, 0);
  return (
    <>
      <ul className="grant-sessions">
        {data.sessions.map((s) => (
          <li key={s.id}>
            <time title={s.startedAt}>{dayClock(s.startedAt)}</time>
            <span>
              <button className="link" onClick={() => store.open({ kind: "session", id: s.id })} title={`Open session ${s.id}`}>{s.agentName}{s.assignmentTitle ? `: ${s.assignmentTitle}` : ""}</button>
              <div className="muted">
                {s.model} · {n(s.adjustedOutputTokens)} {ADJ} · ≈ ${s.usd.toFixed(2)} · {s.reportId
                  ? <button className="link" onClick={() => store.open({ kind: "library", docId: s.reportId! })}>report</button>
                  : s.status === "running" ? "running" : s.error || s.status === "error" ? "error, no report" : "no report"}
              </div>
            </span>
          </li>
        ))}
      </ul>
      <div className={`grant-sessions-total${total === spentTokens ? "" : " bad"}`}>
        {data.sessions.length} session{data.sessions.length === 1 ? "" : "s"} · {n(total)} {ADJ} {total === spentTokens ? "= spent ✓" : `✗ ≠ spent ${n(spentTokens)}`} · ≈ ${usd.toFixed(2)} at API list price
      </div>
    </>
  );
}
