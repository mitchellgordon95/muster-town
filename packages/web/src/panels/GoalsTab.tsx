/**
 * The building panel's goal tabs (Mitchell, 1:1 mt_auczm6f1j1): Goals (the building's subtree of the one goal tree: each
 * goal with the grants filed on it and their key results, drawn with the goal tree's own key-result lines; humans mark
 * met / missed in place, and "Edit" opens the key-result editor) and Grants (every grant of the building, decided in the
 * decision queue). The board is notes only.
 */
import { useDraft } from "../draft";
import { clipText } from "./showMore";
import { useState, type ReactNode } from "react";
import { ROOT_GOAL_ID, grantName, type GoalTreeNode, type GrantView, type KeyResultStatus, type SnapshotBuilding } from "@muster-town/schema";
import { api, type GoalKeyResult, type SpendNode } from "../api";
import { store, useTown } from "../state";
import { Act, ADJ, Empty, ErrorLine, Loading, Pill, Section, fmtTokens, timeAgo, useLoad } from "./ui";
import { UNBLOCK_LINE, blockedLabel, goalsSummary, grantGroups, grantSpendLine, grantSteps, grantsSummary, krAuthorLine, krStatusLabel, krTone, onTree, settableStatuses, spentShare, subtreeGoals, subtreeKrs } from "./keyResults";
import { openDocLink } from "./Markdown";
import { KrLines } from "./GoalTreePanel";
import { findGoal, isArchived } from "./goalTree";

/** The building's key results and grants, reloaded on every town change. */
export function useGoalData(buildingId: string) {
  const rev = useTown((s) => s.rev);
  const tree = useLoad(() => api().keyResults(buildingId), [buildingId, rev]);
  const grants = useLoad(() => api().grants(buildingId), [buildingId, rev]);
  return { tree, grants };
}

/** The building's subtree of the one goal tree (its attachment and every goal under it) and every grant filed on it, any building's. */
export function useSubtree(b: SnapshotBuilding) {
  const rev = useTown((s) => s.rev);
  const goals = useLoad(() => api().goalTree(), [rev]);
  const grants = useLoad(() => api().subtreeGrants(b.id), [b.id, rev]);
  const node = goals.data ? findGoal(goals.data, b.goalId ?? ROOT_GOAL_ID) : null;
  return { goals, grants, node };
}

const openTab = (id: string, tab: "Goals" | "Grants") => store.open({ kind: "building", id, tab });

/** The Overview's two lines, each opening its tab: the Goals line counts the subtree (goals, funded grants, key results met). */
export function GoalTabsSummary({ b }: { b: SnapshotBuilding }) {
  const { tree, grants } = useGoalData(b.id);
  const sub = useSubtree(b);
  const goals = sub.node && sub.grants.data && tree.data ? goalsSummary(subtreeGoals(sub.node).length, sub.grants.data, tree.data.keyResults) : "…";
  return (
    <div className="goal-tabs-summary">
      <button className="link" onClick={() => openTab(b.id, "Goals")}><b>Goals:</b> {goals} →</button>
      <button className="link" onClick={() => openTab(b.id, "Grants")}><b>Grants:</b> {grants.data ? grantsSummary(grants.data) : "…"} →</button>
    </div>
  );
}

type KrActions = ((k: GoalKeyResult) => ReactNode) | undefined;

/** Goals tab: the building's subtree, goal by goal (read), or the key-result editor (Edit, building.manage). */
export function GoalsTab({ b }: { b: SnapshotBuilding }) {
  useTown((s) => s.me);
  const canManage = store.can("building.manage", b.id);
  const canFund = store.can("building.fund", b.id);
  const [editing, setEditing] = useState(false);
  const { tree } = useGoalData(b.id);
  const sub = useSubtree(b);
  const atHall = <button className="link" title="The town goal tree: goals, key results and proposals" onClick={() => store.open({ kind: "goals", id: b.goalId ?? undefined })}>Goal tree at the Town Hall →</button>;
  const toggle = canManage ? <span className="goal-actions">{atHall}<button className="link" onClick={() => setEditing(!editing)}>{editing ? "Done editing" : "Edit"}</button></span> : atHall;
  if (editing) return <KeyResultsEditor b={b} right={toggle} />;
  const grants = (sub.grants.data ?? []).filter(onTree);
  const krs = subtreeKrs(tree.data?.keyResults ?? [], sub.grants.data ?? []);
  const mark = (k: GoalKeyResult, status: KeyResultStatus) => async () => {
    // missed asks why: the line is filed as the human's note and queues one postmortem (docs/goals.md "Postmortems on missed KRs")
    const why = status === "missed" ? window.prompt(`Why was "${clipText(k.text, 60).head}" missed? One line: it queues a postmortem on the building.`)?.trim() : "";
    if (status === "missed" ? !why : !window.confirm(`Mark "${clipText(k.text, 60).head}" ${status}?`)) return;
    await api().updateKeyResult(k.id, { status, note: why ?? "" });
    store.toast(`Key result ${status}`, "ok");
    tree.reload();
  };
  const actions: KrActions = canFund ? (k) => isArchived(k) ? null : (
    <span className="goal-kr-acts">
      <Act small tone="ok" run={mark(k, "met")} title="A human marks it met: it archives under its goal">Met</Act>
      <Act small tone="warn" run={mark(k, "missed")} title="A human marks it missed: it archives under its goal and a postmortem is queued">Missed</Act>
    </span>
  ) : undefined;
  const loading = (!sub.node && !sub.goals.error) || (!tree.data && !tree.error) || (!sub.grants.data && !sub.grants.error);
  return (
    <Section title="Goals" right={toggle}>
      {blockedLabel(b) ? <div className="kr-blocked"><Pill tone="bad">{blockedLabel(b)}</Pill> {UNBLOCK_LINE}</div> : null}
      {loading ? <Loading /> : null}
      <ErrorLine error={sub.goals.error ?? sub.grants.error ?? tree.error} />
      {!loading && sub.node ? <SubtreeGoal node={sub.node} grants={grants} krs={krs} actions={actions} /> : null}
    </Section>
  );
}

