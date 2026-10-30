/**
 * The town map's side bar (Mitchell, town hall mt_xywhisvdcm decision 12; docs/goals.md "The map is the tree"): select a
 * building on the town map and what it is attached to shows here (Change… opens its Settings: the map is drawn from the
 * goal tree, so attaching it elsewhere moves it), then its budget (spend today against the daily cap, funded and held
 * grants) and stats (agents and forks, assignments running / queued / scheduled, the live build).
 */
import { ROOT_GOAL_ID, type SnapshotBuilding } from "@muster-town/schema";
import { api } from "../api";
import { townPlan } from "../map/townPlan";
import { store, useTown } from "../state";
import { Meter } from "./AgentPanel";
import { goalPath, useGoalTree } from "./GoalPicker";
import { useGoalData } from "./GoalsTab";
import { grantGroups, grantSpendLine } from "./keyResults";
import { Glyph } from "./PanelShell";
import { ADJ, ErrorLine, KV, Loading, Pill, Section, fmtTokens, timeAgo, useLoad } from "./ui";

export function PlanSideBar({ id }: { id: string }) {
  const b = useTown((s) => s.buildings.find((x) => x.id === id));
  if (!b) return null;
  const lab = b.kind !== "town-hall";
  return (
    <>
      <header className="panel-head">
        <div className="panel-icon"><Glyph kind="building" /></div>
        <div className="who">
          <div className="who-title">{b.name}</div>
          <div className="who-sub">{lab ? "Lab" : "Town Hall"} · selected on the town map</div>
        </div>
        <button className="close" title="Deselect" aria-label="Deselect" onClick={() => townPlan.select(null)}>×</button>
      </header>
      <div className="panel-body">
        {b.goal ? <div className="goal-card"><span>Goal</span>{b.goal}</div> : null}
        <AttachedLine b={b} />
        {lab ? <PlanBudget b={b} /> : null}
        <PlanStats b={b} />
      </div>
    </>
  );
}

/** "Attached to: [goal path] · Change…" (Change… opens the building's Settings, where the attachment and Desks are set). */
function AttachedLine({ b }: { b: SnapshotBuilding }) {
  const root = useGoalTree();
  const lab = b.kind !== "town-hall";
  return (
    <Section title="Attached to">
      <p className="direction">
        {goalPath(root, lab ? b.goalId ?? ROOT_GOAL_ID : ROOT_GOAL_ID)}
        {lab && store.can("building.manage", b.id) ? <> · <button className="link" onClick={() => { townPlan.cancel(); store.open({ kind: "building", id: b.id, tab: "Settings" }); }}>Change…</button></> : null}
      </p>
    </Section>
  );
}

/** Spend today against the family's daily cap (dailyTokensPerAgent × desks), what's left to draw, the funded and held grants. */
function PlanBudget({ b }: { b: SnapshotBuilding }) {
  const { grants } = useGoalData(b.id);
  const { funded, settled } = grantGroups(grants.data ?? []);
  const held = settled.filter((g) => g.status === "checkpoint");
  const cap = b.dailyTokensPerAgent * b.headcount, today = b.budget?.tokensToday ?? 0;
  const row = (g: (typeof funded)[number]) => (
    <div key={g.id} className="doc-row">
      <b>{g.objective || g.id}</b>
      <div className="doc-row-meta"><span>{g.status === "checkpoint" ? <Pill tone="warn">held</Pill> : <Pill tone="ok">funded</Pill>}</span><span>{grantSpendLine(g)}</span></div>
    </div>
  );
  return (
    <Section title="Budget">
      <KV items={[
        ["Today", <><b>{fmtTokens(today)}</b> of {fmtTokens(cap)} {ADJ} <Meter v={cap ? today / cap : 0} /></>],
        ["Left to draw", b.budget ? `${fmtTokens(b.budget.remainingTokens)} ${ADJ}` : "—"],
        ["All-time", b.budget ? `${fmtTokens(b.budget.tokensAllTime)} ${ADJ}` : "—"],
      ]} />
      {grants.loading && !grants.data ? <Loading /> : null}
      <ErrorLine error={grants.error} />
      {funded.length || held.length ? <div className="doc-list">{[...funded, ...held].map(row)}</div> : grants.data ? <div className="muted">No funded or held grants.</div> : null}
    </Section>
  );
}

/** Its agents and forks, its assignments, the live build (GET /api/buildings/:id/stats). */
function PlanStats({ b }: { b: SnapshotBuilding }) {
  const rev = useTown((s) => s.rev);
  const stats = useLoad(() => api().buildingStats(b.id), [b.id, rev]);
  const s = stats.data;
  return (
    <Section title="Stats">
      <ErrorLine error={stats.error} />
      {!s ? (stats.loading ? <Loading /> : null) : (
        <KV items={[
          ["Agents", <>{s.agents} named · {s.forks} fork{s.forks === 1 ? "" : "s"} · {s.working} working</>],
          ["Assignments", <>{s.assignments.running} running · {s.assignments.queued} queued{s.assignments.blocked ? ` (${s.assignments.blocked} blocked)` : ""} · {s.assignments.scheduled} scheduled</>],
          ["Live build", <>{s.host.commit ? <code>{s.host.commit.slice(0, 7)}</code> : "unknown"}{s.host.startedAt ? <> · redeployed {timeAgo(s.host.startedAt)}</> : null}</>],
        ]} />
      )}
    </Section>
  );
}
