/** Meeting: phase, attendees + summaries, live transcript, say box, decisions. */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Meeting, MeetingAttachment, SnapshotBuilding } from "@muster-town/schema";
import { api } from "../api";
import { store, useTown, roleOf } from "../state";
import { Glyph, PanelShell } from "./PanelShell";
import { Act, Empty, Pill, Section, clock, nameOf, timeAgo, useLoad } from "./ui";
import { portraitUrl } from "../map/sprites";
import { buildingMeetings, phaseTone, roomMeetings } from "./room";
import { CallMeetingForm } from "./CallMeetingForm";
import { endMeetingConfirm } from "./endMeeting";
import { SignInNote } from "../auth/auth";
import { DocText, Markdown, docIdsIn } from "./Markdown";
import { docUrl, grantUrl } from "../route";
import type { PanelRef } from "../state";
import { useMediaPaste } from "./mediaPaste";
import { MeetingSlide } from "./MeetingSlide";

const PHASES: Meeting["phase"][] = ["scheduled", "collecting", "discussing", "done"];

/** `id` is a meeting id, or `room:<buildingId>` from walking up to a meeting room. */
export function MeetingPanel({ id }: { id?: string }) {
  const meetings = useTown((s) => s.meetings);
  const buildings = useTown((s) => s.buildings);
  const roomOf = id?.startsWith("room:") ? id.slice(5) : null;
  const building = roomOf ? buildings.find((b) => b.id === roomOf) : null;
  const meeting = useMemo(() => {
    if (id && !roomOf) return meetings[id] ?? null;
    return roomMeetings(Object.values(meetings), roomOf ?? "", building?.kind === "town-hall").live;
  }, [id, roomOf, meetings, building]);
  // fetch if we only have an id
  useEffect(() => { if (id && !roomOf && !meetings[id]) api().meeting(id).then((m) => store.putMeeting(m), () => undefined); }, [id, roomOf, meetings]);

  if (!meeting) {
    return (
      <PanelShell icon={<Glyph kind="meeting" />} title={building ? `${building.name} meeting room` : "Meeting"} subtitle="No meeting here right now">
        <Empty>The table is empty.{building && canCall(building.id) ? " Call a meeting and the residents will send their summaries." : ""}</Empty>
        {building ? <CallMeeting building={building} /> : null}
        {building ? <RoomMeetings building={building} /> : null}
      </PanelShell>
    );
  }
  return <MeetingView m={meeting} room={building ?? undefined} />;
}

/** The room's list: every meeting of the building, upcoming then past (what the building panel's old Meetings tab showed). `skip`: the meeting already shown above it. */
function RoomMeetings({ building, skip }: { building: SnapshotBuilding; skip?: string }) {
  const live = useTown((s) => s.meetings);
  const rev = useTown((s) => s.rev);
  // the snapshot carries only scheduled/active meetings; fetch the rest for the past list (as the schedule board does)
  const all = useLoad(() => api().meetings({}), [rev]);
  const { upcoming, past } = useMemo(() => {
    const m = new Map<string, Meeting>();
    for (const x of all.data ?? []) m.set(x.id, x);
    for (const x of Object.values(live)) m.set(x.id, x);
    return buildingMeetings([...m.values()], building.id, building.kind === "town-hall");
  }, [all.data, live, building]);
  const row = (m: Meeting) => (
    <button key={m.id} className="doc-row" onClick={() => store.open({ kind: "meeting", id: m.id })}>
      <div className="doc-row-title">{m.title}</div>
      <div className="doc-row-meta"><Pill tone={phaseTone(m.phase)}>{m.phase}</Pill><span>{m.kind} · {m.attendeeIds.length} attendees · {timeAgo(m.createdAt)}</span></div>
    </button>
  );
  const next = upcoming.filter((m) => m.id !== skip);
  return (
    <>
      {next.length ? <Section title={`Upcoming (${next.length})`}>{next.map(row)}</Section> : null}
      <Section title={`Past meetings (${past.length})`}>{past.length ? past.map(row) : <Empty>No meetings yet.</Empty>}</Section>
    </>
  );
}

const canCall = (buildingId: string | null) => store.can("meeting.facilitate", buildingId) || store.can("building.manage", buildingId);

/** The "Call a meeting" form for a building's room: open in an empty room, folded under a finished meeting. */
function CallMeeting({ building, again }: { building: SnapshotBuilding; again?: boolean }) {
  if (!canCall(building.id)) return null;
  return again ? <details className="attendees"><summary>Call another meeting</summary><CallMeetingForm building={building} /></details> : <CallMeetingForm building={building} />;
}

/** under the server's HUMAN_TYPING_MS (30 s) so a held draft never lapses */
const TYPING_PING_MS = 10_000;

