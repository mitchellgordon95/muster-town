# How work gets done in a Muster Town

Status: **vision, for Mitchell's read; nothing below §10 is built yet.** Asked for in 1:1 mt_wql34b8gkl (2026-10-31): "if we don't have one already, i think a vision doc for how work gets done in a muster town is probably a good idea", then "you don't need to wait on me, go ahead and do all the things". Written by Pix 2 (as_5pkqisma36) from that 1:1 and the three that shaped the goal tree: mt_a3nvwfawer (the tree, 2026-10-30), mt_529jbnwvmi (finance) and mt_kh0zaqui0w (open questions, the map).

This is the one narrative of the loop. The per-feature docs it draws on (`docs/goals.md`, `docs/waterfall.md`, `docs/goal-directed-budgets.md`, `docs/bank.md`, `docs/wakes.md`) stay the references for how each piece works; where they disagree with this doc, a line at the top of the conflicting section points here.

Three voices, kept apart:

- **Mitchell said** — his words, quoted, with the meeting.
- **Proposed** — what this doc says the town should do.
- **Open** — what nobody has decided yet. The five that need Mitchell are in §12.

## 1. The loop in one picture

```
 humans own and edit the goal tree  ──────────────────────────────┐
        │  (captains, the Planner at hand, "Change this goal")       │
        ▼                                                          │
 the tick sees free tokens + an idle desk under a goal             │
        │  reserves one chunk (100k), starts one exploration       │
        ▼                                                          │
 the explorer picks a direction, investigates, files ONE grant     │
        │  proposal against a goal, carrying its own key results   │
        ▼                                                          │
 morning / evening review: the human funds, counters or rejects    │
        │                                                          │
        ▼                                                          │
 forks work the funded grant; checkpoints; the manager rolls up    │
        │                                                          │
        ▼                                                          │
 the human marks the grant's key results met or missed ────────────┘
```

Two things run the loop: **humans** at its top and bottom (what matters, what to fund, what was achieved), and **the runtime tick** in its middle (when there is money and a free desk, someone goes looking). Managers sit in between: they decide their forks' reports, roll up, and answer 1:1s. What they no longer do is decide whether to explore.

**Mitchell said** (mt_a3nvwfawer): "i naturally find myself doing a morning and evening review, and just letting the collective work in between." And (mt_529jbnwvmi): "the whole goal of this project is to create an organizational structure that is fairly autonomous, given CEO-level or VP-level direction."

**Why this doc exists.** That design was meant to keep the town moving between reviews. In practice it doesn't: on 2026-10-31 the Workshop spent 4.9M tokens on directed work (a human asked) and 0.36M on exploration, and by Pix's reading in that 1:1 the explorations, too, were queued because a human asked. In the 1:1 Mitchell said: "we have goals now, but nobody's doing any exploration work or proposing key results and grants. I don't know why." The reason is in the code. A manager wakes only on a fresh in-tray report or an open 1:1 (`packages/runtime/src/manage.ts`). A building is "blocked" only when it has no open key result at all (`packages/core/src/grants.ts` `blocked`). And waterfall §3.1 says "an idle building is silent". A quiet building stays quiet forever. This doc moves exploration out of anyone's judgment and into a rule.

## 2. Humans own the goal tree

This is mostly built (goal tree steps 1–8, `docs/goals.md`) and does not change.

