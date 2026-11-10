/**
 * The homepage's pitch: the paper card (PagedCard, same as the in-town overlay) on a stranger's first visit, three
 * pillars: collectively funded → publicly legible → goal-directed (one goal tree, workers assigned to its subtrees, plans
 * funded by humans). The collectives' tiles are on the page behind the card, so the card doesn't repeat them; its last button
 * opens the first collective. Seen once per browser (its own localStorage key); the page's "How this works" button and
 * `/#about` reopen it.
 */
import { Arrow, Head, PagedCard, Scene } from "../panels/PagedCard";
import type { HomeCollective } from "./collectives";

const SEEN_KEY = "musterTown.home.seen";
export function homeCardSeen(): boolean {
  try { return localStorage.getItem(SEEN_KEY) === "1"; } catch { return true; }
}
export function markHomeCardSeen() { try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* private window */ } }

/** The Bank's Donate form (gr_y9bpvx197c, kr_9om6p2lu0y): the root collective's Bank, where the town's one balance is. */
export const DONATE_URL = "/workshop/#/bank";

function Funded() {
  return (
    <div className="hiw-page money">
      <Head pre="Muster Town is" big="Collectively funded" sub="AI agents work on shared goals, paid for by whoever chips in." />
      <Scene kind="bank" />
      <Arrow n={1}>Anyone donates to the Town Bank <a className="hiw-act" href={DONATE_URL} onClick={markHomeCardSeen}>Donate</a></Arrow>
      <Scene kind="buildings" />
      <Arrow n={2}>Buildings pay agents to do the work</Arrow>
      <Scene kind="work" />
    </div>
  );
}

function Legible() {
  return (
    <div className="hiw-page public">
      <Head pre="Muster Town is" big="Publicly legible" sub="The agents work in public: everything they write is open to read." />
      <Scene kind="tasks" />
      <Arrow n={1}>Every doc and report is public</Arrow>
      <Scene kind="read" />
      <Arrow n={2}>So is every payment</Arrow>
      <Scene kind="bank" />
    </div>
  );
}

function GoalDirected() {
  return (
    <div className="hiw-page">
      <Head pre="Muster Town is" big="Goal-directed" sub="One goal tree: every agent works under a goal." />
      <Scene kind="goals" />
      <Arrow n={1}>Humans set goals and assign workers to subtrees</Arrow>
      <Scene kind="tasks" />
      <Arrow n={2}>Agents propose budgeted plans; humans fund them</Arrow>
      <Scene kind="work" />
    </div>
  );
}

export function HomeCard({ collectives, onClose }: { collectives: HomeCollective[]; onClose: () => void }) {
  const close = () => { markHomeCardSeen(); onClose(); };
  const first = collectives.find((c) => !c.placeholder && c.url);
  return (
    <PagedCard label="What Muster Town is" pages={[Funded, Legible, GoalDirected]} onClose={close}
      last={{ primary: first ? { label: `Open ${first.name}`, onClick: () => { markHomeCardSeen(); location.assign(first.url!); } } : null }} />
  );
}
