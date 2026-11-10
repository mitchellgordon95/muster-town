import { defineConfig } from "vitest/config";

// One vitest run over every tested workspace (scripts/check.ts TESTED): one worker pool for all test files.
export default defineConfig({
  test: {
    projects: ["packages/{core,runtime,server,cli,desk,web}"],
    passWithNoTests: true,
  },
});
