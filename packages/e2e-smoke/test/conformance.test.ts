// Contract-conformance (OpenAPI ↔ implemented routes). For every service it reconciles
// the Hono route set parsed from src/app.ts against the OpenAPI spec's paths (canonical
// docs/openapi/ when present, else the vendored PR #59 snapshot). The per-service drift
// map is asserted against a committed golden baseline so any future divergence between
// code and contract turns this suite red; the baseline file itself is the recorded
// "mismatch report". A few explicit checks guarantee the smoke's core CRUD is documented.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { conformanceAll, conformanceFor, driftBaseline } from "../src/conformance";

const BASELINE = fileURLToPath(new URL("../conformance-baseline.json", import.meta.url));

describe("OpenAPI ↔ route conformance", () => {
  it("prints a per-service reconciliation summary", () => {
    const rows = conformanceAll().map((c) => ({
      service: c.service,
      spec: c.specSource,
      code: c.code.length,
      documented: c.spec.length,
      undocumented: c.missingInSpec.length,
      unimplemented: c.missingInCode.length,
    }));
    // Surfaced in the test output so the reconciliation is visible in CI logs.
    // eslint-disable-next-line no-console
    console.table(rows);
    expect(rows.length).toBe(16);
  });

  it("matches the committed drift baseline (code vs OpenAPI)", () => {
    const current = driftBaseline();
    if (!existsSync(BASELINE)) {
      writeFileSync(BASELINE, JSON.stringify(current, null, 2) + "\n");
      // eslint-disable-next-line no-console
      console.warn(`[conformance] baseline bootstrapped at ${BASELINE}`);
    }
    const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
    expect(current).toEqual(baseline);
  });

  // The four services the integration smoke exercises must have their primary
  // write surface documented — a hard floor independent of the golden baseline.
  it("core smoke routes are present in both code and spec", () => {
    const expectations: Record<string, string[]> = {
      "event-service": ["POST /events", "GET /events/{}", "POST /events/{}/actions"],
      "task-service": ["POST /tasks", "GET /tasks", "PATCH /tasks/{}"],
      notification: ["GET /inbox", "GET /inbox/unread-count"],
      "mail-gateway": ["POST /send"],
    };
    for (const [service, routes] of Object.entries(expectations)) {
      const c = conformanceFor(service as never);
      for (const r of routes) {
        expect(c.code, `${service} code should declare ${r}`).toContain(r);
        expect(c.spec, `${service} spec should document ${r}`).toContain(r);
      }
    }
  });
});
