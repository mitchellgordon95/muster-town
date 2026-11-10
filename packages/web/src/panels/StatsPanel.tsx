/**
 * User stats (the Town Hall's stats stand, 1:1 mt_ec2b7x80rg decision 2). First, community engagement in this collective
 * only (Mitchell's flag dc_r7u6bkaei4, GET <prefix>/api/engagement): what its signed-in humans did here and its own join
 * steps, the 30-day total then by day. Counts only, never who. A new count is one entry in ENGAGEMENT_COLUMNS.
 * The root server's collective (the Workshop) also keeps the Muster-Town-wide join funnel (GET /api/join-funnel: homepage,
 * guest card, sign-in, every hosted collective as a row) folded below it; a hosted collective has no such fold. A new
 * funnel step is one entry in COLUMNS.
 * For an admin or a goal captain, a Members table follows (gr_cuobjlny6r): each let-in member with the goals they may
 * direct work under (what opens 1:1s with those goals' managers), a one-click grant of the decider's default goal and a
 * revoke per goal. The server is the gate: GET /api/members is 403 for anyone else.
 */
import { useState, type ReactNode } from "react";
import { api, API_BASE, type EngagementCounts, type EngagementView as Engagement, type JoinFunnelCounts, type JoinFunnelView, type MemberView } from "../api";
import { goalShortName } from "../purpose";
import { useTown } from "../state";
import { letInGoal } from "./letIn";
import { Glyph, PanelShell } from "./PanelShell";
import { Act, Empty, ErrorLine, Loading, Section, timeAgo, useLoad } from "./ui";

/** The steps in funnel order: short column label and what the number is. */
export const COLUMNS: { key: keyof JoinFunnelCounts; label: string; what: string }[] = [
  { key: "homeViews", label: "Home", what: "browsers that opened the homepage (muster.town), each counted once per day" },
  { key: "guestCardViews", label: "Saw card", what: "page loads that showed the signed-out guest card: reloads count again" },
  { key: "guestVisitors", label: "Visitors", what: "browsers that saw the guest card, each counted once per day: the number of strangers at the door" },
  { key: "signInStarted", label: "Pressed Sign in", what: "times Sign in was pressed by a browser with no session, whether or not GitHub was finished" },
  { key: "signIns", label: "Signed in", what: "first sign-ins with GitHub (a GitHub account seen for the first time)" },
  { key: "asked", label: "Asked", what: "requests to join (Ask to join on the guest card)" },
  { key: "letIn", label: "Let in", what: "requests an admin granted: the account became a member" },
  { key: "declined", label: "Declined", what: "requests an admin declined" },
  { key: "acted", label: "Acted", what: "let-in members who then said something or wrote in a 1:1, each counted once" },
];

/** This collective's engagement, in the order a captain reads it: who came and what they did, then who joined. */
export const ENGAGEMENT_COLUMNS: { key: keyof EngagementCounts; label: string; what: string }[] = [
  { key: "humans", label: "Humans", what: "signed-in people who walked, spoke or decided something here (over the 30 days: different people, not the sum of the days)" },
  { key: "spoke", label: "Spoke", what: "lines humans said, told an agent, or spoke in a meeting or 1:1" },
  { key: "oneOnOnes", label: "1:1s", what: "1:1s a human opened with an agent" },
  { key: "flags", label: "Flags", what: "flags humans planted: work asked for on the map" },
  { key: "decisions", label: "Decisions", what: "a human's decisions on reports, flags, grants (fund, counter, reject, continue, adjust, cut, stop), retainers and goal proposals" },
  { key: "asked", label: "Asked", what: "requests to join this collective" },
  { key: "letIn", label: "Let in", what: "requests an admin granted: the account became a member" },
  { key: "declined", label: "Declined", what: "requests an admin declined" },
  { key: "acted", label: "Acted", what: "let-in members who then said something or wrote in a 1:1, each counted once" },
];

/** A wait to decision, short: "40 s", "12 min", "3 h", "2 days". */
export function waitLabel(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 2 * 86_400_000) return `${Math.round(ms / 3_600_000)} h`;
  return `${Math.round(ms / 86_400_000)} days`;
}

/** The days with any count over every collective in the view, newest first (the top level carries no daily rows: they are summed here). */
export function byDay(f: JoinFunnelView): ({ day: string } & JoinFunnelCounts)[] {
  const m = new Map<string, { day: string } & JoinFunnelCounts>();
  for (const c of f.collectives) for (const d of c.daily) {
    const row = m.get(d.day) ?? { day: d.day, homeViews: 0, guestCardViews: 0, guestVisitors: 0, signInStarted: 0, signIns: 0, asked: 0, letIn: 0, declined: 0, acted: 0 };
    for (const col of COLUMNS) row[col.key] += d[col.key] ?? 0;
    m.set(d.day, row);
  }
  return [...m.values()].sort((a, b) => b.day.localeCompare(a.day));
}

