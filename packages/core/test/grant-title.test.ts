/**
 * A grant's short name (migration 105, docs/legible-delegation.md §5): the back-fill rule in SQL and in code, the cards
 * that name a grant by its title and never quote its objective, the gate card's top-up line as a claim, the boot repair
 * that rewrites the live clipped cards once, and the `no-ellipsis` lint rule.
 */
import Database from "better-sqlite3";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GrantTitle, grantTitleOf, lintAskBody, vetAsk } from "@muster-town/schema";
import { describe, expect, it } from "vitest";
import { createBuilding, createResident, migrate, newId, nowIso, updateBuilding } from "../src/index.ts";
import { asksFor, createAsk, retitleClippedAsks, retitleGrantAsks, setRank } from "../src/asks.ts";
import { creditBank, seededWorld } from "./helpers.ts";

const KR = { text: "A guest sees the banner on the lab board", howToCheck: "Open the lab as a guest" };
const STEPS = [{ size: "M" as const, title: "Build the banner", description: "Ship the banner PR" }];

describe("migration 105: every grant gets a title from its objective", () => {
  it("back-fills the first clause, parentheses stripped, at most 8 words, no ellipsis, first letter upper: the SQL and grantTitleOf agree", () => {
    const all = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
    const dir = mkdtempSync(join(tmpdir(), "mig-title-"));
    for (const f of readdirSync(all)) if (Number(/^(\d+)/.exec(f)?.[1]) < 105) copyFileSync(join(all, f), join(dir, f));
    const db = new Database(":memory:");
    migrate(db, dir);
    const objectives = {
      gr_long: "make the lab board answer what the lab is for in one look for every guest who opens it, before anything else; then measure it.",
      gr_paren: "Self-host image (path B, the published one) restores from a backup on every green main: CI checks it…",
      gr_short: "A banner.",
    };
    const ins = db.prepare("INSERT INTO grants (id, buildingId, objective, stopCondition, askTokens, status, proposedBy, createdAt, updatedAt) VALUES (?, 'bl', ?, 's', 1000, 'proposed', 'ag', ?, ?)");
    for (const [id, o] of Object.entries(objectives)) ins.run(id, o, nowIso(), nowIso());
    copyFileSync(join(all, "105_grant_title.sql"), join(dir, "105_grant_title.sql"));
    migrate(db, dir);
    const rows = Object.fromEntries((db.prepare("SELECT id, title FROM grants").all() as { id: string; title: string }[]).map((r) => [r.id, r.title]));
    expect(rows).toEqual({
      gr_long: "Make the lab board answer what the lab",
      gr_paren: "Self-host image restores from a backup on every",
      gr_short: "A banner",
    });
    for (const [id, o] of Object.entries(objectives)) expect(grantTitleOf(o)).toBe(rows[id]);
    expect(Object.values(rows).join("")).not.toMatch(/[…()]/);
  });
});

/** A lab whose manager proposes; `propose` makes a proposal (the town's card) and returns the grant. */
function lab() {
  const s = seededWorld();
  const { world, seed } = s;
  const b = createBuilding(world, { name: "Titled", headcount: 3, model: "claude-opus-5-5", cheapModel: "claude-haiku-5-5" }, seed.admin.id);
  const pix = createResident(world, { buildingId: b.id, name: "Pix" });
  updateBuilding(world, b.id, { managerAgentId: pix.id });
  creditBank(world);
  const objective = "Make the lab board answer what the lab is for in one look, for every guest who opens it, before anything else";
  const propose = () => world.grantDesk.propose(null, world.grantDesk.create(null, b.id, { title: "Lab board answers its purpose", keyResults: [KR], objective, steps: STEPS, stopCondition: "s" }).id);
  return { ...s, b, pix, objective, propose };
}

