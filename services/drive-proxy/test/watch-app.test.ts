import { describe, it, expect } from "vitest";
import { createApp, type AppDeps } from "../src/app";
import type { DriveService } from "../src/service";
import type { WatchService } from "../src/watch/service";
import { memAuthz } from "./helpers";

const allowAll = memAuthz(() => true);
const INTERNAL = { "x-dub-internal": "1", "content-type": "application/json" };

function driveStub(): DriveService {
  return {
    async list() { return { items: [], nextCursor: null }; },
    async get() { return { id: "d", name: "N", mimeType: "text/plain", modifiedAt: "2026-08-09T00:00:00Z" }; },
    async embed() { return { embedUrl: "x" }; },
    async create() { return { id: "n", name: "N", mimeType: "text/plain", modifiedAt: "2026-08-09T00:00:00Z" }; },
    async move() { return { id: "d", name: "N", mimeType: "text/plain", modifiedAt: "2026-08-09T00:00:00Z" }; },
    async trash() { return { file: { id: "d", name: "N", mimeType: "text/plain", modifiedAt: "2026-08-09T00:00:00Z" }, alreadyTrashed: false }; },
    async readSheet() { return { values: [] }; },
    async writeSheet() { return { spreadsheetId: "s", updatedRange: "A1", updatedRows: 0 }; },
    async quota() { return { windowSeconds: 100, usedRequests: 0, softLimit: 500, throttling: false }; },
  };
}

function watchStub(over: Partial<WatchService> = {}): WatchService {
  return {
    async create() { return { channelId: "chan-1", resourceId: "RID-1", fileId: "folder_1", expiration: null, resourceUri: null }; },
    async stop() { return { channelId: "chan-1", alreadyStopped: false }; },
    ...over,
  };
}

function app(deps: Partial<AppDeps> = {}) {
  return createApp({ service: driveStub(), authz: allowAll, ...deps });
}

describe("POST /drive/watch (internal-only)", () => {
  it("403 without x-dub-internal", async () => {
    const res = await app({ watch: watchStub() }).request("/drive/watch", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fileId: "folder_1" }),
    });
    expect(res.status).toBe(403);
  });

  it("201 with the channel view (no token) when internal", async () => {
    let seen: unknown;
    const res = await app({ watch: watchStub({ async create(_ctx, args) { seen = args; return { channelId: "c", resourceId: "r", fileId: args.fileId, expiration: null, resourceUri: null }; } }) })
      .request("/drive/watch", { method: "POST", headers: INTERNAL, body: JSON.stringify({ fileId: "folder_1", ttlSeconds: 120 }) });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.channel).toMatchObject({ channelId: "c", resourceId: "r", fileId: "folder_1" });
    expect(JSON.stringify(body)).not.toContain("token");
    expect(seen).toEqual({ fileId: "folder_1", ttlSeconds: 120 });
  });

  it("500 when no watch service is wired (no D1 bound)", async () => {
    const res = await app().request("/drive/watch", { method: "POST", headers: INTERNAL, body: JSON.stringify({ fileId: "f" }) });
    expect(res.status).toBe(500);
    expect((await res.json() as any).error.code).toBe("DRIVE_WATCH_UNCONFIGURED");
  });
});

describe("POST /drive/watch/:channelId/stop (internal-only)", () => {
  it("403 without x-dub-internal", async () => {
    const res = await app({ watch: watchStub() }).request("/drive/watch/chan-1/stop", { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("200 and passes the channel id through", async () => {
    let seen = "";
    const res = await app({ watch: watchStub({ async stop(_ctx, id) { seen = id; return { channelId: id, alreadyStopped: true }; } }) })
      .request("/drive/watch/chan-9/stop", { method: "POST", headers: { "x-dub-internal": "1" } });
    expect(res.status).toBe(200);
    expect(seen).toBe("chan-9");
    expect(await res.json() as any).toEqual({ channelId: "chan-9", alreadyStopped: true });
  });
});
