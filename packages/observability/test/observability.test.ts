import { describe, it, expect } from "vitest";
import { HEADERS, HDR_REQUEST_ID, INTERNAL_HEADER_VALUE, redactSecrets, DEFAULT_REDACT_KEYS } from "../src/index";

describe("@dub/observability", () => {
  it("exposes the canonical x-dub-* header constants", () => {
    expect(HDR_REQUEST_ID).toBe("x-dub-request-id");
    expect(HEADERS.userId).toBe("x-dub-user-id");
    expect(HEADERS.caller).toBe("x-dub-caller");
    expect(HEADERS.internal).toBe("x-dub-internal");
    expect(INTERNAL_HEADER_VALUE).toBe("1");
  });

  it("redacts secret keys case-insensitively and deeply", () => {
    const input = {
      user: "u1",
      Authorization: "Bearer abc",
      nested: { password: "p", token: "t", keep: "ok" },
      list: [{ apiKey: "k" }],
    };
    const out = redactSecrets(input);
    expect(out.Authorization).toBe("[REDACTED]");
    expect(out.nested.password).toBe("[REDACTED]");
    expect(out.nested.token).toBe("[REDACTED]");
    expect(out.nested.keep).toBe("ok");
    expect(out.list[0]!.apiKey).toBe("[REDACTED]");
    expect(input.Authorization).toBe("Bearer abc"); // original untouched
  });

  it("handles cyclic structures without throwing", () => {
    const a: Record<string, unknown> = { secret: "s" };
    a.self = a;
    const out = redactSecrets(a) as Record<string, unknown>;
    expect(out.secret).toBe("[REDACTED]");
    expect(out.self).toBe(out);
  });

  it("default redact list covers common secret keys", () => {
    expect(DEFAULT_REDACT_KEYS).toContain("token");
    expect(DEFAULT_REDACT_KEYS).toContain("password");
  });
});
