// Typed client for the single dynamic dependency: gateway public inquiry receiver.
// "クライアントは api-gateway だけを知る" (design §1, 4-0). Contract-exact against
// the FROZEN @dub/types gateway namespace (body {kind,name,email,message,turnstileToken}
// → {accepted}); richer draft fields from the P0a doc are NOT in the frozen contract.

import type { gateway } from "@dub/types";
type PublicInquiryRequest = gateway.PublicInquiryRequest;
type PublicInquiryResponse = gateway.PublicInquiryResponse;
import { isErrorResponse, type ErrorResponse } from "@dub/errors/wire";
import { NETWORK_ERROR } from "./error-messages";
import { generateIdempotencyKey } from "./idempotency";

export const PUBLIC_INQUIRY_PATH = "/api/v1/public/inquiries";
export const IDEMPOTENCY_HEADER = "x-dub-idempotency-key";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Normalize a build-time PUBLIC_GATEWAY_ORIGIN value into a base ready for URL
 * concatenation. Returns the bare origin (scheme://host[:port]) with no trailing
 * slash and no path, so `origin + PUBLIC_INQUIRY_PATH` is always well-formed.
 *
 * - undefined / "" / whitespace → "" (same-origin; design default).
 * - a valid http(s) URL → its `.origin` (drops any path / trailing slash).
 * - anything else (bad scheme, unparseable) → "" so a misconfigured deploy falls
 *   back to same-origin instead of building a broken URL. Callers that need to
 *   surface the misconfiguration can compare against {@link isValidGatewayOrigin}.
 */
export function resolveGatewayOrigin(raw?: string): string {
  const value = (raw ?? "").trim();
  if (!value) return "";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
  return parsed.origin;
}

/**
 * True when `raw` is a usable gateway origin: either empty (same-origin) or a
 * well-formed http(s) origin. A non-empty value that fails to resolve is a
 * deploy misconfiguration.
 */
export function isValidGatewayOrigin(raw?: string): boolean {
  const value = (raw ?? "").trim();
  return value === "" || resolveGatewayOrigin(value) !== "";
}

export interface SubmitInquiryOk {
  ok: true;
  data: PublicInquiryResponse;
}

export interface SubmitInquiryErr {
  ok: false;
  /** Error code (@dub/errors) or NETWORK_ERROR sentinel. */
  code: string;
  status: number; // 0 for network failure
  error?: ErrorResponse["error"]; // present when the body was a wire ErrorResponse
}

export type SubmitInquiryResult = SubmitInquiryOk | SubmitInquiryErr;

export interface SubmitInquiryOptions {
  /** Gateway base URL (build-time env: PUBLIC_GATEWAY_ORIGIN). Empty = same-origin. */
  baseUrl?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Reuse a key across retries of the same submission (dedup). */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/**
 * POST the inquiry to the gateway. Never throws — always resolves to a tagged
 * result. Network/parse failures collapse to NETWORK_ERROR (status 0).
 */
export async function submitInquiry(
  body: PublicInquiryRequest,
  options: SubmitInquiryOptions = {},
): Promise<SubmitInquiryResult> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (!fetchImpl) {
    return { ok: false, code: NETWORK_ERROR, status: 0 };
  }

  const url = resolveGatewayOrigin(options.baseUrl) + PUBLIC_INQUIRY_PATH;
  const key = options.idempotencyKey ?? generateIdempotencyKey();

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [IDEMPOTENCY_HEADER]: key,
      },
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch {
    return { ok: false, code: NETWORK_ERROR, status: 0 };
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = undefined;
  }

  if (res.ok) {
    const data = parsed as PublicInquiryResponse | undefined;
    if (data && typeof data.accepted === "boolean") {
      return { ok: true, data };
    }
    // 2xx but unexpected body — treat as network/parse failure, retry-safe.
    return { ok: false, code: NETWORK_ERROR, status: res.status };
  }

  if (isErrorResponse(parsed)) {
    return { ok: false, code: parsed.error.code, status: res.status, error: parsed.error };
  }

  // Non-envelope error body: fall back to a code derived from HTTP status.
  return { ok: false, code: statusToCode(res.status), status: res.status };
}

function statusToCode(status: number): string {
  switch (status) {
    case 400:
      return "VALIDATION_FAILED";
    case 403:
      return "FORBIDDEN";
    case 413:
      return "PAYLOAD_TOO_LARGE";
    case 429:
      return "RATE_LIMITED";
    case 502:
      return "UPSTREAM_UNAVAILABLE";
    case 504:
      return "UPSTREAM_TIMEOUT";
    default:
      return "INTERNAL";
  }
}
