import { BUILTIN_ROLES, Permission, type Agent, type Role } from "@muster-town/schema";
import { forbidden } from "./errors.ts";
import { BUDGET_POLICY } from "./policy.ts";
import type { Repos } from "./store.ts";

/** Who holds roles. A human's avatar agent acts with its owner user's roles. */
export interface Holder { kind: "agent" | "user"; id: string }
export type BuildingRoleName = keyof typeof BUILTIN_ROLES.building;
export type TownRoleName = keyof typeof BUILTIN_ROLES.town;

export function isAgent(x: Holder | Agent): x is Agent {
  return (x as Agent).pos !== undefined;
}

/** Holder for an agent: human avatars act as their owner user; everyone else as themselves. */
export function holderOf(x: Holder | Agent): Holder {
  if (!isAgent(x)) return x;
  if (x.kind === "human" && x.ownerUserId) return { kind: "user", id: x.ownerUserId };
  return { kind: "agent", id: x.id };
}

/** Deterministic ids for built-in roles. */
export const townRoleId = (name: TownRoleName) => `role:${name}`;
export const buildingRoleId = (buildingId: string, name: BuildingRoleName) => `role:${buildingId}:${name}`;

export class Permissions {
  constructor(private repos: Repos) {}

  /** Roles held directly (a human avatar's are its user's). Inherited permissions are not roles: see `effective`. */
  rolesOf(holder: Holder | Agent): Role[] {
    return this.heldRoles(holderOf(this.resolve(holder)));
  }

  /**
   * Effective permission check. Users: their roles. Agents (v1.5):
   *   own       = the agent's roles grant it (town scope, or building scope for `buildingId`)
   *   ownerCan  = the owner user can (an owner id with no user row counts as ownerless)
   *   inherited = agent.inheritsOwner && ownerCan   (human avatars always inherit)
   *   result    = owner ? (own || inherited) && ownerCan : own   — an agent never exceeds its owner
   * then `deniedPermissions` removes it. `building.fund` is never effective for agents (only human avatars, as their
   * user): otherwise a manager agent whose owner is admin could fund its own proposal.
   */
  can(holder: Holder | Agent, permission: Permission, buildingId?: string | null): boolean {
    const x = this.resolve(holder);
    // open question 3 (BUDGET_POLICY.funders): "admins" = only town-level roles fund, not a building's manager role
    if (permission === "building.fund" && BUDGET_POLICY.funders === "admins") buildingId = null;
    if (!isAgent(x)) return this.rolesGrant(x, permission, buildingId);
    if (x.deniedPermissions?.includes(permission)) return false;
    if (permission === "building.fund" && x.kind !== "human") return false;
    const owner = this.ownerOf(x);
    const own = this.rolesGrant({ kind: "agent", id: x.id }, permission, buildingId);
    if (!owner) return own;
    const ownerCan = this.rolesGrant(owner, permission, buildingId);
    return (own || this.inherits(x)) && ownerCan;
  }

  require(holder: Holder | Agent, permission: Permission, buildingId?: string | null): void {
    if (!this.can(holder, permission, buildingId)) throw forbidden(permission);
  }

  /** Every permission `can` grants (town-level ones, plus building-scoped ones for `buildingId`). */
  effective(holder: Holder | Agent, buildingId?: string | null): Permission[] {
    return Permission.options.filter((p) => this.can(holder, p, buildingId));
  }

  /** Admin role, with the same owner cap: an agent is admin only if its owner is (and nothing is denied). */
  isAdmin(holder: Holder | Agent): boolean {
    const x = this.resolve(holder);
    if (!isAgent(x)) return this.holdsAdmin(x);
    const owner = this.ownerOf(x);
    const own = this.holdsAdmin({ kind: "agent", id: x.id });
    if (!owner) return own;
    return (own || this.inherits(x)) && this.holdsAdmin(owner) && !(x.deniedPermissions?.length);
  }

  /** The agent's owner as a user holder, or null when ownerless (service agents, seeded residents). */
  ownerOf(agent: Agent): Holder | null {
    return agent.ownerUserId && this.repos.users.get(agent.ownerUserId) ? { kind: "user", id: agent.ownerUserId } : null;
  }

  private inherits(agent: Agent): boolean {
    return agent.kind === "human" || !!agent.inheritsOwner;
  }

  /** An `{kind: "agent"}` holder becomes its Agent row, so agent rules apply however it is referenced. */
  private resolve(holder: Holder | Agent): Holder | Agent {
    if (isAgent(holder) || holder.kind !== "agent") return holder;
    return this.repos.agents.get(holder.id) ?? holder;
  }

  private rolesGrant(h: Holder, permission: Permission, buildingId?: string | null): boolean {
    return this.heldRoles(h).some((r) =>
      r.permissions.includes(permission) && (r.scope === "town" || (!!buildingId && r.buildingId === buildingId)));
  }

  private holdsAdmin(h: Holder): boolean {
    return this.heldRoles(h).some((r) => r.id === townRoleId("admin"));
  }

  private heldRoles(h: Holder): Role[] {
    const roles: Role[] = [];
    for (const m of this.repos.memberships.forHolder(h.kind, h.id)) {
      const r = this.repos.roles.get(m.roleId);
      if (r) roles.push(r);
    }
    return roles;
  }

  ensureTownRoles(): void {
    for (const name of Object.keys(BUILTIN_ROLES.town) as TownRoleName[]) {
      if (this.repos.roles.get(townRoleId(name))) continue;
      this.repos.roles.upsert({ id: townRoleId(name), name, scope: "town", permissions: [...BUILTIN_ROLES.town[name]], builtin: true });
    }
  }

  ensureBuildingRoles(buildingId: string): void {
    for (const name of Object.keys(BUILTIN_ROLES.building) as BuildingRoleName[]) {
      const id = buildingRoleId(buildingId, name);
      if (this.repos.roles.get(id)) continue;
      this.repos.roles.upsert({ id, name, scope: "building", buildingId, permissions: [...BUILTIN_ROLES.building[name]], builtin: true });
    }
  }

  grant(holder: Holder | Agent, roleId: string): void {
    const h = holderOf(holder);
    this.repos.roles.require(roleId, "role");
    this.repos.memberships.add({ roleId, holderKind: h.kind, holderId: h.id });
  }

  revoke(holder: Holder | Agent, roleId: string): void {
    const h = holderOf(holder);
    this.repos.memberships.remove({ roleId, holderKind: h.kind, holderId: h.id });
  }

  /** Agents (not users) holding a role, e.g. the building's moderator agent(s). */
  agentsWithRole(roleId: string): string[] {
    return this.repos.memberships.forRole(roleId).filter((m) => m.holderKind === "agent").map((m) => m.holderId);
  }

  rolesForBuilding(buildingId?: string): Role[] {
    return buildingId
      ? this.repos.roles.where("scope = 'town' OR buildingId = ?", [buildingId], "ORDER BY rowid")
      : this.repos.roles.all();
  }
}