/** A UTC day "2026-10-31" as "Oct 31" (the year is in the range line above). */
const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const median = (ms: number | null) => ms == null ? "none yet" : waitLabel(ms);
const n = (x: number) => x.toLocaleString("en-US");

type Column<K extends string> = { key: K; label: string; what: string };
function CountsTable<K extends string>({ first, rows, cols }: { first: string; rows: { key: string; head: ReactNode; counts: Record<K, number>; wait?: number | null }[]; cols: Column<K>[] }) {
  const wait = rows.some((r) => r.wait !== undefined);
  return (
    <div className="stats-scroll"><table className="table stats-table">
      <thead><tr><th>{first}</th>{cols.map((c) => <th key={c.key} className="num" title={c.what}>{c.label}</th>)}{wait ? <th className="num" title="Median wait from asking to an admin's decision">Wait</th> : null}</tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>{r.head}</td>
            {cols.map((c) => <td key={c.key} className="num">{r.counts[c.key] ? n(r.counts[c.key]) : <span className="faint">0</span>}</td>)}
            {wait ? <td className="num">{r.wait == null ? <span className="faint">–</span> : waitLabel(r.wait)}</td> : null}
          </tr>
        ))}
      </tbody>
    </table></div>
  );
}

export function StatsView({ f }: { f: JoinFunnelView }) {
  const days = byDay(f);
  const many = f.collectives.length > 1;
  return (
    <>
      <Section title={`Last ${f.days} days`} right={<a className="link" href={`${API_BASE}/api/join-funnel`} target="_blank" rel="noreferrer">JSON</a>}>
        <div className="stats-totals">
          {COLUMNS.map((c) => (
            <div key={c.key} className="stats-total" title={c.what}><b>{n(f.totals[c.key])}</b><span>{c.label}</span></div>
          ))}
          <div className="stats-total" title="Median wait from asking to an admin's decision, over the decided requests"><b>{median(f.medianDecisionMs)}</b><span>Typical wait</span></div>
        </div>
        <div className="muted">
          {f.from} to {f.to} (UTC days), {API_BASE ? "this collective" : many ? "every collective on this server" : "this collective"}. {f.decisions} {f.decisions === 1 ? "request" : "requests"} decided.
        </div>
      </Section>
      <Section title="By day">
        {days.length ? <CountsTable cols={COLUMNS} first="Day (UTC)" rows={days.map((d) => ({ key: d.day, head: <span title={d.day}>{dayLabel(d.day)}</span>, counts: d }))} /> : <Empty>Nothing counted in the last {f.days} days.</Empty>}
      </Section>
      {many ? (
        <Section title="Per collective">
          <CountsTable cols={COLUMNS} first="Collective" rows={f.collectives.map((c) => ({ key: c.slug, head: <a className="link" href={`/${c.slug}/`}>{c.slug}</a>, counts: c.totals, wait: c.medianDecisionMs }))} />
        </Section>
      ) : null}
      <Section title="What the numbers are">
        <dl className="kv">
          {COLUMNS.map((c) => <div key={c.key}><dt>{c.label}</dt><dd>{c.what}.</dd></div>)}
          <div><dt>Typical wait</dt><dd>the median time from asking to join to an admin letting the account in or declining it.</dd></div>
        </dl>
        <div className="muted">Counts only: no login or account id is kept for these numbers. Each day is a UTC day. A browser counts once per day by a random id it keeps itself; headless browsers and command-line tools (our own checks) are not counted.</div>
      </Section>
    </>
  );
}

/** Community engagement in this collective only: the 30-day totals, then by day, then what each number is. */
export function EngagementView({ e }: { e: Engagement }) {
  const days = [...e.daily].reverse();
  return (
    <>
      <Section title={`This collective, last ${e.days} days`} right={<a className="link" href={`${API_BASE}/api/engagement`} target="_blank" rel="noreferrer">JSON</a>}>
        <div className="stats-totals">
          {ENGAGEMENT_COLUMNS.map((c) => (
            <div key={c.key} className="stats-total" title={c.what}><b>{n(e.totals[c.key])}</b><span>{c.label}</span></div>
          ))}
          <div className="stats-total" title="Median wait from asking to join to an admin's decision"><b>{median(e.medianDecisionMs)}</b><span>Typical wait</span></div>
        </div>
        <div className="muted">{e.from} to {e.to} (UTC days), in this collective only.</div>
      </Section>
      <Section title="By day">
        {days.length ? <CountsTable cols={ENGAGEMENT_COLUMNS} first="Day (UTC)" rows={days.map((d) => ({ key: d.day, head: <span title={d.day}>{dayLabel(d.day)}</span>, counts: d }))} /> : <Empty>No human did anything here in the last {e.days} days.</Empty>}
      </Section>
      <Section title="What the numbers are">
        <dl className="kv">
          {ENGAGEMENT_COLUMNS.map((c) => <div key={c.key}><dt>{c.label}</dt><dd>{c.what}.</dd></div>)}
          <div><dt>Typical wait</dt><dd>the median time from asking to join to an admin letting the account in or declining it.</dd></div>
        </dl>
        <div className="muted">Counts only: the answer names nobody. Agents' own work is not counted here; a human who only watches leaves no count.</div>
      </Section>
    </>
  );
}

