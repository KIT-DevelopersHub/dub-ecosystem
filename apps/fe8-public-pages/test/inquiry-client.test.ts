import { describe, it, expect, vi } from "vitest";
import {
  submitInquiry,
  PUBLIC_INQUIRY_PATH,
  IDEMPOTENCY_HEADER,
  type FetchLike,
} from "../src/lib/inquiry-client";
import type { gateway } from "@dub/types";
type PublicInquiryRequest = gateway.PublicInquiryRequest;
import type { ErrorResponse } from "@dub/errors/wire";

const body: PublicInquiryRequest = {
  kind: "sponsor",
  name: "A",
  email: "a@b.co",
  message: "スポンサーの相談です。",
  turnstileToken: "tok",
};

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errBody(code: string, message = "x"): ErrorResponse {
  return { error: { code, message, retryable: false } };
}

describe("submitInquiry", () => {
  it("returns ok on a 2xx {accepted:true} body", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonResponse(200, { accepted: true }));
    const res = await submitInquiry(body, { fetchImpl });
    expect(res).toEqual({ ok: true, data: { accepted: true } });
  });

  it("POSTs to the gateway path with idempotency header and JSON body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { accepted: true })) as unknown as FetchLike;
    await submitInquiry(body, { fetchImpl, baseUrl: "https://api.example.com", idempotencyKey: "K1" });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe(`https://api.example.com${PUBLIC_INQUIRY_PATH}`);
    expect(init.method).toBe("POST");
    expect(init.headers[IDEMPOTENCY_HEADER]).toBe("K1");
    expect(JSON.parse(init.body)).toEqual(body);
  });

  it("maps a wire ErrorResponse (403 turnstile) to its code", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(403, errBody("GATEWAY_TURNSTILE_FAILED"));
    const res = await submitInquiry(body, { fetchImpl });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("GATEWAY_TURNSTILE_FAILED");
      expect(res.status).toBe(403);
      expect(res.error?.code).toBe("GATEWAY_TURNSTILE_FAILED");
    }
  });

  it("maps VALIDATION_FAILED (400) with field details", async () => {
    const payload: ErrorResponse = {
      error: {
        code: "VALIDATION_FAILED",
        message: "bad",
        retryable: false,
        details: [{ field: "email", reason: "invalid" }],
      },
    };
    const res = await submitInquiry(body, { fetchImpl: async () => jsonResponse(400, payload) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("VALIDATION_FAILED");
  });

  it("derives a code from status when body is not an error envelope", async () => {
    const res = await submitInquiry(body, { fetchImpl: async () => jsonResponse(429, { nope: 1 }) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("RATE_LIMITED");
  });

  it("collapses fetch rejection to NETWORK_ERROR (status 0)", async () => {
    const res = await submitInquiry(body, {
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    expect(res).toEqual({ ok: false, code: "NETWORK_ERROR", status: 0 });
  });

  it("treats a 2xx with an unexpected body as retry-safe network failure", async () => {
    const res = await submitInquiry(body, { fetchImpl: async () => jsonResponse(200, { weird: true }) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("NETWORK_ERROR");
  });
});
