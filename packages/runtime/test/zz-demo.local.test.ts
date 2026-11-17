import { writeFileSync } from "node:fs";
import { test } from "vitest";
import { intrayOf } from "@muster-town/core";
import { buildApp } from "@muster-town/server";
import { callVerb, init, result, setup, toolUse } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
test("demo", async () => {
  const env = setup(async function* (s) {
    yield init();
    const mid = s.received[0].match(/(mt_[a-z0-9]+)/)![1];
    yield* callVerb(s, "meeting", { meetingId: mid, action: "speak", text: "Hi Mitchell. Mei here. What do you need?" });
    yield result(100, 0.01);
    await s.next();
    await sleep(3000);
    yield* callVerb(s, "meeting", { meetingId: mid, action: "speak", text: "On it. Reading the goals code now." });
    const calls: [string, unknown][] = [["Read", { file_path: "packages/core/src/goals.ts" }], ["Grep", { pattern: "keyResult", path: "packages/core/src" }], ["Read", { file_path: "docs/goals.md" }], ["Glob", { pattern: "packages/web/src/panels/*Goal*.tsx" }], ["Read", { file_path: "packages/web/src/panels/GoalTreePanel.tsx" }], ["Grep", { pattern: "objective", path: "packages/core/src" }]];
    for (const [n, i] of calls) { yield toolUse(n, i); await sleep(4000); }
    yield* callVerb(s, "meeting", { meetingId: mid, action: "speak", text: "Here is the map: three layers of key results, objectives mirrored into the tree." });
    yield result(200, 0.02);
    await s.next();
    yield result(250, 0.03);
  });
  const { world, seed, lab, by } = env;
  const admin = world.ops.ensureAvatar(seed.admin.id);
  for (const d of intrayOf(world, lab.id)) await world.verbs.review(admin.id, { docId: d.id, decision: "approve" });
  world.ops.updateBuilding(admin, lab.id, { managerAgentId: by("Mei").id });
  const app = await buildApp({ world, dev: true });
  await app.listen({ port: 4555, host: "127.0.0.1" });
  const m = world.ops.openOneOnOne(admin, lab.id);
  writeFileSync("/tmp/demo_mid", m.id);
  await sleep(8000);
  world.ops.meetingSay(admin, m.id, "we need to talk about goals, objectives and key results. can you take a pass at the code?");
  await sleep(50000);
  world.ops.endMeeting(admin, m.id);
  await sleep(1000);
  await app.close();
}, 120_000);
