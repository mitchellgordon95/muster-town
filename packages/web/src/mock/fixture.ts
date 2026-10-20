/**
 * Fixture world for VITE_MOCK=1 (v1.2): Town Hall (Wren at the mod station, Ada), Carbon Cycle Lab (5 residents,
 * Moss the reviewer, two reports in the in-tray, Otto who was dismissed), the Workshop (a workspace building with
 * reviewer policy, one report in its in-tray), meetings now / upcoming / done.
 */
import type { Agent, Assignment, Building, Doc, Event, Meeting, Membership, Role, Town, User } from "@agent-town/schema";
import { BUILTIN_ROLES } from "@agent-town/schema";

export const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

export const town: Town = {
  name: "Agent Town",
  goal: "Return atmospheric CO2 to 350 ppm by 2100",
  tagline: "publicly legible, collectively funded agent town for climate science",
  goalNote: "Current level is about 427 ppm (2025 annual mean, NOAA).",
};

export const users: User[] = [
  { id: "us_mitchell", name: "Mitchell", createdAt: ago(9000), donatedTokens: 50_000_000, hasApiKey: false },
];

const base = { goal: "", description: "", headcount: 6, reviewPolicy: "human" as const, model: "claude-opus-5-5", cheapModel: "claude-haiku-5-5", maxTurnsPerSession: 80, dailyTokensPerAgent: 2_000_000, meetings: [], rules: "", managerAgentId: null as string | null, workspace: null as Building["workspace"] };
export const buildings: Building[] = [
  { ...base, id: "bl_townhall", name: "Town Hall", kind: "town-hall", headcount: 3, description: "Library, trophy room, outbox, mod station, planning desk, donation box, schedule board, and the town meeting room.", createdAt: ago(9000) },
  {
    ...base, id: "bl_carbon", name: "Carbon Cycle Lab", kind: "lab", createdAt: ago(8900), createdBy: "us_mitchell", managerAgentId: "ag_moss",
    goal: "Understand the carbon cycle well enough to say what it would take to get to 350 ppm",
    description: "How CO2 moves between the atmosphere, land, ocean, and people: the fluxes, the stocks, the measurements, and the feedbacks.",
    meetings: [{ kind: "standup", everyMinutes: 0 }], workspace: null,
  },
  {
    ...base, id: "bl_workshop", name: "Workshop", kind: "lab", headcount: 3, reviewPolicy: "reviewer", createdAt: ago(8800), createdBy: "us_mitchell",
    goal: "Keep Agent Town itself working: small, tested changes to its own code",
    description: "Residents work in git worktrees of the Agent Town repo and open PRs.",
    rules: "- One small PR per session, with a screenshot description for web changes.\n- Read AGENTS.md before touching a package.\n- Mention @Mitchell in your report when you need a decision.",
    workspace: {
      path: ".", branchPrefix: "agent", base: "main", repoUrl: "https://github.com/example/agent-town.git",
      tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash(git:*)", "Bash(gh:*)", "Bash(npm:*)"],
    },
  },
];

const agentBase = { ownerUserId: "us_mitchell", status: "idle" as const, activity: "", model: null, spentTokensToday: 0, spentTokensTotal: 0, spentUsdTotal: 0, currentAssignmentId: null, currentMeetingId: null, createdAt: ago(8900), lastActiveAt: null };
const resident = (id: string, name: string, sprite: number, title: string, direction: string, extra: Partial<Agent> = {}): Agent => ({
  ...agentBase, id, name, kind: "resident", buildingId: "bl_carbon", homeBuildingId: "bl_carbon", title, direction, sprite, pos: { x: 0, y: 0 }, ...extra,
});

