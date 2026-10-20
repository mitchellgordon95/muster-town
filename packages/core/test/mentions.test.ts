import { describe, expect, it } from "vitest";
import { extractMentions } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

describe("mentions", () => {
  it("extracts @Name case-insensitively on word boundaries, deduped, ignoring the author and retired agents", () => {
    const { world, by, admin } = seededWorld();
    const noor = by("Noor"), mei = by("Mei"), tomas = by("Tomas");
    const names = (t: string, ex: string[] = []) => extractMentions(t, world, ex).map((a) => a.name);
    expect(names("cc @noor and @MEI, also @Noor again")).toEqual(["Noor", "Mei"]);
    expect(names("@Noorish, mail noor@x.org, @Noor_x")).toEqual([]);
    expect(names("@Noor take a look", [noor.id])).toEqual([]);
    world.ops.dismissAgent(admin, tomas.id);
    expect(names("@Tomas @Mei")).toEqual(["Mei"]);
    expect(mei).toBeTruthy();
  });

  it("a report mention lands in the inbox with docId and shows in look; self-mention ignored", async () => {
    const { world, by } = seededWorld();
    const noor = by("Noor"), mei = by("Mei");
    const r = await world.verbs.submit_report(noor, {
      title: "Growth rate check", verdict: "continue",
      body: "## Summary\n@Mei your SOCAT numbers disagree with mine; @Noor (me) will retry.\n## Proposal for next session\nReconcile.",
    });
    expect((await world.verbs.inbox(noor, { markRead: false })).messages.filter((m) => m.kind === "mention")).toHaveLength(0);
    const look = await world.verbs.look(mei, {});
    expect(look.notices.mentions).toBe(1);
    const inbox = await world.verbs.inbox(mei, {});
    const mention = inbox.messages[0];
    expect(mention).toMatchObject({ kind: "mention", from: "Noor", docId: r.id, meetingId: null });
    expect(mention.body).toMatch(/^Noor mentioned you in report "Growth rate check": .*@Mei your SOCAT/);
    expect(mention.body.length).toBeLessThanOrEqual(260);
    expect((await world.verbs.look(mei, {})).notices.mentions).toBe(0);
    const ev = world.events.recent({ agentId: mei.id, limit: 20 }).find((e) => e.type === "agent.mentioned");
    expect(ev?.payload).toMatchObject({ byId: noor.id, docId: r.id, toId: mei.id });
  });

  it("a meeting utterance mention carries the meetingId; a human's mention reaches the agent", async () => {
    const { world, by, admin } = seededWorld();
    const m = world.ops.createMeeting(admin, { kind: "standup", buildingId: "carbon-cycle", startNow: true });
    world.ops.startMeeting(admin, m.id);
    world.ops.meetingSay(admin, m.id, "@Mei can you summarise the ocean sink?");
    await world.verbs.meeting(by("Noor"), { meetingId: m.id, action: "speak", text: "Agreed with @mitchell." });
    const mine = (await world.verbs.inbox(by("Mei"), {})).messages.filter((x) => x.kind === "mention");
    expect(mine).toMatchObject([{ meetingId: m.id, docId: null, fromId: admin.ownerUserId }]);
    expect(mine[0].body).toContain(`in meeting "${m.title}"`);
    // the human's avatar gets a mention too (the web toasts it from agent.mentioned)
    const avatarMentions = (await world.verbs.inbox(admin, {})).messages.filter((x) => x.kind === "mention");
    expect(avatarMentions).toHaveLength(1);
    const ev = world.events.recent({ agentId: admin.id, limit: 50 }).find((e) => e.type === "agent.mentioned");
    expect(ev?.payload).toMatchObject({ toId: admin.id, meetingId: m.id });
  });

  it("tell notifies third parties but not the recipient twice; drafts don't notify until published", async () => {
    const { world, by } = seededWorld();
    const noor = by("Noor"), mei = by("Mei"), tomas = by("Tomas");
    await world.verbs.tell(noor, { to: mei.id, text: "@Mei @Tomas see the board" });
    expect((await world.verbs.inbox(mei, {})).messages.map((m) => m.kind)).toEqual(["tell"]);
    expect((await world.verbs.inbox(tomas, {})).messages.map((m) => m.kind)).toEqual(["mention"]);
    const d = await world.verbs.write(noor, { type: "note", title: "Draft", body: "@Tomas later", state: "draft" });
    expect((await world.verbs.inbox(tomas, {})).messages).toHaveLength(0);
    await world.verbs.write(noor, { id: d.id, type: "note", title: "Draft", body: "@Tomas later", state: "building" });
    expect((await world.verbs.inbox(tomas, {})).messages).toMatchObject([{ kind: "mention", docId: d.id }]);
    await world.verbs.write(noor, { id: d.id, type: "note", title: "Draft", body: "@Tomas later, edited", state: "building" });
    expect((await world.verbs.inbox(tomas, {})).messages).toHaveLength(0);
  });
});