/** The root server's Muster-Town-wide join funnel (every collective), folded: loaded only when opened. */
function MusterTownFunnel() {
  const f = useLoad(() => api().joinFunnel(), []);
  return (
    <>
      <ErrorLine error={f.error} />
      {f.loading && !f.data ? <Loading /> : f.data ? <StatsView f={f.data} /> : null}
    </>
  );
}

/**
 * The let-in members and the goals each may direct work under. `goal` is the one the Grant button gives (the viewer's
 * default, as the Let in card's second button, named once above the table so the button stays short on a phone); null = the viewer
 * can't grant. Each held goal has its own Revoke.
 */
export function MembersTable({ members, goal, onGrant, onRevoke }: { members: MemberView[]; goal: { id: string; text: string; short: string } | null; onGrant: (userId: string, goalId: string) => Promise<unknown>; onRevoke: (userId: string, goalId: string) => Promise<unknown> }) {
  if (!members.length) return <Empty>Nobody has been let in yet.</Empty>;
  return (
    <>{goal ? <div className="muted">Grant gives direct work under “{goal.short}”.</div> : null}
    <div className="stats-scroll"><table className="table stats-table members-table">
      <thead><tr><th>Member</th><th title="When an admin let them in">Let in</th><th title="The goals they may direct work under: a 1:1 or meeting with a manager of a building under one of them">Direct work under</th></tr></thead>
      <tbody>
        {members.map((m) => {
          const who = m.githubLogin ? `@${m.githubLogin}` : m.name;
          const holds = goal ? m.direct.some((d) => d.goalId === goal.id) : true;
          return (
            <tr key={m.userId}>
              <td title={m.name}>{m.avatarUrl ? <img className="member-avatar" src={m.avatarUrl} alt="" /> : null}{who}</td>
              <td title={m.letInAt ?? "not through a join request"}>{m.letInAt ? timeAgo(m.letInAt) : <span className="faint">–</span>}</td>
              <td><div className="member-direct">
                {m.direct.length ? m.direct.map((d) => (
                  <span key={d.goalId} className="member-goal" title={d.text}>
                    {goalShortName(d.text)}
                    <Act small run={() => onRevoke(m.userId, d.goalId)} title={`${who} may no longer direct work under "${goalShortName(d.text)}"`}>Revoke</Act>
                  </span>
                )) : <span className="faint">none</span>}
                {goal && !holds ? <Act small tone="primary" run={() => onGrant(m.userId, goal.id)} title={`${who} may then open a 1:1 with a manager under "${goal.text}"`}>Grant</Act> : null}
              </div></td>
            </tr>
          );
        })}
      </tbody>
    </table></div></>
  );
}

function MembersSection() {
  const m = useLoad(() => api().members(), []);
  const goal = letInGoal();
  return (
    <Section title="Members" right={m.data ? <span className="muted">{m.data.length}</span> : null}>
      <ErrorLine error={m.error} />
      {m.loading && !m.data ? <Loading /> : m.data ? (
        <MembersTable members={m.data} goal={goal}
          onGrant={async (userId, goalId) => { await api().grantDirect(userId, goalId); m.reload(); }}
          onRevoke={async (userId, goalId) => { await api().revokeDirect(userId, goalId); m.reload(); }} />
      ) : null}
      <div className="muted">Direct work under a goal is what opens a 1:1 with a manager of a building under it; Let in + direct work gives it at the door.</div>
    </Section>
  );
}

export function StatsPanel() {
  const e = useLoad(() => api().engagement(), []);
  const [funnel, setFunnel] = useState(false);
  // the server's gate for GET /api/members: an admin or any goal's captain
  const seesMembers = useTown((s) => !!s.me?.isAdmin || !!s.me?.direct?.some((d) => d.how === "captain"));
  return (
    <PanelShell icon={<Glyph kind="stats" />} title="User stats" subtitle="Community engagement in this collective: who came, spoke, steered and joined">
      <ErrorLine error={e.error} />
      {e.loading && !e.data ? <Loading /> : e.data ? <EngagementView e={e.data} /> : null}
      {/* the root server's collective only: Muster Town's own funnel, every collective on this server */}
      {API_BASE ? null : (
        <details className="grant-fold" onToggle={(ev) => setFunnel(ev.currentTarget.open)}>
          <summary>Muster Town join funnel (every collective on muster.town)</summary>
          {funnel ? <MusterTownFunnel /> : null}
        </details>
      )}
      {seesMembers ? <MembersSection /> : null}
    </PanelShell>
  );
}
