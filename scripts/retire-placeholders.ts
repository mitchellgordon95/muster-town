/**
 * Retire the placeholder "house" allocations so only real funding (the owner's subscription allocation and the
 * API-key buffer, entered in the Bank) remains. Retired allocations keep their spend history; they are just never
 * drawn from again and leave the building's budget. Dry run unless --apply.
 *
 *   npx tsx scripts/retire-placeholders.ts collectives/workshop           # list what it would retire
 *   npx tsx scripts/retire-placeholders.ts collectives/workshop --apply   # retire them
 *   npx tsx scripts/retire-placeholders.ts collectives/workshop --apply al_xxx  # also retire these ids
 *
 * Picks: allocations labelled house/placeholder, the ids given, and (unless --labelled-only) every unlabelled
 * allocation that isn't a donor's own key: all of those predate labels and were the lead's placeholders.
 * Run it with the collective's server stopped or idle (it opens the same SQLite file; the server sees the change
 * on its next read, but its cached sign numbers refresh on the next charge or donation).
 */
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { World } from "@muster-town/core";

/** The two placeholders the lead created in the workshop. */
const KNOWN = ["al_wsihhgeb4c", "al_ntis5p8hwi"];

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--") && !a.startsWith("al_"));
if (!target) {
  console.error("usage: npx tsx scripts/retire-placeholders.ts <collective dir | town.db> [--apply] [--labelled-only] [al_id ...]");
  process.exit(2);
}
const dbPath = statSync(resolve(target)).isDirectory() ? join(resolve(target), "data", "town.db") : resolve(target);
if (!existsSync(dbPath)) {
  console.error(`no database at ${dbPath}`);
  process.exit(1);
}
const apply = args.includes("--apply");
const ids = [...KNOWN, ...args.filter((a) => a.startsWith("al_"))];
const world = World.open(dbPath);
const picked = world.budget.retirePlaceholders({ ids, unlabelled: !args.includes("--labelled-only"), dryRun: !apply, byName: "Placeholder cleanup" });
if (!picked.length) console.log("No placeholder allocations to retire.");
for (const a of picked) {
  const b = world.buildings.get(a.buildingId)?.name ?? a.buildingId;
  console.log(`${apply ? "retired" : "would retire"} ${a.id} at ${b}: ${a.label || "(unlabelled)"}, ${a.auth}, ${a.tokens.toLocaleString("en-US")} allocated, ${a.spentTokens.toLocaleString("en-US")} spent`);
}
if (!apply && picked.length) console.log("Dry run. Re-run with --apply to retire them.");
world.close();
