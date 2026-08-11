// Free-tier consumer conversion: the retired EVT_FILE_META Queue consumer is exposed as
// POST /internal/events-async, running the SAME handler map (createEnvelopeConsumer) with
// D1 idempotency. Producers of drive.* / *.archived drain their deferred `evt.file-meta`
// outbox rows here over a service binding. Guarded by x-dub-internal (gateway 404s it for
// external clients). A handler failure returns non-2xx so the caller's row stays pending.
import { describe, it, expect } from "vitest";
import { createEvent, type DubEventEnvelope, type DubEventName, type DubEventPayloadMap } from "@dub/events";
import { createApp } from "../src/app";
import { createEnvelopeConsumer } from "../src/consumer";
import type { DriveClient, FileRepo } from "../src/deps";
import {
  createMemoryFileRepo,
  createMemoryBlobStore,
  createMemoryIdempotency,
  createStubAuth,
  createSpyEmit,
  createSpyAudit,
} from "./mem";

const drive: DriveClient = { async getFile(id) { return { name: `drive-${id}`, mimeType: "application/pdf" }; } };

function ev<N extends DubEventName>(name: N, payload: DubEventPayloadMap[N]): DubEventEnvelope<N> {
  return createEvent(name, payload, { requestId: "req_async", actorId: null });
}

function build(repoOverride?: FileRepo) {
  const repo = repoOverride ?? createMemoryFileRepo();
  const emitS = createSpyEmit();
  const app = createApp({
    repo,
    blobs: createMemoryBlobStore(),
    emit: emitS.emit,
    audit: createSpyAudit().audit,
    auth: createStubAuth({}),
    drive,
    consume: createEnvelopeConsumer({ repo, emit: emitS.emit, idempotency: createMemoryIdempotency(), drive }),
  });
  return { app, repo, emit: emitS.calls };
}

function post(app: ReturnType<typeof build>["app"], body: unknown, internal = true): Promise<Response> {
  const h = new Headers({ "content-type": "application/json", "x-dub-request-id": "req_async" });
  if (internal) h.set("x-dub-internal", "1");
  return Promise.resolve(app.fetch(new Request("https://svc/internal/events-async", { method: "POST", headers: h, body: JSON.stringify(body) })));
}

describe("POST /internal/events-async (free-tier consumer landing)", () => {
  it("404s without the x-dub-internal marker (never exposed to external clients)", async () => {
    const { app } = build();
    const res = await post(app, ev("drive.file.created", { driveFileId: "gd-guard" }), false);
    expect(res.status).toBe(404);
  });

  it("processes drive.file.created (202) — same handler as the Queue consumer", async () => {
    const { app, repo, emit } = build();
    const res = await post(app, ev("drive.file.created", { driveFileId: "gd-async" }));
    expect(res.status).toBe(202);
    const file = await repo.getByDriveFileId("gd-async");
    expect(file).not.toBeNull();
    expect(file!.name).toBe("drive-gd-async");
    expect(emit.map((c) => c.name)).toEqual(["file.registered"]);
  });

  it("is idempotent on envelope.id — re-delivery is a 202 no-op", async () => {
    const repo = createMemoryFileRepo();
    const { app } = build(repo);
    const envelope = ev("drive.file.created", { driveFileId: "gd-idem" });
    expect((await post(app, envelope)).status).toBe(202);
    expect((await post(app, envelope)).status).toBe(202); // same id
    expect([...repo._files.values()].filter((f) => f.driveFileId === "gd-idem")).toHaveLength(1);
  });

  it("acks unknown events (202) so a stray envelope is not retried forever", async () => {
    const { app } = build();
    const res = await post(app, ev("task.created", { taskId: "task_x", eventId: "event_x" }));
    expect(res.status).toBe(202);
  });

  it("returns 500 when a handler throws, so the caller's outbox row stays pending", async () => {
    const failing = createMemoryFileRepo();
    failing.getByDriveFileId = async () => { throw new Error("D1 down"); };
    const { app } = build(failing);
    const res = await post(app, ev("drive.file.created", { driveFileId: "gd-fail" }));
    expect(res.status).toBe(500);
  });
});
