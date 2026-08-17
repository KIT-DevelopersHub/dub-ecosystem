// Wire-parameter conformance: query-parameter NAMES reconciled across the three sides
// of every contract, so the `?event=` (fe) vs `?eventId=` (server) class of drift is
// caught in CI instead of in production.
//
//   SoT (@dub/types GANTT_WIRE)  ⟷  OpenAPI spec (docs/openapi/*.yaml)  ⟷  server reads
//
// The existing conformance.test.ts reconciles method+PATH only; this adds the query-key
// dimension it is blind to. gantt is the proof endpoint (the one that actually broke);
// docs/api-contracts/_wire-contract-enforcement.md documents extending this per service.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { gantt } from "@dub/types";
import { extractQueryParamsFromFile } from "../src/openapi";
import { specPathFor, appPathFor } from "../src/conformance";

/** All `c.req.query("X")` keys a service's app source reads. */
function serverQueryKeys(service: "gantt-service"): Set<string> {
  const src = readFileSync(appPathFor(service), "utf8");
  const re = /\.req\.query\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
  const keys = new Set<string>();
  for (let m; (m = re.exec(src)); ) keys.add(m[1]!);
  return keys;
}

describe("gantt wire-contract: query keys agree across SoT ⟷ OpenAPI ⟷ server", () => {
  const specParams = extractQueryParamsFromFile(specPathFor("gantt-service").file);
  const serverKeys = serverQueryKeys("gantt-service");

  // Union of every query key the SoT declares for gantt (here: just "eventId").
  const sotKeys = new Set<string>(Object.values(gantt.GANTT_WIRE).flatMap((e) => [...e.query]));

  for (const [op, endpoint] of Object.entries(gantt.GANTT_WIRE)) {
    it(`${op}: OpenAPI query params == GANTT_WIRE (${endpoint.query.join(",")})`, () => {
      // operationId in the spec matches the GANTT_WIRE key by construction.
      expect(specParams[op] ?? []).toEqual([...endpoint.query].sort());
    });
  }

  it("server reads only the SoT query keys (never a drifted alias like `event`)", () => {
    for (const key of serverKeys) {
      expect(sotKeys.has(key), `gantt-service reads c.req.query("${key}") not in the SoT`).toBe(true);
    }
    // and every SoT key is actually consumed by the server
    for (const key of sotKeys) {
      expect(serverKeys.has(key), `SoT key "${key}" is never read by gantt-service`).toBe(true);
    }
  });

  it("guards against the exact production regression (`event` is not a wire key anywhere)", () => {
    expect(sotKeys.has("event")).toBe(false);
    expect(serverKeys.has("event")).toBe(false);
    for (const params of Object.values(specParams)) expect(params).not.toContain("event");
  });
});
