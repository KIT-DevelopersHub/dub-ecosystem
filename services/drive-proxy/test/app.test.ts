import { describe, it, expect } from "vitest";
import { CommonErrorCodes } from "@dub/errors";
import { createApp } from "../src/app";
import type { DriveService } from "../src/service";
import { DRIVE_WRITE } from "../src/permissions";
import { memAuthz } from "./helpers";

function stubService(over: Partial<DriveService> = {}): DriveService {
  const base: DriveService = {
    async list() { return { items: [], nextCursor: null }; },
    async get() { return { id: "d1", name: "N", mimeType: "text/plain", modifiedAt: "2026-08-09T00:00:00Z" }; },
    async embed() { return { embedUrl: "https://embed" }; },
    async create() { return { id: "new1", name: "N", mimeType: "text/plain", modifiedAt: "2026-08-09T00:00:00Z" }; },
    async move() { return { id: "d1", name: "N", mimeType: "text/plain", modifiedAt: "2026-08-09T00:00:00Z" }; },
    async trash() { return { file: { id: "d1", name: "N", mimeType: "text/plain", modifiedAt: "2026-08-09T00:00:00Z" }, alreadyTrashed: false }; },
    async readSheet() { return { values: [["a"]] }; },
    async writeSheet() { return { spreadsheetId: "s1", updatedRange: "A1", updatedRows: 1 }; },
    async quota() { return { windowSeconds: 100, usedRequests: 0, softLimit: 500, throttling: false }; },
  };
  return { ...base, ...over };
}

const allowAll = memAuthz(() => true);
const AUTHED = { "x-dub-user-id": "usr_1" };

describe("authn", () => {
  it("401 when x-dub-user-id is absent", async () => {
    const app = createApp({ service: stubService(), authz: allowAll });
    const res = await app.request("/drive/files?folderId=f1");
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error.code).toBe(CommonErrorCodes.UNAUTHENTICATED);
  });
});

describe("authz", () => {
  it("403 when the permission check denies", async () => {
    const app = createApp({ service: stubService(), authz: memAuthz(() => false) });
    const res = await app.request("/drive/files?folderId=f1", { headers: AUTHED });
    expect(res.status).toBe(403);
    expect((await res.json() as any).error.code).toBe(CommonErrorCodes.FORBIDDEN);
  });
  it("member (read-only) is forbidden from POST /drive/files", async () => {
    const readOnly = memAuthz((_u, perm) => perm !== DRIVE_WRITE);
    const app = createApp({ service: stubService(), authz: readOnly });
    const res = await app.request("/drive/files", {
      method: "POST",
      headers: { ...AUTHED, "content-type": "application/json" },
      body: JSON.stringify({ name: "X", mimeType: "application/vnd.google-apps.document", parentId: "f1" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("routing + status codes", () => {
  it("GET /drive/files returns 200 and the paginated body", async () => {
    let called = false;
    const app = createApp({ service: stubService({ async list() { called = true; return { items: [], nextCursor: null }; } }), authz: allowAll });
    const res = await app.request("/drive/files?folderId=f1", { headers: AUTHED });
    expect(res.status).toBe(200);
    expect(called).toBe(true);
    expect(await res.json() as any).toEqual({ items: [], nextCursor: null });
  });

  it("GET /drive/files/:id/embed resolves the embed route (not :id)", async () => {
    const app = createApp({ service: stubService({ async embed() { return { embedUrl: "https://EMBED" }; } }), authz: allowAll });
    const res = await app.request("/drive/files/d1/embed", { headers: AUTHED });
    expect((await res.json() as any).embedUrl).toBe("https://EMBED");
  });

  it("POST /drive/files returns 201", async () => {
    const app = createApp({ service: stubService(), authz: allowAll });
    const res = await app.request("/drive/files", {
      method: "POST",
      headers: { ...AUTHED, "content-type": "application/json" },
      body: JSON.stringify({ name: "X", mimeType: "application/vnd.google-apps.document", parentId: "f1" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json() as any).file.id).toBe("new1");
  });

  it("POST /drive/files/:id/trash returns {file, trashed:true}", async () => {
    const app = createApp({ service: stubService(), authz: allowAll });
    const res = await app.request("/drive/files/d1/trash", { method: "POST", headers: AUTHED });
    expect(res.status).toBe(200);
    expect(await res.json() as any).toMatchObject({ trashed: true, file: { id: "d1" } });
  });

  it("invalid JSON body -> VALIDATION_FAILED", async () => {
    const app = createApp({ service: stubService(), authz: allowAll });
    const res = await app.request("/drive/files", {
      method: "POST",
      headers: { ...AUTHED, "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error.code).toBe(CommonErrorCodes.VALIDATION_FAILED);
  });
});

describe("internal-only quota endpoint", () => {
  it("403 without x-dub-internal", async () => {
    const app = createApp({ service: stubService(), authz: allowAll });
    const res = await app.request("/drive/health/quota");
    expect(res.status).toBe(403);
  });
  it("200 with x-dub-internal", async () => {
    const app = createApp({ service: stubService(), authz: allowAll });
    const res = await app.request("/drive/health/quota", { headers: { "x-dub-internal": "1" } });
    expect(res.status).toBe(200);
    expect((await res.json() as any).softLimit).toBe(500);
  });
});
