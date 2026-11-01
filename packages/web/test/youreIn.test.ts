import { describe, expect, test } from "vitest";
import type { AuthMe, SnapshotBuilding } from "@muster-town/schema";
import { firstManagerBuilding, youreInDue, youreInKey, youreInLine } from "../src/youreIn";

const AT = "2026-11-01T01:00:00.000Z";
const me = (status: "pending" | "granted" | "declined" | null, extra: Record<string, unknown> = {}, canInteract = status === "granted"): AuthMe =>
  ({ user: { id: "us_me" }, roles: [], avatarAgentId: "ag_me", isAdmin: false, canInteract,
    accessRequest: status ? { status, message: "", decidedAt: status === "pending" ? null : AT, deciders: ["Mitchell"], typicalWaitMs: null, decidedByName: null, ...extra } : null }) as unknown as AuthMe;
const storage = (keys: string[] = []) => ({ getItem: (k: string) => (keys.includes(k) ? "x" : null) });

describe("the one-time You're in card (gr_58n37j410s step 2)", () => {
  test("granted and not dismissed in this browser: shown, keyed on the decision", () => {
    expect(youreInDue(me("granted"), storage())).toBe(youreInKey(AT));
    expect(youreInKey(AT)).toBe(`musterTown.youreIn.${AT}`);
  });
  test("dismissed (key present): hidden; a later re-grant has a new key and shows again", () => {
    expect(youreInDue(me("granted"), storage([youreInKey(AT)]))).toBeNull();
    expect(youreInDue(me("granted", { decidedAt: "2026-11-05T00:00:00.000Z" }), storage([youreInKey(AT)]))).not.toBeNull();
  });
  test("pending, declined, no request, signed out, or no longer a member: hidden", () => {
    expect(youreInDue(me("pending"), storage())).toBeNull();
    expect(youreInDue(me("declined"), storage())).toBeNull();
    expect(youreInDue(me(null, {}, true), storage())).toBeNull();
    expect(youreInDue(null, storage())).toBeNull();
    expect(youreInDue(me("granted", {}, false), storage())).toBeNull();
  });
  test("names who let them in; one named admin stands in; else an admin", () => {
    expect(youreInLine(me("granted", { decidedByName: "Ada" }), "Workshop Collective")).toBe("Ada let you join Workshop Collective.");
    expect(youreInLine(me("granted"), "Workshop Collective")).toBe("Mitchell let you join Workshop Collective.");
    expect(youreInLine(me("granted", { deciders: ["A", "B"] }), "Workshop Collective")).toBe("An admin let you join.");
  });
  test("Talk to ★ goes to the first non-Town-Hall building with a manager", () => {
    const b = (id: string, kind: string, managerAgentId: string | null) => ({ id, kind, managerAgentId }) as unknown as SnapshotBuilding;
    expect(firstManagerBuilding([b("town-hall", "town-hall", "ag_p"), b("bl_x", "building", null), b("workshop", "building", "ag_pix")])?.id).toBe("workshop");
    expect(firstManagerBuilding([b("town-hall", "town-hall", "ag_p")])).toBeNull();
  });
});
