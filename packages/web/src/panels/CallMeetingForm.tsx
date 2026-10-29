/**
 * One "Call a meeting" form (Lena's dc_tcoy1plt2r, gr_jh0lu0w6yj step 2), in Building → Meetings and the meeting room:
 * a preset pre-fills title, agenda, attendees, what attendees bring and the "ask the humans" opener; all stay editable.
 * Mode: Chat, or Presentation with chat (gr_jh0lu0w6yj step 5): a deck (the review deck, or a deck doc by id) shown
 * above the chat, starting on slide 1; "Review the in-tray" pre-fills it with the review deck.
 * The 1:1 is not here: it stays its own "Talk to ★" button.
 */
import { useState } from "react";
import { MEETING_PRESETS, REVIEW_DECK_ID, type MeetingBrings, type MeetingPreset, type SnapshotBuilding } from "@muster-town/schema";
import { api } from "../api";
import { store } from "../state";
import { Act } from "./ui";
import { AttendeePicker, useAttendees } from "./AttendeePicker";
import { attendeeInput } from "./attendees";

const presetById = (id: string): MeetingPreset => MEETING_PRESETS.find((p) => p.id === id) ?? MEETING_PRESETS[0];

export function CallMeetingForm({ building }: { building: SnapshotBuilding }) {
  const hall = building.kind === "town-hall";
  const invite = useAttendees(building);
  const where = hall ? "Town Hall" : building.name;
  const [preset, setPreset] = useState<MeetingPreset>(() => presetById(hall ? "town-hall" : "standup"));
  const [title, setTitle] = useState("");
  const [agenda, setAgenda] = useState<string[]>(() => [...preset.agenda]);
  const [brings, setBrings] = useState<MeetingBrings>(() => ({ ...preset.brings }));
  const [askHumans, setAskHumans] = useState<boolean>(preset.askHumans);
  // Presentation with chat: the deck's id (REVIEW_DECK_ID or a deck doc dc_…); null = chat
  const [deck, setDeck] = useState<string | null>(preset.deck);
  const pick = (id: string) => {
    const p = presetById(id);
    setPreset(p); setTitle(""); setAgenda([...p.agenda]); setBrings({ ...p.brings }); setAskHumans(p.askHumans); setDeck(p.deck); invite.reset(p.attendees);
  };
  const deckDoc = deck !== null && deck !== REVIEW_DECK_ID;
  const setItem = (i: number, v: string) => setAgenda((a) => a.map((x, j) => (j === i ? v : x)));
  return (
    <div className="call-meeting">
      <label>Preset
        <select value={preset.id} onChange={(e) => pick(e.target.value)}>
          {MEETING_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      <label>Title <input value={title} placeholder={`${where} ${preset.label.toLowerCase()}`} onChange={(e) => setTitle(e.target.value)} /></label>
      <div className="call-meeting-agenda">
        <span>Agenda <small className="muted">{agenda.some((a) => a.trim()) ? "the facilitator covers these in order first" : "none: the facilitator proposes 2-4 items"}</small></span>
        {agenda.map((a, i) => (
          <div key={i} className="inline-form">
            <span className="muted">{i + 1}.</span>
            <input value={a} placeholder="Agenda item" onChange={(e) => setItem(i, e.target.value)} />
            <button type="button" className="x" title="Remove item" onClick={() => setAgenda((xs) => xs.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        <button type="button" className="btn sm" onClick={() => setAgenda((xs) => [...xs, ""])}>+ Add item</button>
      </div>
      <AttendeePicker state={invite} />
      <label>What each attendee brings
        <select value={brings.mode} onChange={(e) => setBrings((b) => ({ ...b, mode: e.target.value as MeetingBrings["mode"] }))}>
          <option value="status">Status update (did, next, need)</option>
          <option value="nothing">Nothing (straight to the discussion)</option>
          <option value="custom">Custom…</option>
        </select>
      </label>
      {brings.mode === "custom" ? <input value={brings.text} maxLength={500} placeholder="Bring: the one thing that went worst this week and why" onChange={(e) => setBrings((b) => ({ ...b, text: e.target.value }))} /> : null}
      <label>Mode
        <select value={deck === null ? "chat" : deckDoc ? "doc" : "review"} onChange={(e) => setDeck(e.target.value === "chat" ? null : e.target.value === "review" ? REVIEW_DECK_ID : "")}>
          <option value="chat">Chat</option>
          <option value="review">Presentation with chat: the review deck (Town Hall in-tray)</option>
          <option value="doc">Presentation with chat: a deck doc…</option>
        </select>
      </label>
      {deckDoc ? <input value={deck} placeholder="The deck doc's id (dc_…): open a deck and copy it from its URL" onChange={(e) => setDeck(e.target.value.trim())} /> : null}
      <label className="check"><input type="checkbox" checked={askHumans} onChange={(e) => setAskHumans(e.target.checked)} /> Ask the humans for decisions (the facilitator opens with "Decisions needed from the humans")</label>
      <div className="actions">
        <Act tone="primary" disabled={(brings.mode === "custom" && !brings.text.trim()) || (deckDoc && !deck)} run={async () => {
          const m = await api().createMeeting({
            kind: preset.kind, buildingId: hall ? null : building.id, startNow: true, ...attendeeInput(invite.picked),
            ...(title.trim() ? { title: title.trim() } : {}), agenda: agenda.filter((a) => a.trim()), brings, askHumans, ...(deck ? { deck: { docId: deck } } : {}),
          });
          store.putMeeting(m); store.open({ kind: "meeting", id: m.id });
        }}>Call meeting</Act>
      </div>
    </div>
  );
}
