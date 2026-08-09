import { describe, it, expect } from "vitest";
import { signRequest } from "../src/sigv4";

const base = {
  method: "POST",
  host: "email.ap-northeast-1.amazonaws.com",
  path: "/v2/email/outbound-emails",
  service: "ses",
  region: "ap-northeast-1",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  payload: JSON.stringify({ hello: "world" }),
  now: new Date("2026-08-09T12:34:56.789Z"),
};

describe("sigv4 signRequest", () => {
  it("produces a well-formed Authorization header with correct scope + signed headers", async () => {
    const h = await signRequest(base);
    expect(h["content-type"]).toBe("application/json");
    expect(h["x-amz-date"]).toBe("20260809T123456Z");
    expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(h.authorization).toContain("Credential=AKIAEXAMPLE/20260809/ap-northeast-1/ses/aws4_request");
    expect(h.authorization).toContain("SignedHeaders=content-type;host;x-amz-date");
    const sig = /Signature=([0-9a-f]+)$/.exec(h.authorization ?? "");
    expect(sig).not.toBeNull();
    const signature = sig?.[1] ?? "";
    expect(signature).toHaveLength(64); // hex SHA-256 HMAC
  });

  it("is deterministic for identical inputs", async () => {
    const a = await signRequest(base);
    const b = await signRequest(base);
    expect(a.authorization).toBe(b.authorization);
  });

  it("changes the signature when the payload changes", async () => {
    const a = await signRequest(base);
    const b = await signRequest({ ...base, payload: JSON.stringify({ hello: "there" }) });
    expect(a.authorization).not.toBe(b.authorization);
  });

  it("changes the signature when the amz-date changes", async () => {
    const a = await signRequest(base);
    const b = await signRequest({ ...base, now: new Date("2026-08-10T00:00:00.000Z") });
    expect(a.authorization).not.toBe(b.authorization);
  });

  it("formats x-amz-date as YYYYMMDDTHHMMSSZ", async () => {
    const h = await signRequest(base);
    expect(h["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
  });
});
