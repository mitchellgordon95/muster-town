/** Meeting: phase, attendees + summaries, live transcript, say box, decisions. */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Meeting, SnapshotBuilding } from "@muster-town/schema";
import { api } from "../api";
import { store, useTown, roleOf } from "../state";
import { Glyph, PanelShell } from "./PanelShell";
import { phaseTone } from "./BuildingPanel";
import { Act, Empty, Pill, Section, clock, nameOf, timeAgo } from "./ui";
import { portraitUrl } from "../map/sprites";
import { roomMeetings } from "./room";
import { AttendeePicker, useAttendees } from "./AttendeePicker";
import { attendeeInput } from "./attendees";
import { SignInNote } from "../auth/auth";
import { DocText, Markdown, docIdsIn } from "./Markdown";
import { docUrl } from "../route";

const PHASES: Meeting["phase"][] = ["scheduled", "collecting", "discussing", "done"];

/** `id` is a meeting id, or `room:<buildingId>` from walking up to a meeting room. */
export function MeetingPanel({ id }: { id?: string }) {
  const meetings = useTown((s) => s.meetings);
  const buildings = useTown((s) => s.buildings);
  const roomOf = id?.startsWith("room:") ? id.slice(5) : null;
  const building = roomOf ? buildings.find((b) => b.id === roomOf) : null;
  const { meeting, last } = useMemo(() => {
    if (id && !roomOf) return { meeting: meetings[id] ?? null, last: null };
    const { live, last } = roomMeetings(Object.values(meetings), roomOf ?? "", building?.kind === "town-hall");
    return { meeting: live, last };
  }, [id, roomOf, meetings, building]);
  // fetch if we only have an id
  useEffect(() => { if (id && !roomOf && !meetings[id]) api().meeting(id).then((m) => store.putMeeting(m), () => undefined); }, [id, roomOf, meetings]);

  if (!meeting) {
    return (
      <PanelShell icon={<Glyph kind="meeting" />} title={building ? `${building.name} meeting room` : "Meeting"} subtitle="No meeting here right now">
        <Empty>The table is empty.{building && canCall(building.id) ? " Call a meeting and the residents will send their summaries." : ""}</Empty>
        {building ? <CallMeeting building={building} /> : null}
        {last ? (
          <div className="actions center">
            <button className="btn" onClick={() => store.open({ kind: "meeting", id: last.id })}>Last meeting: {last.title} ({last.phase}, {timeAgo(last.endedAt ?? last.createdAt)})</button>
          </div>
        ) : null}
      </PanelShell>
    );
  }
  return <MeetingView m={meeting} />;
}

const canCall = (buildingId: string | null) => store.can("meeting.facilitate", buildingId) || store.can("building.manage", buildingId);

/** "Call a standup" for a building's room (town hall for Town Hall). Shown in an empty room and under a finished meeting. */
function CallMeeting({ building, again }: { building: SnapshotBuilding; again?: boolean }) {
  const hall = building.kind === "town-hall";
  const invite = useAttendees(building);
  if (!canCall(building.id)) return null;
  return (
    <>
      <div className="actions center">
        <Act tone="primary" run={async () => {
          const m = await api().createMeeting({ kind: hall ? "town-hall" : "standup", buildingId: hall ? null : building.id, startNow: true, ...attendeeInput(invite.picked) });
          store.putMeeting(m); store.open({ kind: "meeting", id: m.id });
        }}>{again ? "Call another" : "Call a"} {hall ? "town hall" : "standup"}</Act>
      </div>
      <AttendeePicker state={invite} />
    </>
  );
}

/** under the server's HUMAN_TYPING_MS (30 s) so a held draft never lapses */
const TYPING_PING_MS = 10_000;

