import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Secrets, dataKeyFrom, decryptSecret, encryptSecret } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const KEY = randomBytes(32).toString("base64");

function setup(key: string | null = KEY) {
  const s = seededWorld();
  const secrets = new Secrets(s.world, () => key ?? undefined);
  const [writer, other] = s.world.agents.where("homeBuildingId = ? AND kind = 'resident'", [LAB]);
  return { ...s, secrets, writer, other };
}

describe("secret crypto", () => {
  it("round-trips, binds the value to its name, and reads hex or base64 keys", () => {
    const key = dataKeyFrom(KEY)!;
    const blob = encryptSecret(key, "A_TOKEN", "s3cret");
    expect(blob).not.toContain("s3cret");
    expect(decryptSecret(key, "A_TOKEN", blob)).toBe("s3cret");
    expect(() => decryptSecret(key, "B_TOKEN", blob)).toThrow();
    expect(() => decryptSecret(randomBytes(32), "A_TOKEN", blob)).toThrow();
    expect(dataKeyFrom(key.toString("hex"))!.equals(key)).toBe(true);
    expect(dataKeyFrom(undefined)).toBeNull();
    expect(() => dataKeyFrom("short")).toThrow(/32 bytes/);
  });
});

describe("Secrets", () => {
  it("stores values encrypted, lists names/grants/set but never values, and deletes", () => {
    const { world, secrets } = setup();
    const v = secrets.put("OVH_KEY", { value: "ovh-value", grants: { buildings: [LAB], agents: [], skills: [] } }, "us_x");
    expect(v).toMatchObject({ name: "OVH_KEY", set: true, grants: { buildings: [LAB] } });
    expect(JSON.stringify(secrets.list())).not.toContain("ovh-value");
    const raw = world.db.prepare("SELECT ciphertext FROM secrets WHERE name = 'OVH_KEY'").get() as { ciphertext: string };
    expect(raw.ciphertext).toMatch(/^v1:/);
    expect(raw.ciphertext).not.toContain("ovh-value");
    // grants-only creates a missing secret; grants are validated
    expect(secrets.put("LATER", { grants: { buildings: [], agents: [], skills: [] } }, null).set).toBe(false);
    expect(() => secrets.put("X", { grants: { buildings: ["nope"], agents: [], skills: [] } }, null)).toThrow(/No building/);
    expect(() => secrets.put("lower", { value: "v" }, null)).toThrow(/env var name/);
    expect(() => secrets.put("GH_OTHER", { value: "v" }, null)).toThrow(/reserved/);
    expect(() => secrets.put("PATH", { value: "v" }, null)).toThrow(/reserved/);
    // the collective's repo token is the one GH_* name allowed; the runtime reads it back with value()
    expect(secrets.value("GH_TOKEN")).toBeNull();
    expect(secrets.put("GH_TOKEN", { value: "github_pat_x" }, null).set).toBe(true);
    expect(secrets.value("GH_TOKEN")).toBe("github_pat_x");
    expect(secrets.delete("GH_TOKEN", null)).toEqual({ removed: true });
    expect(secrets.delete("LATER", null)).toEqual({ removed: true });
    expect(secrets.list().map((s) => s.name)).toEqual(["OVH_KEY"]);
    const events = world.events.list({ types: ["secret.set", "secret.deleted"] });
    expect(JSON.stringify(events)).not.toContain("ovh-value");
  });

  it("refuses to store a value without a data key, never falling back to plaintext", () => {
    const { world, secrets } = setup(null);
    expect(secrets.keyConfigured()).toBe(false);
    expect(() => secrets.put("A_TOKEN", { value: "v" }, null)).toThrow(/MUSTER_TOWN_DATA_KEY/);
    expect(world.db.prepare("SELECT COUNT(*) AS n FROM secrets").get()).toEqual({ n: 0 });
  });

  it("forAgent: only secrets granted to the agent's building, the agent, or a skill pinned for it", async () => {
    const { world, secrets, writer, other } = setup();
    const { id: skillId } = await world.verbs.write(writer, { type: "skill", title: "", body: "---\nname: talk-to-x\ndescription: Use to talk to X.\n---\nRun it.\n", files: [{ path: "x.py", content: "print(1)" }] });
    world.skills.pin(writer, skillId, { scope: "agent", targetId: writer.id, mode: "listed" });
    const none = { buildings: [], agents: [], skills: [] };
    secrets.put("LAB_KEY", { value: "lab", grants: { ...none, buildings: [LAB] } }, null);
    secrets.put("OTHER_KEY", { value: "o", grants: { ...none, agents: [other.id] } }, null);
    secrets.put("SKILL_KEY", { value: "sk", grants: { ...none, skills: [skillId] } }, null);
    secrets.put("NOBODY_KEY", { value: "n" }, null);
    secrets.put("UNSET_KEY", { grants: { ...none, buildings: [LAB] } }, null);
    expect(secrets.forAgent(writer.id).map((s) => [s.name, s.value, s.via])).toEqual([["LAB_KEY", "lab", "building"], ["SKILL_KEY", "sk", "skill"]]);
    expect(secrets.forAgent(other.id).map((s) => s.name)).toEqual(["LAB_KEY", "OTHER_KEY"]);
    // a town grant reaches every resident, whatever the other lists say
    secrets.put("EVERYONE_KEY", { value: "all", grants: { ...none, town: true } }, null);
    expect(secrets.forAgent(writer.id).find((s) => s.name === "EVERYONE_KEY")).toMatchObject({ value: "all", via: "town" });
    expect(secrets.forAgent(other.id).find((s) => s.name === "EVERYONE_KEY")).toMatchObject({ via: "town" });
    expect(secrets.get("EVERYONE_KEY")!.grants).toEqual({ ...none, town: true });
    expect(secrets.get("LAB_KEY")!.grants.town).toBe(false);
    // the host lost its key: nothing is passed (garbled or otherwise)
    expect(new Secrets(world, () => undefined).forAgent(writer.id)).toEqual([]);
  });
});
