import { describe, it, expect } from "vitest";
import { CommonErrorCodes } from "@dub/errors";
import { createWatchService } from "../src/watch/service";
import type { WatchChannelRecord } from "../src/watch/repo";
import { memGoogle, memRate, memEvents, memWatchRepo } from "./helpers";
import type { PublishContext } from "../src/events";

const CTX: PublishContext = { requestId: "req_1", actorId: "usr_1" };

function build(opts: { seed?: WatchChannelRecord[]; softLimit?: number } = {}) {
  const google = memGoogle();
  const repo = memWatchRepo(opts.seed ?? []);
  const rate = memRate(opts.softLimit ?? Number.POSITIVE_INFINITY);
  const events = memEvents();
  const svc = createWatchService({
    google: google.api,
    repo,
    rate,
    events,
    config: { callbackUrl: "https://ingest.example/webhooks/google-drive", ttlSeconds: 3600 },
    tokens: { current: "SECRET-CURRENT", next: "SECRET-NEXT" },
    now: () => 1_000_000,
    genChannelId: () => "chan-fixed",
  });
  return { svc, google, repo, rate, events };
}

describe("watch create (issuance)", () => {
  it("mints a channel with the CURRENT shared token, persists it, audits, and hides the token", async () => {
    const { svc, google, repo, events } = build();
    const view = await svc.create(CTX, { fileId: "folder_1" });

    // the Google call carried the shared secret as the channel token
    expect(google.watchArgs).toHaveLength(1);
    expect(google.watchArgs[0]).toMatchObject({
      fileId: "folder_1",
      channelId: "chan-fixed",
      address: "https://ingest.example/webhooks/google-drive",
      token: "SECRET-CURRENT",
      expirationMs: 1_000_000 + 3600 * 1000,
    });

    // persisted as active with the token VERSION only (never the secret itself)
    const rec = repo.rows.get("chan-fixed")!;
    expect(rec).toMatchObject({ channelId: "chan-fixed", resourceId: "res_chan-fixed", fileId: "folder_1", tokenVersion: "current", status: "active" });
    expect(JSON.stringify(rec)).not.toContain("SECRET-CURRENT");

    // audited, and the returned view carries no token
    expect(events.calls.some((c) => c.t === "audit" && c.action === "drive.watch.create")).toBe(true);
    expect(JSON.stringify(view)).not.toContain("SECRET");
    expect(view).toMatchObject({ channelId: "chan-fixed", resourceId: "res_chan-fixed", fileId: "folder_1" });
  });

  it("honors a per-request ttlSeconds override", async () => {
    const { svc, google } = build();
    await svc.create(CTX, { fileId: "f", ttlSeconds: 60 });
    expect(google.watchArgs[0]!.expirationMs).toBe(1_000_000 + 60 * 1000);
  });

  it("rejects a missing fileId with VALIDATION_FAILED and never calls Google", async () => {
    const { svc, google } = build();
    await expect(svc.create(CTX, { fileId: "" })).rejects.toMatchObject({ code: CommonErrorCodes.VALIDATION_FAILED });
    expect(google.calls.watch).toBe(0);
  });

  it("consumes exactly one rate token per create", async () => {
    const { svc, rate } = build();
    await svc.create(CTX, { fileId: "f" });
    expect(rate.used()).toBe(1);
  });

  it("surfaces the rate-limit error and does not call Google when throttled", async () => {
    const { svc, google } = build({ softLimit: 0 });
    await expect(svc.create(CTX, { fileId: "f" })).rejects.toMatchObject({ code: CommonErrorCodes.RATE_LIMITED });
    expect(google.calls.watch).toBe(0);
  });
});

const seedActive = (over: Partial<WatchChannelRecord> = {}): WatchChannelRecord => ({
  id: "dwc_1",
  channelId: "chan-1",
  resourceId: "RID-1",
  fileId: "folder_1",
  tokenVersion: "current",
  address: "https://cb",
  expiration: null,
  status: "active",
  actorId: null,
  requestId: "req_0",
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
  ...over,
});

describe("watch stop", () => {
  it("stops an active channel via Google, marks it stopped, and audits", async () => {
    const { svc, google, repo, events } = build({ seed: [seedActive()] });
    const out = await svc.stop(CTX, "chan-1");
    expect(out).toEqual({ channelId: "chan-1", alreadyStopped: false });
    expect(google.stopArgs).toEqual([{ channelId: "chan-1", resourceId: "RID-1" }]);
    expect(repo.rows.get("chan-1")!.status).toBe("stopped");
    expect(events.calls.some((c) => c.t === "audit" && c.action === "drive.watch.stop")).toBe(true);
  });

  it("is idempotent for an already-stopped channel: no Google call, no re-audit", async () => {
    const { svc, google, events } = build({ seed: [seedActive({ status: "stopped" })] });
    const out = await svc.stop(CTX, "chan-1");
    expect(out).toEqual({ channelId: "chan-1", alreadyStopped: true });
    expect(google.calls.stop).toBe(0);
    expect(events.calls.filter((c) => c.t === "audit")).toHaveLength(0);
  });

  it("404s an unknown channel", async () => {
    const { svc } = build();
    await expect(svc.stop(CTX, "nope")).rejects.toMatchObject({ code: CommonErrorCodes.NOT_FOUND });
  });
});