/** One goal of the subtree: its words (opening the goal tree there), its grants with their key results, then the goals under it. */
function SubtreeGoal({ node, grants, krs, actions }: { node: GoalTreeNode; grants: GrantView[]; krs: GoalKeyResult[]; actions: KrActions }) {
  const here = grants.filter((g) => g.goalId === node.id);
  const ids = new Set(here.map((g) => g.id));
  const live = here.filter((g) => g.status !== "closed"), closed = here.filter((g) => g.status === "closed");
  // a goal's history: key results written on it before they belonged to grants (no grant on the tree)
  const loose = krs.filter((k) => k.goalId === node.id && !(k.grantId && ids.has(k.grantId)));
  const grant = (g: GrantView) => <SubtreeGrant key={g.id} g={g} krs={krs.filter((k) => k.grantId === g.id)} actions={actions} />;
  return (
    <div className="bt-goal">
      <button className="link bt-goal-text" title="Open it in the goal tree" onClick={() => store.open({ kind: "goals", id: node.id })}>{node.text}</button>
      {live.map(grant)}
      {loose.length ? <KrLines krs={loose} actions={actions} /> : null}
      {closed.length ? <details className="grant-fold settled-fold"><summary><b>Closed</b>{closed.length} grant{closed.length === 1 ? "" : "s"}</summary>{closed.map(grant)}</details> : null}
      {!here.length && !loose.length ? <div className="muted bt-none">No grant under it</div> : null}
      {node.children.length ? <div className="bt-goal-children">{node.children.map((c) => <SubtreeGoal key={c.id} node={c} grants={grants} krs={krs} actions={actions} />)}</div> : null}
    </div>
  );
}

/** A grant under its goal: its name (opens the grant), its status, and its key results as the goal tree draws them. */
function SubtreeGrant({ g, krs, actions }: { g: GrantView; krs: GoalKeyResult[]; actions: KrActions }) {
  return (
    <div className="bt-grant">
      <div className="kr-grant-head">
        <button className="link doc-row-title" title={`Open grant ${g.id}: ${g.objective}`} onClick={() => store.open({ kind: "grant", id: g.id })}>{clipText(grantName(g), GRANT_ROW).head}</button>
        <Pill tone={grantTone(g)}>{g.status}</Pill>
      </div>
      {krs.length ? <KrLines krs={krs} actions={actions} /> : <div className="muted bt-none">No key results</div>}
    </div>
  );
}

const grantTone = (g: GrantView) => g.status === "checkpoint" || g.status === "proposed" ? "warn" : g.status === "funded" ? "ok" : g.status === "rejected" ? "bad" : "";

