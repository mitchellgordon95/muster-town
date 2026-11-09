/**
 * The feed and closed loops (docs/legible-delegation.md §8, UI / UX D). The feed: every notice, newest first, filtered
 * by building, goal and kind, pictures inline; nothing to decide. Closed loops: the human's past decisions paying off,
 * shown beside the asks in the Town Hall in-tray.
 */
import { useState } from "react";
import { NoticeKind, type Notice } from "@muster-town/schema";
import { api, API_BASE } from "../api";
import { useTown } from "../state";
import { Markdown } from "./Markdown";
import { Empty, ErrorLine, Loading, Pill, timeAgo, useLoad } from "./ui";

const KIND_WORD: Record<NoticeKind, string> = { shipped: "shipped", "closed-loop": "closed loop", verified: "verified", slate: "slate", pattern: "pattern", gate: "on budget" };

/** A notice's picture as an img src: an mf_ media id is served at /api/media/<id>; anything else is a src already. */
export function pictureSrc(p: string | null): string | null {
  if (!p) return null;
  return /^mf_[a-z0-9]{10}$/.test(p) ? `${API_BASE}/api/media/${p}` : p;
}

function NoticeItem({ n }: { n: Notice }) {
  const building = useTown((s) => s.buildings.find((b) => b.id === n.buildingId)?.name ?? null);
  const src = pictureSrc(n.picture);
  return (
    <article className={`notice notice-${n.kind}`}>
      <div className="notice-head"><Pill tone={n.kind === "closed-loop" || n.kind === "verified" ? "ok" : ""}>{KIND_WORD[n.kind]}</Pill>{building ? <span className="notice-building">{building}</span> : null}<span className="muted">{timeAgo(n.createdAt)}</span></div>
      <div className="notice-title">{n.title}</div>
      {n.body ? <Markdown text={n.body} className="notice-body" /> : null}
      {src ? <img className="notice-picture" src={src} alt={n.title} loading="lazy" /> : null}
    </article>
  );
}

/** The closed loops beside the asks: the newest few, or nothing. */
export function ClosedLoops({ notices, max = 3 }: { notices: Notice[]; max?: number }) {
  const loops = notices.filter((n) => n.kind === "closed-loop").sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, max);
  if (!loops.length) return null;
  return (
    <section className="closed-loops" aria-label="Closed loops">
      <div className="closed-loops-head">Your decisions paying off</div>
      {loops.map((n) => <NoticeItem key={n.id} n={n} />)}
    </section>
  );
}

/** The feed with its filters; the server filters (GET /api/notices). */
export function NoticesFeed() {
  const buildings = useTown((s) => s.buildings);
  const places = useTown((s) => s.places);
  const [building, setBuilding] = useState("");
  const [goal, setGoal] = useState("");
  const [kind, setKind] = useState<NoticeKind | "">("");
  const feed = useLoad(() => api().notices({ building: building || undefined, goal: goal || undefined, kind: kind || undefined, limit: 100 }), [building, goal, kind]);
  // the goals the map draws (a plaza per goal) name the goal filter's options
  const goals = places.filter((p) => p.id.startsWith("plaza:")).map((p) => ({ id: p.id.slice("plaza:".length), name: p.name }));
  return (
    <div className="notices-feed">
      <div className="notices-filters actions">
        <select aria-label="Building" value={building} onChange={(e) => setBuilding(e.target.value)}>
          <option value="">Every building</option>
          {buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <select aria-label="Goal" value={goal} onChange={(e) => setGoal(e.target.value)}>
          <option value="">Every goal</option>
          {goals.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as NoticeKind | "")}>
          <option value="">Every kind</option>
          {NoticeKind.options.map((k) => <option key={k} value={k}>{KIND_WORD[k]}</option>)}
        </select>
      </div>
      <ErrorLine error={feed.error} />
      {feed.loading && !feed.data ? <Loading /> : !feed.data?.length ? <Empty>Nothing in the feed{building || goal || kind ? " for this filter" : " yet"}. What shipped, closed or was verified flows here.</Empty> : (
        <div className="notices-list">{feed.data.map((n) => <NoticeItem key={n.id} n={n} />)}</div>
      )}
    </div>
  );
}
