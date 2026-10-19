import type { Agent } from "@agent-town/schema";
import { AppError, badRequest } from "../errors.ts";
import { endMeeting, meetingDecide, meetingSpeak } from "../meetings.ts";
import type { World } from "../world.ts";
import type { VerbIn } from "./types.ts";

/** listen cursors: `${meetingId}:${agentId}` -> transcript index (in-memory; resets on restart) */
const cursors = new WeakMap<World, Map<string, number>>();

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
      map.set(key, m.transcript.length);
      const self = world.holderOf(me).id;
      return {
        phase: m.phase,
        utterances: m.transcript.slice(from).filter((u) => u.speakerId !== self).map((u) => ({ speaker: name(u.speakerId), speakerKind: u.speakerKind, text: u.text, at: u.at })),
      };
    }
    case "decide":
      if (!input.decisions?.length) throw badRequest("decide needs decisions.");
      return { decisions: meetingDecide(world, me, m.id, input.decisions).decisions };
    case "end": {
      const ended = endMeeting(world, me, m.id, input.text);
      return { phase: ended.phase, notesDocId: world.meetings.require(m.id).notesDocId };
    }
  }
}
