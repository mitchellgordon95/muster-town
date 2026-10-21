/**
 * Skills (docs/skills.md): a skill is a doc of type "skill" whose body is a SKILL.md (frontmatter `name` and
 * `description`, then the instructions), plus bundled files (scripts, references) in `skill_files`. Pins put skills into
 * sessions: one agent, a building or the whole town; `listed` (name + description) or `always` (full text).
 * Edits load right away: pins point at the doc, never at a frozen copy.
 */
import {
  SKILL_LIMITS, SkillFileInput, type Agent, type Doc, type PinSkillInput, type SkillFileInfo, type SkillPin, type SkillPinView, type SkillView,
} from "@muster-town/schema";
import { canSeeDoc, homeOf } from "./domain.ts";
import { AppError, badRequest } from "./errors.ts";
import { holderOf, type Holder } from "./permissions.ts";
import { newId, nowIso } from "./util.ts";
import type { World } from "./world.ts";

export interface SkillMd { name: string; description: string; instructions: string }

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Parse a SKILL.md: `---` frontmatter with `name:` and `description:` (single-line values, or indented continuation
 * lines; surrounding quotes stripped), then the instructions. Throws a bad_request naming what's wrong.
 */
export function parseSkillMd(body: string): SkillMd {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(body);
  if (!m) throw badRequest("A skill's body is a SKILL.md: start with a frontmatter block (---, then name: and description: lines, then ---), then the instructions.");
  const fields: Record<string, string> = {};
  let key: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) { key = kv[1]; fields[key] = kv[2].trim(); continue; }
    if (key && /^\s+\S/.test(line)) fields[key] = `${fields[key]} ${line.trim()}`.trim();
  }
  const clean = (v: string | undefined) => (v ?? "").replace(/^[>|][-+]?\s*/, "").replace(/^(["'])([\s\S]*)\1$/, "$2").trim();
  const name = clean(fields.name);
  const description = clean(fields.description);
  if (!name) throw badRequest("The skill's frontmatter needs a name: (kebab-case, e.g. verify-deploy).");
  if (name.length > SKILL_LIMITS.nameChars || !NAME_RE.test(name)) throw badRequest(`Skill name "${name}" must be kebab-case (a-z, 0-9, -) and at most ${SKILL_LIMITS.nameChars} chars.`);
  if (!description) throw badRequest("The skill's frontmatter needs a description: one line saying when to use it.");
  if (description.length > SKILL_LIMITS.descriptionChars) throw badRequest(`The skill's description is ${description.length} chars; keep it to ${SKILL_LIMITS.descriptionChars}.`);
  return { name, description, instructions: body.slice(m[0].length).trim() };
}

/** Pin scopes in prompt priority order: the most specific first. */
const PRIORITY = { agent: 0, building: 1, town: 2 } as const;

/** One skill as it reaches a session. */
export interface SessionSkill { doc: Doc; md: SkillMd; mode: "listed" | "always"; scope: SkillPin["scope"]; files: SkillFileInfo[] }

export class Skills {
  constructor(private world: World) {}

  /** The skill doc, or not_found (also for someone else's draft when `holder` is given). */
  require(id: string, holder?: Holder): Doc {
    const d = this.world.docs.get(id);
    if (!d || d.type !== "skill" || (holder && !canSeeDoc(holder, d))) throw new AppError("not_found", `No skill ${id}.`);
    return d;
  }

  /** Validate a skill body before it is written: the parsed SKILL.md, and its name is free (town-wide). */
  validate(body: string, authorId: string, id?: string): SkillMd {
    const md = parseSkillMd(body);
    const taken = this.world.docs.first("type = 'skill' AND title = ? AND id != ? AND (state != 'draft' OR authorId = ?)", [md.name, id ?? "", authorId]);
    if (taken) throw new AppError("conflict", `There is already a skill named "${md.name}" (${taken.id}). Pick another name, or update that one if it's yours.`);
    return md;
  }

  // ---------- bundled files ----------

  files(skillId: string): SkillFileInfo[] {
    return this.world.db.prepare("SELECT path, LENGTH(content) AS chars, updatedAt FROM skill_files WHERE skillId = ? ORDER BY path").all(skillId) as SkillFileInfo[];
  }

  file(skillId: string, path: string): string {
    const row = this.world.db.prepare("SELECT content FROM skill_files WHERE skillId = ? AND path = ?").get(skillId, path) as { content: string } | undefined;
    if (!row) throw new AppError("not_found", `The skill has no file "${path}". Its files: ${this.files(skillId).map((f) => f.path).join(", ") || "(none)"}.`);
    return row.content;
  }

  /** Every file with its content (the bundle a desk unpacks). */
  bundle(skillId: string): { path: string; content: string }[] {
    return this.world.db.prepare("SELECT path, content FROM skill_files WHERE skillId = ? ORDER BY path").all(skillId) as { path: string; content: string }[];
  }

  /** Replace the skill's whole file set (validated: paths, count, sizes, no duplicates). */
  setFiles(skillId: string, files: SkillFileInput[]): SkillFileInfo[] {
    const parsed = files.map((f) => SkillFileInput.parse(f));
    if (parsed.length > SKILL_LIMITS.files) throw badRequest(`A skill bundles at most ${SKILL_LIMITS.files} files.`);
    const seen = new Set<string>();
    for (const f of parsed) { if (seen.has(f.path)) throw badRequest(`Duplicate file path "${f.path}".`); seen.add(f.path); }
    const total = parsed.reduce((n, f) => n + f.content.length, 0);
    if (total > SKILL_LIMITS.totalChars) throw badRequest(`The skill's files total ${total} chars; the limit is ${SKILL_LIMITS.totalChars}.`);
    const ts = nowIso();
    this.world.transaction(() => {
      this.world.db.prepare("DELETE FROM skill_files WHERE skillId = ?").run(skillId);
      const ins = this.world.db.prepare("INSERT INTO skill_files (skillId, path, content, updatedAt) VALUES (?, ?, ?, ?)");
      for (const f of parsed) ins.run(skillId, f.path, f.content, ts);
    });
    return this.files(skillId);
  }

  // ---------- usage ----------

  /** Record a use: a session read the skill (or one of its files). */
  used(me: Agent, doc: Doc, file?: string): void {
    this.world.events.append({
      type: "skill.used", agentId: me.kind === "human" ? null : me.id, buildingId: homeOf(me),
      text: `${me.name} loaded the skill "${doc.title}"${file ? ` (${file})` : ""}`, payload: { docId: doc.id, name: doc.title, ...(file ? { file } : {}) },
    });
  }

  uses(skillId: string, days: number): number {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    return (this.world.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'skill.used' AND ts >= ? AND json_extract(payload, '$.docId') = ?").get(since, skillId) as { n: number }).n;
  }

  // ---------- views ----------

  view(doc: Doc): SkillView {
    let md: Pick<SkillMd, "name" | "description">;
    try { md = parseSkillMd(doc.body); } catch { md = { name: doc.title, description: "(invalid SKILL.md frontmatter)" }; }
    const files = this.files(doc.id);
    return {
      id: doc.id, name: md.name, description: md.description, state: doc.state, buildingId: doc.buildingId, authorId: doc.authorId,
      author: this.world.nameOf(doc.authorId), files, pins: this.pinsOf(doc.id).map((p) => this.pinView(p, files.length)),
      uses7d: this.uses(doc.id, 7), uses30d: this.uses(doc.id, 30), updatedAt: doc.updatedAt,
    };
  }

  /** Skills an agent can see in lists: its own drafts, its building's published skills, the library's. */
  visibleTo(me: Agent, query?: string): Doc[] {
    const holder = holderOf(me);
    const where = ["type = 'skill'", "((state = 'draft' AND authorId = ?) OR (state = 'building' AND buildingId = ?) OR state IN ('library', 'trophy'))"];
    const params: unknown[] = [holder.id, homeOf(me) ?? ""];
    for (const w of (query?.match(/[\p{L}\p{N}-]+/gu) ?? []).slice(0, 8)) { where.push("(title LIKE ? OR body LIKE ?)"); params.push(`%${w}%`, `%${w}%`); }
    return this.world.docs.where(where.join(" AND "), params, "ORDER BY updatedAt DESC, rowid DESC");
  }

  /** Every skill (for the web's Skills tab): published ones, plus the viewer's drafts. */
  listAll(viewer: Holder | null): SkillView[] {
    const docs = this.world.docs.where("type = 'skill' AND (state != 'draft' OR authorId = ?)", [viewer?.id ?? ""], "ORDER BY updatedAt DESC, rowid DESC");
    return docs.map((d) => this.view(d));
  }

  // ---------- pins ----------

  pinsOf(skillId: string): SkillPin[] {
    return this.world.skillPins.where("skillId = ?", [skillId], "ORDER BY createdAt, rowid");
  }

  /** A pin reaches others' sessions unless it is an agent's pin into its own. */
  private reachesOthers(p: Pick<SkillPin, "scope" | "targetId" | "pinnedBy">): boolean {
    return !(p.scope === "agent" && p.targetId === p.pinnedBy);
  }

  /** Why a pin doesn't load (null = it loads): files added after an agent pinned the skill into others' sessions. */
  suspended(p: SkillPin, fileCount: number): string | null {
    if (fileCount > 0 && !p.byHuman && this.reachesOthers(p)) return "The skill now bundles files; a human must pin it again for it to load in others' sessions.";
    return null;
  }

  private pinView(p: SkillPin, fileCount: number): SkillPinView {
    const targetName = p.scope === "town" ? null : p.scope === "building" ? this.world.buildings.get(p.targetId ?? "")?.name ?? p.targetId : this.world.nameOf(p.targetId ?? "");
    return { ...p, targetName, pinnedByName: this.world.nameOf(p.pinnedBy), suspended: this.suspended(p, fileCount) };
  }

  /** Resolve scope + target and check that `me` may pin (or unpin) there. Returns the target id (null for town). */
  private authorize(me: Agent, skill: Doc, input: PinSkillInput, fileCount: number, removing = false): string | null {
    const perms = this.world.permissions;
    const human = me.kind === "human" || removing;
    const needHuman = (what: string) => { if (!human) throw new AppError("forbidden", `${what} needs a human (an admin or a human manager), not an agent.`); };
    if (input.scope === "town") {
      if (!perms.isAdmin(me)) throw new AppError("forbidden", "Only an admin pins skills town-wide.");
      needHuman("A town pin");
      if (!removing && skill.state !== "library" && skill.state !== "trophy") throw badRequest("Only library skills can be pinned town-wide: a manager promotes it first.");
      return null;
    }
    if (input.scope === "building") {
      const bid = input.targetId ?? homeOf(me);
      if (!bid) throw badRequest("You're not in a building; pass targetId.");
      this.world.buildings.require(bid, "building");
      if (!perms.can(me, "building.manage", bid)) throw new AppError("forbidden", "Only the building's manager pins skills into its sessions (needs building.manage).");
      if (!removing && !(skill.state === "library" || skill.state === "trophy" || (skill.state === "building" && skill.buildingId === bid))) throw badRequest("A building pin needs a skill published in that building or in the library.");
      if (input.mode === "always") needHuman("An always-on building pin");
      if (fileCount > 0) needHuman("Pinning a skill with bundled files into others' sessions");
      return bid;
    }
    const target = this.world.agents.require(input.targetId ?? me.id, "agent");
    if (target.id === me.id) {
      if (input.mode === "always" && !human && !perms.can(me, "building.manage", homeOf(me))) throw new AppError("forbidden", "You can pin skills into your own sessions as `listed` only; ask your manager for `always`.");
      return target.id;
    }
    if (!perms.can(me, "building.manage", homeOf(target))) throw new AppError("forbidden", `Only ${target.name}'s building manager pins skills into its sessions.`);
    if (!removing && skill.state === "draft") throw badRequest("Publish the skill before pinning it into someone else's sessions.");
    if (input.mode === "always") needHuman("An always-on pin into another agent's sessions");
    if (fileCount > 0) needHuman("Pinning a skill with bundled files into others' sessions");
    return target.id;
  }

  pin(me: Agent, skillId: string, input: PinSkillInput): SkillPinView {
    const holder = holderOf(me);
    const skill = this.require(skillId, holder);
    const files = this.files(skill.id).length;
    const targetId = this.authorize(me, skill, input, files);
    const cur = this.world.skillPins.first("skillId = ? AND scope = ? AND IFNULL(targetId, '') = ?", [skill.id, input.scope, targetId ?? ""]);
    // a pin into your own sessions records your agent id, so it never counts as reaching others
    const self = input.scope === "agent" && targetId === me.id;
    const pin = this.world.skillPins.upsert({
      id: cur?.id ?? newId("sp"), skillId: skill.id, scope: input.scope, targetId, mode: input.mode,
      pinnedBy: self ? me.id : holder.id, pinnedByKind: self ? "agent" : holder.kind, byHuman: me.kind === "human", createdAt: nowIso(),
    });
    const where = input.scope === "town" ? "town-wide" : input.scope === "building" ? `in ${this.world.buildings.get(targetId!)?.name ?? targetId}` : `for ${this.world.nameOf(targetId!)}`;
    this.world.events.append({ type: "skill.pinned", agentId: me.kind === "human" ? null : me.id, buildingId: input.scope === "building" ? targetId : homeOf(me), text: `${me.name} pinned the skill "${skill.title}" ${where} (${input.mode})`, payload: { docId: skill.id, pinId: pin.id, scope: input.scope, targetId, mode: input.mode } });
    return this.pinView(pin, files);
  }

  /** Remove a pin: whoever made it, or anyone who could make it. */
  unpin(me: Agent, skillId: string, input: Pick<PinSkillInput, "scope" | "targetId">): { removed: boolean } {
    const holder = holderOf(me);
    const skill = this.require(skillId, holder);
    const targetId = input.scope === "town" ? null : input.scope === "building" ? input.targetId ?? homeOf(me) : input.targetId ?? me.id;
    const pin = this.world.skillPins.first("skillId = ? AND scope = ? AND IFNULL(targetId, '') = ?", [skill.id, input.scope, targetId ?? ""]);
    if (!pin) return { removed: false };
    return this.removePin(me, pin);
  }

  removePin(me: Agent, pin: SkillPin): { removed: boolean } {
    const holder = holderOf(me);
    const skill = this.world.docs.get(pin.skillId);
    const mine = pin.pinnedBy === holder.id || pin.pinnedBy === me.id || (pin.scope === "agent" && pin.targetId === me.id);
    if (!mine && skill) this.authorize(me, skill, { scope: pin.scope, targetId: pin.targetId ?? undefined, mode: "listed" }, 0, true);
    else if (!mine) throw new AppError("forbidden", "Not your pin.");
    this.world.db.prepare("DELETE FROM skill_pins WHERE id = ?").run(pin.id);
    this.world.events.append({ type: "skill.unpinned", agentId: me.kind === "human" ? null : me.id, buildingId: pin.scope === "building" ? pin.targetId : homeOf(me), text: `${me.name} unpinned the skill "${skill?.title ?? pin.skillId}"`, payload: { docId: pin.skillId, pinId: pin.id, scope: pin.scope, targetId: pin.targetId } });
    return { removed: true };
  }

  /** The skills pinned into `agentId`'s sessions, most specific first, one entry per skill (always wins over listed). */
  forAgent(agentId: string): SessionSkill[] {
    const agent = this.world.agents.get(agentId);
    if (!agent) return [];
    const bid = homeOf(agent);
    const pins = this.world.skillPins.where("(scope = 'agent' AND targetId = ?) OR (scope = 'building' AND targetId = ?) OR scope = 'town'", [agent.id, bid ?? ""], "ORDER BY createdAt, rowid")
      .sort((a, b) => PRIORITY[a.scope] - PRIORITY[b.scope]);
    const out = new Map<string, SessionSkill>();
    for (const p of pins) {
      const doc = this.world.docs.get(p.skillId);
      if (!doc || doc.type !== "skill" || !canSeeDoc(holderOf(agent), doc)) continue;
      const files = this.files(doc.id);
      if (this.suspended(p, files.length)) continue;
      let md: SkillMd;
      try { md = parseSkillMd(doc.body); } catch { continue; }
      const cur = out.get(doc.id);
      if (cur) { if (p.mode === "always") cur.mode = "always"; continue; }
      out.set(doc.id, { doc, md, mode: p.mode, scope: p.scope, files });
    }
    return [...out.values()];
  }
}

const filePaths = (files: SkillFileInfo[]) => `${files.slice(0, 6).map((f) => f.path).join(", ")}${files.length > 6 ? ", …" : ""}`;
const fileNote = (files: SkillFileInfo[]) => (files.length ? ` [${files.length} file${files.length === 1 ? "" : "s"}: ${filePaths(files)}]` : "");

/**
 * "## Skills" for a session's system prompt: `always` skills in full (most specific first, up to
 * SKILL_LIMITS.alwaysChars in total; the rest fall back to listed), then one line per listed skill. "" when none.
 */
export function skillsBlock(skills: SessionSkill[], cap: number = SKILL_LIMITS.alwaysChars): string {
  if (!skills.length) return "";
  const full: string[] = [];
  const listed: string[] = [];
  let used = 0;
  let overflow = 0;
  for (const s of skills) {
    const line = `- ${s.md.name} (${s.doc.id}, ${s.scope} pin): ${s.md.description}${fileNote(s.files)}`;
    if (s.mode === "always") {
      const text = `### Skill: ${s.md.name} (${s.doc.id}, always on)\n${s.md.instructions}${s.files.length ? `\n(Bundled files: ${filePaths(s.files)}; \`read\` with \`file\` opens one.)` : ""}`;
      if (used + text.length <= cap) { full.push(text); used += text.length; continue; }
      overflow++;
    }
    listed.push(line);
  }
  const out = ["## Skills"];
  if (listed.length) {
    out.push(`Skills pinned for you. Before you use one, load it with \`read\` (its id); \`read\` with \`file\` opens a bundled file (on a desk you can save it and run it). \`skills\` lists every skill you can use.${overflow ? ` (${overflow} always-on skill${overflow === 1 ? "" : "s"} didn't fit the ${cap}-char cap and ${overflow === 1 ? "is" : "are"} listed instead.)` : ""}`);
    out.push(listed.join("\n"));
  }
  if (full.length) out.push(full.join("\n\n"));
  return out.join("\n");
}
