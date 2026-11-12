/**
 * Notices (docs/legible-delegation.md §8, build step 5): a state change with nothing to do, stored as a row of
 * `notices` (migration 102) and listed newest first (`GET /api/notices`, and the latest 20 beside the asks in the Town
 * Hall in-tray). Written in code where the change happens: a grant's close (one `shipped` notice per item its manager names: its
 * "What you'd see" line and picture), a funded grant closed as done (`closed-loop`: funded on, for, closed at, what it
 * bought), a key result a human marked met (`verified`), and the Secretary's runs (`slate`, `pattern`; secretary.ts).
 * `gate` is a grant's step gate: a step report whose forecast is within the ceiling (`fileForecast`, grant-forecast.ts;
 * past it the gate is a money ask instead). Nothing here asks or decides anything.
 */
import { grantName, NoticeKind, Notice, type Grant, type KeyResult } from "@muster-town/schema";
import { badRequest } from "./errors.ts";
import { utcDate } from "./time.ts";
import { newId, nowIso } from "./util.ts";
import type { World } from "./world.ts";

const fmt = (n: number) => n.toLocaleString("en-US");
const oneLine = (s: string, max = 400) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
const MEDIA = /^\/api\/media\/(mf_[a-z0-9]+)(?:\.[a-z0-9]+)?$/;
/** A picture's media id when it is an upload (`/api/media/mf_….png`), else its src as given; null when none. */
const pictureOf = (src: string | undefined) => (src ? MEDIA.exec(src)?.[1] ?? src : null);

/** File a notice and log `notice.filed`. */
export function fileNotice(world: World, n: Omit<Notice, "id" | "createdAt"> & { createdAt?: string }): Notice {
  const notice = world.notices.upsert(Notice.parse({ ...n, id: newId("nt"), createdAt: n.createdAt ?? nowIso() }));
  world.events.append({ type: "notice.filed", buildingId: notice.buildingId, text: `Notice (${notice.kind}): ${oneLine(notice.title, 140)}`, payload: { noticeId: notice.id, kind: notice.kind, refs: notice.refs } });
  return notice;
}

/** `GET /api/notices`: newest first, filtered by building, goal and kind; at most `limit` (default 50, at most 200). */
export function listNotices(world: World, f: { building?: string; goal?: string; kind?: string; limit?: number } = {}): Notice[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.building) { where.push("buildingId = ?"); args.push(f.building); }
  if (f.goal) { where.push("goalId = ?"); args.push(f.goal); }
  if (f.kind) {
    const k = NoticeKind.safeParse(f.kind);
    if (!k.success) throw badRequest(`kind: one of ${NoticeKind.options.join(", ")}.`);
    where.push("kind = ?"); args.push(k.data);
  }
  const limit = Math.min(200, Math.max(1, Math.floor(f.limit ?? 50)));
  return world.notices.where(where.length ? where.join(" AND ") : "1 = 1", args, `ORDER BY createdAt DESC, rowid DESC LIMIT ${limit}`);
}

/** Notices about one id (a grant, a key result) of one kind. */
const noticesOn = (world: World, kind: Notice["kind"], id: string) => world.notices.where("kind = ? AND refs LIKE ?", [kind, `%"${id}"%`]);

const goalOfBuilding = (world: World, id: string | null) => (id ? world.buildings.get(id)?.goalId ?? null : null);

/** What a grant shipped, as its manager says it when closing (`close_grant` shipped): a title, what a human would see, an optional picture. */
export interface ShippedItem { title: string; whatYoudSee: string; picture?: string | null }

/**
 * What a closed grant shipped, one `shipped` notice per item (refs: the grant). Plan dc_uwx045472m step 7: shipped
 * notices come from the close, not from a rollup. Filed once per grant: a second close call adds none.
 */
export function shippedAtClose(world: World, g: Grant, items: ShippedItem[]): Notice[] {
  if (!items.length || noticesOn(world, "shipped", g.id).length) return [];
  const goalId = g.goalId ?? goalOfBuilding(world, g.buildingId);
  return items.map((it) => fileNotice(world, {
    kind: "shipped", buildingId: g.buildingId, goalId, title: oneLine(it.title, 200), body: oneLine(it.whatYoudSee), picture: pictureOf(it.picture ?? undefined), refs: [g.id],
  }));
}

/**
 * A funded grant closed as done: "You funded this on <date> for <N>. It closed <date> at <M>. Here is what it bought",
 * then what it shipped (its `shipped` notices, filed at the close) with their "what you'd see" lines; the first picture.
 * One per grant: called again it rewrites the same notice.
 */
export function closedLoopNotice(world: World, g: Grant, spentTokens: number): Notice | null {
  if (!g.fundedAt || g.status !== "closed" || g.outcome !== "done") return null;
  const items = noticesOn(world, "shipped", g.id);
  const bought = items.length ? items.map((it) => `- ${oneLine(it.title, 160)}: ${oneLine(it.body, 300)}`).join("\n") : "Its manager named nothing shipped at the close; its thread (the grant page) has each step's report.";
  const body = `You funded this on ${utcDate(g.fundedAt)} for ${fmt(g.grantTokens ?? 0)} tokens. It closed ${utcDate(g.closedAt ?? nowIso())} at ${fmt(spentTokens)}. Here is what it bought:\n\n${bought}`;
  const fields = { kind: "closed-loop" as const, buildingId: g.buildingId, goalId: g.goalId ?? goalOfBuilding(world, g.buildingId), title: grantName(g), body, picture: items.find((it) => it.picture)?.picture ?? null, refs: [g.id] };
  const had = noticesOn(world, "closed-loop", g.id)[0];
  if (had) return world.notices.upsert({ ...had, ...fields });
  return fileNotice(world, fields);
}

/** A key result a human (or a passed check) verified met: its text, who and the note. */
export function verifiedNotice(world: World, kr: KeyResult, by: string): Notice {
  return fileNotice(world, {
    kind: "verified", buildingId: kr.buildingId, goalId: kr.goalId, title: oneLine(kr.text, 200),
    body: `${by} verified it met${kr.statusNote ? `: ${oneLine(kr.statusNote, 300)}` : "."}${kr.howToCheck ? `\n\nHow to check: ${oneLine(kr.howToCheck, 300)}` : ""}`,
    picture: null, refs: [kr.id, ...(kr.grantId ? [kr.grantId] : [])],
  });
}
