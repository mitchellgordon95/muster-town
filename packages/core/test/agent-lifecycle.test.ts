/** Agent status is one state machine: STATUS_TRANSITIONS (schema), enforced in World.setStatus. docs/invariants/agent-lifecycle.md. */
import { AgentStatus, NOT_GONE, STATUS_TRANSITIONS, canTransition, isGone } from "@muster-town/schema";
import { describe, expect, it } from "vitest";
import { applyDecision, createDoc } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const ALL = AgentStatus.options;

describe("agent lifecycle", () => {
  it("table test: World.setStatus allows exactly the STATUS_TRANSITIONS pairs", () => {
    const { world, by } = seededWorld();
    const mei = by("Mei");
    for (const from of ALL) {
      for (const to of ALL) {
        world.agents.patch(mei.id, { status: from });
        const allowed = from === to || STATUS_TRANSITIONS[from].includes(to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(allowed);
        if (allowed) expect(world.setStatus(mei.id, to).status, `${from} -> ${to}`).toBe(to);
        else {
          expect(() => world.setStatus(mei.id, to), `${from} -> ${to}`).toThrow(expect.objectContaining({ code: "conflict" }));
          expect(world.agents.require(mei.id).status).toBe(from);
        }
      }
    }
  });

  it("retired and banned are gone and terminal: nothing leaves retired, banned only goes to retired", () => {
    expect(ALL.filter((s) => isGone(s))).toEqual(["banned", "retired"]);
    expect(STATUS_TRANSITIONS.retired).toEqual([]);
    expect(STATUS_TRANSITIONS.banned).toEqual(["retired"]);
    expect(isGone(undefined)).toBe(false);
    expect(NOT_GONE).toBe("status NOT IN ('retired','banned')");
  });

  it("dismiss -> stop -> resume stays retired", () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei");
    world.ops.dismissAgent(admin, mei.id);
    expect(() => world.ops.stopAgent(admin, mei.id)).toThrow(expect.objectContaining({ code: "conflict", status: 409, message: "Mei is retired." }));
    expect(world.ops.resumeAgent(admin, mei.id).status).toBe("retired");
    expect(world.agents.require(mei.id).status).toBe("retired");
  });

  it("meeting decision on a retired assignee does not revive it", () => {
    const { world, by, admin } = seededWorld();
    const noor = by("Noor");
    const m = world.ops.createMeeting(admin, { kind: "standup", buildingId: "carbon-cycle", startNow: true });
    world.ops.dismissAgent(admin, noor.id);
    world.ops.meetingDecide(admin, m.id, [{ text: "Noor: reconcile the growth rates", assigneeId: noor.id, assignmentId: null }]);
    expect(world.agents.require(noor.id).status).toBe("retired");
  });

  it("review continue on a retired author does not revive it (nor stop)", () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei");
    const report = (title: string) => createDoc(world, { type: "report", state: "building", title, body: "## Proposal\nNext step", decision: "pending", authorId: mei.id, authorKind: "agent", buildingId: "carbon-cycle" });
    const r1 = report("one"), r2 = report("two"), r3 = report("three");
    world.ops.dismissAgent(admin, mei.id);
    applyDecision(world, r1.id, "continue", "", world.holderOf(admin));
    applyDecision(world, r2.id, "redirect", "Do this instead", world.holderOf(admin));
    applyDecision(world, r3.id, "stop", "", world.holderOf(admin));
    expect(world.agents.require(mei.id).status).toBe("retired");
  });
});