- **One tree**, rooted at the town goal, edited at the Town Hall's Goal tree. Depth is unbounded, and every building is attached to exactly one node.
- **Humans edit it; managers propose.** **Mitchell said** (mt_a3nvwfawer): "tree edits i think are definitely intended for humans, although (similar to any other org) managers can propose goals and KRs to bring to a meeting".
- **Captains.** A human can captain a node, and everything below rolls up to them: they decide and fund grants in their subtree, and the Town Hall items there go to their in-tray ("Mine"). **Mitchell said**: "maybe humans get assigned to nodes in the goal tree? and everything below rolls up to them? then we get an implicit org structure". Captains are humans only for now (mt_kh0zaqui0w).
- **The Planner at hand.** "Plan with an agent" opens a 1:1 with the Planner, which has the tree, the event digest and the rollups loaded and drafts proposals for the human to accept or cut. **Mitchell said**: "a thing we need to solve is having agents at hand to get information, help articulate and plan the goals". Since mt_wql34b8gkl decision 1, the Planner is the Town Hall's manager.
- **Reorgs.** "Change this goal" (X → Y) sends every manager under the node a prep assignment and opens a planning meeting when the prep reports are in, or after 24 h. It is the one scheduled meeting kind. **Mitchell said**: "come to the meeting having reviewed your work and have proposals for what should happen underneath".

**Proposed (one change).** Goals are **standing**: a goal is a direction, never "met". A human retires it or changes it. **Mitchell said**: "some of those should really be standing goals. like we don't retire them until our priorities change? otherwise they stay on and keep generating grants?" In this doc, the thing that "keeps generating grants" is §3. Goals no longer carry key results of their own (§4).

## 3. Exploration is declarative

**Mitchell said** (mt_wql34b8gkl): "i think maybe it should be declarative or something? but basically if a manager has free budget (either earmarked to the goal or from the bank pool it's connected to) and an empty desk, it should carve out exploratory chunks of tokens (maybe 100k? idk), reserve them for a session, and have the desk go investigate a direction and write a key result + grant".

**Proposed.**

**The rule lives on the goal and is inherited down the tree**, like the goal's funding settings today (`fundingAt`, migration 065). Each goal may set:

| setting | default (at the root) | meaning |
|---|---|---|
| `explore` | on | whether the tick starts explorations for buildings attached at or below this goal |
| `exploreChunkTokens` | 100,000 | the tokens one exploration session reserves |
| `exploreCapTokensPerDay` | none | optional: the most this subtree may reserve for exploration per UTC day (§8) |

A null value inherits from the nearest ancestor that sets one. The root sets the defaults. The Town Hall never explores: its manager, the Planner, is 1:1-only.

**The runtime tick does it, not a manager.** On each tick, for every building (Town Hall excluded):

1. **Is there a desk?** The building has a free desk slot (`freeDesks > 0`), and its queue has nothing forkable waiting. Grant and directed work always go first: exploration only fills desks the queue doesn't need.
2. **Is there money?** Read the free tokens for the building's goal (§7). Free tokens ≥ the chunk.
3. **Is the rule on?** `explore` is on at the building's goal, no other exploration of this building is still starting, and the optional cap isn't reached.
4. **Then:** write a **reservation** (a Bank row: goal, building, assignment, tokens = chunk, the same kind of claim a funded grant's remaining makes on the balance). Queue one assignment on the building queue (lane `exploration`, `goalId` = the building's goal, `reservationId`, title "Explore under <goal short name>"). The fork launcher starts it like any other work.

At most one exploration starts per building per tick. Over successive ticks a building fills its idle desks. That is the concurrency **Mitchell asked for**: "capped only by desk capacity and the free tokens".

**The explorer's brief** (a fork of the manager, like any building-queue work):

