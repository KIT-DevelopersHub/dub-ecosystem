// The router and POLICY_TABLE must match both ways.
import { describe, expect, it } from "vitest";
import { assertRouteCoverage } from "@dub/policy-gate";
import { createApp } from "../src/app";
import { POLICY_TABLE } from "../src/policy-table";

describe("route coverage (POLICY_TABLE <-> router)", () => {
  it("every registered endpoint has exactly one rule, and no rule is orphaned", () => {
    expect(() => assertRouteCoverage(createApp({ authz: async () => [] }), POLICY_TABLE)).not.toThrow();
  });
});
