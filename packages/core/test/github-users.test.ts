import { describe, expect, it } from "vitest";
import { townRoleId, upsertGithubUser } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

describe("upsertGithubUser", () => {
  it("creates a visitor on first sign-in and matches by githubId afterwards", () => {
    const { world } = seededWorld();
    const before = world.users.all().length;
    const a = upsertGithubUser(world, { id: 42, login: "octo", name: "Octo Cat", avatarUrl: "https://a/x.png" });
    expect(a).toMatchObject({ created: true, linked: false });
    expect(a.user).toMatchObject({ name: "Octo Cat", githubLogin: "octo", githubId: 42, avatarUrl: "https://a/x.png" });
    expect(world.permissions.rolesOf({ kind: "user", id: a.user.id }).map((r) => r.id)).toEqual([townRoleId("visitor")]);

    // renamed on GitHub: same user, login refreshed, display name kept
    const b = upsertGithubUser(world, { id: 42, login: "octo-renamed", name: "Someone Else" });
    expect(b).toMatchObject({ created: false, linked: false });
    expect(b.user).toMatchObject({ id: a.user.id, name: "Octo Cat", githubLogin: "octo-renamed", avatarUrl: "https://a/x.png" });
    expect(world.users.all().length).toBe(before + 1);
  });

  it("an allowlisted login links the seeded admin instead of creating a second user", () => {
    const { world, seed } = seededWorld();
    const r = upsertGithubUser(world, { id: 7, login: "Mitchell-G", name: null }, { admins: ["mitchell-g"] });
    expect(r).toMatchObject({ created: false, linked: true });
    expect(r.user.id).toBe(seed.admin.id);
    expect(world.permissions.isAdmin({ kind: "user", id: seed.admin.id })).toBe(true);
    // a second allowlisted account can't take the already-linked admin: it gets its own admin user
    const s = upsertGithubUser(world, { id: 8, login: "cohost" }, { admins: ["mitchell-g", "cohost"] });
    expect(s.created).toBe(true);
    expect(s.user.name).toBe("cohost");
    expect(world.permissions.isAdmin({ kind: "user", id: s.user.id })).toBe(true);
  });

  it("a login not on the allowlist is never admin", () => {
    const { world } = seededWorld();
    const r = upsertGithubUser(world, { id: 9, login: "rando" }, { admins: ["mitchell-g"] });
    expect(world.permissions.isAdmin({ kind: "user", id: r.user.id })).toBe(false);
  });
});
