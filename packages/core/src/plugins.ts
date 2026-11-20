import type { Agent, Doc } from "@muster-town/schema";
import { createDoc, updateDoc } from "./domain.ts";
import { AppError, badRequest, forbidden } from "./errors.ts";
import { lastWriterOf } from "./memory.ts";
import { nowIso } from "./util.ts";
import { canEditOwned, ownsDoc, parsePlugin, PLUGIN_LIMITS, TAG_RE, type PluginManifest, type PluginScope } from "./plugin-manifest.ts";
import type { World } from "./world.ts";

/**
 * Plugins: town objects residents make (Mitchell's flag dc_4boq48hqr6; docs/plugins.md). A plugin is DATA, never code
 * in the repo, so a hosted collective (no repo, no shell) can make one with the town tools: a doc of type "plugin"
 * whose body is a frontmatter manifest, then a full HTML page. Published in a building (state "building") it is
 * installed there: the map hangs its screen on that building's back wall (layout.ts `pluginScreens`), and using it opens
 * the page in a sandboxed iframe (no network, no same origin). The page reaches the town only through the bridge: it
 * posts a message to the parent window, the parent calls the routes below as the VIEWING human, and these functions
 * enforce the manifest's scopes on the server, so a widget can never do what its viewer could not do with the tools.
 *
 * What a plugin owns: the docs of its `docType` carrying its `tag`, in its own building. It lists and reads those (the
 * viewer's own drafts and everything published) and writes them (create, rewrite, draft ↔ published).
 *
 * Pure core: plugin-manifest.ts (`parsePlugin`, `ownsDoc`, `canEditOwned`). This file is the stateful shell.
 */

// ---------- stateful shell ----------

export interface PluginView {
  id: string; name: string; description: string; scopes: PluginScope[]; docType: string; tag: string;
  buildingId: string | null; state: Doc["state"]; authorId: string; author: string; updatedAt: string;
}
export const pluginView = (world: World, d: Doc, manifest: PluginManifest): PluginView => ({
  id: d.id, ...manifest, buildingId: d.buildingId, state: d.state, authorId: d.authorId, author: world.nameOf(d.authorId), updatedAt: d.updatedAt,
});

/** The installed plugins (published in a building), oldest first; one building's when given. Bodies that no longer parse are skipped. */
export function installedPlugins(world: World, buildingId?: string): { doc: Doc; manifest: PluginManifest }[] {
  const docs = world.docs.where(`type = 'plugin' AND state = 'building' AND buildingId IS NOT NULL${buildingId ? " AND buildingId = ?" : ""}`, buildingId ? [buildingId] : [], "ORDER BY createdAt, rowid");
  return docs.flatMap((doc) => { try { return [{ doc, manifest: parsePlugin(doc.body).manifest }]; } catch { return []; } });
}

/** The plugin `id` as `viewerId` may see it (its author sees a draft too), with its page. */
export function requirePlugin(world: World, id: string, viewerId: string | null): { doc: Doc; manifest: PluginManifest; html: string } {
  const doc = world.docs.get(id);
  if (!doc || doc.type !== "plugin" || (doc.state === "draft" && doc.authorId !== viewerId)) throw new AppError("not_found", `No plugin ${id}.`);
  return { doc, ...parsePlugin(doc.body) };
}

function needScope(manifest: PluginManifest, scope: PluginScope) {
  if (!manifest.scopes.includes(scope)) throw forbidden("doc.write_building", `The plugin "${manifest.name}" did not ask for the ${scope} scope in its manifest.`);
}

/** The plugin's docs `viewerId` may see (its own drafts, everything published), newest first. Needs docs.read. */
export function listPluginDocs(world: World, pluginId: string, viewerId: string | null, q: { state?: "draft" | "building"; limit?: number } = {}): Doc[] {
  const { doc: p, manifest } = requirePlugin(world, pluginId, viewerId);
  needScope(manifest, "docs.read");
  if (!p.buildingId) return [];
  const rows = world.docs.where("type = ? AND buildingId = ? AND (state != 'draft' OR authorId = ?)", [manifest.docType, p.buildingId, viewerId ?? ""], "ORDER BY updatedAt DESC, rowid DESC");
  const limit = Math.max(1, Math.min(200, q.limit ?? 100));
  return rows.filter((d) => ownsDoc(p, manifest, d) && (!q.state || (q.state === "building" ? d.state !== "draft" : d.state === "draft"))).slice(0, limit);
}

