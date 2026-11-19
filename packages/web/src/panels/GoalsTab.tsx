/**
 * The building panel's goal tabs (Mitchell, 1:1 mt_auczm6f1j1): Goals (the key results in the building's subtree, each with
 * one word on its grant state; humans mark met / missed and delete in place, and "Edit" opens the editor that used to sit
 * in Settings) and Grants (every grant of the building, decided in the decision queue). The board is notes only.
 */
import { useDraft } from "../draft";
import { clipText } from "./showMore";
import { useState, type ReactNode } from "react";
import { isJudgedKr, grantName, type GrantView, type KeyResultStatus, type SnapshotBuilding } from "@muster-town/schema";
import { api, type GoalKeyResult, type SpendNode } from "../api";
import { store, useTown } from "../state";
import { Act, ADJ, Empty, ErrorLine, Loading, Pill, Section, fmtTokens, timeAgo, useLoad } from "./ui";
import { UNBLOCK_LINE, blockedLabel, goalsSummary, grantGroups, grantSpendLine, grantSteps, grantsSummary, krAuthorLine, krGrantWord, krStatusLabel, krTone, settableStatuses, spentShare, type KrGrantWord } from "./keyResults";
import { openDocLink } from "./Markdown";

/** The building's key results and grants, reloaded on every town change. */
export function useGoalData(buildingId: string) {
  const rev = useTown((s) => s.rev);
  const tree = useLoad(() => api().keyResults(buildingId), [buildingId, rev]);
  const grants = useLoad(() => api().grants(buildingId), [buildingId, rev]);
  return { tree, grants };
}

const openTab = (id: string, tab: "Goals" | "Grants") => store.open({ kind: "building", id, tab });

/** The Overview's two lines, each opening its tab. */
export function GoalTabsSummary({ b }: { b: SnapshotBuilding }) {
  const { tree, grants } = useGoalData(b.id);
  const g = grants.data ?? [];
  const goalIds = tree.data ? new Set([...(b.goalId ? [b.goalId] : []), ...tree.data.keyResults.flatMap((k) => k.goalId ? [k.goalId] : [])]) : undefined;
  return (
    <div className="goal-tabs-summary">
      <button className="link" onClick={() => openTab(b.id, "Goals")}><b>Goals:</b> {tree.data ? goalsSummary(tree.data.keyResults, g) : "…"} →</button>
      <button className="link" onClick={() => openTab(b.id, "Grants")}><b>Grants:</b> {grants.data ? grantsSummary(g, goalIds) : "…"} →</button>
    </div>
  );
}

const WORD_TONE: Record<KrGrantWord, string> = { funded: "ok", proposed: "info", open: "" };
const WORD_TITLE: Record<KrGrantWord, string> = { funded: "A funded grant works on it", proposed: "A proposal names it, waiting in the decision queue", open: "No grant: open for exploration" };

/** Goals tab: the key results (read), or the editor (Edit, building.manage). */
export function GoalsTab({ b }: { b: SnapshotBuilding }) {
  useTown((s) => s.me);
  const canManage = store.can("building.manage", b.id);
  const canFund = store.can("building.fund", b.id);
  const [editing, setEditing] = useState(false);
  const { tree, grants } = useGoalData(b.id);
  const atHall = <button className="link" title="The town goal tree: goals, key results and proposals" onClick={() => store.open({ kind: "goals", id: b.goalId ?? undefined })}>Goal tree at the Town Hall →</button>;
  const toggle = canManage ? <span className="goal-actions">{atHall}<button className="link" onClick={() => setEditing(!editing)}>{editing ? "Done editing" : "Edit"}</button></span> : atHall;
  if (editing) return <KeyResultsEditor b={b} right={toggle} />;
  const all = tree.data?.keyResults ?? [];
  const num = new Map(all.map((k, i) => [k.id, i + 1]));
  const g = grants.data ?? [];
  const row = (k: GoalKeyResult) => <GoalRow key={k.id} n={num.get(k.id)!} kr={k} word={krGrantWord(k, g)} />;
  // met and missed key results are the record: they fold to their count under the open ones (gr_zak30564zh step 5)
  const isOpen = (k: GoalKeyResult) => !isJudgedKr(k.status);
  const judged = all.filter((k) => !isOpen(k));
  const rows = (list: GoalKeyResult[]) => list.filter(isOpen).length ? <ol className="kr-rows">{list.filter(isOpen).map(row)}</ol> : null;
  return (
    <Section title="Key results" right={toggle}>
      {blockedLabel(b) ? <div className="kr-blocked"><Pill tone="bad">{blockedLabel(b)}</Pill> {UNBLOCK_LINE}</div> : null}
      {tree.loading && !tree.data ? <Loading /> : null}
      <ErrorLine error={tree.error} />
      {tree.data && !all.length ? <Empty>No key results on the goal yet: each grant carries its own.</Empty> : null}
      {rows(all)}
      {judged.length ? <details className="grant-fold settled-fold kr-judged-fold"><summary><b>Met or missed</b>{judged.length} key result{judged.length === 1 ? "" : "s"}</summary><ol className="kr-rows">{judged.map(row)}</ol></details> : null}
      {/* one fold for every key result's how to check, notes and marks, not one per row: the list opens on status and words,
          and its controls stay the same however many key results there are (gr_zak30564zh step 5, kr_p6l1w6tade) */}
      {all.length ? (
        <details className="kr-more kr-checks-fold">
          <summary>How to check{all.some((k) => k.statusNote) ? ", notes" : ""}{canFund || canManage ? " and marks" : ""}</summary>
          <ol className="kr-rows">{all.map((k) => <GoalRowMore key={k.id} n={num.get(k.id)!} kr={k} canFund={canFund} canDelete={canManage} onChanged={tree.reload} />)}</ol>
        </details>
      ) : null}
    </Section>
  );
}

