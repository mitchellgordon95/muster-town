import { Verdict, type Agent, type Building, type Doc } from "@agent-town/schema";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { createDoc, updateDoc } from "./domain.ts";
import { createBuilding, createResident } from "./entities.ts";
import { AppError } from "./errors.ts";
import { parseFrontmatter } from "./util.ts";
import type { World } from "./world.ts";

export interface ImportV0Options {
  /** user who becomes the building's manager/owner (and author of master/wiki articles) */
  creatorUserId?: string | null;
}
export interface ImportV0Result {
  building: Building;
  agents: Agent[];
  /** v0 desk id -> agent id */
  deskAgents: Record<string, string>;
  docs: Doc[];
}

interface V0Desk { id: string; name: string; title?: string; direction?: string; sprite?: number }
interface V0Building { id: string; name: string; goal?: string; description?: string; maxTurns?: number; desks?: V0Desk[] }

const listMd = (dir: string) => existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md" && statSync(join(dir, f)).isFile()).sort() : [];
const heading = (md: string) => /^#\s+(.+)$/m.exec(md)?.[1].trim();

/**
 * Import a v0 building folder: building.json → building + residents (one per desk);
 * sources/*.md → `source` docs in the library; wiki/desks/<desk>.md → desk `article` on the board;
 * wiki/main.md → "Master article"; other wiki/*.md → `note`; reports/<desk>/run-NNN.md → `report`
 * with verdict/decision from frontmatter. Relative links between imported files become `doc:<id>`.
 */