describe("cards name a grant by its title", () => {
  it("the proposal card has no ellipsis, never quotes the objective, and its second line is the first key result", () => {
    const { world, propose, objective } = lab();
    const g = propose();
    expect(g.title).toBe("Lab board answers its purpose");
    const ask = asksFor(world, { kind: "grant", id: g.id })[0]!;
    expect(ask.title).toBe('Fund "Lab board answers its purpose" at 150k');
    expect(ask.body.split("\n")[1]).toBe("A guest sees the banner on the lab board.");
    expect(`${ask.title}\n${ask.body}`).not.toContain("…");
    expect(ask.body).not.toContain(objective.slice(0, 30));
    expect(ask.tags).toEqual([]);
    expect(world.events.list({ types: ["grant.proposed"] }).at(-1)!.text).toBe("Proposal: Lab board answers its purpose (150,000 tokens)");
  });

  it("the gate card's body holds no quote: the forks' top-up line is a claim checked by the checkpoint report", async () => {
    const { world, admin, propose, pix } = lab();
    const g = world.grantDesk.decide(admin, propose().id, { action: "fund" });
    const report = await world.verbs.submit_report(pix, { title: "Checkpoint", body: "## What I did\nx\n## Findings\ny\n## What I need from you\nNothing needed.", verdict: "continue" });
    const buys = "one session merges PR #392 and closes it, so the docs point at the image";
    world.grants.patch(g.id, { topUpTokens: 150_000, whatTopUpBuys: buys, checkpointDocId: report.id });
    world.sessions.upsert({
      id: newId("se"), agentId: pix.id, assignmentId: null, meetingId: null, purpose: "work", backend: "host", status: "done", model: "m",
      sdkSessionId: null, output: 150_000, costUsd: 0, turns: 0, reportId: null, error: null, startedAt: nowIso(), endedAt: nowIso(), funding: null, lane: "grant", grantId: g.id,
    } as never);
    world.grantDesk.checkpoints(g.buildingId);
    const ask = asksFor(world, { kind: "grant", id: g.id }).find((a) => a.status === "open")!;
    expect(ask.title).toBe('"Lab board answers its purpose" is held at its ceiling: adjust or cut it');
    expect(ask.body).not.toContain("merges PR");
    expect(ask.body).not.toContain("The forks say");
    expect(ask.claims).toContainEqual({ text: "The forks say 150,000 more tokens finish it", check: { kind: "manual", ref: report.id } });
  });
});

describe("the retitle repair (boot)", () => {
  it("rewrites a live clipped town card once from its target, keeping its id, sources, rank and status; a card with no target card loses its ellipsis and keeps its words", () => {
    const { world, propose } = lab();
    const g = propose();
    const ask = asksFor(world, { kind: "grant", id: g.id })[0]!;
    setRank(world, ask.id, 2);
    // the card as the town wrote it before migration 105: the objective quoted and clipped
    const old = { title: 'Fund "Make the lab board answer what the lab is for in one look, for every…" at 150,000 tokens', body: `This is a new proposal. You have not decided on it before.\nMake the lab board answer what the lab is for in one look, for every guest who opens it…\n${ask.body.split("\n").slice(2).join("\n")}` };
    world.asks.upsert({ ...world.asks.require(ask.id), ...old });
    // a manager's card (a rollup's typed ask) that carries an ellipsis
    const mgr = createAsk(world, { type: "policy", targetKind: "rule", targetId: "dc_rulebook", buildingId: g.buildingId, sourceDocId: "dc_rollup1", by: "ag_x", title: "Keep the rule on forks…", body: "Rule: forks may redeploy… I applied it twice. Reversing it costs a session.", branches: [{ label: "Keep" }, { label: "Change" }], recommendation: "Keep" }).ask;

    expect(retitleClippedAsks(world)).toBe(2);
    const fixed = world.asks.require(ask.id);
    expect(fixed).toMatchObject({ id: ask.id, status: "open", rank: 2, sources: ask.sources, title: 'Fund "Lab board answers its purpose" at 150k', tags: [] });
    expect(fixed.body).not.toContain("…");
    expect(fixed.body.split("\n")[1]).toBe("A guest sees the banner on the lab board.");
    expect(fixed.history.at(-1)).toMatchObject({ action: "retitled", by: "system" });
    // the manager's card has no target card to rewrite from: its words stay, the ellipsis goes, its first clause is the title
    const kept = world.asks.require(mgr.id);
    expect(kept.title).toBe("Keep the rule on forks");
    expect(kept.title + kept.body + kept.recommendation).not.toContain("\u2026");
    expect(kept).toMatchObject({ id: mgr.id, status: mgr.status, sources: mgr.sources.map((x) => ({ ...x, line: x.line.replace(/\s*\u2026\s*/g, " ").trim() })) });
    expect(kept.history.at(-1)).toMatchObject({ action: "retitled", by: "system" });
    // idempotent: nothing left to rewrite
    expect(retitleClippedAsks(world)).toBe(0);
    expect(world.asks.require(ask.id).history.filter((h) => h.action === "retitled")).toHaveLength(1);
  });
});