function MeetingView({ m, room: roomPanel }: { m: Meeting; room?: SnapshotBuilding }) {
  const agents = useTown((s) => s.agents);
  const me = useTown((s) => s.me);
  const [text, setText] = useState("");
  const media = useMediaPaste(setText);
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
  const writing = useDrafting(m.id, open);
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
      {m.agenda ? <div className="goal-card"><span>Agenda</span>{m.agenda.split("\n").map((l, i) => <div key={i}><DocText text={l} newTab={open} /></div>)}</div> : null}
      {oneOnOne ? null : <div className="muted small-line">{m.deck ? "Presentation with chat · " : ""}Attendees bring: {m.brings.mode === "nothing" ? "nothing (no summaries)" : m.brings.mode === "custom" ? m.brings.text : "a status update"}{m.askHumans ? " · opens with decisions needed from the humans" : ""}</div>}
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

      {m.deck ? <MeetingSlide m={{ ...m, deck: m.deck }} /> : null}
      <Section title="Transcript">
        {!m.transcript.length ? <Empty>{m.phase === "collecting" ? "Discussion starts as soon as every summary is in." : oneOnOne && open ? `Say what's on your mind; ${nameOf(m.facilitatorId)} answers here.` : "Nobody has spoken."}</Empty> : (
          <div className="transcript">
            {m.transcript.map((u, i) => {
              const isMe = u.speakerKind === "user" && u.speakerId === me?.user.id;
              return (
                <div key={i} className={`utt ${u.speakerKind} ${isMe ? "me" : ""}`}>
                  <div className="utt-head"><b>{u.speakerKind === "system" ? "Town" : u.speakerKind === "user" ? (isMe ? "You" : nameOf(u.speakerId)) : nameOf(u.speakerId)}</b><time>{clock(u.at)}</time></div>
                  <Markdown text={u.text} className="bubble" breaks newTab={open} />
                  {u.attachment ? <Presented a={u.attachment} newTab={open} /> : null}
                </div>
              );
            })}
            <div ref={end} />
          </div>
        )}
        {writing.length ? <div className="utt-writing muted">{writingLine(writing.map((w) => w.name))}</div> : null}
      </Section>
      {open && !me ? <SignInNote to="speak in the meeting" /> : null}
      {open && me && (!oneOnOne || canRun) ? (
        <form className="chatbar" onSubmit={(e) => { e.preventDefault(); void say(); }}>
          <textarea {...media.props} rows={2} value={text} disabled={!discussing} placeholder={discussing ? (oneOnOne ? `Say something to ${nameOf(m.facilitatorId)}…` : "Say something to the meeting…") : "Chat opens when the discussion starts…"} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void say(); } }} />
          <button className="btn primary" disabled={!discussing || !text.trim() || media.uploading > 0}>Say</button>
          {canRun ? <Act tone="bad" run={async () => { const ask = endMeetingConfirm(m); if (ask && !confirm(ask)) return; store.putMeeting(await api().endMeeting(m.id)); }}>{oneOnOne ? "End 1:1" : "End meeting"}</Act> : null}
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
      {roomPanel ? <details className="attendees"><summary>Other meetings in this room</summary><RoomMeetings building={roomPanel} skip={m.id} /></details> : null}
    </PanelShell>
  );
}

/** under the server's 5 min drafting window; a poll only while the meeting is live */
const DRAFTING_POLL_MS = 4_000;

/** Agents writing a reply or decisions right now (server-side heuristic: they heard something and haven't spoken yet). */
function useDrafting(meetingId: string, live: boolean): { id: string; name: string }[] {
  const [who, setWho] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!live) { setWho([]); return; }
    let stop = false;
    const poll = () => { api().meetingDrafting(meetingId).then((d) => { if (!stop) setWho(d); }, () => undefined); };
    poll();
    const timer = setInterval(poll, DRAFTING_POLL_MS);
    return () => { stop = true; clearInterval(timer); };
  }, [meetingId, live]);
  return who;
}

export function writingLine(names: string[]): string {
  if (names.length === 1) return `${names[0]} is writing…`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} are writing…`;
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

/** The panel a presented town page opens (`ref` from the server's resolveAttachment). */
function pageRef(ref: string): PanelRef | null {
  const [k, id] = ref.split(/[:/](.*)/s);
  if (k === "grant" || k === "agent" || k === "building") return id ? { kind: k, id } : null;
  if (k === "manual") return { kind: "manual", ...(id ? { id } : {}) };
  if (k === "bank" || k === "finance" || k === "dashboard" || k === "connect") return { kind: k };
  return null;
}

/** What a speaker presented with their line (docs/meetings.md §8): an image inline, a doc card with its opening, or a page card. */
function Presented({ a, newTab }: { a: MeetingAttachment; newTab: boolean }) {
  const tab = newTab ? { target: "_blank", rel: "noopener noreferrer" } : {};
  if (a.kind === "media" && a.url) {
    return (
      <figure className="presented media">
        {/\.(webm|mp4)$/.test(a.url) ? <video src={a.url} controls muted /> : <a href={a.url} {...tab}><img src={a.url} alt={a.title} /></a>}
      </figure>
    );
  }
  if (a.kind === "doc") {
    return (
      <a className="presented card" href={docUrl(a.ref)} {...tab} onClick={newTab ? undefined : (e) => { e.preventDefault(); store.open({ kind: "library", docId: a.ref }); }}>
        <span className="presented-kind">Presented doc</span><b>{a.title}</b>{a.excerpt ? <span className="presented-excerpt">{a.excerpt}</span> : null}
      </a>
    );
  }
  const to = pageRef(a.ref);
  const href = to?.kind === "grant" && to.id ? grantUrl(to.id) : to && (to.kind === "finance" || to.kind === "connect") ? `#/${to.kind}` : to?.kind === "manual" ? `#/manual${to.id ? `/${to.id}` : ""}` : null;
  if (href && newTab) return <a className="presented card" href={href} {...tab}><span className="presented-kind">Presented page</span><b>{a.title}</b></a>;
  return (
    <button className="presented card" disabled={!to} onClick={() => to && store.open(to)}>
      <span className="presented-kind">Presented page</span><b>{a.title}</b>
    </button>
  );
}
