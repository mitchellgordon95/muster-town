/**
 * v1.2 roles split, as an idempotent data fix run at every open (after SQL migrations, before any role is read
 * through the schema, which no longer knows `building.ban`). Raw SQL on purpose.
 * - building `role:<bid>:moderator` → `role:<bid>:reviewer` with the reviewer permission set; memberships move with it
 * - built-in managers lose `building.ban`, gain `building.dismiss`; admin gets every permission
 * - any other role drops permissions the schema no longer has
 * - creates the town `moderator` role once the town has roles
 */
import { BUILTIN_ROLES, Permission } from "@agent-town/schema";
import type { DB } from "./db.ts";

export interface MigrateRolesResult { renamed: number; updated: number; created: number }

export function migrateRoles(db: DB): MigrateRolesResult {
  const res: MigrateRolesResult = { renamed: 0, updated: 0, created: 0 };
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
  })();
  return res;
}
