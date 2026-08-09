import { describe, it, expect, vi } from "vitest";
import { MobileBffClient } from "../src/bff-client";
import { TaskRepository } from "../src/task-repository";
import { InMemorySessionStore } from "../src/session-store";
import { makeMockServer, errorBody } from "./helpers";

function setup(server = makeMockServer()) {
  const store = new InMemorySessionStore();
  store.setSession("tok_1", "r_1");
  const client = new MobileBffClient({ fetchFn: server.fetch, store, onLogout: vi.fn() });
  const repo = new TaskRepository(client);
  repo.seed([{ id: "tsk_1", title: "T1", status: "todo", assigneeId: "usr_me" }]);
  return { repo, server };
}

function fullTask(over: Record<string, unknown> = {}) {
  return {
    id: "tsk_1",
    eventId: "evt_1",
    title: "T1",
    description: null,
    status: "in_progress",
    priority: "medium",
    assigneeId: "usr_me",
    dueAt: null,
    origin: "internal",
    archivedAt: null,
    version: 2,
    createdAt: "2026-08-09T00:00:00Z",
    updatedAt: "2026-08-09T00:00:00Z",
    ...over,
  };
}

describe("TaskRepository — optimistic status change (§6, theme3 D4)", () => {
  it("success commits the authoritative server task", async () => {
    const server = makeMockServer({ status: 200, body: fullTask({ status: "done", version: 2 }) });
    const { repo } = setup(server);

    const states: string[] = [];
    repo.subscribe((tasks) => states.push(tasks[0]!.status));

    const res = await repo.updateStatus("tsk_1", "done", 1);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.task.version).toBe(2);
    expect(repo.observe()[0]!.status).toBe("done");
    // optimistic "done" emitted first, then committed "done"
    expect(states[0]).toBe("done");
  });

  it("409 -> rollback optimistic UI then refetch latest server state", async () => {
    const server = makeMockServer(
      { status: 409, body: errorBody("TASK_VERSION_CONFLICT", { serverVersion: 5 }) }, // PATCH
      { status: 200, body: fullTask({ status: "blocked", version: 5 }) }, // getTask refetch
    );
    const { repo } = setup(server);

    const seen: string[] = [];
    repo.subscribe((tasks) => seen.push(tasks[0]!.status));

    const res = await repo.updateStatus("tsk_1", "done", 1);
    expect(res.ok).toBe(false);
    if (!res.ok && res.conflict) expect(res.serverVersion).toBe(5);
    // final state = refetched server truth, not the optimistic "done" nor the stale "todo"
    expect(repo.observe()[0]!.status).toBe("blocked");
    // sequence: optimistic done -> rollback todo -> refetched blocked
    expect(seen).toEqual(["done", "todo", "blocked"]);
  });

  it("non-conflict error rolls back to the previous value", async () => {
    const server = makeMockServer({ status: 500, body: errorBody("INTERNAL") });
    const { repo } = setup(server);
    const res = await repo.updateStatus("tsk_1", "done", 1);
    expect(res.ok).toBe(false);
    if (!res.ok && !res.conflict) expect(res.error.kind).toBe("Server");
    expect(repo.observe()[0]!.status).toBe("todo"); // rolled back
  });

  it("updating an id not in cache returns an error without a network call", async () => {
    const server = makeMockServer();
    const { repo } = setup(server);
    const res = await repo.updateStatus("tsk_missing", "done", 1);
    expect(res.ok).toBe(false);
  });
});