export const agents: Agent[] = [
  resident("ag_noor", "Noor", 1, "Atmospheric CO2", "How atmospheric CO2 is measured and what the record shows: Mauna Loa and the NOAA network, growth rate, isotopes, airborne fraction.", { status: "idle", spentTokensToday: 412_000, spentTokensTotal: 1_240_000, spentUsdTotal: 9.82, lastActiveAt: ago(12) }),
  resident("ag_tomas", "Tomas", 2, "Land sink", "The terrestrial carbon sink: photosynthesis vs respiration, CO2 fertilization, regrowth, soil carbon, interannual variability, weakening.", { status: "working", activity: "Searching: TRENDY v13 land sink 2024 anomaly", currentAssignmentId: "as_tomas2", spentTokensToday: 655_000, spentTokensTotal: 2_100_000, spentUsdTotal: 16.4, lastActiveAt: ago(0) }),
  resident("ag_mei", "Mei", 3, "Ocean sink", "Ocean carbon uptake: solubility and biological pumps, SOCAT pCO2, cumulative uptake, acidification, the Southern Ocean.", { spentTokensTotal: 640_000, spentUsdTotal: 5.2, lastActiveAt: ago(55) }),
  resident("ag_ravi", "Ravi", 4, "Human emissions", "Fossil and land-use emissions, their uncertainty, and how the Global Carbon Budget closes the books (the budget imbalance).", { spentTokensTotal: 980_000, spentUsdTotal: 7.1, lastActiveAt: ago(300) }),
  resident("ag_ingrid", "Ingrid", 5, "Feedbacks & futures", "Carbon-climate feedbacks: permafrost, fire, Amazon dieback, ocean warming, model projections, remaining carbon budgets."),
  resident("ag_moss", "Moss", 8, "Reviewer", "Reviews reports against the building goal: sources present, units and uncertainty, one concrete question, no duplication."),
  // dismissed: the row stays so documents keep their author; the client must never draw it
  resident("ag_otto", "Otto", 6, "Methane", "Methane budget (dismissed).", { status: "retired", lastActiveAt: ago(3000) }),
  resident("ag_keel", "Keel", 11, "Reviewer", "Reviews Workshop PR reports: tests added, checks green, scope small.", { buildingId: "bl_workshop", homeBuildingId: "bl_workshop" }),
  resident("ag_pike", "Pike", 9, "Web client", "Small fixes to the web client: one PR per session, with a screenshot.", { buildingId: "bl_workshop", homeBuildingId: "bl_workshop", spentTokensTotal: 300_000, spentUsdTotal: 2.4, lastActiveAt: ago(30) }),
  { ...agentBase, id: "ag_wren", name: "Wren", kind: "resident", buildingId: "bl_townhall", homeBuildingId: "bl_townhall", title: "Town moderator", direction: "Collective-wide misuse prevention: approves outbox requests, reviews trophy proposals, bans abuse.", sprite: 10, pos: { x: 0, y: 0 } },
  { ...agentBase, id: "ag_ada", name: "Ada", kind: "service", buildingId: "bl_townhall", homeBuildingId: "bl_townhall", ownerUserId: null, title: "Librarian", direction: "Knows every document in the library.", sprite: 0, pos: { x: 0, y: 0 }, activity: "Ask me about the library" },
  { ...agentBase, id: "ag_me", name: "Mitchell", kind: "human", buildingId: null, homeBuildingId: null, title: "Town owner", direction: "", sprite: 7, pos: { x: 0, y: 0 } },
];

const docBase = { authorKind: "agent" as const, provenance: { sourceIds: [], urls: [] }, tags: [] as string[] };
const REPORT_NOOR = `# Airborne fraction, 1959–2024

## Summary
The airborne fraction (AF) of CO2 emissions has stayed near **0.44 ± 0.07** since 1959 with no significant trend, which means land and ocean sinks have grown roughly in proportion to emissions.

## What I did
- Read the [GCB 2025 ESSD paper](../sources/gcb-2025-essd.md) and the [GCB data note](../sources/gcb-2025-data.md).
- Recomputed AF from the NOAA global growth rate (ppm/yr × 2.124 GtC/ppm) over total emissions.

## Findings
| Decade | Emissions (GtC/yr) | Growth (GtC/yr) | AF |
|---|---|---|---|
| 1960s | 4.5 ± 0.7 | 1.8 ± 0.07 | 0.40 |
| 1990s | 7.6 ± 0.7 | 3.2 ± 0.02 | 0.42 |
| 2014–2023 | 11.1 ± 0.9 | 5.2 ± 0.02 | 0.47 |

The 2023 spike (AF ≈ 0.55) lines up with the El Niño drop in the land sink. One year is not a trend.

## Proposal for next session
Does the airborne fraction show a statistically significant trend once ENSO and volcanic years are removed?

## For others
@Tomas: the 2023 land sink anomaly matters for your desk.

## Questions for humans
Is "0.44" the number we want on the town dashboard, or the 10-year mean?`;

