import { describe, it, expect } from "vitest";
import {
  readHeader,
  readRequestId,
  readCorrelation,
  correlationHeaders,
} from "../src/index";
import { HDR_REQUEST_ID, HDR_USER_ID, HDR_CALLER } from "../src/index";

describe("request correlation helpers", () => {
  it("reads headers from a Headers instance (case-insensitive)", () => {
    const h = new Headers({ [HDR_REQUEST_ID]: "r1" });
    expect(readRequestId(h)).toBe("r1");
    expect(readHeader(h, "X-DUB-REQUEST-ID")).toBe("r1");
  });

  it("reads headers from a Request", () => {
    const req = new Request("https://x/y", { headers: { [HDR_USER_ID]: "u1" } });
    expect(readHeader(req, HDR_USER_ID)).toBe("u1");
  });

  it("reads headers from a plain object case-insensitively", () => {
    const rec = { "X-Dub-Request-Id": "r2" };
    expect(readRequestId(rec)).toBe("r2");
  });

  it("returns undefined for missing headers and undefined source", () => {
    expect(readRequestId(undefined)).toBeUndefined();
    expect(readHeader(new Headers(), HDR_CALLER)).toBeUndefined();
  });

  it("readCorrelation extracts the triplet, omitting absent fields", () => {
    const req = new Request("https://x/y", {
      headers: { [HDR_REQUEST_ID]: "r1", [HDR_CALLER]: "gw" },
    });
    expect(readCorrelation(req)).toEqual({ requestId: "r1", caller: "gw" });
  });

  it("correlationHeaders emits only defined x-dub-* pairs for propagation", () => {
    expect(correlationHeaders({ requestId: "r1", caller: "gw" })).toEqual({
      [HDR_REQUEST_ID]: "r1",
      [HDR_CALLER]: "gw",
    });
    expect(correlationHeaders({})).toEqual({});
  });

  it("round-trips: read from inbound, propagate to outbound", () => {
    const inbound = new Request("https://x/y", {
      headers: { [HDR_REQUEST_ID]: "r1", [HDR_USER_ID]: "u1" },
    });
    const out = correlationHeaders(readCorrelation(inbound));
    expect(out[HDR_REQUEST_ID]).toBe("r1");
    expect(out[HDR_USER_ID]).toBe("u1");
  });
});
