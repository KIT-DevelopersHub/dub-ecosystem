import { describe, it, expect } from "vitest";
import { createEvent, type DubEventEnvelope, type DubEventName, type DubEventPayloadMap } from "@dub/events";
import { createConsumer } from "../src/consumer";
import type { DriveClient, StoredLink } from "../src/deps";
import { createMemoryFileRepo, createMemoryIdempotency, createSpyEmit } from "./mem";
import { newId, nowIso } from "@dub/db";

const drive: DriveClient = { async getFile(id) { return { name: `Drive ${id}`, mimeType: "application/pdf" }; } };

function ev<N extends DubEventName>(name: N, payload: DubEventPayloadMap[N]): DubEventEnvelope<N> {
  return createEvent(name, payload, { requestId: "req_c", actorId: null });
}

function makeBatch(envelopes: DubEventEnvelope[]) {
  const acked: number[] = [];
  const retried: number[] = [];
  const messages = envelopes.map((body, i) => ({
    id: String(i), timestamp: new Date(), attempts: 1, body,
    ack() { acked.push(i); }, retry() { retried.push(i); },
  }));
  return { batch: { messages, queue: "dub-q-evt-file-meta", ackAll() {}, retryAll() {} } as unknown as never, acked, retried };
}

describe("drive.* subscriptions", () => {
  it("drive.file.created auto-registers meta (with drive completion) + emits file.registered", async () => {
    const repo = createMemoryFileRepo();
    const emitS = createSpyEmit();
    const consumer = createConsumer({ repo, emit: emitS.emit, drive });
    const { batch, acked } = makeBatch([ev("drive.file.created", { driveFileId: "gd-1" })]);
    await consumer(batch, {});
    expect(acked).toEqual([0]);
    const file = await repo.getByDriveFileId("gd-1");
    expect(file).not.toBeNull();
    expect(file!.name).toBe("Drive gd-1");
    expect(file!.ownerId).toBe("system");
    expect(emitS.calls.map((c) => c.name)).toEqual(["file.registered"]);
  });

  it("without drive client falls back to driveFileId as name", async () => {
    const repo = createMemoryFileRepo();
    const emitS = createSpyEmit();
    const consumer = createConsumer({ repo, emit: emitS.emit });
    const { batch } = makeBatch([ev("drive.file.created", { driveFileId: "gd-2" })]);
    await consumer(batch, {});
    expect((await repo.getByDriveFileId("gd-2"))!.name).toBe("gd-2");
  });

  it("drive.file.trashed soft-deletes + emits file.deleted", async () => {
    const repo = createMemoryFileRepo();
    const emitS = createSpyEmit();
    const consumer = createConsumer({ repo, emit: emitS.emit, drive });
    await consumer(makeBatch([ev("drive.file.created", { driveFileId: "gd-3" })]).batch, {});
    emitS.calls.length = 0;
    await consumer(makeBatch([ev("drive.file.trashed", { driveFileId: "gd-3" })]).batch, {});
    expect((await repo.getByDriveFileId("gd-3"))!.archivedAt).not.toBeNull();
    expect(emitS.calls.map((c) => c.name)).toEqual(["file.deleted"]);
  });

  it("drive.file.moved reflects renamed name", async () => {
    const repo = createMemoryFileRepo();
    const emitS = createSpyEmit();
    let name = "Old";
    const dyn: DriveClient = { async getFile() { return { name, mimeType: "text/plain" }; } };
    const consumer = createConsumer({ repo, emit: emitS.emit, drive: dyn });
    await consumer(makeBatch([ev("drive.file.created", { driveFileId: "gd-4" })]).batch, {});
    name = "New";
    await consumer(makeBatch([ev("drive.file.moved", { driveFileId: "gd-4" })]).batch, {});
    expect((await repo.getByDriveFileId("gd-4"))!.name).toBe("New");
  });
});

describe("*.archived suppression (links kept)", () => {
  async function seedLinkedFile(repo: ReturnType<typeof createMemoryFileRepo>, targetType: StoredLink["targetType"], targetId: string) {
    const now = nowIso();
    const file = await repo.createFile({
      id: newId("file"), name: "f", mimeType: "text/plain", sizeBytes: 1,
      ownerId: "u", visibility: "org", driveFileId: null, r2Key: null, createdBy: "u", createdAt: now, updatedAt: now,
    });
    await repo.addLink({ fileId: file.id, targetType, targetId, linkedBy: "u", linkedAt: now, archivedAt: null });
    return file;
  }

  it("event.archived archives matching links but keeps the row", async () => {
    const repo = createMemoryFileRepo();
    const consumer = createConsumer({ repo, emit: createSpyEmit().emit });
    const file = await seedLinkedFile(repo, "event", "event_9");
    await consumer(makeBatch([ev("event.archived", { eventId: "event_9" })]).batch, {});
    expect(await repo.listLinks(file.id)).toHaveLength(0); // suppressed from active list
    expect(repo._links).toHaveLength(1); // but row preserved
    expect(repo._links[0]!.archivedAt).not.toBeNull();
  });

  it("task.archived and action.archived suppress their links", async () => {
    const repo = createMemoryFileRepo();
    const consumer = createConsumer({ repo, emit: createSpyEmit().emit });
    const t = await seedLinkedFile(repo, "task", "task_1");
    const a = await seedLinkedFile(repo, "action", "action_1");
    await consumer(makeBatch([ev("task.archived", { taskId: "task_1", eventId: "event_1" })]).batch, {});
    await consumer(makeBatch([ev("action.archived", { actionId: "action_1", eventId: "event_1" })]).batch, {});
    expect(await repo.listLinks(t.id)).toHaveLength(0);
    expect(await repo.listLinks(a.id)).toHaveLength(0);
  });
});

describe("idempotency (test #11)", () => {
  it("re-delivering the same envelope.id is a no-op", async () => {
    const repo = createMemoryFileRepo();
    const emitS = createSpyEmit();
    const idem = createMemoryIdempotency();
    const consumer = createConsumer({ repo, emit: emitS.emit, drive, idempotency: idem });
    const envelope = ev("drive.file.created", { driveFileId: "gd-idem" });
    await consumer(makeBatch([envelope]).batch, {});
    await consumer(makeBatch([envelope]).batch, {}); // same id
    const all = [...repo._files.values()].filter((f) => f.driveFileId === "gd-idem");
    expect(all).toHaveLength(1);
    expect(emitS.calls).toHaveLength(1);
  });

  it("unique driveFileId dedups even without an idempotency store", async () => {
    const repo = createMemoryFileRepo();
    const emitS = createSpyEmit();
    const consumer = createConsumer({ repo, emit: emitS.emit, drive });
    // two distinct envelope ids, same drive file
    await consumer(makeBatch([ev("drive.file.created", { driveFileId: "gd-u" })]).batch, {});
    await consumer(makeBatch([ev("drive.file.created", { driveFileId: "gd-u" })]).batch, {});
    expect([...repo._files.values()].filter((f) => f.driveFileId === "gd-u")).toHaveLength(1);
  });
});

describe("unknown events", () => {
  it("acked without throwing", async () => {
    const repo = createMemoryFileRepo();
    const consumer = createConsumer({ repo, emit: createSpyEmit().emit });
    const { batch, acked, retried } = makeBatch([ev("task.created", { taskId: "task_x", eventId: "event_x" })]);
    await consumer(batch, {});
    expect(acked).toEqual([0]);
    expect(retried).toEqual([]);
  });
});
