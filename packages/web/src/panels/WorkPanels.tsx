/**
 * An assignment card (`as_…`) and a session panel (`se_…`), reached from any link to their ids (kr_utx7pmv1yk "No dead ids";
 * the shareable `/#/assignment/<id>` and `/#/session/<id>`). Both are public reads: GET /api/assignments/:id (the card, without
 * its creator or origin) and GET /api/sessions/:id (the transcript file only for an admin, its building's manager or its agent).
 */
import type { ReactNode } from "react";
import { api } from "../api";
import { store, useTown } from "../state";
import { TranscriptLink } from "./AgentPanel";
import { DocText, IdLink, rememberAssignmentTitle } from "./Markdown";
import { Glyph, PanelShell } from "./PanelShell";
import { ADJ, Empty, ErrorLine, KV, Loading, Section, StatusPill, dayClock, fmtTokens, timeAgo, useLoad } from "./ui";

const LANE_WORDS = { grant: "grant", exploration: "exploration", directed: "directed (a human asked for it)" } as const;

/** When and how long: "Oct 31 20:36 · 42 min" (or "running for 12 min"). */
function span(startedAt: string, endedAt: string | null): string {
  const min = Math.max(1, Math.round(((endedAt ? Date.parse(endedAt) : Date.now()) - Date.parse(startedAt)) / 60_000));
  return `${dayClock(startedAt)} · ${endedAt ? `${min} min` : `running for ${min} min`}`;
}

export function AssignmentPanel({ id }: { id: string }) {
  const rev = useTown((s) => s.rev);
  const r = useLoad(() => api().assignmentCard(id).then((a) => { rememberAssignmentTitle(a.id, a.title); return a; }), [id, rev]);
  const a = r.data;
  const subtitle = a ? <>{a.buildingName ? <button className="link" onClick={() => store.open({ kind: "building", id: a.buildingId })}>{a.buildingName}</button> : a.buildingId} · assignment · {id}</> : id;
  return (
    <PanelShell icon={<Glyph kind="intray" />} title={a?.title ?? "Assignment"} subtitle={subtitle}>
      <div className="grant-panel">
        <ErrorLine error={r.error} />
        {r.loading && !a ? <Loading /> : !a ? (r.error ? null : <Empty>No assignment with id {id}.</Empty>) : (
          <>
            <KV items={[
              ["Status", <><StatusPill status={a.status} />{a.heldReason ? <span className="muted"> · {a.heldReason}</span> : null}</>],
              ["Who", <button className="link" onClick={() => store.open({ kind: "agent", id: a.agentId })}>{a.agentName ?? a.agentId}</button>],
              ["Lane", <>{LANE_WORDS[a.lane]}{a.grantId ? <> · <IdLink id={a.grantId} /></> : null}{a.keyResultId ? <> · <IdLink id={a.keyResultId} /></> : null}{a.sourceId ? <> · from <IdLink id={a.sourceId} /></> : null}</>],
              ...(a.gap ? [["Gap", a.gap] as [string, ReactNode]] : []),
              ["Report", a.reportId ? <IdLink id={a.reportId} /> : a.status === "done" || a.status === "cancelled" ? "none" : "not yet"],
              ...(a.fromAssignmentId ? [["Retry of", <IdLink id={a.fromAssignmentId} />] as [string, ReactNode]] : []),
              ...(a.fromReportId ? [["From report", <IdLink id={a.fromReportId} />] as [string, ReactNode]] : []),
              ...(a.fromMeetingId ? [["From meeting", <IdLink id={a.fromMeetingId} />] as [string, ReactNode]] : []),
              ...(a.chainId && a.chainId !== a.id ? [["Chain", <IdLink id={a.chainId} />] as [string, ReactNode]] : []),
              ["Created", `${dayClock(a.createdAt)} (${timeAgo(a.createdAt)})`],
            ]} />
            {a.description ? <Section title="What it asks"><div className="asg-desc"><DocText text={a.description} /></div></Section> : null}
            <Section title="Sessions">
              {a.sessions.length ? (
                <ul className="kr-list">
                  {a.sessions.map((s) => (
                    <li key={s.id}>
                      <IdLink id={s.id} /> <span className="muted">· {span(s.startedAt, s.endedAt)} · {s.status}{s.endedAt ? ` · ${fmtTokens(s.adjustedOutputTokens)} ${ADJ}` : ""}{s.turns ? ` · ${s.turns} turns` : ""}</span>
                    </li>
                  ))}
                </ul>
              ) : <Empty>No session yet.</Empty>}
            </Section>
          </>
        )}
      </div>
    </PanelShell>
  );
}

export function SessionPanel({ id }: { id: string }) {
  const rev = useTown((s) => s.rev);
  const r = useLoad(() => api().sessionById(id), [id, rev]);
  const s = r.data?.session;
  const file = r.data?.transcript ?? null;
  const agentName = useTown((st) => (s ? st.agents[s.agentId]?.name : undefined));
  return (
    <PanelShell icon={<Glyph kind="planning" />} title={s ? `${agentName ?? "Session"} · ${s.purpose} session` : "Session"} subtitle={<>session · {id}</>}>
      <div className="grant-panel">
        <ErrorLine error={r.error} />
        {r.loading && !s ? <Loading /> : !s ? (r.error ? null : <Empty>No session with id {id}.</Empty>) : (
          <KV items={[
            ["Who", <IdLink id={s.agentId} />],
            ["Assignment", s.assignmentId ? <IdLink id={s.assignmentId} /> : s.meetingId ? <>meeting <IdLink id={s.meetingId} /></> : "none"],
            ["When", span(s.startedAt, s.endedAt)],
            ["Status", <><StatusPill status={s.status} />{s.error ? <span className="muted"> · {s.error}</span> : null}</>],
            ["Tokens", s.endedAt ? `${fmtTokens(s.adjustedOutputTokens)} ${ADJ} · ${s.turns} turns · ${s.model}` : `running (tokens book when it ends) · ${s.model}`],
            ["Report", s.reportId ? <IdLink id={s.reportId} /> : s.endedAt ? "none" : "not yet"],
            ["Transcript", file ? <TranscriptLink sessionId={s.id} /> : <span className="muted">kept for admins, the building's managers and the agent</span>],
          ]} />
        )}
      </div>
    </PanelShell>
  );
}