/** One of the plugin's docs, if `viewerId` may see it. Needs docs.read. */
export function readPluginDoc(world: World, pluginId: string, viewerId: string | null, docId: string): Doc {
  const { doc: p, manifest } = requirePlugin(world, pluginId, viewerId);
  needScope(manifest, "docs.read");
  const d = world.docs.get(docId);
  if (!d || !ownsDoc(p, manifest, d) || (d.state === "draft" && d.authorId !== viewerId)) throw new AppError("not_found", `The plugin has no doc ${docId}.`);
  return d;
}

export interface PluginWrite { id?: string; title: string; body: string; state: "draft" | "building"; tags?: string[] }

/**
 * Create or rewrite one of the plugin's docs as `me` (the viewing human, or an agent): type, tag and building are the
 * plugin's, whatever the page sent. Publishing needs what publishing there needs with the tools (doc.write_building in
 * the building, or an agent whose home it is); a rewrite needs `canEditOwned`. A rewrite keeps the old body as a
 * revision. Needs docs.write.
 */
export function writePluginDoc(world: World, me: Agent, pluginId: string, input: PluginWrite): Doc {
  const holder = world.holderOf(me);
  const { doc: p, manifest } = requirePlugin(world, pluginId, holder.id);
  needScope(manifest, "docs.write");
  if (!p.buildingId || p.state === "draft") throw badRequest(`The plugin "${manifest.name}" is not installed in a building, so it has nowhere to write.`);
  const title = input.title.trim(), body = input.body;
  if (!title) throw badRequest("A doc needs a title.");
  if (title.length > PLUGIN_LIMITS.titleChars || body.length > PLUGIN_LIMITS.bodyChars) throw badRequest(`A doc's title is at most ${PLUGIN_LIMITS.titleChars} chars and its body ${PLUGIN_LIMITS.bodyChars}.`);
  const writes = world.permissions.can(me, "doc.write_building", p.buildingId);
  const resident = me.kind !== "human" && me.homeBuildingId === p.buildingId;
  if (input.state === "building" && !writes && !resident) {
    throw forbidden("doc.write_building", `You can't publish in ${world.buildings.get(p.buildingId)?.name ?? p.buildingId}: keep it a draft, or ask its manager.`);
  }
  const extra = (input.tags ?? []).map((t) => t.trim()).filter((t) => TAG_RE.test(t) && t.length <= PLUGIN_LIMITS.tagChars && t !== manifest.tag).slice(0, 10);
  const tags = [manifest.tag, ...new Set(extra)];
  if (input.id) {
    const cur = world.docs.get(input.id);
    if (!cur || !ownsDoc(p, manifest, cur) || (cur.state === "draft" && cur.authorId !== holder.id)) throw new AppError("not_found", `The plugin has no doc ${input.id}.`);
    if (!canEditOwned(cur, holder.id, writes)) throw forbidden("doc.write_building", "Only its author, or the building's manager or an admin, rewrites this doc.");
    if (cur.state === "library") throw badRequest("That doc is in the library now; it can't be rewritten from a plugin.");
    const doc = world.transaction(() => {
      world.db.prepare("INSERT INTO doc_revisions (docId, title, body, authorId, replacedBy, createdAt) VALUES (?, ?, ?, ?, ?, ?)")
        .run(cur.id, cur.title, cur.body, lastWriterOf(world, cur), holder.id, nowIso());
      return updateDoc(world, cur.id, { title, body, state: input.state, tags });
    });
    world.events.append({ type: "doc.updated", agentId: me.kind === "human" ? null : me.id, buildingId: doc.buildingId, text: `${me.name} updated "${doc.title}" with the plugin "${manifest.name}"`, payload: { docId: doc.id, pluginId: p.id } });
    return doc;
  }
  return createDoc(world, { type: manifest.docType, title, body, state: input.state, authorId: holder.id, authorKind: holder.kind, buildingId: p.buildingId, tags },
    `${me.name} wrote "${title}" with the plugin "${manifest.name}"`);
}
