import type { World } from "./world.ts";

/** Short, easy-to-say first names for new residents, so nobody has to invent one to add a resident. */
export const RESIDENT_NAMES = [
  "Ada", "Alma", "Amir", "Anya", "Arlo", "Asha", "Beni", "Bo", "Cleo", "Dara", "Dev", "Eli", "Elin", "Emre", "Esme", "Ezra",
  "Fern", "Finn", "Gia", "Hana", "Ines", "Ira", "Ivo", "Jada", "Jin", "Juno", "Kai", "Kira", "Lars", "Lena", "Leo", "Lina",
  "Luca", "Mae", "Mara", "Mika", "Milo", "Nell", "Nia", "Nico", "Nils", "Noa", "Oli", "Omar", "Ona", "Otto", "Pia", "Quin",
  "Rafa", "Remy", "Rhea", "Rio", "Rosa", "Rui", "Sami", "Sana", "Sol", "Suri", "Tae", "Tali", "Teo", "Tess", "Uma", "Vera",
  "Wren", "Yara", "Yuki", "Zane", "Zara", "Zoe",
];

/**
 * A resident name no agent in the town already uses (case-insensitive), picked at random.
 * `avoid` also skips names (e.g. ones just offered). If the pool runs out, names get a number: "Lena 2".
 */
export function suggestResidentName(world: World, avoid: Iterable<string> = [], rand: () => number = Math.random): string {
  // forks ("Pix 3") are named after their manager, so their names never block a resident's
  const taken = new Set([...world.agents.where("forkOf IS NULL").map((a) => a.name), ...avoid].map((n) => n.toLowerCase()));
  const free = RESIDENT_NAMES.filter((n) => !taken.has(n.toLowerCase()));
  if (free.length) return free[Math.floor(rand() * free.length)];
  for (let i = 2; ; i++) {
    const n = RESIDENT_NAMES.map((b) => `${b} ${i}`).filter((x) => !taken.has(x.toLowerCase()));
    if (n.length) return n[Math.floor(rand() * n.length)];
  }
}