function MeetingView({ m }: { m: Meeting }) {
  const agents = useTown((s) => s.agents);
  const me = useTown((s) => s.me);
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [m.transcript.length]);
  const buildings = useTown((s) => s.buildings);
  const room = buildings.find((b) => (m.buildingId ? b.id === m.buildingId : b.kind === "town-hall"));
  const bName = m.buildingId ? room?.name : "Town Hall";
  const oneOnOne = m.kind === "one-on-one";
  // a 1:1: the human who opened it ends it; only they and the manager speak
  const canRun = oneOnOne ? !!me && me.user.id === m.withUserId : store.can("meeting.facilitate", m.buildingId) || store.can("building.manage", m.buildingId);
  const open = m.phase === "collecting" || m.phase === "discussing"; // while live, doc links open in a new tab so the meeting (and an unsent draft) stays put
  const discussing = m.phase === "discussing";
  const submitted = m.attendeeIds.filter((a) => m.summaries[a]).length;
  // while there's an unsent draft, tell the server a human is typing so the agent facilitator doesn't end the meeting under us
  const drafting = discussing && !!me && !!text.trim();
  useEffect(() => {
    if (!drafting) return;
    const ping = () => { void api().typingMeeting(m.id).catch(() => {}); };
    ping();
    const timer = setInterval(ping, TYPING_PING_MS);
    return () => clearInterval(timer);
  }, [drafting, m.id]);
  const say = async () => {
    const t = text.trim(); if (!t || !discussing) return;
    setText("");
    try { store.putMeeting(await api().sayMeeting(m.id, t)); } catch (e) { setText(t); store.toast((e as Error).message, "bad"); }
  };
  return (
    <PanelShell icon={<Glyph kind="meeting" />} title={<>{m.title} <Pill tone={phaseTone(m.phase)}>{m.phase}</Pill></>} subtitle={oneOnOne ? `1:1 · ${bName ?? ""} · ${nameOf(m.withUserId)} and ★ ${nameOf(m.facilitatorId)}` : `${m.kind} · ${bName ?? ""} · facilitated by ${nameOf(m.facilitatorId)}`}>
      {oneOnOne ? null : (
        <ol className="phases">
          {PHASES.map((p, i) => <li key={p} className={p === m.phase ? "on" : PHASES.indexOf(m.phase) > i ? "past" : ""}>{p}</li>)}
        </ol>
      )}
      {m.agenda ? <div className="goal-card"><span>Agenda</span><DocText text={m.agenda} newTab={open} /></div> : null}
      <div className="actions">
        {canRun && m.phase === "collecting" ? <Act tone="primary" run={async () => store.putMeeting(await api().startMeeting(m.id))}>Start discussion</Act> : null}
        {m.notesDocId ? <button className="btn" onClick={() => store.open({ kind: "library", docId: m.notesDocId! })}>Open notes</button> : null}
      </div>
      {!open && m.phase !== "scheduled" && room && !oneOnOne ? <CallMeeting building={room} again /> : null}

      {oneOnOne ? null : <Section title={`Summaries (${submitted}/${m.attendeeIds.length})`}>
        <div className="summaries">
          {m.attendeeIds.map((aid) => {
            const a = agents[aid];
            const s = m.summaries[aid];
            return (
              <div key={aid} className={`summary ${s ? "" : "waiting"}`}>
                <div className="summary-who">{a ? <img src={portraitUrl(a.sprite, 2)} alt="" /> : null}<b>{a?.name ?? aid}</b><span>{a ? roleOf(a) : ""}</span></div>
                {s ? <div className="summary-text">{s.split("\n").map((l, i) => <div key={i}><DocText text={l} newTab={open} /></div>)}</div> : <div className="summary-text muted">{m.phase === "collecting" ? "writing…" : "no summary"}</div>}
              </div>
            );
          })}
        </div>
      </Section>}

      <Section title="Transcript">
        {!m.transcript.length ? <Empty>{m.phase === "collecting" ? "Discussion starts as soon as every summary is in." : oneOnOne && open ? `Say what's on your mind; ${nameOf(m.facilitatorId)} answers here.` : "Nobody has spoken."}</Empty> : (
          <div className="transcript">
            {m.transcript.map((u, i) => {
              const isMe = u.speakerKind === "user" && u.speakerId === me?.user.id;
              return (
                <div key={i} className={`utt ${u.speakerKind} ${isMe ? "me" : ""}`}>
                  <div className="utt-head"><b>{u.speakerKind === "system" ? "Town" : u.speakerKind === "user" ? (isMe ? "You" : nameOf(u.speakerId)) : nameOf(u.speakerId)}</b><time>{clock(u.at)}</time></div>
                  <Markdown text={u.text} className="bubble" breaks newTab={open} />
                </div>
              );
            })}
            <div ref={end} />
          </div>
        )}
      </Section>
      {open && !me ? <SignInNote to="speak in the meeting" /> : null}
      {open && me && (!oneOnOne || canRun) ? (
        <form className="chatbar" onSubmit={(e) => { e.preventDefault(); void say(); }}>
          <textarea rows={2} value={text} disabled={!discussing} placeholder={discussing ? (oneOnOne ? `Say something to ${nameOf(m.facilitatorId)}…` : "Say something to the meeting…") : "Chat opens when the discussion starts…"} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void say(); } }} />
          <button className="btn primary" disabled={!discussing || !text.trim()}>Say</button>
          {canRun ? <Act tone="bad" run={async () => store.putMeeting(await api().endMeeting(m.id))}>{oneOnOne ? "End 1:1" : "End meeting"}</Act> : null}
          <DraftDocs text={text} />
        </form>
      ) : null}
      {open && canRun ? <div className="foot-note">{oneOnOne ? `${nameOf(m.facilitatorId)} answers each message and can assign the work you agree on. Press End 1:1 when you're done; the transcript is filed in the cabinet.` : "The facilitator keeps listening while you talk. Press End meeting when you're done."}</div> : null}

      <Section title="Decisions">
        {!m.decisions.length ? <Empty>{m.phase === "done" ? "No decisions recorded." : oneOnOne ? `${nameOf(m.facilitatorId)} records the work you agree on here.` : "The facilitator records decisions at the end."}</Empty> : (
          <ol className="decisions">
            {m.decisions.map((d, i) => (
              <li key={i} className={d.supersededBy ? "superseded" : undefined} title={d.supersededBy ? `Superseded by decision ${d.supersededBy}` : undefined}>{d.supersedes ? <span className="muted">(replaces {d.supersedes}) </span> : null}<DocText text={d.text} newTab={open} />{d.assigneeId ? <> <button className="link" onClick={() => store.open({ kind: "agent", id: d.assigneeId!, tab: "Assignments" })}>→ {nameOf(d.assigneeId)}</button></> : null}</li>
            ))}
          </ol>
        )}
      </Section>
      <div className="foot-note">Scheduled {timeAgo(m.scheduledAt)}{m.startedAt ? ` · started ${timeAgo(m.startedAt)}` : ""}{m.endedAt ? ` · ended ${timeAgo(m.endedAt)}` : ""}</div>
    </PanelShell>
  );
}

/** The docs cited in the say-box draft, by title, each opening in a new tab: check a `dc_…` id before you say it without leaving the meeting. */
function DraftDocs({ text }: { text: string }) {
  const docs = useTown((s) => s.docs);
  const ids = useMemo(() => docIdsIn(text), [text]);
  const tried = useRef(new Set<string>());
  useEffect(() => {
    for (const id of ids) {
      if (store.state.docs[id] || tried.current.has(id)) continue;
      tried.current.add(id);
      api().doc(id).then((d) => store.putDocs([d]), () => undefined);
    }
  }, [ids]);
  if (!ids.length) return null;
  return (
    <div className="doc-chips">
      {ids.map((id) => <a key={id} className="doc-chip" href={docUrl(id)} target="_blank" rel="noopener noreferrer" title={docs[id] ? id : "Not a document you can see"}>{docs[id]?.title ?? id}</a>)}
    </div>
  );
}
