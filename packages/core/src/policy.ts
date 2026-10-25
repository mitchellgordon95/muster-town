/**
 * Goal-directed budgets: the four open questions of docs/goal-directed-budgets.md, as constants, so Mitchell's answers
 * are one-line changes. The values are the design's defaults (waterfall §4, carried to step 5).
 */
export const BUDGET_POLICY = {
  /** Q1 exploration size: this share of the building's pool's daily inflow (a building's `explorationTokensPerDay` overrides it) */
  explorationShare: 0.1,
  /** Q1: false = the share is per building; true = split evenly across the buildings drawing on the pool */
  explorationSplitAcrossPool: false,
  /** Q2: true = directed work (a human asked for it) bypasses grants; false = in goal-directed buildings nobody creates directed work */
  directedBypassesGrants: true,
  /** Q3 who funds: "managers-and-admins" = humans holding the building's manager role and town admins; "admins" = town-level roles only. Never agents. */
  funders: "managers-and-admins" as "managers-and-admins" | "admins",
  /** Q4: false = grants are ceilings (the pool pays first come, first served); true = a funded grant's unspent tokens are held back from other lanes */
  grantReservations: false,
} as const;
