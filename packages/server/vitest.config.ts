import { defineConfig } from "vitest/config";

// isolate: false: one module graph per worker instead of a fresh one per test file. Server's test files spend most of
// their time importing (in CI vitest's "collect" summed ~34 s of a ~36 s server run); without isolation each worker
// imports the server once. Every test opens its own fresh database, so no state crosses files that way. A package whose
// modules keep state at module level (runtime: cache-miss.ts's memo, the sandbox timers) stays isolated.
export default defineConfig({
  test: { isolate: false },
});
