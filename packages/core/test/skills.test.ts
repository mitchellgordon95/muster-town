import { describe, expect, it } from "vitest";
import { buildingRoleId, composeWorkBrief, newId, nowIso, parseSkillMd, skillsBlock } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const md = (name: string, description = `Use when you need ${name}.`, body = `Do the ${name} steps.`) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

function setup() {
  const s = seededWorld();
  const { world } = s;
  const residents = world.agents.where("homeBuildingId = ? AND kind = 'resident'", [LAB]);
  const [writer, other, manager] = residents;
  world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
  const session = (agentId: string) => world.sessions.upsert({
    id: newId("se"), agentId, assignmentId: null, meetingId: null, purpose: "work", backend: "docker", status: "running", model: "m",
    sdkSessionId: null, tokens: 0, costUsd: 0, startedAt: nowIso(), endedAt: null,
  } as never);
  return { ...s, writer, other, manager, session };
}

describe("parseSkillMd", () => {
  it("reads name, description (quoted, folded) and the instructions", () => {
    expect(parseSkillMd(md("verify-deploy"))).toEqual({ name: "verify-deploy", description: "Use when you need verify-deploy.", instructions: "Do the verify-deploy steps." });
    const folded = parseSkillMd(`---\nname: "x-y"\ndescription: >\n  Use after a push,\n  before the report.\nlicense: MIT\n---\nbody`);
    expect(folded).toMatchObject({ name: "x-y", description: "Use after a push, before the report." });
  });
  it("rejects a missing frontmatter, name or description, and non-kebab names", () => {
    expect(() => parseSkillMd("just text")).toThrow(/frontmatter/);
    expect(() => parseSkillMd("---\ndescription: d\n---\nx")).toThrow(/name/);
    expect(() => parseSkillMd("---\nname: ok\n---\nx")).toThrow(/description/);
    expect(() => parseSkillMd(md("Not Kebab"))).toThrow(/kebab/);
  });
});

