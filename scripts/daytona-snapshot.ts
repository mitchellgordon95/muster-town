/**
 * Build the Daytona snapshot that sandbox desks are created from (`desks.backend: "daytona"`), from packages/desk/Dockerfile.
 * Run from the repo root with DAYTONA_API_KEY in the environment:  npx tsx scripts/daytona-snapshot.ts [name] [--replace]
 * The SDK takes COPY sources relative to the Dockerfile's own directory, but ours are relative to the repo root, so a copy of
 * the Dockerfile is staged at the root for the build and removed afterwards.
 */
import { copyFileSync, rmSync } from "node:fs";
import { Daytona, Image } from "@daytona/sdk";

const name = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "muster-town-desk";
const replace = process.argv.includes("--replace");
const staged = ".daytona-desk.Dockerfile";

const daytona = new Daytona();
if (replace) {
  try { await daytona.snapshot.delete(await daytona.snapshot.get(name)); console.log(`deleted existing snapshot ${name}`); } catch { /* none */ }
}
copyFileSync("packages/desk/Dockerfile", staged);
try {
  const image = Image.fromDockerfile(staged);
  console.log(`building snapshot ${name} (${image.contextList.length} context entries)…`);
  const snap = await daytona.snapshot.create({ name, image, resources: { cpu: 2, memory: 2, disk: 8 } }, { onLogs: (l: string) => console.log(l) });
  console.log(`snapshot ${snap.name}: ${snap.state}`);
} finally {
  rmSync(staged, { force: true });
}
