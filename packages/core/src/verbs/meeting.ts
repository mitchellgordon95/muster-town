import type { Agent, Meeting } from "@muster-town/schema";
import { AppError, badRequest } from "../errors.ts";
import { agentsDrafting, attachmentLine, clearAgentDrafting, endMeeting, humanStillTalking, humanTyping, meetingDecide, meetingSpeak, noteAgentDrafting, setMeetingPhase } from "../meetings.ts";
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
      // the facilitator checking status once every summary is in is about to steer or write decisions
      if (m.phase === "discussing" && world.holderOf(me).id === m.facilitatorId && me.kind !== "human") noteAgentDrafting(world, m.id, me.id);
      return {
        id: m.id, title: m.title, kind: m.kind, phase: m.phase, agenda: m.agenda, facilitator: m.facilitatorId ? name(m.facilitatorId) : null,
        attendees: m.attendeeIds.map((id) => ({ id, name: name(id), summary: m.summaries[id] ?? null })),
        transcript: m.transcript.slice(-30).map((u) => ({ speaker: name(u.speakerId), speakerKind: u.speakerKind, text: u.text, at: u.at, ...(u.attachment ? { presented: attachmentLine(u.attachment) } : {}) })),
        decisions: m.decisions.map((d, i) => ({ n: i + 1, ...d })),
        humanTyping: humanTyping(world, m.id),
        drafting: agentsDrafting(world, m.id).map(name),
      };
    case "summary": {
      if (!input.text?.trim()) throw badRequest("summary needs text (up to three short lines).");
      if (m.phase === "done" || m.phase === "cancelled") throw new AppError("conflict", `Meeting is ${m.phase}.`);
      const updated = world.meetings.upsert({ ...m, summaries: { ...m.summaries, [me.id]: input.text } });
      world.events.append({ type: "meeting.utterance", agentId: me.id, buildingId: m.buildingId, text: `${me.name} submitted a summary for ${m.title}`, payload: { meetingId: m.id, summary: true } });
      // the last summary in starts the discussion; nobody waits out the collecting window
      if (updated.phase === "collecting" && updated.attendeeIds.every((id) => updated.summaries[id])) setMeetingPhase(world, m.id, "discussing");
      return { ok: true };
    }
    case "speak":
    {
      const said = meetingSpeak(world, me, m.id, input.text ?? "", input.attach);
      const a = said.transcript[said.transcript.length - 1]?.attachment;
      return a ? { ok: true, presented: attachmentLine(a) } : { ok: true };
    }
    case "listen": {
      let map = cursors.get(world);
      if (!map) { map = new Map(); cursors.set(world, map); }
      const key = `${m.id}:${me.id}`;
      const from = map.get(key) ?? 0;
      const self = world.holderOf(me).id;
      const live = m.phase === "collecting" || m.phase === "discussing";
      clearAgentDrafting(world, me.id, m.id); // listening is not writing
      if (input.waitSeconds && live && !m.transcript.slice(from).some((u) => u.speakerId !== self)) {
        await waitForUtterance(world, m.id, self, from, input.waitSeconds * 1000);
      }
      const now = world.meetings.require(m.id, "meeting");
      map.set(key, now.transcript.length);
      const heard = now.transcript.slice(from).filter((u) => u.speakerId !== self);
      // something to answer (or, for the facilitator, decisions to write): show "is writing…" until it speaks
      if (now.phase === "discussing" && me.kind !== "human" && (heard.length || self === now.facilitatorId)) noteAgentDrafting(world, m.id, me.id);
      return {
        phase: now.phase,
        humanTyping: humanTyping(world, m.id),
        utterances: heard.map((u) => ({ speaker: name(u.speakerId), speakerKind: u.speakerKind, text: u.text, at: u.at, ...(u.attachment ? { presented: attachmentLine(u.attachment) } : {}) })),
      };
    }
    case "decide":
      if (!input.decisions?.length) throw badRequest("decide needs decisions.");
      {
        const decided = meetingDecide(world, me, m.id, input.decisions);
        clearAgentDrafting(world, me.id, m.id);
        return { decisions: decided.decisions.map((d, i) => ({ n: i + 1, ...d })) };
      }
    case "end": {
      if (me.kind !== "human" && m.kind === "one-on-one") throw new AppError("conflict", "The human ends a 1:1. Answer them; your turn ends when you stop, and their next message wakes you.");
      if (me.kind !== "human" && humanStillTalking(world, m)) {
        throw new AppError("conflict", humanTyping(world, m.id)
          ? "A human is typing a message in this meeting. Keep listening (waitSeconds 60) and answer them; they'll end it with End meeting, or you can end it once they've been quiet for a few minutes."
          : "A human is talking in this meeting. Keep listening (waitSeconds 60) and answer them; they'll end it with End meeting, or you can end it once they've been quiet for a few minutes.");
      }
      const ended = endMeeting(world, me, m.id, input.text);
      clearAgentDrafting(world, me.id, m.id);
      return { phase: ended.phase, notesDocId: world.meetings.require(m.id).notesDocId };
    }
  }
}
