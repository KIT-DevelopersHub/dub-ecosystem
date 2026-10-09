import { describe, it, expect } from "vitest";
import type { identity, fileMeta } from "@dub/types";
import { createApp } from "../src/app";
import type { DriveClient } from "../src/deps";
import {
  createMemoryFileRepo,
  createMemoryBlobStore,
  createStubGranter,
  createSpyEmit,
  createSpyAudit,
} from "./mem";

// Grants carry BOTH halves of each rule, because POLICY_TABLE demands both: the Drive共有
// ロール管理 tier (`app:driveshare:view` / `:edit`) AND the fine-grained `file:*` key.
const GRANTS: Record<string, identity.PermissionKey[]> = {
  admin: ["app:driveshare:view", "app:driveshare:edit", "file:read", "file:write", "file:admin"],
  writer: ["app:driveshare:view", "app:driveshare:edit", "file:read", "file:write"],
  reader: ["app:driveshare:view", "file:read"],
  nobody: [],
  // A second writer, to exercise "someone else's private file" without using the admin.
  writer2: ["app:driveshare:view", "app:driveshare:edit", "file:read", "file:write"],
};

const drive: DriveClient = { async getFile(id) { return { name: `drive-${id}`, mimeType: "application/pdf" }; } };

function build(grants: Record<string, identity.PermissionKey[]> = GRANTS) {
  const repo = createMemoryFileRepo();
  const blobs = createMemoryBlobStore();
  const emitS = createSpyEmit();
  const auditS = createSpyAudit();
  const app = createApp({ repo, blobs, emit: emitS.emit, audit: auditS.audit, authz: createStubGranter(grants), drive });
  return { app, repo, blobs, emit: emitS.calls, audit: auditS.calls };
}

interface ReqOpts { userId?: string; body?: unknown; raw?: Uint8Array; contentType?: string; headers?: Record<string, string> }
function req(app: ReturnType<typeof build>["app"], method: string, path: string, o: ReqOpts = {}): Promise<Response> {
  const h = new Headers({ "x-dub-request-id": "req_test", ...(o.headers ?? {}) });
  if (o.userId) h.set("x-dub-user-id", o.userId);
  const init: RequestInit = { method, headers: h };
  if (o.body !== undefined) { h.set("content-type", "application/json"); init.body = JSON.stringify(o.body); }
  else if (o.raw !== undefined) { h.set("content-type", o.contentType ?? "application/octet-stream"); init.body = o.raw; }
  return Promise.resolve(app.fetch(new Request(`https://svc${path}`, init)));
}

async function register(app: ReturnType<typeof build>["app"], userId: string, over: Partial<fileMeta.RegisterMetaRequest> = {}): Promise<fileMeta.FileMeta> {
  const res = await req(app, "POST", "/files/meta", { userId, body: { name: "doc.txt", mimeType: "text/plain", sizeBytes: 10, ...over } });
  expect(res.status).toBe(201);
  return res.json() as Promise<fileMeta.FileMeta>;
}