export const docs: Doc[] = [
  { ...docBase, id: "dc_gcb_essd", type: "source", state: "library", title: "GCB 2025 ESSD", tags: ["gcb-2025-essd"], authorId: "ag_ravi", buildingId: "bl_carbon", body: "# Global Carbon Budget 2025 (ESSD)\n\n**Says:** fossil CO2 emissions 10.2 ± 0.5 GtC in 2024; ocean sink 2.9 ± 0.4 GtC/yr; land sink 3.2 ± 0.9 GtC/yr (2014–2023).\n\n**Link:** https://essd.copernicus.org/\n\nSee also the [data note](gcb-2025-data.md).", provenance: { sourceIds: [], urls: ["https://essd.copernicus.org/"] }, createdAt: ago(5000), updatedAt: ago(5000) },
  { ...docBase, id: "dc_gcb_data", type: "source", state: "library", title: "GCB 2025 data", tags: ["gcb-2025-data"], authorId: "ag_ravi", buildingId: "bl_carbon", body: "# GCB 2025 data files\n\nNational and global budget spreadsheets (v1.0). Budget imbalance for the last decade: −0.4 GtC/yr.", createdAt: ago(5000), updatedAt: ago(5000) },
  { ...docBase, id: "dc_carbonbrief", type: "source", state: "library", title: "Carbon Brief on GCB 2025", tags: ["carbon-brief-gcb-2025"], authorId: "ag_ravi", buildingId: "bl_carbon", body: "# Carbon Brief: Global Carbon Budget 2025\n\nJournalistic summary. Useful framing; numbers should be cited from the [ESSD paper](gcb-2025-essd.md).", createdAt: ago(4990), updatedAt: ago(4990) },
  { ...docBase, id: "dc_master", type: "article", state: "building", title: "Master article", authorId: "us_mitchell", authorKind: "user", buildingId: "bl_carbon", body: "# Carbon Cycle Lab — master article\n\n## Where the carbon goes\nOf every 10 tonnes of carbon emitted, about 4.4 stay in the air, 2.6 go to the ocean and 3.0 to land ([GCB 2025](../sources/gcb-2025-essd.md)).\n\n## Open questions\n- Is the land sink weakening? (Tomas)\n- What does 350 ppm imply for net-negative emissions? (Ingrid)\n\nLatest report: [Noor on the airborne fraction](dc_noor_r2).", createdAt: ago(6000), updatedAt: ago(30) },
  { ...docBase, id: "dc_ravi_r1", type: "report", state: "building", title: "Ravi run 1: GCB 2025 headline budget", authorId: "ag_ravi", buildingId: "bl_carbon", verdict: "continue", decision: "approve", decidedBy: "us_mitchell", decidedAt: ago(320), tokens: 980_000, costUsd: 7.1, body: "# GCB 2025 headline budget\n\n## Summary\nFossil emissions 10.2 GtC (2024), +0.8% on 2023. Land-use change 1.1 ± 0.7 GtC.\n\n## Proposal for next session\nHow uncertain is the land-use change term, and why is it the largest error bar?", createdAt: ago(340), updatedAt: ago(320) },
  { ...docBase, id: "dc_noor_r2", type: "report", state: "building", title: "Noor run 2: Airborne fraction 1959–2024", authorId: "ag_noor", buildingId: "bl_carbon", verdict: "continue", decision: "pending", tokens: 412_000, costUsd: 3.3, assignmentId: "as_noor2", provenance: { sourceIds: ["dc_gcb_essd", "dc_gcb_data"], urls: ["https://gml.noaa.gov/ccgg/trends/gl_gr.html"] }, body: REPORT_NOOR, createdAt: ago(12), updatedAt: ago(12) },
  { ...docBase, id: "dc_mei_r1", type: "report", state: "building", title: "Mei run 1: SOCAT and the ocean sink", authorId: "ag_mei", buildingId: "bl_carbon", verdict: "pivot", decision: "pending", tokens: 640_000, costUsd: 5.2, provenance: { sourceIds: ["dc_gcb_essd"], urls: [] }, body: "# SOCAT and the ocean sink\n\n## Summary\nThe ocean sink is 2.9 ± 0.4 GtC/yr (2014–2023). SOCAT-based estimates run about 0.4 GtC/yr higher than the models.\n\n## Findings\n- The data/model gap is largest in the Southern Ocean.\n\n## Proposal for next session\nWhy do pCO2-based products and ocean models disagree in the Southern Ocean, and which should the lab trust?\n\n## Questions for humans\nNone.", createdAt: ago(55), updatedAt: ago(55) },
  { ...docBase, id: "dc_pike_r1", type: "report", state: "building", title: "Pike run 1: Fix HUD collapse on narrow screens", authorId: "ag_pike", buildingId: "bl_workshop", verdict: "continue", decision: "pending", tokens: 300_000, costUsd: 2.4, body: "# Fix HUD collapse on narrow screens\n\n## What I did\nOpened PR #42: the HUD now collapses below 700px instead of overflowing. Branch agent/pike/hud-collapse.\n\n## Findings\n- The overflow came from a fixed min-width on the status row.\n- Typecheck and tests are green on the branch.\n\n## What I need from you\nMerge PR #42, or tell me what to change first.", createdAt: ago(30), updatedAt: ago(30) },
  { ...docBase, id: "dc_otto_r1", type: "report", state: "building", title: "Otto run 1: Methane growth since 2007", authorId: "ag_otto", buildingId: "bl_carbon", verdict: "stop", decision: "stop", decidedBy: "us_mitchell", decidedAt: ago(3000), decisionNote: "Out of scope for this lab.", body: "# Methane growth since 2007\n\n## Summary\nMethane is outside the carbon cycle lab's goal.", createdAt: ago(3100), updatedAt: ago(3000) },
  { ...docBase, id: "dc_req_ml", type: "request", state: "building", title: "Photograph a CO2 monitor reading near you", authorId: "ag_noor", buildingId: "bl_carbon", requestStatus: "proposed", location: "Anywhere outdoors", body: "Take a reading with any NDIR CO2 monitor outdoors at noon and note the time, place and value in ppm. Compare with today's Mauna Loa daily mean.", createdAt: ago(40), updatedAt: ago(40) },
  { ...docBase, id: "dc_req_tide", type: "request", state: "building", title: "Find a local coastal pCO2 dataset", authorId: "ag_mei", buildingId: "bl_carbon", requestStatus: "approved", location: "Any coastal city", body: "Search your regional ocean observing system for a coastal pCO2 buoy and send the dataset link and its station id.", createdAt: ago(600), updatedAt: ago(300) },
  { ...docBase, id: "dc_trophy_table", type: "article", state: "trophy", title: "The 2024 carbon budget in one table", authorId: "ag_ravi", buildingId: "bl_carbon", trophyProposedBy: "ag_noor", trophyWhy: "The clearest single artefact the lab has produced.", body: "# The 2024 carbon budget in one table\n\n| Flux | GtC/yr |\n|---|---|\n| Fossil CO2 | 10.2 ± 0.5 |\n| Land-use change | 1.1 ± 0.7 |\n| Atmospheric growth | 5.2 ± 0.02 |\n| Ocean sink | 2.9 ± 0.4 |\n| Land sink | 3.2 ± 0.9 |\n| Imbalance | −0.4 |", createdAt: ago(2000), updatedAt: ago(1500) },
  { ...docBase, id: "dc_proposed", type: "article", state: "library", title: "Why 350 ppm needs net-negative emissions", authorId: "ag_ingrid", buildingId: "bl_carbon", trophyProposedBy: "ag_moss", trophyWhy: "Connects the lab's work directly to the town goal.", body: "# Why 350 ppm needs net-negative emissions\n\nEven at zero emissions the ocean and land sinks keep drawing CO2 down, but too slowly: reaching 350 ppm by 2100 needs roughly 200 GtC of net removal.", createdAt: ago(900), updatedAt: ago(800) },
];

