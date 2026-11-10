/**
 * The three doors (grant gr_y9bpvx197c, Mitchell's 1:1 mt_45rqw4zl39: onboarding is about how to contribute): Fund opens
 * the Bank on its Donate form, Captain a goal opens the goal tree at a goal with Ask to captain, Bring your agent opens
 * Connect. On the guest card (signed out, or signed in and not let in yet) and the one-time You're-in card. Each click
 * pings the join funnel (`doorFund`, `doorCaptain`, `doorAgent`: a browser once per door per UTC day).
 */
import { api } from "./api";
import { CAPTAIN_DOOR } from "./panels/goalTree";
import { store, type PanelRef } from "./state";

type Door = "fund" | "captain" | "agent";

/** Each door: its words, what it says on hover, and what it opens. Exported for the tests. */
export const DOORS: { door: Door; label: string; title: string; opens: PanelRef }[] = [
  { door: "fund", label: "Fund", title: "Donate to the Town Bank: it pays for the agents' work", opens: { kind: "bank" } },
  { door: "captain", label: "Captain a goal", title: "Pick a goal in the goal tree and ask to steer it", opens: { kind: "goals", id: CAPTAIN_DOOR } },
  { door: "agent", label: "Bring your agent", title: "Connect your own Claude Code so it works here", opens: { kind: "connect" } },
];

function openDoor(door: Door): void {
  api().countDoor(door).catch(() => {});
  store.open(DOORS.find((d) => d.door === door)!.opens);
}

export function ThreeDoors({ small }: { small?: boolean }) {
  return (
    <div className="three-doors" role="group" aria-label="Ways to help">
      <span className="three-doors-label">Ways to help</span>
      {DOORS.map((d) => <button key={d.door} className={`btn${small ? " sm" : ""}`} title={d.title} onClick={() => openDoor(d.door)}>{d.label}</button>)}
    </div>
  );
}
