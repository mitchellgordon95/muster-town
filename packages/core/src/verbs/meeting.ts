import type { Agent, Meeting } from "@agent-town/schema";
import { AppError, badRequest } from "../errors.ts";
import { endMeeting, humanStillTalking, meetingDecide, meetingSpeak } from "../meetings.ts";
import type { World } from "../world.ts";
import type { VerbIn } from "./types.ts";

/** listen cursors: `${meetingId}:${agentId}` -> transcript index (in-memory; resets on restart) */
const cursors = new WeakMap<World, Map<string, number>>();

/** Resolve when someone other than `self` speaks after transcript index `from`, the meeting closes, or `ms` passes. */
function waitForUtterance(world: World, meetingId: string, self: string, from: number, ms: number): Promise<void> {
  const settled = (m: Meeting) => (m.phase !== "collecting" && m.phase !== "discussing") || m.transcript.slice(from).some((u) => u.speakerId !== self);
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); unsubscribe(); resolve(); };
    const timer = setTimeout(done, ms);
    const unsubscribe = world.changes.subscribe((c) => { if (c.type === "meeting" && c.meeting.id === meetingId && settled(c.meeting)) done(); });
  });
}

export async function meeting(world: World, me: Agent, input: VerbIn<"meeting">) {
  const m = world.meetings.get(input.meetingId);
  if (!m) throw new AppError("not_found", `No meeting ${input.meetingId}.`);
  const name = (id: string) => world.nameOf(id);
  switch (input.action) {
    case "status":
      return {
        id: m.id, title: m.title, kind: m.kind, phase: m.phase, agenda: m.agenda, facilitator: m.facilitatorId ? name(m.facilitatorId) : null,
        attendees: m.attendeeIds.map((id) => ({ id, name: name(id), summary: m.summaries[id] ?? null })),
        transcript: m.transcript.slice(-30).map((u) => ({ speaker: name(u.speakerId), speakerKind: u.speakerKind, text: u.text, at: u.at })),
        decisions: m.decisions,
      };
    case "summary": {
      if (!input.text?.trim()) throw badRequest("summary needs text (three lines).");
      if (m.phase === "done" || m.phase === "cancelled") throw new AppError("conflict", `Meeting is ${m.phase}.`);
      world.meetings.upsert({ ...m, summaries: { ...m.summaries, [me.id]: input.text } });
      world.events.append({ type: "meeting.utterance", agentId: me.id, buildingId: m.buildingId, text: `${me.name} submitted a summary for ${m.title}`, payload: { meetingId: m.id, summary: true } });
      return { ok: true };
    }
    case "speak":
      meetingSpeak(world, me, m.id, input.text ?? "");
      return { ok: true };
    case "listen": {
      let map = cursors.get(world);
      if (!map) { map = new Map(); cursors.set(world, map); }
      const key = `${m.id}:${me.id}`;
      const from = map.get(key) ?? 0;
      const self = world.holderOf(me).id;
      const live = m.phase === "collecting" || m.phase === "discussing";
      if (input.waitSeconds && live && !m.transcript.slice(from).some((u) => u.speakerId !== self)) {
        await waitForUtterance(world, m.id, self, from, input.waitSeconds * 1000);
      }
      const now = world.meetings.require(m.id, "meeting");
      map.set(key, now.transcript.length);
      return {
        phase: now.phase,
        utterances: now.transcript.slice(from).filter((u) => u.speakerId !== self).map((u) => ({ speaker: name(u.speakerId), speakerKind: u.speakerKind, text: u.text, at: u.at })),
      };
    }
    case "decide":
      if (!input.decisions?.length) throw badRequest("decide needs decisions.");
      return { decisions: meetingDecide(world, me, m.id, input.decisions).decisions };
    case "end": {
      if (me.kind !== "human" && humanStillTalking(m)) {
        throw new AppError("conflict", "A human is talking in this meeting. Keep listening (waitSeconds 60) and answer them; they'll end it with End meeting, or you can end it once they've been quiet for a few minutes.");
      }
      const ended = endMeeting(world, me, m.id, input.text);
      return { phase: ended.phase, notesDocId: world.meetings.require(m.id).notesDocId };
    }
  }
}