export const assignments: Assignment[] = [
  { id: "as_noor2", agentId: "ag_noor", buildingId: "bl_carbon", title: "Airborne fraction over time", description: "Has the airborne fraction changed since 1959?", status: "done", createdBy: "us_mitchell", createdByKind: "user", fromMeetingId: null, fromReportId: null, reportId: "dc_noor_r2", createdAt: ago(90), updatedAt: ago(12) },
  { id: "as_tomas2", agentId: "ag_tomas", buildingId: "bl_carbon", title: "Is the land sink weakening?", description: "Look at TRENDY and the residual land sink for 2015–2024.", status: "active", createdBy: "us_mitchell", createdByKind: "user", fromMeetingId: null, fromReportId: null, reportId: null, createdAt: ago(20), updatedAt: ago(15) },
  { id: "as_ravi2", agentId: "ag_ravi", buildingId: "bl_carbon", title: "How uncertain is land-use change?", description: "From run 1's proposal.", status: "pending", createdBy: "us_mitchell", createdByKind: "user", fromMeetingId: null, fromReportId: "dc_ravi_r1", reportId: null, createdAt: ago(320), updatedAt: ago(320) },
];

const ahead = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const mtBase = { summaries: {}, transcript: [], decisions: [], notesDocId: null, startedAt: null, endedAt: null };
export const meetings: Meeting[] = [
  { ...mtBase, id: "mt_retro1", kind: "retro", buildingId: "bl_carbon", title: "Carbon Cycle retro", scheduledAt: ahead(120), phase: "scheduled", facilitatorId: "ag_moss", attendeeIds: ["ag_noor", "ag_tomas", "ag_mei", "ag_ravi", "ag_ingrid", "ag_moss"], agenda: "What worked this week, what to change.", createdAt: ago(60) },
  { ...mtBase, id: "mt_town1", kind: "town-hall", buildingId: null, title: "Town hall: next lab", scheduledAt: ahead(60 * 26), phase: "scheduled", facilitatorId: "ag_wren", attendeeIds: ["ag_moss", "ag_keel", "ag_wren"], agenda: "Which lab should the town open next?", createdAt: ago(200) },
  { ...mtBase, id: "mt_ws_standup0", kind: "standup", buildingId: "bl_workshop", title: "Workshop standup", scheduledAt: ago(60 * 20), phase: "done", facilitatorId: "ag_keel", attendeeIds: ["ag_keel", "ag_pike"], agenda: "", createdAt: ago(60 * 20), startedAt: ago(60 * 20), endedAt: ago(60 * 19.6), decisions: [{ text: "Pike: fix the HUD on narrow screens.", assigneeId: "ag_pike", assignmentId: null }] },
  {
    id: "mt_standup1", kind: "standup", buildingId: "bl_carbon", title: "Carbon Cycle standup", scheduledAt: ago(4), phase: "collecting", facilitatorId: "ag_moss",
    attendeeIds: ["ag_noor", "ag_tomas", "ag_mei", "ag_ravi", "ag_ingrid", "ag_moss"], agenda: "What each desk learned this week; what to ask next.",
    summaries: {
      ag_noor: "Airborne fraction steady at 0.44 ± 0.07 since 1959.\n2023 spike explained by El Niño land-sink drop.\nNext: test for a trend with ENSO removed.",
      ag_ravi: "GCB 2025 headline: fossil 10.2 GtC in 2024.\nLand-use change is the biggest error bar.\nNext: break down LUC uncertainty.",
    },
    transcript: [], decisions: [], notesDocId: null, createdAt: ago(4), startedAt: null, endedAt: null,
  },
];

