import { Agent, Building, Doc, Meeting, ROOT_GOAL_ID, Town, type Event, type ServerMessage } from "@muster-town/schema";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type { DB } from "./db.ts";
import { EventLog } from "./events.ts";
import { createRepos } from "./store.ts";
import { Emitter, parseFrontmatter, slugify, stringifyFrontmatter } from "./util.ts";
import type { World } from "./world.ts";

/**
 * `error`: the first line of what git said when a git step failed (null when git ran clean), so export.done shows why `commit` is null.
 * Publish to GitHub (gr_30f8obzab8): `pushedAt`/`pushCommit` when this run pushed to the collective's repo, `pushError` when the
 * push failed (git's first line, tokens masked); all three null when no push was due (no repo set, or the repo already has HEAD).
 */
export interface ExportResult {
  dir: string; commit: string | null; changed: boolean; files: number; error: string | null;
  pushedAt: string | null; pushCommit: string | null; pushError: string | null;
}

/**
 * Where an export pushes (gr_30f8obzab8): the World's own `Town.publish.repoUrl`, its runtime-owned token (null: push without
 * auth, e.g. a file:// remote in tests) and the commit its last push landed (a run pushes when HEAD differs from it, so a run
 * after a failed push catches up even when nothing changed locally).
 */
export interface PublishTarget { repoUrl: string; token: string | null; lastPushCommit: string | null }

/**
 * Path of a doc inside the export mirror (null = not exported: drafts are private).
 * Every doc folder is `<type>/<YYYY-MM>/` and every file `<YYYY-MM-DD>-<slug>-<id8>.md`, so a folder
 * never holds more than a month of one type and files sort by date.
 */
export function docExportPath(d: Doc): string | null {
  if (d.state === "draft") return null;
  const file = posix.join(d.createdAt.slice(0, 7), `${d.createdAt.slice(0, 10)}-${slugify(d.title)}-${d.id.slice(-8)}.md`);
  if (d.type === "request") return posix.join("town-hall", "outbox", file);
  if (d.state === "library") return posix.join("library", d.type, file);
  return posix.join("buildings", d.buildingId ?? "town-hall", "docs", d.type, file);
}

function meetingExportPath(m: Meeting): string {
  return posix.join("meetings", m.createdAt.slice(0, 7), `${m.createdAt.slice(0, 10)}-${slugify(m.title)}-${m.id.slice(-8)}.md`);
}

const ID = "dc_[a-z0-9]{10}";
/** Apply `fn` to the parts of markdown outside code spans and fenced blocks. */
function outsideCode(md: string, fn: (text: string) => string): string {
  return md.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, i) => (i % 2 ? part : fn(part))).join("");
}

/**
 * Doc links in a body, made browsable in the git mirror: `[label](dc_…)` and `[label](doc:dc_…)` point at the
 * target's file (the `doc:` form keeps a `"doc:"` link title so import restores it), and a bare `dc_…` becomes `[dc_…](file)`. Ids of docs that aren't exported stay as they are.
 * `importLinks` undoes it.
 */
export function exportLinks(body: string, fromPath: string, pathOf: (id: string) => string | null): string {
  const rel = (id: string) => { const p = pathOf(id); return p ? posix.relative(posix.dirname(fromPath), p) : null; };
  return outsideCode(body, (text) => text.split(/(\[[^\]\n]*\]\([^)\s]*\))/).map((part, i) => {
    if (i % 2) return part.replace(new RegExp(`\\]\\((doc:)?(${ID})\\)$`), (all, doc: string | undefined, id: string) => { const r = rel(id); return r ? `](${r}${doc ? ' "doc:"' : ""})` : all; });
    return part.replace(new RegExp(`(?<![\\w/:-])(${ID})\\b`, "g"), (all, id: string) => { const r = rel(id); return r ? `[${id}](${r})` : all; });
  }).join(""));
}