export function importV0(world: World, dirIn: string, opts: ImportV0Options = {}): ImportV0Result {
  const dir = resolve(dirIn);
  const cfgPath = join(dir, "building.json");
  if (!existsSync(cfgPath)) throw new AppError("bad_request", `No building.json in ${dir}`);
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as V0Building;
  if (world.buildings.get(cfg.id)) throw new AppError("conflict", `Building ${cfg.id} already exists (already imported?).`);
  const desks = cfg.desks ?? [];
  const creator = opts.creatorUserId ?? null;

  return world.transaction(() => {
    const building = createBuilding(world, {
      name: cfg.name, goal: cfg.goal ?? "", description: cfg.description ?? "",
      headcount: Math.max(6, desks.length + 1), maxTurnsPerSession: cfg.maxTurns ?? 80,
      reviewPolicy: "human", meetings: [{ kind: "standup", everyMinutes: 0 }],
    }, creator, { id: cfg.id });

    const deskAgents: Record<string, string> = {};
    const agents: Agent[] = [];
    for (const d of desks) {
      const a = createResident(world, { buildingId: building.id, name: d.name, title: d.title ?? d.id, direction: d.direction ?? "", sprite: d.sprite });
      deskAgents[d.id] = a.id;
      agents.push(a);
    }
    const fallbackAuthor = creator ? { authorId: creator, authorKind: "user" as const } : agents[0] ? { authorId: agents[0].id, authorKind: "agent" as const } : { authorId: "system", authorKind: "user" as const };

    // reports first (read only) so sources can be attributed to the desk whose report cites them
    const reports: { desk: string; file: string; text: string }[] = [];
    const rdir = join(dir, "reports");
    if (existsSync(rdir)) {
      for (const desk of readdirSync(rdir).sort()) {
        if (!statSync(join(rdir, desk)).isDirectory()) continue;
        for (const f of listMd(join(rdir, desk))) reports.push({ desk, file: join(rdir, desk, f), text: readFileSync(join(rdir, desk, f), "utf8") });
      }
    }
    const citedBy = (srcFile: string) => reports.find((r) => r.text.includes(`sources/${srcFile}`))?.desk;
    const authorFor = (desk?: string) => desk && deskAgents[desk] ? { authorId: deskAgents[desk], authorKind: "agent" as const } : fallbackAuthor;

    /** absolute file path -> imported doc */
    const byPath = new Map<string, Doc>();
    const docs: Doc[] = [];
    const add = (file: string, d: Doc) => { byPath.set(normalize(file), d); docs.push(d); };

    for (const f of listMd(join(dir, "sources"))) {
      const file = join(dir, "sources", f);
      const body = readFileSync(file, "utf8");
      const urls = [...body.matchAll(/^[-*]\s*(?:URL|Underlying dataset|DOI)[^:]*:.*?(https?:\/\/\S+)/gim)].map((m) => m[1].replace(/[).,]+$/, ""));
      add(file, createDoc(world, {
        type: "source", state: "library", title: heading(body) ?? f.replace(/\.md$/, ""), body, buildingId: building.id,
        provenance: { sourceIds: [], urls: [...new Set(urls)] }, tags: ["v0-import"], ...authorFor(citedBy(f)),
      }, `Imported source "${heading(body) ?? f}"`));
    }

    const wiki = join(dir, "wiki");
    for (const f of listMd(join(wiki, "desks"))) {
      const file = join(wiki, "desks", f);
      const body = readFileSync(file, "utf8");
      const desk = f.replace(/\.md$/, "");
      const deskCfg = desks.find((d) => d.id === desk);
      add(file, createDoc(world, {
        type: "article", state: "building", title: deskCfg?.title ? `${deskCfg.title} — desk article` : heading(body) ?? desk, body,
        buildingId: building.id, tags: ["v0-import", `desk:${desk}`], ...authorFor(desk),
      }, `Imported desk article "${desk}"`));
    }
    for (const f of listMd(wiki)) {
      const file = join(wiki, f);
      const body = readFileSync(file, "utf8");
      const isMain = f === "main.md";
      add(file, createDoc(world, {
        type: isMain ? "article" : "note", state: "building", title: isMain ? "Master article" : heading(body) ?? f.replace(/\.md$/, ""), body,
        buildingId: building.id, tags: ["v0-import", isMain ? "master" : "wiki"], ...fallbackAuthor,
      }, `Imported ${isMain ? "master article" : `wiki page ${f}`}`));
    }

    for (const r of reports) {
      const { data, body } = parseFrontmatter(r.text);
      const verdict = Verdict.safeParse(data.verdict).success ? (data.verdict as Doc["verdict"]) : "continue";
      const decision = (["pending", "approve", "redirect", "stop"] as const).find((x) => x === data.decision) ?? "pending";
      const ts = typeof data.ended === "string" && data.ended ? data.ended : typeof data.started === "string" ? data.started : undefined;
      const createdAt = ts && !Number.isNaN(Date.parse(ts)) ? new Date(ts).toISOString() : undefined;
      const author = authorFor(r.desk);
      const doc = createDoc(world, {
        type: "report", state: "building", title: heading(body) ?? basename(r.file, ".md"), body, verdict, decision,
        decisionNote: typeof data.note === "string" && data.note ? data.note : undefined,
        buildingId: building.id, tags: ["v0-import", `desk:${r.desk}`, `run:${data.run ?? basename(r.file, ".md")}`], createdAt, ...author,
      }, `Imported report "${heading(body) ?? r.file}"`);
      add(r.file, doc);
      if (decision === "pending" && author.authorKind === "agent") world.setStatus(author.authorId, "awaiting-review");
      if (decision === "stop" && author.authorKind === "agent") world.setStatus(author.authorId, "stopped");
    }

    // rewrite relative links between imported files to doc:<id>; linked sources become provenance
    const out: Doc[] = [];
    for (const [file, d] of byPath) {
      const linked = new Set<string>();
      const body = d.body.replace(/\]\(([^)\s#]+\.md)(#[^)]*)?\)/g, (m, target: string) => {
        if (/^[a-z]+:/i.test(target)) return m;
        const hit = byPath.get(normalize(join(dirname(file), target)));
        if (!hit) return m;
        if (hit.type === "source" && hit.id !== d.id) linked.add(hit.id);
        return `](doc:${hit.id})`;
      });
      out.push(body === d.body && !linked.size ? d : updateDoc(world, d.id, { body, provenance: { ...d.provenance, sourceIds: [...linked] } }));
    }
    return { building: world.buildings.require(building.id), agents: agents.map((a) => world.agents.require(a.id)), deskAgents, docs: out };
  });
}
