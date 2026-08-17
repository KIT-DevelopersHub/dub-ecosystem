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
import { gantt, event, fileMeta, webhook } from "@dub/types";
import { extractQueryParamsFromFile } from "../src/openapi";
import { specPathFor, appPathFor, type ServiceName } from "../src/conformance";

/** Every query-parameter name a service's app source actually consumes. Handles both
 *  read styles Dub services use:
 *    (a) keyed:        c.req.query("X")            -> "X"
 *    (b) destructured: const q = c.req.query(); q.X -> "X"
 *  so the "server reads == SoT" reconciliation works whether a handler pulls one key or
 *  destructures the whole query object. */
function serverQueryKeys(service: ServiceName): Set<string> {
  const src = readFileSync(appPathFor(service), "utf8");
  const keys = new Set<string>();
  // (a) keyed reads.
  const keyed = /\.req\.query\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
  for (let m; (m = keyed.exec(src)); ) keys.add(m[1]!);
  // (b) whole-object reads: find each var bound to a no-arg `c.req.query()`, then its `.prop` reads.
  const bind = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$.]*\.req\.query\(\s*\)/g;
  const vars = new Set<string>();
  for (let m; (m = bind.exec(src)); ) vars.add(m[1]!);
  for (const v of vars) {
    const prop = new RegExp(`\\b${v}\\.([A-Za-z_$][\\w$]*)`, "g");
    for (let m; (m = prop.exec(src)); ) keys.add(m[1]!);
  }
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

describe("event wire-contract: query keys agree across SoT ⟷ OpenAPI ⟷ server", () => {
  const specParams = extractQueryParamsFromFile(specPathFor("event-service").file);
  const serverKeys = serverQueryKeys("event-service");

  // Union of every query key the SoT declares across event-service read endpoints.
  const sotKeys = new Set<string>(Object.values(event.EVENT_WIRE).flatMap((e) => [...e.query]));

  for (const [op, endpoint] of Object.entries(event.EVENT_WIRE)) {
    it(`${op}: OpenAPI query params == EVENT_WIRE (${endpoint.query.join(",")})`, () => {
      // operationId in the spec matches the EVENT_WIRE key by construction.
      expect(specParams[op] ?? []).toEqual([...endpoint.query].sort());
    });
  }

  it("server reads exactly the SoT query keys (no drifted alias, no undocumented read)", () => {
    for (const key of serverKeys) {
      expect(sotKeys.has(key), `event-service reads query key "${key}" not in the SoT`).toBe(true);
    }
    for (const key of sotKeys) {
      expect(serverKeys.has(key), `SoT key "${key}" is never read by event-service`).toBe(true);
    }
  });
});

describe("file-meta wire-contract: query keys agree across SoT ⟷ OpenAPI ⟷ server", () => {
  const specParams = extractQueryParamsFromFile(specPathFor("file-meta").file);
  const serverKeys = serverQueryKeys("file-meta");

  // Union of every query key the SoT declares across file-meta read endpoints.
  const sotKeys = new Set<string>(Object.values(fileMeta.FILE_META_WIRE).flatMap((e) => [...e.query]));

  for (const [op, endpoint] of Object.entries(fileMeta.FILE_META_WIRE)) {
    it(`${op}: OpenAPI query params == FILE_META_WIRE (${endpoint.query.join(",")})`, () => {
      expect(specParams[op] ?? []).toEqual([...endpoint.query].sort());
    });
  }

  it("server reads exactly the SoT query keys (no drifted alias, no undocumented read)", () => {
    for (const key of serverKeys) {
      expect(sotKeys.has(key), `file-meta reads query key "${key}" not in the SoT`).toBe(true);
    }
    for (const key of sotKeys) {
      expect(serverKeys.has(key), `SoT key "${key}" is never read by file-meta`).toBe(true);
    }
  });
});

describe("webhook-ingest wire-contract: query keys agree across SoT ⟷ OpenAPI ⟷ server", () => {
  const specParams = extractQueryParamsFromFile(specPathFor("webhook-ingest").file);
  const serverKeys = serverQueryKeys("webhook-ingest");

  const sotKeys = new Set<string>(Object.values(webhook.WEBHOOK_WIRE).flatMap((e) => [...e.query]));

  for (const [op, endpoint] of Object.entries(webhook.WEBHOOK_WIRE)) {
    it(`${op}: OpenAPI query params == WEBHOOK_WIRE (${endpoint.query.join(",")})`, () => {
      expect(specParams[op] ?? []).toEqual([...endpoint.query].sort());
    });
  }

  it("server reads exactly the SoT query keys (no drifted alias, no undocumented read)", () => {
    for (const key of serverKeys) {
      expect(sotKeys.has(key), `webhook-ingest reads query key "${key}" not in the SoT`).toBe(true);
    }
    for (const key of sotKeys) {
      expect(serverKeys.has(key), `SoT key "${key}" is never read by webhook-ingest`).toBe(true);
    }
  });
});
