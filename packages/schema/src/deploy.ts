/**
 * Which changed files make a deploy: the server's prod-branch puller (runtime prod-watch.ts) restarts only for them, and the
 * monitor's `deploy` key (server deploy-watch.ts) only counts them, so the two agree on "docs-only".
 */

/** A change that needs a restart to go live: anything but docs/, .github/ and top-level *.md; docs/manual.md is served by the server, so it counts. */
export function deployable(file: string): boolean {
  if (file === "docs/manual.md") return true;
  return !/^(docs\/|\.github\/|[^/]+\.md$)/.test(file);
}
