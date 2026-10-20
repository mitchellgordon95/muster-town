import type { User } from "@muster-town/schema";
import { createUser } from "./entities.ts";
import { townRoleId } from "./permissions.ts";
import type { World } from "./world.ts";

/** The parts of GitHub's `GET /user` we keep. */
export interface GithubProfile { id: number; login: string; name?: string | null; avatarUrl?: string | null }

export interface GithubUpsertResult {
  user: User;
  /** a new user was created */
  created: boolean;
  /** an existing user without a GitHub id (the seeded admin) was linked to this GitHub account */
  linked: boolean;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Find or create the user for a GitHub account. Matches by `githubId`. A login in `admins` that matches no user is
 * linked to the first town admin without a GitHub id (the seeded admin keeps its buildings and avatar); otherwise
 * a new user is created. Every GitHub user holds the town `visitor` role, plus `admin` when the login is allowlisted.
 * Profile fields (login, avatar) are refreshed on every sign-in; the display name is set only on creation.
 */
export function upsertGithubUser(world: World, gh: GithubProfile, opts: { admins?: string[] } = {}): GithubUpsertResult {
  const isAdmin = (opts.admins ?? []).some((a) => norm(a) === norm(gh.login));
  const profile = { githubId: gh.id, githubLogin: gh.login, ...(gh.avatarUrl ? { avatarUrl: gh.avatarUrl } : {}) };
  return world.transaction(() => {
    world.permissions.ensureTownRoles();
    let created = false, linked = false;
    let user = world.users.first("githubId = ?", [gh.id]);
    if (!user && isAdmin) {
      const adminIds = world.memberships.forRole(townRoleId("admin")).filter((m) => m.holderKind === "user").map((m) => m.holderId);
      const unlinked = adminIds.map((id) => world.users.get(id)).find((u): u is User => !!u && u.githubId == null);
      if (unlinked) { user = unlinked; linked = true; }
    }
    if (!user) {
      user = createUser(world, gh.name?.trim() || gh.login).user;
      created = true;
    }
    user = world.users.upsert({ ...user, ...profile });
    const holder = { kind: "user" as const, id: user.id };
    world.permissions.grant(holder, townRoleId("visitor"));
    if (isAdmin) world.permissions.grant(holder, townRoleId("admin"));
    if (created || linked) {
      world.events.append({ type: "system", text: created ? `${user.name} signed in with GitHub (@${gh.login})` : `${user.name} linked GitHub account @${gh.login}`, payload: { userId: user.id, githubLogin: gh.login } });
    }
    return { user, created, linked };
  });
}
