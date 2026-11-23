import { describe, expect, it } from "vitest";
import { parseMeminfo } from "../src/meminfo.ts";

const SAMPLE = `MemTotal:        2014412 kB
MemFree:          101236 kB
MemAvailable:     409600 kB
Buffers:           20480 kB
SwapCached:            0 kB
SwapTotal:       1048576 kB
SwapFree:         786432 kB
HugePages_Total:       0
`;

describe("parseMeminfo", () => {
  it("reads MemAvailable, SwapTotal and SwapFree in MiB", () => {
    expect(parseMeminfo(SAMPLE)).toEqual({ memAvailableMb: 400, swapTotalMb: 1024, swapFreeMb: 768 });
  });
  it("no swap lines read 0; no MemAvailable is null", () => {
    expect(parseMeminfo("MemAvailable:  1536 kB\n")).toEqual({ memAvailableMb: 2, swapTotalMb: 0, swapFreeMb: 0 });
    expect(parseMeminfo("MemTotal: 2014412 kB\nSwapTotal: 0 kB\n")).toBeNull();
    expect(parseMeminfo("")).toBeNull();
  });
});
