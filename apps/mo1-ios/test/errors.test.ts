import { describe, it, expect } from "vitest";
import { fromResponseBody, offlineError } from "../src/errors.js";
import { errBody } from "./helpers.js";

describe("semi-open error mapping (design §6)", () => {
  it("maps common codes to their kind", () => {
    expect(fromResponseBody(401, errBody("UNAUTHENTICATED")).kind).toBe("reauth");
    expect(fromResponseBody(403, errBody("FORBIDDEN")).kind).toBe("forbidden");
    expect(fromResponseBody(400, errBody("VALIDATION_FAILED")).kind).toBe("validation");
    expect(fromResponseBody(409, errBody("CONFLICT")).kind).toBe("conflict");
    expect(fromResponseBody(429, errBody("RATE_LIMITED")).kind).toBe("rate_limited");
    expect(fromResponseBody(502, errBody("UPSTREAM_UNAVAILABLE")).kind).toBe("upstream");
  });

  it("classifies OPEN service codes by suffix without dropping them", () => {
    const conflict = fromResponseBody(409, errBody("TASK_VERSION_CONFLICT"));
    expect(conflict.kind).toBe("conflict");
    expect(conflict.code).toBe("TASK_VERSION_CONFLICT");

    const sync = fromResponseBody(410, errBody("MOBILE_SYNC_CURSOR_EXPIRED"));
    expect(sync.kind).toBe("sync_expired");
  });

  it("falls through to unknown for unmodelled code/status but keeps the code", () => {
    const e = fromResponseBody(418, errBody("SOMETHING_WEIRD", "teapot", { retryable: false }));
    expect(e.kind).toBe("unknown");
    expect(e.code).toBe("SOMETHING_WEIRD");
    expect(e.status).toBe(418);
  });

  it("reads Retry-After seconds from RATE_LIMITED details", () => {
    const e = fromResponseBody(429, errBody("RATE_LIMITED", "slow down", { details: { retryAfterSec: 3 } }));
    expect(e.retryAfterSec).toBe(3);
  });

  it("treats a non-envelope body as retryable upstream", () => {
    const e = fromResponseBody(500, { oops: true });
    expect(e.kind).toBe("upstream");
    expect(e.retryable).toBe(true);
  });

  it("offlineError is a retryable transport failure", () => {
    const e = offlineError(new Error("network down"));
    expect(e.kind).toBe("offline");
    expect(e.retryable).toBe(true);
    expect(e.status).toBe(0);
  });
});
