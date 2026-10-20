/** Meeting: phase, attendees + summaries, live transcript, say box, decisions. */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Meeting } from "@agent-town/schema";
import { api } from "../api";
import { store, useTown } from "../state";
import { Glyph, PanelShell } from "./PanelShell";
import { phaseTone } from "./BuildingPanel";
import { Act, Empty, Pill, Section, clock, nameOf, timeAgo } from "./ui";
import { portraitUrl } from "../map/sprites";

const PHASES: Meeting["phase"][] = ["scheduled", "collecting", "discussing", "done"];

/** `id` is a meeting id, or `room:<buildingId>` from walking up to a meeting room. */
export function MeetingPanel({ id }: { id?: string }) {
  const meetings = useTown((s) => s.meetings);
  const buildings = useTown((s) => s.buildings);
  const roomOf = id?.startsWith("room:") ? id.slice(5) : null;
  const building = roomOf ? buildings.find((b) => b.id === roomOf) : null;
  const meeting = useMemo(() => {
    if (id && !roomOf) return meetings[id] ?? null;
    const inRoom = Object.values(meetings).filter((m) => m.buildingId === roomOf || (building?.kind === "town-hall" && m.buildingId === null));
    const active = inRoom.filter((m) => m.phase !== "done" && m.phase !== "cancelled").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return active[0] ?? inRoom.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }, [id, roomOf, meetings, building]);
  // fetch if we only have an id
  useEffect(() => { if (id && !roomOf && !meetings[id]) api().meeting(id).then((m) => store.putMeeting(m), () => undefined); }, [id, roomOf, meetings]);

  if (!meeting) {
    const bid = roomOf ?? null;
    const can = store.can("meeting.facilitate", bid) || store.can("building.manage", bid);
    return (
      <PanelShell icon={<Glyph kind="meeting" />} title={building ? `${building.name} meeting room` : "Meeting"} subtitle="No meeting here right now">
        <Empty>The table is empty.{can ? " Call a meeting and the residents will send their summaries." : ""}</Empty>
        {can && building ? (
          <div className="actions center">
            <Act tone="primary" run={async () => {
              const m = await api().createMeeting({ kind: building.kind === "town-hall" ? "town-hall" : "standup", buildingId: building.kind === "town-hall" ? null : building.id, startNow: true });
              store.putMeeting(m); store.open({ kind: "meeting", id: m.id });
            }}>Call a {building.kind === "town-hall" ? "town hall" : "standup"}</Act>
          </div>
        ) : null}
      </PanelShell>
    );
  }
  return <MeetingView m={meeting} />;
}

function MeetingView({ m }: { m: Meeting }) {
  const agents = useTown((s) => s.agents);
  const me = useTown((s) => s.me);
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [m.transcript.length]);
  const bName = m.buildingId ? store.state.buildings.find((b) => b.id === m.buildingId)?.name : "Town Hall";
  const canRun = store.can("meeting.facilitate", m.buildingId) || store.can("building.manage", m.buildingId);
  const open = m.phase === "collecting" || m.phase === "discussing";
  const submitted = m.attendeeIds.filter((a) => m.summaries[a]).length;
  const say = async () => {
    const t = text.trim(); if (!t) return;
    setText("");
    try { store.putMeeting(await api().sayMeeting(m.id, t)); } catch (e) { setText(t); store.toast((e as Error).message, "bad"); }
  };
  return (
    <PanelShell icon={<Glyph kind="meeting" />} title={<>{m.title} <Pill tone={phaseTone(m.phase)}>{m.phase}</Pill></>} subtitle={`${m.kind} · ${bName ?? ""} · facilitated by ${nameOf(m.facilitatorId)}`}>
      <ol className="phases">
        {PHASES.map((p, i) => <li key={p} className={p === m.phase ? "on" : PHASES.indexOf(m.phase) > i ? "past" : ""}>{p}</li>)}
      </ol>
      {m.agenda ? <div className="goal-card"><span>Agenda</span>{m.agenda}</div> : null}
      <div className="actions">
        {canRun && m.phase === "collecting" ? <Act tone="primary" run={async () => store.putMeeting(await api().startMeeting(m.id))}>Start discussion</Act> : null}
        {canRun && open ? <Act tone="bad" run={async () => store.putMeeting(await api().endMeeting(m.id))}>End meeting</Act> : null}
        {m.notesDocId ? <button className="btn" onClick={() => store.open({ kind: "library", docId: m.notesDocId! })}>Open notes</button> : null}
      </div>

      <Section title={`Summaries (${submitted}/${m.attendeeIds.length})`}>
        <div className="summaries">
          {m.attendeeIds.map((aid) => {
            const a = agents[aid];
            const s = m.summaries[aid];
            return (
              <div key={aid} className={`summary ${s ? "" : "waiting"}`}>
                <div className="summary-who">{a ? <img src={portraitUrl(a.sprite, 2)} alt="" /> : null}<b>{a?.name ?? aid}</b><span>{a?.title}</span></div>
                {s ? <div className="summary-text">{s.split("\n").map((l, i) => <div key={i}>{l}</div>)}</div> : <div className="summary-text muted">{m.phase === "collecting" ? "writing…" : "no summary"}</div>}
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Transcript">
        {!m.transcript.length ? <Empty>{m.phase === "collecting" ? "Discussion starts once summaries are in. You can speak now; the facilitator will read it." : "Nobody has spoken."}</Empty> : (
          <div className="transcript">
            {m.transcript.map((u, i) => {
              const isMe = u.speakerKind === "user" && u.speakerId === me?.user.id;
              return (
                <div key={i} className={`utt ${u.speakerKind} ${isMe ? "me" : ""}`}>
                  <div className="utt-head"><b>{u.speakerKind === "user" ? (isMe ? "You" : nameOf(u.speakerId)) : nameOf(u.speakerId)}</b><time>{clock(u.at)}</time></div>
                  <div>{u.text}</div>
                </div>
              );
            })}
            <div ref={end} />
          </div>
        )}
      </Section>
      {open ? (
        <form className="chatbar" onSubmit={(e) => { e.preventDefault(); void say(); }}>
          <textarea rows={2} value={text} placeholder="Say something to the meeting…" onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void say(); } }} />
          <button className="btn primary" disabled={!text.trim()}>Say</button>
        </form>
      ) : null}
      {open && canRun ? <div className="foot-note">The facilitator keeps listening while you talk. Press End meeting when you're done.</div> : null}

      <Section title="Decisions">
        {!m.decisions.length ? <Empty>{m.phase === "done" ? "No decisions recorded." : "The facilitator records decisions at the end."}</Empty> : (
          <ul className="decisions">
            {m.decisions.map((d, i) => (
              <li key={i}>{d.text}{d.assigneeId ? <> <button className="link" onClick={() => store.open({ kind: "agent", id: d.assigneeId!, tab: "Assignments" })}>→ {nameOf(d.assigneeId)}</button></> : null}</li>
            ))}
          </ul>
        )}
      </Section>
      <div className="foot-note">Scheduled {timeAgo(m.scheduledAt)}{m.startedAt ? ` · started ${timeAgo(m.startedAt)}` : ""}{m.endedAt ? ` · ended ${timeAgo(m.endedAt)}` : ""}</div>
    </PanelShell>
  );
}