describe("skills", () => {
  it("write type skill: title = name, bundled files, unique names, files only for skills", async () => {
    const { world, writer, other } = setup();
    const res = await world.verbs.write(writer, { type: "skill", title: "ignored", body: md("verify-deploy"), files: [{ path: "scripts/check.sh", content: "echo ok" }] });
    expect(world.docs.require(res.id).title).toBe("verify-deploy");
    expect(world.skills.files(res.id).map((f) => f.path)).toEqual(["scripts/check.sh"]);
    // a draft's name is only taken for its author
    await expect(world.verbs.write(writer, { type: "skill", title: "", body: md("verify-deploy") })).rejects.toThrow(/already a skill/);
    await expect(world.verbs.write(other, { type: "skill", title: "", body: md("verify-deploy") })).resolves.toBeTruthy();
    await expect(world.verbs.write(writer, { type: "note", title: "n", body: "b", files: [{ path: "a.txt", content: "" }] })).rejects.toThrow(/only for skills/);
    await expect(world.verbs.write(writer, { type: "skill", title: "", body: md("bad-path"), files: [{ path: "../x", content: "" }] })).rejects.toThrow(/relative path/);
    await expect(world.verbs.write(writer, { id: res.id, type: "note", title: "n", body: "b" })).rejects.toThrow(/That's a skill/);
    // update: omitted files are kept; given files replace the set
    await world.verbs.write(writer, { id: res.id, type: "skill", title: "", body: md("verify-deploy", "Use after pushing.") });
    expect(world.skills.files(res.id)).toHaveLength(1);
    await world.verbs.write(writer, { id: res.id, type: "skill", title: "", body: md("verify-deploy"), files: [{ path: "README.md", content: "r" }, { path: "run.py", content: "print(1)" }] });
    expect(world.skills.files(res.id).map((f) => f.path)).toEqual(["README.md", "run.py"]);
  });

  it("read lists files, reads one, and logs skill.used", async () => {
    const { world, writer, other } = setup();
    const { id } = await world.verbs.write(writer, { type: "skill", title: "", body: md("source-card"), state: "building", files: [{ path: "template.md", content: "# Source" }] });
    const r = await world.verbs.read(other, { id }) as { files?: { path: string }[] };
    expect(r.files?.map((f) => f.path)).toEqual(["template.md"]);
    const f = await world.verbs.read(other, { id, file: "template.md" });
    expect(f.body).toBe("# Source");
    await expect(world.verbs.read(other, { id, file: "nope" })).rejects.toThrow(/no file/);
    expect(world.skills.uses(id, 7)).toBe(2);
    expect(world.events.list({ types: ["skill.used"] }).map((e) => e.agentId)).toEqual([other.id, other.id]);
  });

  it("pins: self listed only; managers pin building-wide; humans for always/files/town; edits load right away", async () => {
    const { world, writer, other, manager, admin } = setup();
    const { id } = await world.verbs.write(writer, { type: "skill", title: "", body: md("plain"), state: "building" });
    // an agent pins into its own sessions, listed only
    await world.verbs.pin(writer, { skillId: id });
    await expect(world.verbs.pin(writer, { skillId: id, mode: "always" })).rejects.toThrow(/listed/);
    await expect(world.verbs.pin(writer, { skillId: id, scope: "agent", targetId: other.id })).rejects.toThrow(/manager/);
    await expect(world.verbs.pin(writer, { skillId: id, scope: "building" })).rejects.toThrow(/building.manage/);
    expect(world.skills.forAgent(writer.id).map((s) => s.md.name)).toEqual(["plain"]);
    expect(world.skills.forAgent(other.id)).toEqual([]);
    // the manager agent pins building-wide (listed); always needs a human
    await world.verbs.pin(manager, { skillId: id, scope: "building" });
    await expect(world.verbs.pin(manager, { skillId: id, scope: "building", mode: "always" })).rejects.toThrow(/human/);
    expect(world.skills.forAgent(other.id).map((s) => [s.md.name, s.mode, s.scope])).toEqual([["plain", "listed", "building"]]);
    // town pins: admin, human, library skills only
    await expect(world.verbs.pin(admin, { skillId: id, scope: "town" })).rejects.toThrow(/library/);
    await world.verbs.promote(manager, { docId: id, state: "library" });
    await world.verbs.pin(admin, { skillId: id, scope: "town", mode: "always" });
    expect(world.skills.forAgent(other.id)[0].mode).toBe("always");
    // edits load right away
    await world.verbs.write(writer, { id, type: "skill", title: "", body: md("plain", "Use always.", "New steps.") });
    expect(world.skills.forAgent(other.id)[0].md.instructions).toBe("New steps.");
    // adding files suspends the agent-made building pin (the human town pin still loads)
    await world.verbs.write(writer, { id, type: "skill", title: "", body: md("plain"), files: [{ path: "x.sh", content: "rm -rf ~" }] });
    const view = world.skills.view(world.docs.require(id));
    expect(view.pins.find((p) => p.scope === "building")?.suspended).toMatch(/human/);
    expect(view.pins.find((p) => p.scope === "town")?.suspended).toBeNull();
    // unpin: the pinner, or someone who could pin there
    await expect(world.verbs.pin(other, { skillId: id, scope: "town", remove: true })).rejects.toThrow(/admin/);
    expect(await world.verbs.pin(admin, { skillId: id, scope: "town", remove: true })).toEqual({ removed: true });
    expect(world.skills.forAgent(other.id)).toEqual([]);
    // with files, a manager agent can't pin into others' sessions
    await expect(world.verbs.pin(manager, { skillId: id, scope: "agent", targetId: other.id })).rejects.toThrow(/human/);
  });

  it("skills verb: pinned first, then building + library + own drafts", async () => {
    const { world, writer, other } = setup();
    const a = await world.verbs.write(writer, { type: "skill", title: "", body: md("alpha"), state: "building" });
    await world.verbs.write(writer, { type: "skill", title: "", body: md("beta") });
    await world.verbs.pin(other, { skillId: a.id });
    const mine = await world.verbs.skills(writer, {});
    expect(mine.available.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
    const theirs = await world.verbs.skills(other, {});
    expect(theirs.pinned.map((s) => s.name)).toEqual(["alpha"]);
    expect(theirs.available).toEqual([]);
    expect((await world.verbs.skills(writer, { query: "beta" })).available.map((s) => s.name)).toEqual(["beta"]);
  });

  it("the prompt block: listed lines, always text within the cap, the rest listed; reaches the desk brief", async () => {
    const { world, writer, session } = setup();
    const a = await world.verbs.write(writer, { type: "skill", title: "", body: md("small"), files: [{ path: "s.sh", content: "x" }] });
    await world.verbs.pin(writer, { skillId: a.id });
    const skills = world.skills.forAgent(writer.id);
    const listed = skillsBlock(skills);
    expect(listed).toContain("## Skills");
    expect(listed).toContain(`- small (${a.id}, agent pin): Use when you need small. [1 file: s.sh]`);
    const always = skillsBlock(skills.map((s) => ({ ...s, mode: "always" as const })));
    expect(always).toContain("### Skill: small");
    expect(always).toContain("Do the small steps.");
    const capped = skillsBlock(skills.map((s) => ({ ...s, mode: "always" as const })), 10);
    expect(capped).not.toContain("### Skill");
    expect(capped).toContain("didn't fit");
    expect(skillsBlock([])).toBe("");
    const brief = composeWorkBrief(world, session(writer.id).id);
    expect(brief.system).toContain(`- small (${a.id}`);
  });
});
