/**
 * v1.2 roles split, as an idempotent data fix run at every open (after SQL migrations, before any role is read
 * through the schema, which no longer knows `building.ban`). Raw SQL on purpose.
 * - one agent model (gr_a5ct690l7a, Mitchell's 1:1 mt_26vin80bpm): the town `moderator` role and every building
 *   `reviewer` (and the older building `moderator`) role are deleted with their memberships, and the service agent
 *   (Ada, kind `service`) is retired as a resident, its row kept so its documents keep their author
 * - built-in managers lose `building.ban`, gain `building.dismiss` and `building.fund`; admin gets every permission
 * - any other role drops permissions the schema no longer has
 * - v1.3: creates the town `deployer` role (`town.redeploy`) once the town has roles. Data fix: in the pass that
 *   creates it, residents of workspace buildings (the Town Workshop) who hold no deployer membership are granted it,
 *   matching what seed does for `townRoles: ["deployer"]` in collective.json. Later opens never re-grant, so a revoke sticks.
 * - who may interact (dc_f0cumcfubk): built-in town deployer gains `town.interact`; creates the town
 *   `member` role once the town has roles, and in that pass grants it to every user holding any role other than
 *   `visitor`, so nobody who can act today is locked out except plain visitors. Later opens never re-grant.
 */
import { BUILTIN_ROLES, Permission } from "@muster-town/schema";
import type { DB } from "./db.ts";

export interface MigrateRolesResult { dropped: number; updated: number; created: number; granted: number }

export function migrateRoles(db: DB): MigrateRolesResult {
  const res: MigrateRolesResult = { dropped: 0, updated: 0, created: 0, granted: 0 };
  const valid = new Set<string>(Permission.options);
  type RoleRow = { id: string; name: string; scope: string; buildingId: string | null; permissions: string; builtin: number };
  db.transaction(() => {
    res.dropped += db.prepare("UPDATE agents SET kind = 'resident', status = 'retired' WHERE kind = 'service'").run().changes;
    const roles = db.prepare("SELECT id, name, scope, buildingId, permissions, builtin FROM roles").all() as RoleRow[];
    if (!roles.length) return;
    for (const r of roles) {
      if (r.builtin && ((r.scope === "town" && r.name === "moderator") || (r.scope === "building" && (r.name === "reviewer" || r.name === "moderator")))) {
        db.prepare("DELETE FROM memberships WHERE roleId = ?").run(r.id);
        db.prepare("DELETE FROM roles WHERE id = ?").run(r.id);
        res.dropped++;
        continue;
      }
      let perms = (JSON.parse(r.permissions) as string[]);
      const before = JSON.stringify(perms);
      if (r.builtin && r.scope === "town" && r.name === "admin") perms = [...Permission.options];
      else if (r.builtin && r.scope === "town" && r.name === "deployer" && !perms.includes("town.interact")) perms.push("town.interact");
      else if (r.builtin && r.scope === "building" && r.name === "manager") {
        perms = perms.filter((p) => p !== "building.ban");
        if (!perms.includes("building.dismiss")) perms.push("building.dismiss");
        if (!perms.includes("building.fund")) perms.push("building.fund");
      }
      perms = perms.filter((p) => valid.has(p));
      if (JSON.stringify(perms) !== before) {
        db.prepare("UPDATE roles SET permissions = ? WHERE id = ?").run(JSON.stringify(perms), r.id);
        res.updated++;
      }
    }
    if (!db.prepare("SELECT 1 FROM roles WHERE id = 'role:deployer'").get()) {
      db.prepare("INSERT INTO roles (id, name, scope, buildingId, permissions, builtin) VALUES ('role:deployer', 'deployer', 'town', NULL, ?, 1)").run(JSON.stringify(BUILTIN_ROLES.town.deployer));
      res.created++;
      // v1.3 data fix: workshop residents get the deployer role (seed grants it from collective.json for new towns)
      const residents = db.prepare(`
        SELECT a.id FROM agents a JOIN buildings b ON b.id = a.homeBuildingId
        WHERE a.kind = 'resident' AND a.status NOT IN ('retired', 'banned')
          AND b.codeAccess = 1
          AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.roleId = 'role:deployer' AND m.holderKind = 'agent' AND m.holderId = a.id)`).all() as { id: string }[];
      for (const r of residents) {
        db.prepare("INSERT OR IGNORE INTO memberships (roleId, holderKind, holderId) VALUES ('role:deployer', 'agent', ?)").run(r.id);
        res.granted++;
      }
    }
    if (!db.prepare("SELECT 1 FROM roles WHERE id = 'role:member'").get()) {
      db.prepare("INSERT INTO roles (id, name, scope, buildingId, permissions, builtin) VALUES ('role:member', 'member', 'town', NULL, ?, 1)").run(JSON.stringify(BUILTIN_ROLES.town.member));
      res.created++;
      const users = db.prepare("SELECT DISTINCT holderId FROM memberships WHERE holderKind = 'user' AND roleId NOT IN ('role:visitor', 'role:member')").all() as { holderId: string }[];
      for (const u of users) {
        db.prepare("INSERT OR IGNORE INTO memberships (roleId, holderKind, holderId) VALUES ('role:member', 'user', ?)").run(u.holderId);
        res.granted++;
      }
    }
  })();
  return res;
}