/** Characters of a key result's words on its row (about one line); the full words are in the "How to check" fold. */
const KR_ROW = 64;

/** One key result, read-only: number, status, text and its grant word. How to check, notes and marks are in the list's one fold (GoalRowMore). */
function GoalRow({ n, kr, word }: { n: number; kr: GoalKeyResult; word: KrGrantWord }) {
  return (
    <li className="kr-row">
      <div className="kr-row-head">
        <span className="kr-n">{n}</span>
        <Pill tone={krTone(kr.status)} title={kr.statusNote || undefined}>{krStatusLabel(kr.status)}</Pill>
        <b title={kr.text}>{clipText(kr.text, KR_ROW).head}</b>
        <span className={`kr-word ${WORD_TONE[word]}`} title={WORD_TITLE[word]}>{word}</span>
      </div>
    </li>
  );
}

/** One key result in the "How to check" fold: how to check, the status note, the postmortem, met / missed (building.fund) and delete (building.manage). */
function GoalRowMore({ n, kr, canFund, canDelete, onChanged }: { n: number; kr: GoalKeyResult; canFund: boolean; canDelete: boolean; onChanged: () => void }) {
  const judged = isJudgedKr(kr.status);
  const mark = (status: KeyResultStatus) => async () => {
    // missed asks why: the line is filed as the human's note and queues one postmortem (docs/goals.md "Postmortems on missed KRs")
    const why = status === "missed" ? window.prompt(`Why was key result ${n} missed? One line: it queues a postmortem on the building.`)?.trim() : "";
    if (status === "missed" ? !why : !window.confirm(`Mark key result ${n} ${status}?`)) return;
    await api().updateKeyResult(kr.id, { status, note: why ?? "" });
    store.toast(`Key result ${n} is ${status}`, "ok");
    onChanged();
  };
  return (
    <li className="kr-row">
      <div className="kr-row-head"><span className="kr-n">{n}</span><b>{kr.text}</b></div>
      <div className="muted kr-check">How to check: {kr.howToCheck}</div>
      {kr.statusNote ? <div className="muted kr-check">{krStatusLabel(kr.status)}: {kr.statusNote}</div> : null}
      {kr.status === "missed" ? <div className="muted kr-check">{kr.postmortemDocId ? <button className="link" onClick={() => void openDocLink(kr.postmortemDocId!)}>Postmortem →</button> : "Postmortem pending: queued on the building that worked on it."}</div> : null}
      {(canFund && !judged) || canDelete ? (
        <div className="actions">
          {canFund && !judged ? <><Act small tone="ok" run={mark("met")}>Mark met</Act><Act small tone="warn" run={mark("missed")}>Mark missed</Act></> : null}
          {canDelete ? <Act small tone="bad" title="Refused while a grant names it" run={async () => {
            if (!window.confirm(`Delete key result ${n} ("${kr.text}")?`)) return;
            await api().deleteKeyResult(kr.id);
            store.toast(`Key result ${n} deleted`, "ok");
            onChanged();
          }}>Delete</Act> : null}
        </div>
      ) : null}
    </li>
  );
}

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
        <Pill tone={g.status === "checkpoint" || g.status === "proposed" ? "warn" : g.status === "funded" ? "ok" : g.status === "rejected" ? "bad" : ""}>{g.status}</Pill>
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