/** Reverse of `exportLinks`: `[dc_…](….md)` back to the bare id, and links to `…-<id8>.md` files back to `](dc_…)`. */
export function importLinks(body: string, idOf8: (id8: string) => string | null): string {
  return outsideCode(body, (text) => text
    .replace(new RegExp(`\\[(${ID})\\]\\((?![a-z]+:)[^)\\s]*\\.md\\)`, "g"), "$1")
    .replace(/\]\((?![a-z]+:)[^)\s]*-([a-z0-9]{8})\.md( "doc:")?\)/g, (all, id8: string, doc: string | undefined) => { const id = idOf8(id8); return id ? `](${doc ? "doc:" : ""}${id})` : all; }));
}

const STALE_LOCK_MS = 10 * 60_000;

/**
 * One git call of the export. `safe.directory=*`: git >= 2.35.2 refuses a repo owned by another uid ("detected dubious
 * ownership"), and the export dir on the Fly volume may predate the server's uid; never prompt for anything.
 * A failure throws an Error whose message is `git <cmd>: <first line git printed>` (not node's "Command failed: …").
 */
function git(cwd: string, args: string[], env: Record<string, string> = {}, input?: string): string {
  try {
    return execFileSync("git", ["-c", "safe.directory=*", ...args], { cwd, input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env } }).trim();
  } catch (e) {
    const err = e as Error & { stderr?: string | Buffer; stdout?: string | Buffer };
    const said = `${String(err.stderr ?? "")}\n${String(err.stdout ?? "")}\n${err.message}`.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("Command failed:"));
    throw new Error(`git ${args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? ""}: ${said ?? "failed"}`.slice(0, 500));
  }
}

/** Token-looking strings (GitHub tokens, and the given secrets and their Basic header) masked out of a message. */
export function maskTokens(text: string, secrets: string[] = []): string {
  let out = text;
  for (const v of secrets) if (v) out = out.split(v).join("***");
  return out.replace(/\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g, "***");
}

/**
 * The top-level names the export owns in its repo (rebuilt from the live world every run, so a hand edit to them is
 * overwritten by the next export); anything else at the repo's top level (a LICENSE, .gitignore, .github/) is foreign and kept.
 */
const EXPORT_OWNED = ["README.md", "town.json", "index.json", "agents.json", "buildings", "library", "town-hall", "meetings", "events"] as const;

/** The ref a push fetches the remote's main into (keeps its objects, so a later fetch transfers only what is new). */
const REMOTE_MAIN = "refs/publish/main";

/**
 * Push HEAD to the collective's repo as `main`, never forced (decision 5 of 1:1 mt_msnjkpgwdb). It fetches the remote's main
 * first: an empty repo, or one whose main HEAD already contains, gets HEAD itself (a fast-forward); a main with commits the
 * export doesn't have (GitHub's "initialise with README", a hand commit) gets a new commit on top of it whose tree is HEAD's
 * plus the remote's top-level entries outside EXPORT_OWNED, so foreign files survive and the export's own paths match the
 * town. Nothing is pushed when that tree already is the remote's. The token rides in the environment of the git calls as an
 * `http.extraheader` (GIT_CONFIG_COUNT/KEY/VALUE): never in argv, never in the remote URL, never in .git/config
 * (no `git remote add`). A failure is returned, never thrown: the local commit already landed.
 */