/** Grants tab: open proposals, then funded grants, then checkpoint / closed. Fund, counter and reject stay in the decision queue. */
export function GrantsTab({ b }: { b: SnapshotBuilding }) {
  const { grants } = useGoalData(b.id);
  const spend = useLoad(() => api().financeSpend(), [b.id]);
  const { proposals, funded, settled } = grantGroups(grants.data ?? []);
  const held = settled.filter((g) => g.status === "checkpoint"), closed = settled.filter((g) => g.status !== "checkpoint");
  const hall = useTown((s) => s.buildings.find((x) => x.kind === "town-hall"));
  const decideLink = hall ? <button className="link" onClick={() => store.open({ kind: "queue" })}>Decide in the Town Hall →</button> : undefined;
  const rows = (list: GrantView[]) => <div className="doc-list">{list.map((g) => <GrantTabRow key={g.id} g={g} steps={grantSteps(spend.data, b.id, g.id)} />)}</div>;
  return (
    <>
      {grants.loading && !grants.data ? <Loading /> : null}
      <ErrorLine error={grants.error} />
      {grants.data && !grants.data.length ? <Empty>No grants or proposals yet. The manager proposes one per key result; humans fund it in the decision queue at the Town Hall.</Empty> : null}
      {/* the grants waiting on a human link to the in-tray once per section, not once per row (gr_zak30564zh step 5) */}
      {proposals.length ? <Section title={<>Open proposals <Pill>{proposals.length}</Pill></>} right={decideLink}>{rows(proposals)}</Section> : null}
      {funded.length ? <Section title={<>Funded <Pill>{funded.length}</Pill></>}>{rows(funded)}</Section> : null}
      {held.length ? <Section title={<>At checkpoint <Pill>{held.length}</Pill></>} right={proposals.length ? undefined : decideLink}>{rows(held)}</Section> : null}
      {/* closed grants are history: folded to their count, one click away (gr_zak30564zh step 4) */}
      {closed.length ? <details className="grant-fold settled-fold"><summary><b>Closed</b>{closed.length} grant{closed.length === 1 ? "" : "s"}</summary>{rows(closed)}</details> : null}
    </>
  );
}

function grantStatusLine(g: GrantView): ReactNode {
  switch (g.status) {
    case "proposed": return `Asks ${fmtTokens(g.askTokens)} ${ADJ} · proposed ${timeAgo(g.createdAt)}`;
    case "countered": return `Countered: the manager revises it and proposes again · asks ${fmtTokens(g.askTokens)} ${ADJ}`;
    case "closed": return `Closed${g.outcome ? `: ${g.outcome}` : ""}${g.closedAt ? ` ${timeAgo(g.closedAt)}` : ""} · spent ${grantSpendLine(g)}`;
    case "stopping": return `Stopping: a human stopped it; it closes as stopped once its forks have filed their reports · spent ${grantSpendLine(g)}`;
    case "rejected": return `Rejected · asked ${fmtTokens(g.askTokens)} ${ADJ}`;
    default: return null;
  }
}

/** Characters of a grant's objective on its Grants-tab row (about one line; the grant's page has it whole). */
const GRANT_ROW = 84;

/** One grant: objective (opens the grant), status, spend, its key result, its steps as one line (the in-tray link sits on its section). */
function GrantTabRow({ g, steps }: { g: GrantView; steps: SpendNode[] }) {
  const live = g.status === "funded" || g.status === "checkpoint";
  return (
    <div className="doc-row grant-tab-row">
      <div className="kr-grant-head">
        <button className="link doc-row-title" title={`Open grant ${g.id}: ${g.objective}`} onClick={() => store.open({ kind: "grant", id: g.id })}>{clipText(grantName(g), GRANT_ROW).head}</button>
        <Pill tone={grantTone(g)}>{g.status}</Pill>
      </div>
      {live ? (
        <div className="kr-bar-row">
          <span className="kr-bar"><i style={{ width: `${spentShare(g.spentTokens, g.grantTokens ?? 0) * 100}%` }} /></span>
          <span className="muted">{grantSpendLine(g)}</span>
        </div>
      ) : <div className="muted">{grantStatusLine(g)}</div>}
      <div className="muted">{g.keyResults.length ? <>{g.keyResults.length === 1 ? "Key result" : `${g.keyResults.length} key results`}: {clipText(g.keyResults[0]!.text, 48).head} · {krStatusLabel(g.keyResults[0]!.status)}</> : "No key results"}</div>
      {/* the steps as one line; each session is listed on the grant's page (gr_zak30564zh step 4: one control per row) */}
      {steps.length ? <div className="muted" title={steps.map((s) => `${s.name} · ${fmtTokens(s.tokens)} ${ADJ}`).join("\n")}>{steps.length} step{steps.length === 1 ? "" : "s"}{live ? "" : ` · ${fmtTokens(steps.reduce((t, s) => t + s.tokens, 0))} ${ADJ}`} · {steps.reduce((t, s) => t + s.sessions, 0)} sessions</div>
        : live ? <div className="muted">No step sessions yet.</div> : null}
    </div>
  );
}

/**
 * The key results in the building's subtree, the edit path (Goals → Edit; read on the Goals tab). Each belongs to a grant
 * (docs/how-work-gets-done.md §4). A human with building.manage edits the words, and so does the manager; status up to
 * claimed is the manager's, met / missed need building.fund. A key result a live grant names can't be deleted (the
 * server says why).
 */
