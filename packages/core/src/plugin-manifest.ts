import type { Doc, DocType } from "@muster-town/schema";
import { badRequest } from "./errors.ts";

/**
 * A plugin's manifest and the rules on what it owns (docs/plugins.md): the pure core of plugins.ts. Data in, data out:
 * no World, no DB, no clock. The map (world/map.ts) reads the manifest's name through here too.
 */

/**
 * What a plugin may ask for. `docs.read`: list and read its docs. `docs.write`: create and rewrite them.
 * `media.upload`: upload an image as the viewer (POST /api/media), for a picture in a doc.
 */
export const PLUGIN_SCOPES = ["docs.read", "docs.write", "media.upload"] as const;
export type PluginScope = (typeof PLUGIN_SCOPES)[number];
/** The doc types a plugin may own: plain written docs only (never reports, asks, wiki pages or skills). */
export const PLUGIN_DOC_TYPES = ["note", "article"] as const satisfies readonly DocType[];
export const PLUGIN_LIMITS = { nameChars: 40, descriptionChars: 300, tagChars: 40, bodyChars: 200_000, titleChars: 200 } as const;

export interface PluginManifest {
  name: string;
  description: string;
  scopes: PluginScope[];
  /** the type of the docs it owns */
  docType: (typeof PLUGIN_DOC_TYPES)[number];
  /** the tag on every doc it owns (kebab-case) */
  tag: string;
}
interface ParsedPlugin { manifest: PluginManifest; html: string }

export const TAG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, PLUGIN_LIMITS.tagChars).replace(/-+$/, "");

const HELP = "A plugin's body starts with a frontmatter block: ---, then name:, description: and optional scopes: (docs.read, docs.write, media.upload), docType: (note or article) and tag: lines, then ---, then the HTML page (skill make-a-town-plugin).";

/** Read a plugin doc's body: its manifest and its page. Throws bad_request naming what is wrong. Pure. */
export function parsePlugin(body: string): ParsedPlugin {
  const m = /^﻿?\s*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(body);
  if (!m) throw badRequest(HELP);
  const f: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) f[kv[1]] = kv[2].trim().replace(/^(["'])([\s\S]*)\1$/, "$2").trim();
  }
  const name = f.name ?? "", description = f.description ?? "";
  if (!name) throw badRequest(`The plugin needs a name: line. ${HELP}`);
  if (name.length > PLUGIN_LIMITS.nameChars) throw badRequest(`The plugin's name is ${name.length} chars; keep it to ${PLUGIN_LIMITS.nameChars}.`);
  if (!description) throw badRequest(`The plugin needs a description: line (one line: what it is for). ${HELP}`);
  if (description.length > PLUGIN_LIMITS.descriptionChars) throw badRequest(`The plugin's description is ${description.length} chars; keep it to ${PLUGIN_LIMITS.descriptionChars}.`);
  const scopes: PluginScope[] = [];
  for (const s of (f.scopes ?? "").replace(/^\[|\]$/g, "").split(/[\s,]+/).filter(Boolean)) {
    if (!(PLUGIN_SCOPES as readonly string[]).includes(s)) throw badRequest(`Unknown plugin scope "${s}". Scopes: ${PLUGIN_SCOPES.join(", ")}.`);
    if (!scopes.includes(s as PluginScope)) scopes.push(s as PluginScope);
  }
  if (scopes.includes("docs.write") && !scopes.includes("docs.read")) scopes.unshift("docs.read");
  const docType = (f.docType ?? f.doctype ?? "note") as PluginManifest["docType"];
  if (!(PLUGIN_DOC_TYPES as readonly string[]).includes(docType)) throw badRequest(`A plugin owns docs of type ${PLUGIN_DOC_TYPES.join(" or ")}, not "${docType}".`);
  const tag = f.tag || slug(name);
  if (!TAG_RE.test(tag) || tag.length > PLUGIN_LIMITS.tagChars) throw badRequest(`The plugin's tag "${tag}" must be kebab-case (a-z, 0-9, -) and at most ${PLUGIN_LIMITS.tagChars} chars.`);
  const html = body.slice(m.index + m[0].length).trim();
  if (!html) throw badRequest(`The plugin has no page after its frontmatter. ${HELP}`);
  return { manifest: { name, description, scopes, docType, tag }, html };
}

/** Whether `doc` is one of the plugin's own docs: its type, its tag, its building. Pure. */
export function ownsDoc(plugin: Pick<Doc, "buildingId">, manifest: PluginManifest, doc: Pick<Doc, "type" | "tags" | "buildingId">): boolean {
  return doc.type === manifest.docType && doc.tags.includes(manifest.tag) && !!plugin.buildingId && doc.buildingId === plugin.buildingId;
}

/**
 * Who may rewrite one of a plugin's docs: its author, or someone who may manage what is published in the building
 * (doc.write_building there: its manager, its forks, an admin). Pure: the permission is passed in.
 */
export function canEditOwned(doc: Pick<Doc, "authorId" | "state">, holderId: string, writesBuilding: boolean): boolean {
  return doc.authorId === holderId || (writesBuilding && doc.state !== "draft");
}
