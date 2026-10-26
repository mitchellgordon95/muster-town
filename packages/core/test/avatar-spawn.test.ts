import { describe, expect, it } from "vitest";
import { seededWorld } from "./helpers.ts";

describe("ensureAvatar", () => {
  it("two newcomers arrive on different free tiles near the plaza, not stacked", () => {
    const { world } = seededWorld();
    const plaza = world.layout.place("plaza")!.pos;
    const a = world.ops.ensureAvatar(world.ops.createUser("one").user.id);
    const b = world.ops.ensureAvatar(world.ops.createUser("two").user.id);
    expect(`${a.pos.x},${a.pos.y}`).not.toBe(`${b.pos.x},${b.pos.y}`);
    for (const p of [a.pos, b.pos]) {
      expect(world.layout.isWalkable(p.x, p.y)).toBe(true);
      expect(Math.max(Math.abs(p.x - plaza.x), Math.abs(p.y - plaza.y))).toBeLessThanOrEqual(3);
    }
    expect(world.ops.ensureAvatar(a.ownerUserId!).pos).toEqual(a.pos); // idempotent
  });
});
