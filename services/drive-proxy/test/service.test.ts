import { describe, it, expect } from "vitest";
import { isDubError, CommonErrorCodes } from "@dub/errors";
import { createDriveService } from "../src/service";
import type { DriveConfig } from "../src/env";
import type { GoogleFileResource } from "../src/google/mapper";
import { memCache, memRate, memEvents, memGoogle } from "./helpers";

const config: DriveConfig = {
  rateWindowSeconds: 100,
  rateSoftLimit: 500,
  listTtlSeconds: 60,
  fileTtlSeconds: 60,
  sheetTtlSeconds: 30,
};
const ctx = { requestId: "req_1", actorId: "usr_1" };
const ROOT = "folder_root";

const seed: GoogleFileResource[] = [
  { id: "doc1", name: "Doc One", mimeType: "application/vnd.google-apps.document", parents: [ROOT], trashed: false, modifiedTime: "2026-08-09T00:00:00Z" },
  { id: "sheet1", name: "Sheet One", mimeType: "application/vnd.google-apps.spreadsheet", parents: [ROOT], trashed: false, modifiedTime: "2026-08-09T00:00:00Z" },
  { id: "folder1", name: "Sub", mimeType: "application/vnd.google-apps.folder", parents: [ROOT], trashed: false, modifiedTime: "2026-08-09T00:00:00Z" },
];

function make(softLimit = Number.POSITIVE_INFINITY, files = seed) {
  const google = memGoogle(files);
  const cache = memCache();
  const rate = memRate(softLimit);
  const events = memEvents();
  const service = createDriveService({ google: google.api, cache, rate, events, config });
  return { service, google, cache, rate, events };
}

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
    throw new Error("expected throw");
  } catch (e) {
    expect(isDubError(e)).toBe(true);
    expect((e as { code: string }).code).toBe(code);
  }
}

describe("list", () => {
  it("requires folderId", async () => {
    const { service } = make();
    await expectCode(() => service.list({}), CommonErrorCodes.VALIDATION_FAILED);
  });
  it("rejects limit > 100", async () => {
    const { service } = make();
    await expectCode(() => service.list({ folderId: ROOT, limit: 101 }), CommonErrorCodes.VALIDATION_FAILED);
  });
  it("rejects invalid kind", async () => {
    const { service } = make();
    await expectCode(() => service.list({ folderId: ROOT, kind: "bogus" }), CommonErrorCodes.VALIDATION_FAILED);
  });
  it("lists files in a folder and maps to DriveFile", async () => {
    const { service } = make();
    const res = await service.list({ folderId: ROOT });
    expect(res.items.map((f) => f.id).sort()).toEqual(["doc1", "folder1", "sheet1"]);
    expect(res.items[0]).toHaveProperty("modifiedAt");
    expect(res.nextCursor).toBeNull();
  });
  it("passes through the Drive pageToken as nextCursor", async () => {
    const { service, google } = make();
    google.setNextPageToken("PAGE2");
    const res = await service.list({ folderId: ROOT });
    expect(res.nextCursor).toBe("PAGE2");
  });
  it("serves the second call from cache (no extra Google call)", async () => {
    const { service, google } = make();
    await service.list({ folderId: ROOT });
    await service.list({ folderId: ROOT });
    expect(google.calls.list).toBe(1);
  });
});

describe("get + embed", () => {
  it("gets a single file", async () => {
    const { service } = make();
    const f = await service.get("doc1");
    expect(f.name).toBe("Doc One");
  });
  it("derives embed URLs per kind", async () => {
    const { service } = make();
    expect((await service.embed("doc1")).embedUrl).toContain("/document/d/doc1/preview");
    expect((await service.embed("sheet1")).embedUrl).toContain("/spreadsheets/d/sheet1/preview");
  });
  it("rejects embedding a folder", async () => {
    const { service } = make();
    await expectCode(() => service.embed("folder1"), CommonErrorCodes.VALIDATION_FAILED);
  });
  it("caches file reads", async () => {
    const { service, google } = make();
    await service.get("doc1");
    await service.embed("doc1");
    expect(google.calls.get).toBe(1);
  });
});

describe("create", () => {
  it("blank-creates, publishes drive.file.created + audit(create)", async () => {
    const { service, events, google } = make();
    const f = await service.create(ctx, { name: "New", mimeType: "application/vnd.google-apps.document", parentId: ROOT });
    expect(f.id).toMatch(/^file_/);
    expect(google.calls.create).toBe(1);
    expect(events.calls.find((c) => c.t === "created")?.id).toBe(f.id);
    expect(events.calls.find((c) => c.t === "audit")?.action).toBe("drive.file.create");
  });
  it("copies from a template when templateFileId is set", async () => {
    const { service, google } = make();
    await service.create(ctx, { name: "Copy", mimeType: "application/vnd.google-apps.document", parentId: ROOT, templateFileId: "doc1" });
    expect(google.calls.copy).toBe(1);
    expect(google.calls.create).toBe(0);
  });
  it("purges the parent's list cache", async () => {
    const { service, cache } = make();
    await service.list({ folderId: ROOT });
    const before = [...cache.store.keys()].filter((k) => k.startsWith(`drive:list:${ROOT}:`)).length;
    expect(before).toBe(1);
    await service.create(ctx, { name: "New", mimeType: "application/vnd.google-apps.document", parentId: ROOT });
    const after = [...cache.store.keys()].filter((k) => k.startsWith(`drive:list:${ROOT}:`)).length;
    expect(after).toBe(0);
  });
  it("validates required name", async () => {
    const { service } = make();
    await expectCode(() => service.create(ctx, { name: "", mimeType: "x" }), CommonErrorCodes.VALIDATION_FAILED);
  });
});

