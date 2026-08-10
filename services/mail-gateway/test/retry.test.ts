import { describe, it, expect, vi } from "vitest";
import { DubError } from "@dub/errors";
import type { mail } from "@dub/types";
import { isRetryable, withRetry } from "../src/retry";
import { sendMail } from "../src/send";
import { findSendByKey } from "../src/repo";
import type { MailProvider, OutboundMail, ProviderName } from "../src/provider";
import { makeHarness, sendDeps } from "./helpers";

const noSleep = async () => {};
const fixedJitter = () => 1; // deterministic: delay == ceil (irrelevant, sleep is a no-op)

const retryable = (msg = "transient") => new DubError("MAIL_PROVIDER_UNAVAILABLE", msg, { status: 502, retryable: true });
const permanent = (msg = "bad") => new DubError("MAIL_PROVIDER_UNAVAILABLE", msg, { status: 502, retryable: false });

describe("isRetryable", () => {
  it("is true only for retryable DubErrors", () => {
    expect(isRetryable(retryable())).toBe(true);
    expect(isRetryable(permanent())).toBe(false);
    expect(isRetryable(new Error("plain"))).toBe(false);
    expect(isRetryable("string")).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns on the first success without sleeping", async () => {
    const sleep = vi.fn(noSleep);
    const fn = vi.fn(async () => "ok");
    const out = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, sleep });
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a retryable error then succeeds", async () => {
    const sleep = vi.fn(noSleep);
    let n = 0;
    const fn = vi.fn(async () => {
      if (++n < 3) throw retryable();
      return "recovered";
    });
    const out = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, sleep, random: fixedJitter });
    expect(out).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2); // between attempts 1->2 and 2->3
  });

  it("does NOT retry a non-retryable error (fails fast)", async () => {
    const sleep = vi.fn(noSleep);
    const fn = vi.fn(async () => {
      throw permanent("validation");
    });
    await expect(withRetry(fn, { maxAttempts: 5, baseDelayMs: 10, sleep })).rejects.toMatchObject({ status: 502 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after maxAttempts and rethrows the last error", async () => {
    const sleep = vi.fn(noSleep);
    const err = retryable("still down");
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, sleep })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("uses exponential backoff with jitter within [ceil/2, ceil]", async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });
    let n = 0;
    const fn = async () => {
      if (++n < 3) throw retryable();
      return "ok";
    };
    await withRetry(fn, { maxAttempts: 3, baseDelayMs: 100, sleep, random: () => 0 }); // min jitter
    // attempt1 ceil=100 -> [50,100]; attempt2 ceil=200 -> [100,200]. random()=0 => floor(ceil*0.5).
    expect(delays).toEqual([50, 100]);
  });
});

// A provider that fails `failTimes` with a retryable error, then succeeds — proves the
// send core recovers a transient provider blip without a client-driven re-POST.
class FlakyProvider implements MailProvider {
  readonly name: ProviderName = "ses";
  readonly sent: OutboundMail[] = [];
  private count = 0;
  constructor(private readonly failTimes: number, private readonly kind: "retryable" | "permanent" = "retryable") {}
  async send(mail: OutboundMail): Promise<{ providerMessageId: string }> {
    if (this.count++ < this.failTimes) throw this.kind === "retryable" ? retryable() : permanent();
    this.sent.push(mail);
    return { providerMessageId: `flaky-${mail.messageId}` };
  }
}

const baseReq: mail.SendMailRequest = { to: [{ email: "alice@example.com" }], subject: "Hi", textBody: "Body" };

describe("sendMail — provider retry integration", () => {
  it("recovers from 2 transient failures and marks the send-log sent (one delivery)", async () => {
    const h = makeHarness();
    const provider = new FlakyProvider(2, "retryable");
    const deps = sendDeps(h, { provider, retry: { maxAttempts: 3, baseDelayMs: 0 } });
    const { status } = await sendMail(deps, baseReq, "idem-flaky", "notification");
    expect(status).toBe("sent");
    expect(provider.sent).toHaveLength(1); // 二重送信ゼロ — one actual delivery
    const row = await findSendByKey(h.db, "idem-flaky");
    expect(row?.status).toBe("sent");
    expect(h.notif.sends[0]!.name).toBe("mail.message.sent");
  });

  it("does not retry a non-retryable (permanent) provider error", async () => {
    const h = makeHarness();
    const provider = new FlakyProvider(1, "permanent");
    const deps = sendDeps(h, { provider, retry: { maxAttempts: 3, baseDelayMs: 0 } });
    await expect(sendMail(deps, baseReq, "idem-perm", "notification")).rejects.toBeInstanceOf(DubError);
    const row = await findSendByKey(h.db, "idem-perm");
    expect(row?.status).toBe("failed");
  });
});