> Pick one direction under goal X. Read the goal tree around X (its words, siblings, children, archived results), the last rollups of the buildings on this subtree, the event log since the last exploration here, and the open grants and proposals (don't duplicate one). Investigate the direction: use the live town, the code and the web. End with **one grant proposal** against a goal in your subtree, carrying its key results (§4). If the direction isn't worth a grant, say why in the report and propose nothing.

**The chunk is the session's ceiling.** The desk gets the chunk as its cap (the same per-session cap mechanism the key streams need, `docs/goals.md` "Sessions and keys"), so the fork stops cleanly and files before the chunk runs out. **When the session ends, the reservation closes**: what was spent is booked as exploration on the goal (Spend by goal already attributes by `goalId`), and **what is unspent returns** to free tokens. A session that dies without a report closes its reservation the same way.

**Where the output goes.** The proposal goes straight to the Town Hall in-tray and the review deck, routed to the goal's captain as proposals already are. The fork's report goes to its manager's in-tray as any report does, and the manager folds it into the next rollup. **The manager isn't woken to start anything.** The "quiet-building wake" Pix floated in mt_wql34b8gkl is not needed.

**What stays.** Directed work (a human asked) is unchanged and never waits for free tokens. Managers can still `assign` exploration with a goal or gap; that assignment draws a reservation like the tick's does.

**Open.** How big the default chunk should be against real session sizes (§12 q1). Whether the explorer may propose against a goal outside its own subtree (proposed: no; it names the gap in its report instead).

## 4. Grants carry their key results

**Mitchell said** (mt_wql34b8gkl): "i'm also kind of thinking that key results and grants should just merge? like you only file grants against goals, and the grants have key results to check (which are currently like, test expectations or something?)". And in mt_a3nvwfawer: "now that i'm talking about it it feels like KRs and KPIs are really just tools to help make goals more concrete and understood?"

**Proposed.** **A grant is filed against a goal and carries its own key results.**

- **A grant** = `goalId` + objective + approach + stop condition + ask + **key results**. Each key result has text, how to check, and a due date. A grant has 1–5 of them.
- **A key result belongs to exactly one grant.** It is dated and checkable, as today ("a concrete thing in the live town by a date"). Its status runs not-started → on-track / at-risk → claimed, set by the manager (`checkpoint_grant`). **A human marks it met or missed on the grant**, in the grant panel or on the deck slide. Today's `testingPlan` folds into these key results: a testing plan line *is* a key result without a date.
- **A goal keeps no key results of its own.** It holds standing direction, grants (live and archived), and the archived key results of its closed grants. A goal's "results" are what its grants achieved.
- **A grant closes** as today: done (all key results claimed, then a human marks each), stopped, cut at a checkpoint, or rejected. A missed key result still triggers the postmortem (`docs/goals.md` "Postmortems"), now on the grant.

**What goes:**

- the `key_results` rows that hang on goals with no grant, and the "KR with no funded grant" state ("open for exploration");
- `set_key_result` and `propose_key_result` (managers propose grants now; `propose_goal` stays for tree edits);
- **the key-result stoplight** (today: red = no key results or no funded grant, yellow = a key result without a grant or a grant at its checkpoint, green = every key result funded). After: green = a funded grant of the building is running, yellow = a grant is held at its checkpoint (waiting on a human), grey = no funded grant (the building explores or idles). "Blocked: no key results" goes too: with exploration declarative, a building with free tokens and a desk is never stuck, and one without them is waiting on money or desks, which the Town blockers page shows;
- exploration naming a key result (it names a goal);
- the rule "directed work naming a KR stops once a grant proposal names it" (it names a goal or a grant).

**Standing duties.** Some of today's KRs are duties, not results. The live "Town blockers" page (kr_hj8wwx0q0w) is one example: "keeps a live page ... no older than the latest rollup". **Proposed:** a duty becomes a **goal with a recurring grant**: a grant with a schedule (e.g. daily), a per-period ask, and key results checked per period ("today's edition exists and is fresher than the latest rollup"). A human funds it once. It runs each period on the building's schedule. It reaches a checkpoint when its total is spent, as any grant does. **Open:** the exact shape (§12 q2).

**Migration (proposed).**

- Every **open key result with no grant** (on 2026-10-31, 8 of them under gl_join alone, e.g. kr_2qg0ayfs1j, kr_4li00ad46e, kr_pxisdsocdp) is **dropped**: archived with the note "dropped when key results merged into grants (docs/how-work-gets-done.md §4)". Its text is kept and listed in the explorer's brief for its goal as "ideas left from the old key results", so nothing is lost; an explorer can turn one into a grant.
- **Met and missed key results stay archived on their goal**, as history.
- A **live grant** (none in the Workshop today) keeps its key result, which becomes the grant's first key result, with its `testingPlan` lines added after it.
- This rewrites live data (open KRs become archived), so the rollup that ships it says so in its "Your call" (merge rules dc_vzqoh7ppen).

## 5. The review: fund, counter or reject

Built (the deck, kr_2qg0ayfs1j; captains' "Mine"; the funder filter) and unchanged, except that proposals now arrive from the tick's explorers and not only when a human asked.

**Mitchell said** (mt_529jbnwvmi): "i actually really like reviewing the grants, i think that's one part i would keep: human review of grants." **No grant starts itself.**

**Proposed.** The morning and evening review is where a human:

- **funds, counters or rejects** each grant proposal, judging it on the slide: the goal path, the key results with dates, the ask against the free tokens left under that goal;
- **decides checkpoints** (continue, adjust, cut);
- **marks key results met or missed** on grants whose key results are claimed;
- **accepts or cuts** goal proposals (tree edits).

**Counting open proposals' asks in free tokens** (§7) is what keeps the review from flooding: once the town has proposed as much as it can afford, exploration stops until the human decides. **Mitchell said** (mt_529jbnwvmi): "i think one change from #2 is that we count both funded and pending grants in that number". A rejected or countered proposal frees its ask.

**Open.** Whether one goal needs a limit on open proposals, so twenty explorers don't file twenty variants of one idea (§12 q5).

## 6. Funded work, checkpoints and rollups

Built and unchanged (`docs/waterfall.md`, `docs/invariants/grants.md`):

- A funded grant's work runs on the building queue. Forks (copies of the manager, one per assignment, one per free desk) take it, in lane `grant`.
- **Effort is desks.** **Mitchell said** (mt_529jbnwvmi): "i think effort steering should basically be how many desks you assign to a goal subtree". More desks under a goal means more sessions at once, both for grants and for exploration.
- At 100% of its tokens a grant **holds at its checkpoint**, and the manager files `checkpoint_grant` plus a rollup. A grant whose work is done early closes as done (`close_grant`), and its unspent tokens return.
- The manager decides each fork's report (approve, continue, redirect, stop) and **rolls up** to the Town Hall whenever something new is live and decided, at least ~4 h apart (mt_7mhv73quu3).
- Directed work (a human's 1:1, flag or meeting decision) bypasses all of this and is never held by exploration rules.

## 7. The Bank: one balance, earmarks, free tokens

**Mitchell said** (mt_529jbnwvmi): "Right now, there's only one pole, and every building pulls from the same pole ... I don't know that I really want to split the pot right now." Then: "so we drop bank pools? but we leave earmarks for users who want to fund specific goals?" And in mt_wql34b8gkl: "are bank pools obsolete now that we changed the bank structure?"

**Proposed (decided in mt_529jbnwvmi decision 1; the code is still to do):**

- **One balance.** Every input (a subscription, a donated key, a lump) pays into it. **Pools are deleted** (`BankPool`, `Goal.poolId`, `Building.poolId`, the Pools tab). Migration 065 already put every goal on General, so prod loses nothing.
- **Earmarks** stay. An earmark is a credit scoped to a goal: it pays only for work in that goal's subtree (built, migration 064).
- **Draw order** (built): the grant's own input, then the nearest earmark walking up from the work's goal, then the general balance. One key per session.
- **Free tokens** is the one number exploration reads, computed per goal:

```
free(goal) = general balance
           + earmarks at or above goal (balances)
           − funded grants' remaining tokens   (whole town; under goal for earmarks)
           − open proposals' asks              (likewise)
           − open exploration reservations     (likewise)
```

Funded grants, proposals and reservations under *other* goals still claim the general balance, because it is shared. An earmark only counts toward the goals under it, and only the claims under it reduce it. Free tokens can't go below zero. At zero, the tick starts nothing under that goal.

- **Reservations** are Bank rows (`bank_reservations`: goal, building, assignment, tokens, opened, closed, spent). They are the only new Bank object. A funded grant's claim stays derived (`grantTokens − spent`), as it is today.

**Open.** Whether free tokens should also count stream income over a horizon (a week), as `docs/goals.md` "Exploration: free funds" proposed, or only what is in the Bank now (§12 q4). This doc's formula uses only what is there now: a reservation must be backed by tokens that exist.

## 8. Exploration is uncapped by default

**Mitchell said** (mt_wql34b8gkl): "exploration budget should probably be unlimited for now (capped only by desk capacity and the free tokens), with the option to add a cap if you want it either town wide or per subtree".

**Proposed.**

- **No allowance.** The per-building daily exploration allowance goes (`explorationTokensPerDay`, `EXPLORATION_SHARE`, `grantDesk.exploration`, "held: exploration allowance spent today"). So does the separate directed bucket's role as a counterweight to it (directed spend is still metered and shown).
- **Concurrency = desks; money = free tokens.** Nothing else limits exploration.
- **An optional cap** (`exploreCapTokensPerDay`) on any goal, inherited down: the sum of reservations opened today under that goal can't pass it. On the root it is the town-wide cap. Only a human with `goals.edit` and funding rights there (an admin or the goal's captain) sets it, as with today's exploration setting.
- **Switching off** is the same setting: `explore: off` on a goal stops new explorations under it. Running ones finish.
- **The daily caps are gone** (1:1 mt_q10xf3bkoq, 2026-10-31): the per-agent cap (`dailyTokensPerAgent`) and the fork-family cap (× headcount) no longer hold any work; desks, free tokens, the optional exploration cap and grant totals are the only gates. The column stays, read by nothing.

## 9. The map is drawn from the tree

Built as goal tree step 2 (`packages/core/src/world/tree.ts` `treeLayout`): the Town Hall at the root, a plaza per goal, roads as the tree's edges, a building hanging under its goal's plaza.

**Mitchell said** (mt_wql34b8gkl): "the town organization does not look very good. I get that it's a first pass on auto-generating town structure from the gold tree, but that doesn't mean it should be ugly." The obvious fixes: "We don't need an empty lot for every unassigned goal. Buildings don't need a plaza. We should try to pack the buildings together so that it actually feels like a town." The shapes he floated: "A tree with the Town Hall at the root. More radial, kind of like the spokes of a wheel. More like a town, where you have big plazas with fountains and stuff, and the buildings are connected that way, like related buildings go in related plazas."

**Proposed: the obvious fixes, whatever the shape.**

- **No lot or plaza for a goal with no building under it** (built, PR #168: nothing draws for it; a goal with no building of its own and one drawn child folds into that child). This closes the "empty-goal look" question from mt_kh0zaqui0w.
- **No plaza per building** (built, PR #168): a building's door opens on its parent goal's street; a goal with drawn children gets its own street one row down, with a signpost. Buildings sit one tile apart.
- **Pack.** Lots sit on both sides of a road, two tiles apart. A chain of single-child goals folds into one road with its signposts in a row, which closes "long walks".

**Proposed shape: a tree from the Town Hall whose first level is plazas.** It is a hybrid of his first and third shapes:

- The Town Hall square at the top, with the Bank.
- One **big plaza with a fountain per child of the root** (today Fund, Join, Trust, and the attached goals under them).
- **Streets** running out of each plaza, one per goal below it, with buildings packed along both sides.

Related buildings share a plaza because they share a top-level goal. Walking from the Town Hall to a building still walks down the tree, and a reorg still redraws it.

**Not radial.** A tile map is rectangular, so spokes waste the corners and give diagonal roads in a grid world. Adding a sibling also changes every spoke's angle, which breaks the stable-layout rule (adding a building must not move the others).

**Open.** The pick is Mitchell's (§12 q3). Proposed: the obvious fixes ship first as their own PR; then three mock layouts of the live tree, one per shape, as pictures; then build the one he picks.

## 10. What changes from today

| | today | after this doc |
|---|---|---|
| Who starts exploration | a manager, only when a report or a 1:1 wakes it; in practice only when a human asks | the runtime tick, by a rule on the goal, whenever there are free tokens and an idle desk |
| Exploration budget | per building per day: 10% of the pool's inflow, or `Goal.explorationTokensPerDay` | none by default; an optional per-goal cap, inherited (root = town-wide) |
| Exploration's unit | a session that spends against today's allowance | a reserved chunk (100k default), returned unspent at session end |
| Exploration names | an open KR with no funded grant, or a gap | a goal |
| Key results | live on goals; a grant names one KR, plus an undated testing plan | live on grants (1–5, dated, checkable); goals keep none; testing plan folded in |
| `set_key_result`, `propose_key_result` | managers write and propose goal KRs | gone; managers propose grants and goals |
| Stoplight | red (no KRs, or no funded grant) / yellow (a KR without a grant, or a checkpoint) / green | green (a funded grant runs) / yellow (a checkpoint waits on a human) / grey (none); no "blocked: no KRs" |
| Standing duties (Town blockers) | a KR that never closes | a goal with a recurring grant |
| Bank structure | pools (all on General since 065), earmarks, draw order | one balance, earmarks, draw order; pools deleted |
| What exploration reads | the allowance and the pool's remaining | free tokens = balance + earmarks − funded remaining − open asks − open reservations |
| Human review | fund / counter / reject grants; edit KRs | the same for grants; marks key results met / missed on the grant |
| Map (steps 7–8, PR #168, #179) | a plaza per goal (an empty plaza for a goal with no building), every building on a goal plaza | no lot for empty goals, doors on the goal's road, packed lots; first level as fountain plazas (pending his pick) |

**Landed** (2026-10-31): every row but "Standing duties" is the code on main (PRs #169, #173, #171, #168, #179; see §11 Status). Standing duties wait on step 6.

## 11. Build order

**Status (2026-10-31, step 9's docs sweep).** Landed on main: steps 1 and 3 (PR #169 = 8d18dbc, migration 067, with step 2's `bank_reservations` table and the cap column); step 2, the explore tick (PR #173 = 49afcdd, migration 068; core `explore.ts`); steps 4–5, key results merge into grants (PR #171 = 5bead7f, migration 069); step 7, the obvious map fixes (PR #168 = b4c2dc1); step 8 as a picker of all three shapes rather than one pick (PR #179 = 343c5c5, `town.mapLayout`, migration 070); step 9, this sweep. Not built: step 6 (recurring grants), waiting on §12 q2.

Each step is one PR, with tests and docs, merged green and redeployed by the Workshop under the merge rules (dc_vzqoh7ppen). Migrations are additive (new tables, new nullable columns, back-fills); their numbers are checked against main's highest right before merging (066 on 2026-10-31). Steps 1–3 touch the Bank, and Mitchell's go-ahead in mt_wql34b8gkl ("go ahead and do all the things") is the sign-off for them.

1. **Free tokens (read-only).** Core `Bank.freeTokens(goalId)` per §7, from the balance, earmarks, funded grants' remaining and open proposals' asks. It is shown in the goal tree's Funding block and in `GET /api/goals/:id`. No migration, no behaviour change.
2. **Reservations and the explore rule.** A migration adds `bank_reservations` and nullable `goals.explore`, `goals.exploreChunkTokens`, `goals.exploreCapTokensPerDay`, inherited through `fundingAt`. The root back-fills on / 100,000 / none. The runtime tick's explore step (§3) does its work; the desk cap is the chunk; the reservation closes at session end. Exploration assignments name a `goalId`. Free tokens subtract open reservations. **Built** (PR #173): `exploreTick` runs every runtime tick. Per building (Town Hall excluded) it starts an explorer when the rule is on, the manager can fork, a desk is free, nothing else startable is on the building queue, no reservation of the building is open, none opened in the last 30 min (`EXPLORE_MIN_GAP_MS`), no proposal of the building is open, free tokens ≥ the chunk and the cap isn't passed. The explorer is an exploration assignment (gap "Explore under: <goal>", `reservationId`) on the building queue; the lane gate lets it run on its reservation. An open reservation claims its tokens less what its sessions spent; it closes (unspent returns) once its assignment is no longer pending or active. There is no hard desk cap: at 90% of the chunk the explorer is interrupted once and asked to file. Forks may `propose_grant` as their manager (since step 4, with `goalId` and the grant's own key results). Events `exploration.reserved`, `.started`, `.proposed`, `.closed`. The rule is edited on the goal tree's Funding block (Exploration row).
3. **The allowance and pools go.** Remove `explorationTokensPerDay`, `EXPLORATION_SHARE`, `grantDesk.exploration` and the "exploration allowance spent" hold. Remove `BankPool` and `poolId` (goal, building) from code, API and the Bank panel (the Pools tab, "Pool: X" lines); the columns stay, read by nothing. Update the manual's Bank section.
4. **Grants carry key results.** A migration adds nullable `grants.goalId` and `key_results.grantId`, and back-fills the goal and the KR of each existing grant. `propose_grant` takes `goalId` + `keyResults: [{text, howToCheck, due}]` (1–5), and `testingPlan` folds in. Met / missed are marked on the grant's panel and deck slide, and `checkpoint_grant` sets each key result's status. `keyResultId` stays readable for old grants. **Built with step 5** (PR #171, migration 069, as_6vdqloo3yi): checkpoints and close act on all of a grant's open key results; a rejected proposal's key results archive with it.
5. **Goal key results go.** Archive open key results with no grant (rewrites live data: its rollup says so), keeping their text as "ideas" in the explorer's brief. Remove `set_key_result`, `propose_key_result` and `add-kr` goal proposals, and "blocked: no key results"; the stoplight becomes the grant-based one of §4; remove KR naming in exploration and directed lanes. Remove the KR cards from the goal tree; the archived ones stay on their goal. **Built** (PR #171): the dropped key results are listed as ideas in the desk brief's "Goals and grants" block; the building's Goals tab still shows its grants' key results under their objectives; the Town Hall and building "add key result" forms are gone.
6. **Recurring grants for standing duties.** A grant gains an optional schedule and per-period ask, and its key results are checked per period. Town blockers moves to a goal with a recurring grant.
7. **Map: the obvious fixes.** No lot for empty goals (a signpost), doors on the goal's road, packed lots, single-child chains folded. This is independent of steps 1–6 and may land first. **Built** (PR #168).
8. **Map: the shape.** Three mock layouts of the live tree as pictures for Mitchell, then the one he picks (proposed: fountain plazas at the first level, streets below). **Built as a picker** (PR #179, migration 070): fountain plazas, plain tree or radial, picked on the town map.
9. **Docs sweep.** `docs/manual.md`, `docs/architecture.md`, the invariants docs (grants, bank, assignments-lanes) and `AGENTS.md` true to the code; the superseded sections of the older docs are trimmed to pointers. **Built** (this PR).

## 12. Open questions for Mitchell

1. **Chunk size.** You said "maybe 100k". The town's real work sessions run p50 ≈ 43k and p90 ≈ 120k adjusted tokens (`Bank.expectedSession`, 2026-10-30), so a 100k chunk ends a long investigation early. Keep 100k as the root default, or default the chunk to the expected session (today ~120k)?
2. **Recurring grants.** For a standing duty like Town blockers: fund once with a per-period ask that runs until its total is spent (proposed), or re-fund each period from the deck?
3. **Map shape.** Fountain plazas at the first level with streets below (proposed), a plain tree, or radial? Or should I just build the obvious fixes and show you the three mocks before you pick? **Answered** (1:1 mt_q10xf3bkoq): all three, as a town-wide picker on the town map (PR #179).
4. **Horizon in free tokens.** Only what is in the Bank now (proposed: a reservation must be backed), or also a week of stream income, as `docs/goals.md` had it?
5. **Proposal flood.** With exploration uncapped, a goal with many desks could fill your deck. Leave it to free tokens (open asks count, so it stops itself), or add a default limit of open proposals per goal (say 3)?