describe("move", () => {
  it("moves and publishes drive.file.moved + audit(move)", async () => {
    const { service, events, google } = make();
    const f = await service.move(ctx, "doc1", "folder_dest");
    expect(google.calls.move).toBe(1);
    expect(f.id).toBe("doc1");
    expect(events.calls.find((c) => c.t === "moved")?.id).toBe("doc1");
    expect(events.calls.find((c) => c.t === "audit")?.action).toBe("drive.file.move");
  });
  it("404s when moving a trashed file", async () => {
    const trashed: GoogleFileResource[] = [{ id: "t1", name: "T", mimeType: "application/pdf", parents: [ROOT], trashed: true }];
    const { service } = make(Number.POSITIVE_INFINITY, trashed);
    await expectCode(() => service.move(ctx, "t1", "folder_dest"), CommonErrorCodes.NOT_FOUND);
  });
});

describe("trash", () => {
  it("trashes and publishes drive.file.trashed + audit(trash)", async () => {
    const { service, events } = make();
    const r = await service.trash(ctx, "doc1");
    expect(r.alreadyTrashed).toBe(false);
    expect(events.calls.find((c) => c.t === "trashed")?.id).toBe("doc1");
    expect(events.calls.find((c) => c.t === "audit")?.action).toBe("drive.file.trash");
  });
  it("is idempotent on re-trash (200, no re-emit)", async () => {
    const already: GoogleFileResource[] = [{ id: "t2", name: "T2", mimeType: "application/pdf", parents: [ROOT], trashed: true }];
    const { service, events, google } = make(Number.POSITIVE_INFINITY, already);
    const r = await service.trash(ctx, "t2");
    expect(r.alreadyTrashed).toBe(true);
    expect(google.calls.trash).toBe(0);
    expect(events.calls.length).toBe(0);
  });
});

describe("sheets", () => {
  it("reads values (bad A1 -> VALIDATION_FAILED)", async () => {
    const { service } = make();
    const r = await service.readSheet("sheet1", "Sheet1!A1:B2");
    expect(r.values.length).toBeGreaterThan(0);
    await expectCode(() => service.readSheet("sheet1", "1:2"), CommonErrorCodes.VALIDATION_FAILED);
  });
  it("caches reads (no extra Google call within TTL)", async () => {
    const { service, google } = make();
    await service.readSheet("sheet1", "A1:B2");
    await service.readSheet("sheet1", "A1:B2");
    expect(google.calls.sheetRead).toBe(1);
  });
  it("update path: audit(sheet.write) only, NO domain event", async () => {
    const { service, events, google } = make();
    const r = await service.writeSheet(ctx, "sheet1", { mode: "update", range: "A1:B2", values: [["x", "y"]] });
    expect(r.updatedRows).toBe(1);
    expect(google.calls.sheetUpdate).toBe(1);
    expect(events.calls.filter((c) => c.t === "audit")).toHaveLength(1);
    expect(events.calls.find((c) => c.t === "audit")?.action).toBe("drive.sheet.write");
    expect(events.calls.some((c) => c.t !== "audit")).toBe(false);
  });
  it("append path routes to append", async () => {
    const { service, google } = make();
    await service.writeSheet(ctx, "sheet1", { mode: "append", range: "A1:B2", values: [["x", "y"]] });
    expect(google.calls.sheetAppend).toBe(1);
    expect(google.calls.sheetUpdate).toBe(0);
  });
  it("404s when writing to a trashed sheet", async () => {
    const trashed: GoogleFileResource[] = [{ id: "s9", name: "S9", mimeType: "application/vnd.google-apps.spreadsheet", parents: [ROOT], trashed: true }];
    const { service } = make(Number.POSITIVE_INFINITY, trashed);
    await expectCode(() => service.writeSheet(ctx, "s9", { mode: "update", range: "A1", values: [["z"]] }), CommonErrorCodes.NOT_FOUND);
  });
  it("purges sheet cache after a write", async () => {
    const { service, google } = make();
    await service.readSheet("sheet1", "A1:B2");
    await service.writeSheet(ctx, "sheet1", { mode: "update", range: "A1:B2", values: [["p", "q"]] });
    await service.readSheet("sheet1", "A1:B2");
    expect(google.calls.sheetRead).toBe(2); // cache purged -> re-fetch
  });
});

describe("rate limit + quota", () => {
  it("throws RATE_LIMITED once the soft limit is reached", async () => {
    const { service } = make(1);
    await service.get("doc1"); // 1st acquire
    await expectCode(() => service.get("sheet1"), CommonErrorCodes.RATE_LIMITED);
  });
  it("reports quota status", async () => {
    const { service } = make(500);
    await service.get("doc1");
    const q = await service.quota();
    expect(q.usedRequests).toBe(1);
    expect(q.softLimit).toBe(500);
    expect(q.throttling).toBe(false);
  });
});
