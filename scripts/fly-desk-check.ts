// Live smoke test of the Fly desk backend (creates a throwaway Machine + volume, runs commands, cleans up; costs a few cents).
// node --env-file=collectives/workshop/.env --import tsx scripts/fly-desk-check.ts
import { FlyApi, SandboxBackend } from "../packages/runtime/src/index.ts";

const api = new FlyApi({ app: process.env.FLY_APP!, token: process.env.FLY_API_TOKEN!, image: `registry.fly.io/${process.env.FLY_APP}:desk`, pollMs: 2000 });
const b = new SandboxBackend({ api, collective: "livetest", heartbeatMs: 0, idleStopMs: 600_000 });
const agent = { id: "ag_probe" } as any;
const t0 = Date.now(); const el = () => ((Date.now() - t0) / 1000).toFixed(0) + "s";
const run = async (label: string, argv: string[], env: Record<string, string> = {}) => {
  const h = await b.ensure(agent, {} as any);
  console.log(`[${el()}] ${label}: ensured`);
  const lines: string[] = [];
  const code = await b.exec(h, argv, env, (s, l) => lines.push(l)).wait();
  console.log(`[${el()}] ${label}: exit ${code}\n  ` + lines.join("\n  "));
  return code;
};
try {
  await run("basics", ["sh", "-c", "whoami; echo HOME=$HOME; pwd; node --version; ls -ld /home/agent; echo SECRET=$MY_SECRET; curl -s -m 8 -o /dev/null -w 'egress %{http_code}\\n' https://example.com; touch /home/agent/persist.txt; which agent-town-desk"], { MY_SECRET: "it's s3cret" });
  console.log(`[${el()}] -- long run (past the 60 s exec limit)`);
  await run("long", ["sh", "-c", "for i in 1 2 3 4; do echo tick $i; sleep 20; done; echo finished"]);
  console.log(`[${el()}] -- stop, then start again`);
  await api.stop("desk-livetest-ag_probe");
  await new Promise((r) => setTimeout(r, 8000));
  await run("after restart", ["sh", "-c", "ls -l /home/agent/persist.txt; whoami"]);
} catch (e) {
  console.log("ERR", e instanceof Error ? e.message : e);
} finally {
  await b.remove("ag_probe", { purge: true });
  console.log(`[${el()}] cleaned up`);
  process.exit(0);
}