function pushExport(dir: string, commit: string, p: PublishTarget): Pick<ExportResult, "pushedAt" | "pushCommit" | "pushError"> {
  const header = p.token ? Buffer.from(`x-access-token:${p.token}`).toString("base64") : null;
  const env: Record<string, string> = header ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraheader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${header}` } : {};
  try {
    const remote = fetchRemoteMain(dir, p.repoUrl, env);
    const publish = remote ? onTopOf(dir, commit, remote) : commit;
    if (publish === remote) return { pushedAt: null, pushCommit: null, pushError: null }; // the repo already shows this export
    git(dir, ["push", "-q", "--", p.repoUrl, `${publish}:refs/heads/main`], env);
    return { pushedAt: new Date().toISOString(), pushCommit: publish, pushError: null };
  } catch (e) {
    const pushError = maskTokens((e as Error).message, [p.token ?? "", header ?? ""]);
    console.log("[core] export: push failed:", pushError);
    return { pushedAt: null, pushCommit: null, pushError };
  }
}

/** The remote's main, fetched into REMOTE_MAIN; null when the repo has no main yet (a new empty repo). */
function fetchRemoteMain(dir: string, repoUrl: string, env: Record<string, string>): string | null {
  try {
    git(dir, ["fetch", "-q", "--no-tags", "--", repoUrl, `+refs/heads/main:${REMOTE_MAIN}`], env);
  } catch (e) {
    if (/couldn't find remote ref/i.test((e as Error).message)) return null;
    throw e;
  }
  return git(dir, ["rev-parse", REMOTE_MAIN]);
}

/**
 * What to push over `remote`: `commit` itself when the remote is already in its history (a fast-forward), else a commit
 * with `remote` as its parent and HEAD's tree plus the remote's foreign top-level entries; `remote` itself when that tree
 * is the remote's already (nothing to push).
 */
function onTopOf(dir: string, commit: string, remote: string): string {
  try { git(dir, ["merge-base", "--is-ancestor", remote, commit]); return commit; } catch { /* the remote has commits the export doesn't */ }
  const owned = new Set<string>(EXPORT_OWNED);
  const entries = (rev: string) => git(dir, ["ls-tree", "-z", rev]).split("\0").filter(Boolean);
  const name = (line: string) => line.slice(line.indexOf("\t") + 1);
  const ours = entries(commit);
  for (const line of ours) owned.add(name(line));
  const tree = git(dir, ["mktree", "-z"], {}, [...ours, ...entries(remote).filter((l) => !owned.has(name(l)))].map((l) => l + "\0").join(""));
  if (tree === git(dir, ["rev-parse", `${remote}^{tree}`])) return remote;
  const message = git(dir, ["log", "-1", "--format=%B", commit]);
  const who = { GIT_AUTHOR_NAME: "Muster Town", GIT_AUTHOR_EMAIL: "export@muster-town.local", GIT_COMMITTER_NAME: "Muster Town", GIT_COMMITTER_EMAIL: "export@muster-town.local" };
  return git(dir, ["commit-tree", tree, "-p", remote, "-m", message], who);
}

/** What an export reads: the World's repos on the main thread, or a read-only connection of its own in the export worker. */
interface ExportSource {
  town(): Town;
  docs(): Doc[];
  buildings(): Building[];
  meetings(): Meeting[];
  agents(): Agent[];
  events(q: { since: number; limit: number }): Event[];
  nameOf(id: string): string;
  purposeOf(b: Building): string;
}

export function worldSource(world: World): ExportSource {
  return {
    town: () => world.town.get(),
    docs: () => world.docs.all("ORDER BY createdAt, rowid"),
    buildings: () => world.buildings.all(),
    meetings: () => world.meetings.all("ORDER BY createdAt, rowid"),
    agents: () => world.agents.all("ORDER BY createdAt, rowid"),
    events: (q) => world.events.list(q),
    nameOf: (id) => world.nameOf(id),
    purposeOf: (b) => world.goalTree.purposeOf(b),
  };
}

/**
 * The same reads on a bare connection (the export worker opens town.db read-only): the repos only, no World (World's
 * constructor writes: migrateRoles, the layout). nameOf and purposeOf repeat World.nameOf and Goals.purposeOf.
 */
export function dbSource(db: DB): ExportSource {
  const changes = new Emitter<ServerMessage>(); // nothing is written, so nothing is emitted
  const repos = createRepos(db, changes);
  const events = new EventLog(db, changes);
  return {
    town: () => repos.town.get(),
    docs: () => repos.docs.all("ORDER BY createdAt, rowid"),
    buildings: () => repos.buildings.all(),
    meetings: () => repos.meetings.all("ORDER BY createdAt, rowid"),
    agents: () => repos.agents.all("ORDER BY createdAt, rowid"),
    events: (q) => events.list(q),
    nameOf: (id) => repos.agents.get(id)?.name ?? repos.users.get(id)?.name ?? (id === "system" ? "Town" : id),
    purposeOf: (b) => (b.goalId ? repos.goals.get(b.goalId) : undefined)?.text ?? repos.goals.get(ROOT_GOAL_ID)?.text ?? b.goal,
  };
}

/**
 * Write the readable repo mirror, `git commit` it if anything changed and append `export.done`.
 * Never writes secrets (no users, tokens, or API keys). Drafts are not exported.
 */
export function exportWorld(world: World, dir: string): ExportResult {
  const r = writeExport(worldSource(world), dir, world.publishTarget());
  world.recordExport(r);
  return r;
}

/** The one `export.done` event of a run (the runtime appends it when the worker answers). */
export function exportDoneEvent(r: ExportResult) {
  const push = r.pushError ? `; push failed: ${r.pushError}` : r.pushedAt ? `; pushed ${r.pushCommit?.slice(0, 7)} to GitHub` : "";
  return { type: "export.done" as const, text: `${r.changed ? `Exported the town (${r.commit?.slice(0, 7) ?? "no commit"})` : "Export: no changes"}${push}`, payload: { ...r } };
}

/** the worker file: the source under tsx or vitest, dist/export-worker.js in the prebuilt server (server/build.mjs bundles it) */
const WORKER_FILE = import.meta.url.endsWith(".ts") ? new URL("./export-worker.ts", import.meta.url) : new URL("./export-worker.js", import.meta.url);

export type ExportWorkerMessage = { ok: true; result: ExportResult } | { ok: false; error: string };

/**
 * One export off the main thread (docs/postmortem-2026-10-31-cpu-throttle-503.md suggestion 2): a `worker_threads` worker opens
 * `dbPath` read-only on its own connection and runs writeExport there, so the reads (~1 s at the live size), the ~1,600 file
 * writes and git never block the event loop. Resolves with the worker's result; the caller appends `export.done`.
 */
export function exportInWorker(dbPath: string, dir: string, publish: PublishTarget | null = null): Promise<ExportResult> {
  // the sources need tsx's loader in the worker (core uses TypeScript Node can't strip); tsx's own runs pass it down already
  const needsTsx = WORKER_FILE.pathname.endsWith(".ts") && !process.execArgv.some((a) => a.includes("tsx"));
  return new Promise((done, fail) => {
    let settled = false;
    const worker = new Worker(WORKER_FILE, { workerData: { exportRun: { dbPath, dir: resolve(dir), publish } }, ...(needsTsx ? { execArgv: [...process.execArgv, "--import", "tsx"] } : {}) });
    worker.once("message", (m: ExportWorkerMessage) => { settled = true; if (m.ok) done(m.result); else fail(new Error(m.error)); });
    worker.once("error", (e) => { if (!settled) { settled = true; fail(e); } });
    worker.once("exit", (code) => { if (!settled) { settled = true; fail(new Error(`export worker exited with code ${code} before answering`)); } });
  });
}

/** The export itself, without the event: synchronous file writes and git (the runtime runs it in a worker, export-worker.ts). */
export function writeExport(src: ExportSource, dirIn: string, publish: PublishTarget | null = null): ExportResult {
  const dir = resolve(dirIn);
  mkdirSync(dir, { recursive: true });
  // regenerate everything except .git so moved/deleted docs disappear
  for (const entry of readdirSync(dir)) if (entry !== ".git") rmSync(join(dir, entry), { recursive: true, force: true });
  let files = 0;
  const write = (rel: string, content: string) => {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    files++;
  };
  const town = src.town();
  const docs = src.docs().flatMap((d) => { const path = docExportPath(d); return path ? [{ d, path }] : []; });
  const pathById = new Map(docs.map((x) => [x.d.id, x.path]));
  write("town.json", JSON.stringify(town, null, 2) + "\n");
  for (const { d, path } of docs) {
    const { body, ...front } = d;
    write(path, stringifyFrontmatter(front, exportLinks(body, path, (id) => pathById.get(id) ?? null)));
  }
  write("index.json", JSON.stringify(docs.map(({ d, path }) => ({ id: d.id, path, title: d.title, type: d.type, state: d.state, buildingId: d.buildingId, createdAt: d.createdAt })), null, 2) + "\n");
  const buildings = src.buildings();
  for (const b of buildings) {
    write(join("buildings", b.id, "building.json"), JSON.stringify(b, null, 2) + "\n");
    const dir = posix.join("buildings", b.id);
    write(posix.join(dir, "README.md"), indexPage(src, `# ${b.name}\n\n${src.purposeOf(b) ? `Goal: ${src.purposeOf(b)}\n\n` : ""}Published docs (the board and the filing cabinet), newest first. Drafts are private and not exported.`, dir, docs.filter((x) => x.path.startsWith(dir + "/"))));
  }
  const library = docs.filter((x) => x.path.startsWith("library/"));
  write("library/README.md", indexPage(src, "# Library\n\nDocs promoted to the town library, newest first.", "library", library));
  write("README.md", [
    `# ${town.name} — export`, "",
    "**The town is the source of truth and this repo is its mirror:** a hand edit to an exported file is overwritten by the next hourly export; files outside the export's paths (a LICENSE, `.gitignore`, `.github/`) are kept.", "",
    "Generated by Muster Town from the live world. Docs link to each other by relative path; `index.json` maps every doc id (`dc_…`) to its file.", "",
    "## Layout", "",
    "- `buildings/<id>/README.md` — the building's index; `buildings/<id>/docs/<type>/<YYYY-MM>/<YYYY-MM-DD>-<slug>-<id8>.md` — its published docs",
    "- `library/` — docs promoted to the library, same `<type>/<YYYY-MM>/` layout",
    "- `town-hall/outbox/<YYYY-MM>/` — requests for humans",
    "- `meetings/<YYYY-MM>/` — meeting transcripts",
    "- `events/<YYYY-MM>/<YYYY-MM-DD>.jsonl` — the event log, one file per day",
    "- `town.json`, `agents.json`, `buildings/<id>/building.json`, `index.json`", "",
    "## Buildings", "",
    ...buildings.map((b) => `- [${b.name}](buildings/${b.id}/README.md): ${docs.filter((x) => x.path.startsWith(`buildings/${b.id}/`)).length} docs`),
    `- [Library](library/README.md): ${library.length} docs`, "",
  ].join("\n"));
  for (const m of src.meetings()) {
    const name = (id: string) => src.nameOf(id);
    const body = [`# ${m.title}`, "", ...m.transcript.map((u) => `- **${name(u.speakerId)}** (${u.at}): ${u.text}`)].join("\n");
    // focus is what the human's screen shows this minute, not a record: left out so the export doesn't churn on every J / K
    const { focus: _onScreen, ...rest } = m;
    write(meetingExportPath(m), stringifyFrontmatter(rest, body));
  }
  write("agents.json", JSON.stringify(src.agents(), null, 2) + "\n");
  const byDay = new Map<string, Event[]>();
  let since = 0;
  for (;;) {
    const batch = src.events({ since, limit: 5000 });
    if (!batch.length) break;
    for (const e of batch) {
      since = e.id;
      if (e.type === "export.done" || e.type === "agent.thought") continue;
      const day = e.ts.slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push(e);
    }
  }
  for (const [day, evs] of byDay) write(join("events", day.slice(0, 7), `${day}.jsonl`), evs.map((e) => JSON.stringify(e)).join("\n") + "\n");

  let commit: string | null = null, changed = false, error: string | null = null;
  try {
    if (!existsSync(join(dir, ".git"))) git(dir, ["init", "-q"]);
    // a server killed mid-export (a redeploy) leaves .git/index.lock behind and every later `git add` fails on it; runs are one
    // at a time, so a lock older than 10 min is stale
    const lock = join(dir, ".git", "index.lock");
    if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { force: true });
    git(dir, ["add", "-A"]);
    changed = git(dir, ["status", "--porcelain"]).length > 0;
    if (changed) {
      git(dir, ["-c", "user.name=Muster Town", "-c", "user.email=export@muster-town.local", "commit", "-q", "-m", `export ${new Date().toISOString()}`]);
    }
    try { commit = git(dir, ["rev-parse", "HEAD"]); } catch { commit = null; }
  } catch (e) {
    error = (e as Error).message;
    console.log("[core] export: git unavailable or failed:", error);
  }
  // Publish to GitHub (gr_30f8obzab8): push when the repo doesn't have HEAD yet (a new commit, or an earlier push failed)
  const pushed = publish && commit && !error && commit !== publish.lastPushCommit ? pushExport(dir, commit, publish) : { pushedAt: null, pushCommit: null, pushError: null };
  return { dir, commit, changed, files, error, ...pushed };
}