describe("migration 107: written titles for the grants still in play", () => {
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "migrations", "107_grant_written_titles.sql"), "utf8");
  const rows = [...sql.matchAll(/UPDATE grants SET title = '((?:[^']|'')*)' WHERE id = '(gr_[a-z0-9]+)' AND title = '((?:[^']|'')*)';/g)]
    .map((m) => ({ title: m[1]!.replace(/''/g, "'"), id: m[2]!, was: m[3]!.replace(/''/g, "'") }));

  it("every title is a whole written name a proposal could carry: 3-8 words, at most 60 characters, no period, ids, parentheses or ellipsis", () => {
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) expect(GrantTitle.safeParse(r.title).success, r.title).toBe(true);
  });

  it("only replaces a title still at its 105 back-fill: a title edited since stays", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE grants (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '')");
    const [a, b] = rows;
    db.prepare("INSERT INTO grants (id, title) VALUES (?, ?), (?, ?)").run(a!.id, a!.was, b!.id, "Edited by its manager");
    db.exec(sql);
    expect(db.prepare("SELECT title FROM grants WHERE id = ?").pluck().get(a!.id)).toBe(a!.title);
    expect(db.prepare("SELECT title FROM grants WHERE id = ?").pluck().get(b!.id)).toBe("Edited by its manager");
  });
});

describe("the grant-ask retitle repair (boot, migration 107)", () => {
  it("a live town-written ask on a grant takes the grant's current title, quoted, and keeps its body; a manager's ask is untouched; idempotent", () => {
    const { world, propose } = lab();
    const g = propose();
    const ask = asksFor(world, { kind: "grant", id: g.id })[0]!;
    // the grant got its written title after its ask was filed (migration 107), and the ask still has the old unquoted form
    world.grants.patch(g.id, { title: "One look says what the lab is for" });
    world.asks.upsert({ ...world.asks.require(ask.id), title: "Fund Lab board answers its purpose at 150k" });
    const mgr = createAsk(world, { type: "money", targetKind: "grant", targetId: "gr_other1234", buildingId: g.buildingId, sourceDocId: "dc_rollup1", by: "ag_x", title: "Fund the other one", body: "b", branches: [{ label: "Fund" }, { label: "Reject" }], recommendation: "Fund" }).ask;
    expect(retitleGrantAsks(world)).toBe(1);
    const fixed = world.asks.require(ask.id);
    expect(fixed).toMatchObject({ id: ask.id, status: "open", body: ask.body, title: 'Fund "One look says what the lab is for" at 150k' });
    expect(fixed.history.at(-1)).toMatchObject({ action: "retitled", by: "system", note: "was: Fund Lab board answers its purpose at 150k" });
    expect(world.asks.require(mgr.id).title).toBe("Fund the other one");
    expect(retitleGrantAsks(world)).toBe(0);
  });
});

describe("the no-ellipsis lint rule", () => {
  it("refuses an ellipsis in an ask's title, body or recommendation", () => {
    expect(lintAskBody("It has spent 474k…", { recommendation: "Cut", branches: [{ label: "A" }, { label: "B" }] })).toEqual(["no-ellipsis: an ellipsis in the body: say it whole or leave it out"]);
    expect(lintAskBody("It has spent 474k.", { title: "Fund the banner…", recommendation: "Cut", branches: [{ label: "A" }, { label: "B" }] })).toEqual(["no-ellipsis: an ellipsis in the title: say it whole or leave it out"]);
    expect(vetAsk("policy", { title: "Keep it", body: "Rule: x. I applied it. Reversing it costs a run.", recommendation: "Keep…", branches: [{ label: "A" }, { label: "B" }] })).toEqual(["no-ellipsis: an ellipsis in the recommendation: say it whole or leave it out"]);
    expect(lintAskBody("It has spent 474k.", { title: "Fund the banner", recommendation: "Cut", branches: [{ label: "A" }, { label: "B" }] })).toEqual([]);
  });
});
