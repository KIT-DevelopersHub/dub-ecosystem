import { describe, it, expect } from "vitest";
import { createMetrics, metricsFor, type MetricEntry } from "../src/index";

function capture() {
  const out: MetricEntry[] = [];
  return { out, sink: (m: MetricEntry) => out.push(m) };
}

describe("createMetrics", () => {
  it("emits count/gauge/timing with type, value, requestId, service and time", () => {
    const { out, sink } = capture();
    const m = createMetrics({ requestId: "r1", service: "svc", sink });
    m.count("req");
    m.count("req", 5);
    m.gauge("queue.depth", 12);
    m.timing("db.ms", 34);
    expect(out.map((e) => [e.type, e.name, e.value])).toEqual([
      ["count", "req", 1],
      ["count", "req", 5],
      ["gauge", "queue.depth", 12],
      ["timing", "db.ms", 34],
    ]);
    expect(out[0]!.requestId).toBe("r1");
    expect(out[0]!.service).toBe("svc");
    expect(typeof out[0]!.time).toBe("string");
  });

  it("merges base tags with per-call tags (per-call wins)", () => {
    const { out, sink } = capture();
    const m = createMetrics({ tags: { env: "test", region: "a" }, sink });
    m.count("hit", 1, { region: "b", route: "/x" });
    expect(out[0]!.tags).toEqual({ env: "test", region: "b", route: "/x" });
  });

  it("startTimer records an elapsed timing and returns the elapsed ms", () => {
    const { out, sink } = capture();
    const m = createMetrics({ sink });
    const stop = m.startTimer("op.ms", { op: "x" });
    const elapsed = stop();
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("timing");
    expect(out[0]!.name).toBe("op.ms");
    expect(out[0]!.tags).toEqual({ op: "x" });
    expect(out[0]!.value).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });

  it("child() adds permanently-bound tags", () => {
    const { out, sink } = capture();
    const child = createMetrics({ tags: { a: "1" }, sink }).child({ b: "2" });
    child.count("c");
    expect(out[0]!.tags).toEqual({ a: "1", b: "2" });
  });

  it("metricsFor derives requestId/service from a correlation triplet", () => {
    const { out, sink } = capture();
    const m = metricsFor({ requestId: "r9", caller: "gw" }, { sink });
    m.count("x");
    expect(out[0]!.requestId).toBe("r9");
    expect(out[0]!.service).toBe("gw");
  });
});
