// Minimal Stripe client (no SDK): Checkout Session create/retrieve over fetch (form-encoded)
// + webhook signature check. fetch is injectable so tests never hit the network.
import { errors } from "@dub/errors";

const API = "https://api.stripe.com/v1";
/** Stripe's default replay window. */
export const STRIPE_TOLERANCE_SEC = 300;

export interface CheckoutLineItem {
  name: string;
  /** > 0 (free lines are not sent to Stripe). */
  unitAmountJpy: number;
  quantity: number;
}

export interface CheckoutSessionInput {
  orderId: string;
  lineItems: CheckoutLineItem[];
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  /** unix seconds */
  expiresAt: number;
}

export interface CheckoutSession {
  id: string;
  url: string | null;
  /** "open" | "complete" | "expired" */
  status: string | null;
  /** "paid" | "unpaid" | "no_payment_required" */
  paymentStatus: string | null;
  clientReferenceId: string | null;
}

export interface StripeClient {
  createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession>;
  getCheckoutSession(id: string): Promise<CheckoutSession>;
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export function toCheckoutSession(raw: unknown): CheckoutSession {
  const r = (raw ?? {}) as Record<string, unknown>;
  const s = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    id: s(r.id) ?? "",
    url: s(r.url),
    status: s(r.status),
    paymentStatus: s(r.payment_status),
    clientReferenceId: s(r.client_reference_id),
  };
}

export function createStripeClient(secretKey: string, fetchFn: FetchFn = (i, init) => fetch(i, init)): StripeClient {
  const call = async (method: "GET" | "POST", path: string, form?: URLSearchParams): Promise<CheckoutSession> => {
    let res: Response;
    try {
      res = await fetchFn(`${API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${secretKey}`,
          ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(form ? { body: form.toString() } : {}),
      });
    } catch (cause) {
      throw errors.upstreamUnavailable("stripe", cause);
    }
    if (!res.ok) throw errors.upstreamUnavailable("stripe", new Error(`stripe ${method} ${path}: ${res.status}`));
    return toCheckoutSession(await res.json());
  };

  return {
    createCheckoutSession(i) {
      const f = new URLSearchParams();
      f.set("mode", "payment");
      // Payment methods come from the Dashboard (API 2026-09-30+ rejects payment_method_types).
      // Keep delayed methods (e.g. konbini) disabled there: they settle after the 35-min seat hold.
      i.lineItems.forEach((l, n) => {
        f.set(`line_items[${n}][price_data][currency]`, "jpy");
        f.set(`line_items[${n}][price_data][unit_amount]`, String(l.unitAmountJpy));
        f.set(`line_items[${n}][price_data][product_data][name]`, l.name);
        f.set(`line_items[${n}][quantity]`, String(l.quantity));
      });
      f.set("customer_email", i.customerEmail);
      f.set("client_reference_id", i.orderId);
      f.set("metadata[order_id]", i.orderId);
      f.set("success_url", i.successUrl);
      f.set("cancel_url", i.cancelUrl);
      f.set("expires_at", String(i.expiresAt));
      f.set("locale", "ja");
      return call("POST", "/checkout/sessions", f);
    },
    getCheckoutSession(id) {
      return call("GET", `/checkout/sessions/${encodeURIComponent(id)}`);
    },
  };
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Stripe-Signature "t=..,v1=.." = HMAC-SHA256(secret, `${t}.${rawBody}`), |now - t| <= tolerance. */
export async function verifyStripeSignature(
  header: string | null | undefined,
  rawBody: string,
  secret: string,
  nowSec: number,
  toleranceSec = STRIPE_TOLERANCE_SEC,
): Promise<boolean> {
  if (!header || !secret) return false;
  let t: number | null = null;
  const v1s: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") t = Number.parseInt(v, 10);
    else if (k === "v1" && v) v1s.push(v.toLowerCase());
  }
  if (t === null || Number.isNaN(t) || v1s.length === 0) return false;
  if (Math.abs(nowSec - t) > toleranceSec) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`)));
  let ok = false;
  for (const v of v1s) if (timingSafeEqual(v, expected)) ok = true;
  return ok;
}

/** Test/helper: build a valid header for a body. */
export async function signStripePayload(rawBody: string, secret: string, tSec: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return `t=${tSec},v1=${hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${tSec}.${rawBody}`)))}`;
}