const LATEST = 30;
/** A folder's README: per doc type, the latest docs as links (with id and author), then links to each month folder. */
function indexPage(src: ExportSource, head: string, dir: string, docs: { d: Doc; path: string }[]): string {
  const out = [head, ""];
  const types = [...new Set(docs.map((x) => x.d.type))].sort();
  if (!types.length) out.push("Nothing published yet.", "");
  for (const type of types) {
    const of = docs.filter((x) => x.d.type === type).reverse();
    out.push(`## ${type} (${of.length})`, "");
    for (const { d, path } of of.slice(0, LATEST)) out.push(`- ${d.createdAt.slice(0, 10)} [${d.title.replace(/[[\]]/g, "")}](${posix.relative(dir, path)}) \`${d.id}\` · ${src.nameOf(d.authorId)}`);
    if (of.length > LATEST) {
      const months = [...new Set(of.map((x) => posix.dirname(posix.relative(dir, x.path))))];
      out.push("", `All by month: ${months.map((m) => `[${posix.basename(m)}](${m}/)`).join(" · ")}`);
    }
    out.push("");
  }
  return out.join("\n");
}

function walkMd(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walkMd(p));
    else if (e.endsWith(".md")) out.push(p);
  }
  return out;
}

/** Load an export mirror into this (normally empty) world. Existing ids are overwritten. */
export function importExport(world: World, dirIn: string) {
  const dir = resolve(dirIn);
  const counts = { buildings: 0, agents: 0, docs: 0, meetings: 0 };
  world.transaction(() => {
    if (existsSync(join(dir, "town.json"))) world.town.set(Town.parse(JSON.parse(readFileSync(join(dir, "town.json"), "utf8"))));
    world.permissions.ensureTownRoles();
    const bdir = join(dir, "buildings");
    for (const id of existsSync(bdir) ? readdirSync(bdir) : []) {
      const f = join(bdir, id, "building.json");
      if (!existsSync(f)) continue;
      const b = world.buildings.upsert(Building.parse(JSON.parse(readFileSync(f, "utf8"))));
      world.permissions.ensureBuildingRoles(b.id);
      counts.buildings++;
    }
    if (existsSync(join(dir, "agents.json"))) {
      for (const raw of JSON.parse(readFileSync(join(dir, "agents.json"), "utf8")) as unknown[]) {
        const a = world.agents.upsert(Agent.parse(raw));
        counts.agents++;
        if (a.kind === "resident" && a.homeBuildingId && world.buildings.get(a.homeBuildingId)) {
          const n = world.db.prepare("SELECT COUNT(*) AS n FROM desks WHERE buildingId = ?").get(a.homeBuildingId) as { n: number };
          world.db.prepare("INSERT OR IGNORE INTO desks (buildingId, n, agentId) VALUES (?, ?, ?)").run(a.homeBuildingId, n.n, a.id);
        }
      }
    }
    const docFiles = [...walkMd(join(dir, "library")), ...walkMd(join(dir, "town-hall")), ...walkMd(bdir)]
      .map((f) => parseFrontmatter(readFileSync(f, "utf8")))
      .filter(({ data }) => data.id && data.type);
    const byId8 = new Map(docFiles.map(({ data }) => [String(data.id).slice(-8), String(data.id)]));
    for (const { data, body } of docFiles) {
      world.docs.upsert(Doc.parse({ ...data, body: importLinks(body.replace(/\n$/, ""), (id8) => byId8.get(id8) ?? null) }), { silent: true });
      counts.docs++;
    }
    for (const f of walkMd(join(dir, "meetings"))) {
      const { data } = parseFrontmatter(readFileSync(f, "utf8"));
      if (!data.id) continue;
      world.meetings.upsert(Meeting.parse(data), { silent: true });
      counts.meetings++;
    }
  });
  world.layout.rebuild();
  return counts;
}
