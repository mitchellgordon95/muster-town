import { describe, expect, it } from "vitest";
import { parseProcStat, readProcStat, startPerf } from "../src/perf.ts";

const LINE = "cpu  4705 356 584 3699176 23060 0 277 87654 0 0\ncpu0 1393 280 290 1844 2286 0 0 3 0 0\nintr 114930548 113199788 3 0";

describe("/proc/stat", () => {
  it("parses cpu = user+nice+system and steal (column 8) from the aggregate line", () => {
    expect(parseProcStat(LINE)).toEqual({ cpu: 4705 + 356 + 584, steal: 87654 });
    expect(parseProcStat("cpu0 1 2 3 4 5 6 7 8")).toBeNull();
    expect(parseProcStat("cpu  1 2 3")).toBeNull();
    expect(parseProcStat("")).toBeNull();
  });

  it("an unreadable file is null, not a throw", () => {
    expect(readProcStat("/nonexistent/proc/stat")).toBeNull();
  });

  it("measures the session's deltas in ms (10 ms a jiffy); unreadable at start → wallMs only", () => {
    let t = 1000;
    const reads = [{ cpu: 100, steal: 50 }, { cpu: 127, steal: 268 }];
    const p = startPerf(() => reads.shift()!, () => t);
    t += 1_860_000;
    expect(p.finish()).toEqual({ wallMs: 1_860_000, cpuMs: 270, stealMs: 2180 });
    expect(startPerf(() => null, () => 0).finish()).toEqual({ wallMs: 0 });
  });
});
