import { describe, it, expect } from "vitest";
import { verifyGithub } from "../src/verify/github";
import { verifyGoogleDrive } from "../src/verify/google-drive";
import { verifyStripe } from "../src/verify/stripe";
import { verifyGmail } from "../src/verify/gmail";
import { hmacSha256Hex, timingSafeEqual } from "../src/crypto";
import { signGithub } from "./helpers";

const enc = (s: string) => new TextEncoder().encode(s);

describe("github verifier", () => {
  const body = JSON.stringify({ zen: "Keep it simple" });

  it("accepts a correctly signed request (test #1 auth half)", async () => {
    const headers = await signGithub(body, "s1");
    const res = await verifyGithub({ rawBytes: enc(body), headers }, { github: ["s1", undefined] });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.eventKind).toBe("push");
      expect(res.externalId).toBe("11111111-2222-3333-4444-555555555555");
    }
  });

  it("rejects a bad signature (test #2)", async () => {
    const headers = await signGithub(body, "s1", { badSig: true });
    const res = await verifyGithub({ rawBytes: enc(body), headers }, { github: ["s1"] });
    expect(res.ok).toBe(false);
  });

  it("rejects a missing signature (test #2)", async () => {
    const h = new Headers({ "x-github-delivery": "d1", "x-github-event": "push" });
    const res = await verifyGithub({ rawBytes: enc(body), headers: h }, { github: ["s1"] });
    expect(res.ok).toBe(false);
  });

  it("accepts when only the NEXT secret matches (test #14 rotation)", async () => {
    const headers = await signGithub(body, "s2-next");
    const res = await verifyGithub({ rawBytes: enc(body), headers }, { github: ["s1-old", "s2-next"] });
    expect(res.ok).toBe(true);
  });

  it("fails closed with no secret configured", async () => {
    const headers = await signGithub(body, "s1");
    const res = await verifyGithub({ rawBytes: enc(body), headers }, { github: [undefined, undefined] });
    expect(res.ok).toBe(false);
  });
});

describe("timing-safe compare (test #12)", () => {
  it("matches equal strings and rejects unequal / different-length", async () => {
    const a = await hmacSha256Hex("k", "data");
    const b = await hmacSha256Hex("k", "data");
    expect(timingSafeEqual(a, b)).toBe(true);
    expect(timingSafeEqual(a, a.slice(0, -1) + "0")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});

describe("stripe stub verifier (test #4)", () => {
  const body = JSON.stringify({ id: "evt_123", type: "payment_intent.succeeded" });

  it("accepts a fresh, correctly signed event", async () => {
    const t = Math.floor(Date.now() / 1000);
    const v1 = await hmacSha256Hex("whsec", `${t}.${body}`);
    const h = new Headers({ "stripe-signature": `t=${t},v1=${v1}` });
    const res = await verifyStripe({ rawBytes: enc(body), headers: h }, { stripe: ["whsec"] });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.externalId).toBe("evt_123");
  });

  it("rejects a timestamp outside the tolerance window", async () => {
    const t = Math.floor(Date.now() / 1000) - 10_000;
    const v1 = await hmacSha256Hex("whsec", `${t}.${body}`);
    const h = new Headers({ "stripe-signature": `t=${t},v1=${v1}` });
    const res = await verifyStripe({ rawBytes: enc(body), headers: h }, { stripe: ["whsec"] });
    expect(res.ok).toBe(false);
  });
});

describe("google-drive verifier (test #5)", () => {
  it("rejects a channel-token mismatch", async () => {
    const h = new Headers({
      "x-goog-channel-id": "chan-1",
      "x-goog-message-number": "7",
      "x-goog-channel-token": "wrong-token",
      "x-goog-resource-state": "update",
    });
    const res = await verifyGoogleDrive({ rawBytes: enc("{}"), headers: h }, { driveTokens: ["right-token"] });
    expect(res.ok).toBe(false);
  });

  it("accepts a matching channel token and derives the dedup id", async () => {
    const h = new Headers({
      "x-goog-channel-id": "chan-1",
      "x-goog-message-number": "7",
      "x-goog-channel-token": "right-token",
      "x-goog-resource-state": "update",
    });
    const res = await verifyGoogleDrive({ rawBytes: enc("{}"), headers: h }, { driveTokens: ["right-token"] });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.externalId).toBe("chan-1:7");
  });
});

describe("gmail verifier", () => {
  it("fails closed with no audience/service-account configured", async () => {
    const res = await verifyGmail({ rawBytes: enc("{}"), headers: new Headers() }, {});
    expect(res.ok).toBe(false);
  });
});
