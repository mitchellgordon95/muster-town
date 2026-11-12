import { defineConfig } from "vitest/config";

// isolate: false: one module graph per worker instead of a fresh one per test file. Core's test files spend most of
// their time importing (in CI vitest's "collect" summed ~77 s of an ~84 s core run); without isolation each worker
// imports core once. Every test opens its own fresh database, so no state crosses files that way. A package whose
// modules keep state at module level (runtime: cache-miss.ts's memo, the sandbox timers) stays isolated.
// CI only: on a 2 GB desk Machine (no swap) the shared graph grows past the guest's memory (11-12: core went from 1.5 GB to
// under 350 MB free in 67 s; isolated, it never went under 1.1 GB), the guest freezes and the session dies "desk exited -1".
// GitHub Actions sets CI; a desk or a laptop keeps isolation.
export default defineConfig({
  test: { isolate: !process.env.CI },
});