function KeyResultsEditor({ b, right }: { b: SnapshotBuilding; right?: ReactNode }) {
  const rev = useTown((s) => s.rev);
  useTown((s) => s.me);
  const tree = useLoad(() => api().keyResults(b.id), [b.id, rev]);
  const canFund = store.can("building.fund", b.id);
  const human = store.can("building.manage", b.id); // the web is the humans' client: a manage holder here is a human
  const all = tree.data?.keyResults ?? [];
  return (
    <Section title="Key results" right={right}>
      <p className="direction">Each key result says how you'll know a grant's work is done, in terms a human can check in the live town. It belongs to its grant: the manager writes them in the grant proposal, and you edit the words here.</p>
      {tree.loading && !tree.data ? <Loading /> : null}
      <ErrorLine error={tree.error} />
      {tree.data && !all.length ? <Empty>No key results on the goal yet{b.kind !== "town-hall" ? ": the building is blocked until a grant is funded" : ""}.</Empty> : null}
      {all.length ? <ol className="kr-editor">{all.map((k, i) => <KeyResultRow key={k.id} n={i + 1} kr={k} canWrite={human} statuses={settableStatuses(canFund)} onChanged={tree.reload} />)}</ol> : null}
    </Section>
  );
}

/** Who wrote the key result (a human, or the building's manager from a meeting), who last edited it, and its sources. */
function KeyResultAuthor({ kr }: { kr: GoalKeyResult }) {
  const by = krAuthorLine(kr);
  if (!by && !kr.sourceDocIds.length) return null;
  return (
    <div className="muted kr-author">
      {by}
      {kr.sourceDocIds.length ? <>{by ? " · " : ""}from {kr.sourceDocIds.map((id, i) => <span key={id}>{i ? ", " : ""}<button className="link" onClick={() => void openDocLink(id)}>{store.state.docs[id]?.title ?? id}</button></span>)}</> : null}
    </div>
  );
}

/** One key result in the editor: words (humans), status (per `statuses`), delete. Dirty rows save explicitly. */
function KeyResultRow({ n, kr, canWrite, statuses, onChanged }: { n: number; kr: GoalKeyResult; canWrite: boolean; statuses: KeyResultStatus[]; onChanged: () => void }) {
  const [f, setF] = useDraft(`kr-edit:${kr.id}:${kr.text}|${kr.howToCheck}`, { text: kr.text, howToCheck: kr.howToCheck });
  const dirty = f.text !== kr.text || f.howToCheck !== kr.howToCheck;
  const canStatus = statuses.includes(kr.status);
  const setStatus = async (status: KeyResultStatus) => {
    if (status === kr.status) return;
    await api().updateKeyResult(kr.id, { status });
    store.toast(`Key result ${n} is ${krStatusLabel(status)}`, "ok");
    onChanged();
  };
  return (
    <li className="kr-editor-row">
      <div className="kr-row-head">
        <span className="kr-n">{n}</span>
        {canStatus ? (
          <select className={`kr-status ${krTone(kr.status)}`} value={kr.status} title={kr.statusNote || "Status"} onChange={(e) => setStatus(e.target.value as KeyResultStatus).catch((err) => store.toast((err as Error).message, "bad"))}>
            {statuses.map((s) => <option key={s} value={s}>{krStatusLabel(s)}</option>)}
          </select>
        ) : <Pill tone={krTone(kr.status)} title={kr.statusNote || undefined}>{krStatusLabel(kr.status)}</Pill>}
        {canWrite ? null : <b>{kr.text}</b>}
      </div>
      {canWrite ? (
        <form className="form" onSubmit={(e) => e.preventDefault()}>
          <input value={f.text} maxLength={300} aria-label={`Key result ${n}`} onChange={(e) => setF({ ...f, text: e.target.value })} />
          <input value={f.howToCheck} maxLength={300} aria-label={`How to check ${n}`} placeholder="How to check" onChange={(e) => setF({ ...f, howToCheck: e.target.value })} />
          <div className="actions">
            <Act small tone="primary" disabled={!dirty || !f.text.trim() || !f.howToCheck.trim()} run={async () => {
              await api().updateKeyResult(kr.id, { text: f.text.trim(), howToCheck: f.howToCheck.trim() });
              store.toast(`Key result ${n} saved`, "ok");
              onChanged();
            }}>Save</Act>
            {dirty ? <button className="link" onClick={() => setF({ text: kr.text, howToCheck: kr.howToCheck })}>Undo</button> : null}
            <Act small tone="bad" title="Refused while a grant names it" run={async () => {
              if (!window.confirm(`Delete key result ${n} ("${kr.text}")?`)) return;
              await api().deleteKeyResult(kr.id);
              store.toast(`Key result ${n} deleted`, "ok");
              onChanged();
            }}>Delete</Act>
          </div>
        </form>
      ) : <div className="muted kr-check">How to check: {kr.howToCheck}</div>}
      <KeyResultAuthor kr={kr} />
    </li>
  );
}