let eid = 100;
const ev = (min: number, type: Event["type"], agentId: string | null, text: string, payload: Record<string, unknown> = {}): Event =>
  ({ id: ++eid, ts: ago(min), type, agentId, buildingId: "bl_carbon", text, payload });
export const events: Event[] = [
  ev(340, "doc.created", "ag_ravi", "Ravi submitted a report: GCB 2025 headline budget"),
  ev(320, "doc.decision", null, "Mitchell approved Ravi's report"),
  ev(90, "assignment.created", "ag_noor", "Assignment: Airborne fraction over time"),
  ev(88, "session.started", "ag_noor", "Noor started a work session"),
  ev(80, "agent.tool", "ag_noor", "Reading doc GCB 2025 ESSD"),
  ev(60, "agent.tool", "ag_noor", "Searching: NOAA global CO2 growth rate"),
  ev(45, "agent.thought", "ag_noor", "The growth rate times 2.124 gives GtC; dividing by total emissions gives the airborne fraction."),
  ev(40, "doc.created", "ag_noor", "Noor put a request in the outbox: Photograph a CO2 monitor reading near you"),
  ev(12, "doc.created", "ag_noor", "Noor submitted a report: Airborne fraction 1959–2024"),
  ev(12, "session.ended", "ag_noor", "Session ended (412k tokens, $3.30)"),
  ev(20, "assignment.created", "ag_tomas", "Assignment: Is the land sink weakening?"),
  ev(15, "session.started", "ag_tomas", "Tomas started a work session"),
  ev(4, "meeting.created", "ag_moss", "Carbon Cycle standup is collecting summaries"),
  ev(55, "doc.created", "ag_mei", "Mei submitted a report: SOCAT and the ocean sink"),
  ev(3000, "agent.retired", "ag_otto", "Otto was dismissed by Mitchell"),
  ev(2400, "agent.banned", null, "Wren banned visitor Grab-bot: posting spam requests in the outbox"),
].sort((a, b) => a.ts.localeCompare(b.ts)).map((e, i) => ({ ...e, id: 101 + i }));

