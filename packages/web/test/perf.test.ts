import { describe, expect, it } from "vitest";
import { fmtMs, fmtPerf } from "../src/format";

describe("session performance line", () => {
  it("wall · cpu · steal share of cpu + steal", () => {
    expect(fmtPerf({ wallMs: 1_860_000, cpuMs: 270_000, stealMs: 2_184_000 })).toBe("wall 31m · cpu 4.5m · steal 89%");
    expect(fmtPerf({ wallMs: 600_000, cpuMs: 300_000, stealMs: 15_000 })).toBe("wall 10m · cpu 5m · steal 4.8%");
    expect(fmtPerf({ wallMs: 1_860_000, cpuMs: 270_000, stealMs: 8_000, cpuKind: "performance", cpus: 1 })).toBe("perf-1x · wall 31m · cpu 4.5m · steal 2.9%");
  });
  it("leaves out what wasn't measured", () => {
    expect(fmtPerf({ wallMs: 45_000, cpuMs: null, stealMs: null })).toBe("wall 45s");
    expect(fmtPerf({ wallMs: null })).toBeNull();
    expect(fmtMs(5_400_000)).toBe("1.5h");
  });
});
