import { describe, expect, it } from "vitest";
import { secretEquals, signTicket, verifyTicket } from "../src/ticket";

describe("ws-ticket", () => {
  it("verifies its own ticket and returns the user", async () => {
    const t = await signTicket("s3cret", "user_1", 1_000);
    expect(await verifyTicket("s3cret", t, 1_000)).toMatchObject({ userId: "user_1", aud: "commander-relay" });
  });

  it("rejects wrong secret, tampering and expiry", async () => {
    const t = await signTicket("s3cret", "user_1", 1_000);
    expect(await verifyTicket("other", t, 1_000)).toBeNull();
    const [payload, sig] = t.split(".");
    const forged = btoa(JSON.stringify({ aud: "commander-relay", userId: "admin", expEpochMs: 9e15 })).replace(/=+$/, "");
    expect(await verifyTicket("s3cret", `${forged}.${sig}`, 1_000)).toBeNull();
    expect(await verifyTicket("s3cret", `${payload}.`, 1_000)).toBeNull();
    expect(await verifyTicket("s3cret", t, 1_000 + 61_000)).toBeNull();
  });

  it("refuses a ticket minted for another audience (e.g. chat)", async () => {
    const payload = btoa(JSON.stringify({ channelId: "c", userId: "u", expEpochMs: 9e15 })).replace(/=+$/, "");
    expect(await verifyTicket("s3cret", `${payload}.AAAA`)).toBeNull();
  });

  it("secretEquals is exact", () => {
    expect(secretEquals("abc", "abc")).toBe(true);
    expect(secretEquals("abc", "abd")).toBe(false);
    expect(secretEquals("", "abc")).toBe(false);
  });
});