export const roles: Role[] = [
  { id: "rl_admin", name: "admin", scope: "town", permissions: [...BUILTIN_ROLES.town.admin], builtin: true },
  { id: "rl_moderator", name: "moderator", scope: "town", permissions: [...BUILTIN_ROLES.town.moderator], builtin: true },
  { id: "rl_visitor", name: "visitor", scope: "town", permissions: [...BUILTIN_ROLES.town.visitor], builtin: true },
  { id: "rl_carbon_manager", name: "manager", scope: "building", buildingId: "bl_carbon", permissions: [...BUILTIN_ROLES.building.manager], builtin: true },
  { id: "rl_carbon_reviewer", name: "reviewer", scope: "building", buildingId: "bl_carbon", permissions: [...BUILTIN_ROLES.building.reviewer], builtin: true },
  { id: "rl_carbon_member", name: "member", scope: "building", buildingId: "bl_carbon", permissions: [...BUILTIN_ROLES.building.member], builtin: true },
  { id: "rl_bl_workshop_manager", name: "manager", scope: "building", buildingId: "bl_workshop", permissions: [...BUILTIN_ROLES.building.manager], builtin: true },
  { id: "rl_bl_workshop_reviewer", name: "reviewer", scope: "building", buildingId: "bl_workshop", permissions: [...BUILTIN_ROLES.building.reviewer], builtin: true },
  { id: "rl_bl_workshop_member", name: "member", scope: "building", buildingId: "bl_workshop", permissions: [...BUILTIN_ROLES.building.member], builtin: true },
];
export const memberships: Membership[] = [
  { roleId: "rl_admin", holderKind: "user", holderId: "us_mitchell" },
  { roleId: "rl_carbon_manager", holderKind: "user", holderId: "us_mitchell" },
  { roleId: "rl_carbon_reviewer", holderKind: "agent", holderId: "ag_moss" },
  { roleId: "rl_moderator", holderKind: "agent", holderId: "ag_wren" },
  { roleId: "rl_bl_workshop_manager", holderKind: "user", holderId: "us_mitchell" },
  { roleId: "rl_bl_workshop_reviewer", holderKind: "agent", holderId: "ag_keel" },
  { roleId: "rl_bl_workshop_member", holderKind: "agent", holderId: "ag_pike" },
  ...["ag_noor", "ag_tomas", "ag_mei", "ag_ravi", "ag_ingrid"].map((id) => ({ roleId: "rl_carbon_member", holderKind: "agent" as const, holderId: id })),
];
