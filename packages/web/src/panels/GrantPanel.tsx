/**
 * One grant or proposal (`gr_…`), reached from any link to its id (in-tray rows, reports, meeting notes, chat; the
 * shareable `/#/grant/<id>`). The same row as the Town Hall in-tray, with its decision controls when a human has to
 * decide, plus what the row leaves out: the approach, the findings it draws on and the negotiation history.
 * It opens on a summary (gr_zak30564zh, kr_obykl8yydh): the row's status, spent / granted and one line per key result;
 * the plan, the sessions and the earlier history are each one click away.
 */
import { historyActor, historyNote, type GrantView } from "@muster-town/schema";
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
            <GrantRow grant={g} onPage onDecided={r.reload} onOpenDoc={(docId) => store.open({ kind: "library", docId })} />
            <Plan grant={g} />
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

/** The approach, stop condition, findings and (old grants) testing plan, folded to one line. */
function Plan({ grant: g }: { grant: GrantView }) {
  const parts = [g.approach ? "approach" : null, "stop condition", g.findingsDocIds.length ? `${g.findingsDocIds.length} finding${g.findingsDocIds.length === 1 ? "" : "s"}` : null, g.testingPlan.length ? "testing plan" : null].filter(Boolean);
  return (
    <details className="grant-fold grant-plan-fold">
      <summary><b>Plan</b>{parts.join(", ")}</summary>
      {g.approach ? <div className="asg-desc"><DocText text={g.approach} /></div> : null}
      <div className="intray-proposal">Stop when: {g.stopCondition}</div>
      {g.findingsDocIds.length ? <><div className="muted">Findings it draws on:</div><ul className="kr-list">{g.findingsDocIds.map((d) => <li key={d}><FindingLink id={d} /></li>)}</ul></> : null}
      {g.testingPlan.length ? <><div className="muted">Testing plan (from before key results moved onto grants):</div><ul className="kr-list">{g.testingPlan.map((t, i) => <li key={i}>{t.text}<div className="muted kr-check">How to check: {t.howToCheck}</div></li>)}</ul></> : null}
    </details>
  );
}

/** A long note folds to its first words; the full note (with its links) is one click away. */
const FOLD_AT = 160;
function HistoryNote({ text, fold }: { text: string; fold?: boolean }) {
  if (!fold || text.length <= FOLD_AT) return <div className="muted"><DocText text={text} /></div>;
  const plain = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`#>]/g, "").replace(/\s+/g, " ");
  return (
    <details className="grant-history-note muted">
      <summary>{plain.slice(0, plain.lastIndexOf(" ", FOLD_AT) > 0 ? plain.lastIndexOf(" ", FOLD_AT) : FOLD_AT)}… <span className="more">more</span></summary>
      <DocText text={text} />
    </details>
  );
}

/** One propose / counter / fund / checkpoint decision / close, as the grant records it; `fold`: a long note folds. */
function HistoryEntry({ h, fold }: { h: GrantView["history"][number]; fold?: boolean }) {
  return (
    <li>
      <time title={h.at}>{clock(h.at)}</time>
      <span>
        <b>{historyActor(h, nameOf)}</b> {h.action === "close" && h.tokens != null ? `closed, returned ${fmtTokens(h.tokens)} ${ADJ} unspent to the Bank` : `${h.action === "withdraw" ? "withdrew the proposal" : h.action}${h.tokens != null ? ` ${fmtTokens(h.tokens)} ${ADJ}` : ""}`} <span className="muted">· {timeAgo(h.at)}</span>
        {historyNote(h) ? <HistoryNote text={historyNote(h)} fold={fold} /> : null}
      </span>
    </li>
  );
}

/** The latest entry, with the earlier ones (oldest first) folded above it. */
function History({ grant: g }: { grant: GrantView }) {
  if (!g.history.length) return null;
  const earlier = g.history.slice(0, -1);
  const latest = g.history[g.history.length - 1]!;
  return (
    <Section title="History">
      {earlier.length ? (
        <details className="grant-history-earlier">
          <summary>Show all {g.history.length}</summary>
          <ul className="grant-history">{earlier.map((h, i) => <HistoryEntry key={i} h={h} />)}</ul>
        </details>
      ) : null}
      <ul className="grant-history"><HistoryEntry h={latest} fold /></ul>
    </Section>
  );
}

const n = (x: number) => x.toLocaleString("en-US");

/** The sessions the grant paid for (GET /api/sessions?grantId=, gr_4tf9hd64d5); loads once the grant has spent anything. */
function Sessions({ grant: g }: { grant: GrantView }) {
  const rev = useTown((s) => s.rev);
  const r = useLoad(() => (g.spentTokens > 0 || g.status === "funded" ? api().grantSessions(g.id) : Promise.resolve(null)), [g.id, g.spentTokens, rev]);
  if (!r.data && !r.error) return null;
  return <><ErrorLine error={r.error} />{r.data ? <GrantSessionList data={r.data} spentTokens={g.spentTokens} /> : null}</>;
}

/**
 * Folded to its footer line (count, sum, = spent ✓, ≈ $); open: one row per session, newest first: when, who, which assignment, the model, its adj. tokens and ≈ $ at list price, and
 * the report it filed (or "error, no report" / "running"); a row opens the session panel. The footer sums the rows and
 * says whether they equal the grant's spentTokens (a visible ✗ with both numbers when they don't).
 */
export function GrantSessionList({ data, spentTokens }: { data: GrantSessions; spentTokens: number }) {
  if (!data.sessions.length) return <Empty>No sessions yet.</Empty>;
  const total = data.sessions.reduce((t, s) => t + s.adjustedOutputTokens, 0);
  const usd = data.sessions.reduce((t, s) => t + s.usd, 0);
  return (
    <details className="grant-fold grant-sessions-fold">
      <summary className={`grant-sessions-total${total === spentTokens ? "" : " bad"}`}>
        <b>Sessions</b>{data.sessions.length} session{data.sessions.length === 1 ? "" : "s"} · {n(total)} {ADJ} {total === spentTokens ? "= spent ✓" : `✗ ≠ spent ${n(spentTokens)}`} · ≈ ${usd.toFixed(2)} at API list price
      </summary>
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
    </details>
  );
}
