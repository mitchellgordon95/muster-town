/**
 * v1.2 roles split, as an idempotent data fix run at every open (after SQL migrations, before any role is read
 * through the schema, which no longer knows `building.ban`). Raw SQL on purpose.
 * - building `role:<bid>:moderator` → `role:<bid>:reviewer` with the reviewer permission set; memberships move with it
 * - built-in managers lose `building.ban`, gain `building.dismiss`; admin gets every permission
 * - any other role drops permissions the schema no longer has
 * - creates the town `moderator` role once the town has roles
 * - v1.3: creates the town `deployer` role (`town.redeploy`) once the town has roles. Data fix: in the pass that
 *   creates it, residents of workspace buildings (the Town Workshop) who hold no deployer membership are granted it,
 *   matching what seed does for `townRoles: ["deployer"]` in collective.json. Later opens never re-grant, so a revoke sticks.
 */
import { BUILTIN_ROLES, Permission } from "@muster-town/schema";
import type { DB } from "./db.ts";

export interface MigrateRolesResult { renamed: number; updated: number; created: number; granted: number }

export function migrateRoles(db: DB): MigrateRolesResult {
  const res: MigrateRolesResult = { renamed: 0, updated: 0, created: 0, granted: 0 };
  const valid = new Set<string>(Permission.options);
  type RoleRow = { id: string; name: string; scope: string; buildingId: string | null; permissions: string; builtin: number };
  db.transaction(() => {
    const roles = db.prepare("SELECT id, name, scope, buildingId, permissions, builtin FROM roles").all() as RoleRow[];
    if (!roles.length) return;
    for (const r of roles) {
      if (r.scope === "building" && r.name === "moderator" && r.buildingId && r.id === `role:${r.buildingId}:moderator`) {
        const to = `role:${r.buildingId}:reviewer`;
        const perms = JSON.stringify(BUILTIN_ROLES.building.reviewer);
        if (!db.prepare("SELECT 1 FROM roles WHERE id = ?").get(to)) {
          db.prepare("INSERT INTO roles (id, name, scope, buildingId, permissions, builtin) VALUES (?, 'reviewer', 'building', ?, ?, 1)").run(to, r.buildingId, perms);
        }
        db.prepare("INSERT OR IGNORE INTO memberships (roleId, holderKind, holderId) SELECT ?, holderKind, holderId FROM memberships WHERE roleId = ?").run(to, r.id);
        db.prepare("DELETE FROM memberships WHERE roleId = ?").run(r.id);
        db.prepare("DELETE FROM roles WHERE id = ?").run(r.id);
        res.renamed++;
        continue;
      }
      let perms = (JSON.parse(r.permissions) as string[]);
      const before = JSON.stringify(perms);
      if (r.builtin && r.scope === "town" && r.name === "admin") perms = [...Permission.options];
      else if (r.builtin && r.scope === "building" && r.name === "manager") {
        perms = perms.filter((p) => p !== "building.ban");
        if (!perms.includes("building.dismiss")) perms.push("building.dismiss");
      }
      perms = perms.filter((p) => valid.has(p));
      if (JSON.stringify(perms) !== before) {
        db.prepare("UPDATE roles SET permissions = ? WHERE id = ?").run(JSON.stringify(perms), r.id);
        res.updated++;
      }
    }
    if (!db.prepare("SELECT 1 FROM roles WHERE id = 'role:moderator'").get()) {
      db.prepare("INSERT INTO roles (id, name, scope, buildingId, permissions, builtin) VALUES ('role:moderator', 'moderator', 'town', NULL, ?, 1)").run(JSON.stringify(BUILTIN_ROLES.town.moderator));
      res.created++;
    }
    if (!db.prepare("SELECT 1 FROM roles WHERE id = 'role:deployer'").get()) {
      db.prepare("INSERT INTO roles (id, name, scope, buildingId, permissions, builtin) VALUES ('role:deployer', 'deployer', 'town', NULL, ?, 1)").run(JSON.stringify(BUILTIN_ROLES.town.deployer));
      res.created++;
      // v1.3 data fix: workshop residents get the deployer role (seed grants it from collective.json for new towns)
      const residents = db.prepare(`
        SELECT a.id FROM agents a JOIN buildings b ON b.id = a.homeBuildingId
        WHERE a.kind = 'resident' AND a.status NOT IN ('retired', 'banned')
          AND b.codeAccess = 1
          AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.roleId = 'role:deployer' AND m.holderKind = 'agent' AND m.holderId = a.id)
          AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.roleId = 'role:' || b.id || ':reviewer' AND m.holderKind = 'agent' AND m.holderId = a.id)`).all() as { id: string }[];
      for (const r of residents) {
        db.prepare("INSERT OR IGNORE INTO memberships (roleId, holderKind, holderId) VALUES ('role:deployer', 'agent', ?)").run(r.id);
        res.granted++;
      }
    }
  })();
  return res;
}
