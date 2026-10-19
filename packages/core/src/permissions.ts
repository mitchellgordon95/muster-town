import { BUILTIN_ROLES, type Agent, type Permission, type Role } from "@agent-town/schema";
import { forbidden } from "./errors.ts";
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

  rolesOf(holder: Holder | Agent): Role[] {
    const h = holderOf(holder);
    const roles: Role[] = [];
    for (const m of this.repos.memberships.forHolder(h.kind, h.id)) {
      const r = this.repos.roles.get(m.roleId);
      if (r) roles.push(r);
    }
    return roles;
  }

  /** Any held role grants `permission` at town scope, or at building scope for `buildingId`. */
  can(holder: Holder | Agent, permission: Permission, buildingId?: string | null): boolean {
    return this.rolesOf(holder).some((r) =>
      r.permissions.includes(permission) && (r.scope === "town" || (!!buildingId && r.buildingId === buildingId)));
  }

  require(holder: Holder | Agent, permission: Permission, buildingId?: string | null): void {
    if (!this.can(holder, permission, buildingId)) throw forbidden(permission);
  }

  isAdmin(holder: Holder | Agent): boolean {
    return this.rolesOf(holder).some((r) => r.id === townRoleId("admin"));
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