describe("health", () => {
  it("returns contract version", async () => {
    const { app } = build();
    // INTERNAL in POLICY_TABLE: a probe arrives over a Service Binding carrying the marker.
    // The refusal path for a request without it is asserted in test/policy-table.test.ts.
    const res = await req(app, "GET", "/internal/health", { headers: { "x-dub-internal": "1" } });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; contractVersion: string };
    expect(body.status).toBe("ok");
    expect(body.contractVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("meta CRUD (test #1)", () => {
  it("register -> get -> update -> delete, then write is 409", async () => {
    const { app, emit } = build();
    const file = await register(app, "writer", { driveFileId: "gdrive-1" });
    expect(file.id).toMatch(/^file_/);
    expect(file.driveFileId).toBe("gdrive-1");
    expect((file as unknown as { archivedAt?: unknown }).archivedAt).toBeUndefined();

    const got = await req(app, "GET", `/files/meta/${file.id}`, { userId: "reader" });
    expect(got.status).toBe(200);

    const upd = await req(app, "PATCH", `/files/meta/${file.id}`, { userId: "writer", body: { name: "renamed.txt" } });
    expect(upd.status).toBe(200);
    const updBody = await upd.json() as fileMeta.FileMeta;
    expect(updBody.name).toBe("renamed.txt");
    expect(updBody.updatedAt >= file.updatedAt).toBe(true);

    const del = await req(app, "DELETE", `/files/meta/${file.id}`, { userId: "writer" });
    expect(del.status).toBe(204);

    const writeAfter = await req(app, "PATCH", `/files/meta/${file.id}`, { userId: "writer", body: { name: "x.txt" } });
    expect(writeAfter.status).toBe(409);
    const err = await writeAfter.json() as { error: { code: string } };
    expect(err.error.code).toBe("FILE_DELETED_IMMUTABLE");

    // delete is idempotent
    const del2 = await req(app, "DELETE", `/files/meta/${file.id}`, { userId: "writer" });
    expect(del2.status).toBe(204);

    expect(emit.map((e) => e.name)).toEqual(expect.arrayContaining(["file.registered", "file.updated", "file.deleted"]));
  });
});

describe("duplicate external id (test #2)", () => {
  it("same driveFileId -> 409 FILE_DUPLICATE_EXTERNAL", async () => {
    const { app } = build();
    await register(app, "writer", { driveFileId: "dup-1" });
    const res = await req(app, "POST", "/files/meta", { userId: "writer", body: { name: "b", mimeType: "text/plain", sizeBytes: 1, driveFileId: "dup-1" } });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("FILE_DUPLICATE_EXTERNAL");
  });
});

describe("links (test #3)", () => {
  it("add / remove / duplicate", async () => {
    const { app, emit } = build();
    const file = await register(app, "writer");
    const add = await req(app, "POST", `/files/meta/${file.id}/links`, { userId: "writer", body: { targetType: "event", targetId: "event_1" } });
    expect(add.status).toBe(201);

    const dup = await req(app, "POST", `/files/meta/${file.id}/links`, { userId: "writer", body: { targetType: "event", targetId: "event_1" } });
    expect(dup.status).toBe(409);
    expect((await dup.json() as { error: { code: string } }).error.code).toBe("FILE_DUPLICATE_LINK");

    const withLinks = await req(app, "GET", `/files/meta/${file.id}?include=links`, { userId: "reader" });
    const wl = await withLinks.json() as { links: fileMeta.FileMetaLink[] };
    expect(wl.links).toHaveLength(1);
    expect(wl.links[0]!.targetId).toBe("event_1");

    const rm = await req(app, "DELETE", `/files/meta/${file.id}/links`, { userId: "writer", body: { targetType: "event", targetId: "event_1" } });
    expect(rm.status).toBe(204);

    const rm2 = await req(app, "DELETE", `/files/meta/${file.id}/links`, { userId: "writer", body: { targetType: "event", targetId: "event_1" } });
    expect(rm2.status).toBe(404);

    expect(emit.map((e) => e.name)).toEqual(expect.arrayContaining(["file.linked", "file.unlinked"]));
  });

  it("invalid targetType -> 400", async () => {
    const { app } = build();
    const file = await register(app, "writer");
    const res = await req(app, "POST", `/files/meta/${file.id}/links`, { userId: "writer", body: { targetType: "bogus", targetId: "x" } });
    expect(res.status).toBe(400);
  });
});

describe("search (test #4, #5)", () => {
  it("AND filters q / mimeType / ownerId", async () => {
    const { app } = build();
    await register(app, "writer", { name: "alpha-report.pdf", mimeType: "application/pdf" });
    await register(app, "writer", { name: "beta-notes.txt", mimeType: "text/plain" });
    await register(app, "admin", { name: "alpha-admin.pdf", mimeType: "application/pdf" });

    const byQ = await req(app, "GET", "/files/search?q=alpha", { userId: "reader" });
    expect((await byQ.json() as fileMeta.FileSearchResponse).items).toHaveLength(2);

    const byMime = await req(app, "GET", "/files/search?mimeType=text/plain", { userId: "reader" });
    expect((await byMime.json() as fileMeta.FileSearchResponse).items).toHaveLength(1);

    const byOwnerAndQ = await req(app, "GET", "/files/search?q=alpha&ownerId=admin", { userId: "reader" });
    const r = await byOwnerAndQ.json() as fileMeta.FileSearchResponse;
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.name).toBe("alpha-admin.pdf");
  });

  it("pagination cursor + limit boundaries", async () => {
    const { app } = build();
    for (let i = 0; i < 5; i++) await register(app, "writer", { name: `f${i}` });

    const p1 = await req(app, "GET", "/files/search?limit=2", { userId: "reader" });
    const b1 = await p1.json() as fileMeta.FileSearchResponse;
    expect(b1.items).toHaveLength(2);
    expect(b1.nextCursor).not.toBeNull();

    const seen = new Set(b1.items.map((f) => f.id));
    let cursor = b1.nextCursor;
    while (cursor) {
      const pn = await req(app, "GET", `/files/search?limit=2&cursor=${encodeURIComponent(cursor)}`, { userId: "reader" });
      const bn = await pn.json() as fileMeta.FileSearchResponse;
      for (const f of bn.items) { expect(seen.has(f.id)).toBe(false); seen.add(f.id); }
      cursor = bn.nextCursor;
    }
    expect(seen.size).toBe(5);

    expect((await req(app, "GET", "/files/search?limit=1", { userId: "reader" })).status).toBe(200);
    expect((await req(app, "GET", "/files/search?limit=200", { userId: "reader" })).status).toBe(200);
    expect((await req(app, "GET", "/files/search?limit=201", { userId: "reader" })).status).toBe(400);
    expect((await req(app, "GET", "/files/search?limit=0", { userId: "reader" })).status).toBe(400);
  });
});

describe("R2 upload/download round-trip (test #6, #7)", () => {
  it("upload -> auto meta -> download bytes match", async () => {
    const { app, emit } = build();
    const bytes = new TextEncoder().encode("hello attachment");
    const up = await req(app, "POST", "/files", { userId: "writer", raw: bytes, contentType: "text/plain", headers: { "x-dub-filename": "note.txt" } });
    expect(up.status).toBe(201);
    const file = await up.json() as fileMeta.FileMeta;
    expect(file.r2Key).not.toBeNull();
    expect(file.driveFileId).toBeNull();
    expect(file.sizeBytes).toBe(bytes.byteLength);

    const dl = await req(app, "GET", `/files/${file.id}/download`, { userId: "reader" });
    expect(dl.status).toBe(200);
    const got = new Uint8Array(await dl.arrayBuffer());
    expect(new TextDecoder().decode(got)).toBe("hello attachment");

    expect(emit.filter((e) => e.name === "file.registered")).toHaveLength(1);
  });

  it("download of a drive file -> 409 FILE_NOT_DOWNLOADABLE", async () => {
    const { app } = build();
    const file = await register(app, "writer", { driveFileId: "gd-x" });
    const dl = await req(app, "GET", `/files/${file.id}/download`, { userId: "reader" });
    expect(dl.status).toBe(409);
    expect((await dl.json() as { error: { code: string } }).error.code).toBe("FILE_NOT_DOWNLOADABLE");
  });

  it("upload over the size cap -> 413", async () => {
    const repo = createMemoryFileRepo();
    const blobs = createMemoryBlobStore();
    const emitS = createSpyEmit();
    const auditS = createSpyAudit();
    const app = createApp({ repo, blobs, emit: emitS.emit, audit: auditS.audit, authz: createStubGranter(GRANTS), config: { maxUploadBytes: 4 } });
    const res = await req(app, "POST", "/files", { userId: "writer", raw: new Uint8Array([1, 2, 3, 4, 5]) });
    expect(res.status).toBe(413);
  });
});

describe("authz + visibility (test #9)", () => {
  it("401 without user, 403 without permission", async () => {
    const { app } = build();
    expect((await req(app, "GET", "/files/search", {})).status).toBe(401);
    const file = await register(app, "writer");
    expect((await req(app, "PATCH", `/files/meta/${file.id}`, { userId: "reader", body: { name: "x" } })).status).toBe(403);
  });

  it("private file: non-owner reader 403, owner ok, admin ok", async () => {
    const { app } = build();
    const file = await register(app, "writer", { visibility: "private" });
    // reader (has file:read) but not owner/admin
    expect((await req(app, "GET", `/files/meta/${file.id}`, { userId: "reader" })).status).toBe(403);
    // owner is "writer"
    expect((await req(app, "GET", `/files/meta/${file.id}`, { userId: "writer" })).status).toBe(200);
    // admin
    expect((await req(app, "GET", `/files/meta/${file.id}`, { userId: "admin" })).status).toBe(200);
  });

  it("private files are hidden from non-owner search results", async () => {
    const { app } = build();
    await register(app, "writer", { name: "secret", visibility: "private" });
    await register(app, "writer", { name: "public-doc", visibility: "org" });
    const res = await req(app, "GET", "/files/search", { userId: "reader" });
    const items = (await res.json() as fileMeta.FileSearchResponse).items;
    expect(items.map((f) => f.name)).toEqual(["public-doc"]);
  });

  it("owner change requires file:admin", async () => {
    const { app } = build();
    const file = await register(app, "writer");
    const asWriter = await req(app, "PATCH", `/files/meta/${file.id}`, { userId: "writer", body: { ownerId: "someone" } });
    expect(asWriter.status).toBe(403);
    const asAdmin = await req(app, "PATCH", `/files/meta/${file.id}`, { userId: "admin", body: { ownerId: "someone" } });
    expect(asAdmin.status).toBe(200);
    expect((await asAdmin.json() as fileMeta.FileMeta).ownerId).toBe("someone");
  });
});

// The instance-level half of the policy migration (inventory §3(d)). The table can only say
// "this caller may write files"; whether THIS private file is theirs to write is asserted in
// the handler, and before the migration it was not asserted at all on the mutating routes —
// a `file:write` holder could logically delete, rename and relink a private file it was
// forbidden to read. These are the regression guards for that fix.
describe("private-file ownership on mutations (§3(d) fix)", () => {
  // writer2 holds the full 編集 tier + file:write, i.e. the table lets it in. Only the
  // instance-level check stands between it and someone else's private file.
  const privateOf = async (app: ReturnType<typeof build>["app"]): Promise<fileMeta.FileMeta> =>
    register(app, "writer", { visibility: "private" });

  it("DELETE: a non-owner writer cannot logically delete someone else's private file", async () => {
    const { app, repo } = build();
    const file = await privateOf(app);
    const res = await req(app, "DELETE", `/files/meta/${file.id}`, { userId: "writer2" });
    expect(res.status).toBe(403);
    // and the row is genuinely untouched (not a 403 after the write)
    expect((await repo.getFile(file.id))!.archivedAt).toBeNull();
  });

  it("DELETE: the owner and a file:admin still can", async () => {
    const { app } = build();
    const own = await privateOf(app);
    expect((await req(app, "DELETE", `/files/meta/${own.id}`, { userId: "writer" })).status).toBe(204);
    const other = await privateOf(app);
    expect((await req(app, "DELETE", `/files/meta/${other.id}`, { userId: "admin" })).status).toBe(204);
  });

  it("PATCH: a non-owner writer cannot edit someone else's private file", async () => {
    const { app, repo } = build();
    const file = await privateOf(app);
    const res = await req(app, "PATCH", `/files/meta/${file.id}`, { userId: "writer2", body: { name: "stolen.txt" } });
    expect(res.status).toBe(403);
    expect((await repo.getFile(file.id))!.name).toBe("doc.txt");
  });

  it("links: a non-owner writer can neither link nor unlink someone else's private file", async () => {
    const { app } = build();
    const file = await privateOf(app);
    const link = { targetType: "event", targetId: "event_1" };
    expect((await req(app, "POST", `/files/meta/${file.id}/links`, { userId: "writer2", body: link })).status).toBe(403);
    // owner links it, the other writer still cannot remove it
    expect((await req(app, "POST", `/files/meta/${file.id}/links`, { userId: "writer", body: link })).status).toBe(201);
    expect((await req(app, "DELETE", `/files/meta/${file.id}/links`, { userId: "writer2", body: link })).status).toBe(403);
    expect((await req(app, "DELETE", `/files/meta/${file.id}/links`, { userId: "writer", body: link })).status).toBe(204);
  });

  it("org files stay writable by any writer (the check narrows private only)", async () => {
    const { app } = build();
    const file = await register(app, "writer", { visibility: "org" });
    expect((await req(app, "PATCH", `/files/meta/${file.id}`, { userId: "writer2", body: { name: "ok.txt" } })).status).toBe(200);
    expect((await req(app, "DELETE", `/files/meta/${file.id}`, { userId: "writer2" })).status).toBe(204);
  });
});

describe("audit + emit per write (test #10)", () => {
  it("each write op records one audit entry", async () => {
    const { app, audit } = build();
    const file = await register(app, "writer");
    await req(app, "PATCH", `/files/meta/${file.id}`, { userId: "writer", body: { name: "y" } });
    await req(app, "POST", `/files/meta/${file.id}/links`, { userId: "writer", body: { targetType: "task", targetId: "task_1" } });
    await req(app, "DELETE", `/files/meta/${file.id}/links`, { userId: "writer", body: { targetType: "task", targetId: "task_1" } });
    await req(app, "DELETE", `/files/meta/${file.id}`, { userId: "writer" });
    const actions = audit.map((a) => (a as { action: string }).action);
    expect(actions).toEqual([
      "file.meta.registered",
      "file.meta.updated",
      "file.link.added",
      "file.link.removed",
      "file.meta.deleted",
    ]);
  });
});

describe("routing (test #13)", () => {
  it("GET /files/meta/:id is not captured by /files/:id/download", async () => {
    const { app } = build();
    const file = await register(app, "writer");
    const res = await req(app, "GET", `/files/meta/${file.id}`, { userId: "reader" });
    expect(res.status).toBe(200);
    // malformed id -> 404 (ULID guard), not routed to download
    expect((await req(app, "GET", "/files/meta/not-a-ulid", { userId: "reader" })).status).toBe(404);
  });
});
