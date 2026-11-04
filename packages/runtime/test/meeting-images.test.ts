import { describe, expect, test } from "vitest";
import { IMAGE_MAX_BYTES, IMAGES_PER_MESSAGE, mediaIdsOf, meetingImages } from "../src/meetingImages.ts";
import { callVerb, init, result, setup, type Script } from "./helpers.ts";
import { intrayOf } from "@muster-town/core";

const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5)); expect(ok()).toBe(true); };
const png = (n = 64, seed = 1) => Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(n, seed)]);
const webm = () => Buffer.concat([Buffer.from("1a45dfa3", "hex"), Buffer.alloc(64, 7)]);

async function managed(script: Script) {
  const env = setup(script);
  const admin = env.world.ops.ensureAvatar(env.seed.admin.id);
  for (const d of intrayOf(env.world, env.lab.id)) await env.world.verbs.review(admin.id, { docId: d.id, decision: "approve" });
  env.world.ops.updateBuilding(admin, env.lab.id, { managerAgentId: env.by("Mei").id });
  return { ...env, admin };
}

describe("pictures in a meeting line reach the agent (1:1 mt_z1b38bwg98)", () => {
  test("mediaIdsOf: markdown links and a presented screenshot, once each", () => {
    expect(mediaIdsOf({ text: "see ![a](/api/media/mf_aaaaaaaaaa.png) and ![b](/api/media/mf_bbbbbbbbbb.jpg) ![a](/api/media/mf_aaaaaaaaaa.png)", attachment: { kind: "media", ref: "mf_cccccccccc", title: "Screenshot" } }))
      .toEqual(["mf_aaaaaaaaaa", "mf_bbbbbbbbbb", "mf_cccccccccc"]);
    expect(mediaIdsOf({ text: "no pictures: mf_aaaaaaaaaa alone is not a link" })).toEqual([]);
  });

  test("meetingImages: images as base64 blocks; videos and oversized ones named, not sent; at most the last few", () => {
    const { world, seed } = setup(async function* () { yield init(); });
    const me = world.ops.ensureAvatar(seed.admin.id).id;
    const small = world.media.put(me, "image/png", png());
    const big = world.media.put(me, "image/png", png(IMAGE_MAX_BYTES + 10));
    const vid = world.media.put(me, "video/webm", webm());
    const { images, note } = meetingImages(world, [{ text: `![x](${small.url}) ![y](${big.url}) ![z](${vid.url})` }]);
    expect(images).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: png().toString("base64") } }]);
    expect(note).toContain("attached to this message");
    expect(note).toContain(`${big.id} (`);
    expect(note).toContain(`${vid.id} (a video)`);
    const many = Array.from({ length: IMAGES_PER_MESSAGE + 2 }, (_, i) => world.media.put(me, "image/png", png(64, i + 10)));
    const r = meetingImages(world, many.map((f) => ({ text: `![](${f.url})` })));
    expect(r.images).toHaveLength(IMAGES_PER_MESSAGE);
    expect(r.images[0].source.data).toBe(world.media.get(many[2].id)!.data.toString("base64")); // the last ones
    expect(r.note).toContain("2 earlier pictures not attached");
    expect(meetingImages(world, [{ text: "plain words" }])).toEqual({ images: [], note: "" });
  });

  test("a screenshot pasted into a 1:1 line arrives in the session as an image block", async () => {
    let seen = "";
    const env = await managed(async function* (s) {
      yield init();
      const mid = s.received[0].match(/(mt_[a-z0-9]+)/)![1];
      yield* callVerb(s, "meeting", { meetingId: mid, action: "speak", text: "Hi." });
      yield result(100, 0.01);
      seen = (await s.next()) ?? "";
      yield* callVerb(s, "meeting", { meetingId: mid, action: "speak", text: "I see it." });
      yield result(200, 0.02);
      await s.next();
      yield result(250, 0.03);
    });
    const { world, runtime, admin, lab } = env;
    const m = world.ops.openOneOnOne(admin, lab.id);
    await until(() => world.meetings.require(m.id).transcript.length === 1);
    const f = world.media.put(admin.id, "image/png", png());
    world.ops.meetingSay(admin, m.id, `What is wrong here?\n![shot](${f.url})`);
    await until(() => world.meetings.require(m.id).transcript.length === 3);
    const content = JSON.parse(seen) as { type: string; text?: string; source?: { data: string } }[];
    expect(content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png", data: png().toString("base64") } });
    expect(content[1].type).toBe("text");
    expect(content[1].text).toContain("What is wrong here?");
    expect(content[1].text).toContain("attached to this message");
    world.ops.endMeeting(admin, m.id);
    await runtime.whenIdle();
  });
});
