import { describe, it, expect, vi, afterEach } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";
import type { task } from "@dub/types";
import { createHttpUpstream } from "../src/upstream";
import type { Env } from "../src/env";

const ctx = { requestId: "req_test", userId: "user_a" };

// A fake Service Binding: routes by pathname, returns JSON. `tasksResponder`
// receives the incoming cursor (undefined on the first page) and returns the
// page body, letting a test drive the pagination loop deterministically.
function fakeTaskFetcher(handlers: {
  tasks?: (cursor: string | undefined) => task.ListTasksResponse;
  dependencies?: () => unknown;
}): Fetcher {
  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === "/tasks" && handlers.tasks) {
        const cursor = url.searchParams.get("cursor") ?? undefined;
        return new Response(JSON.stringify(handlers.tasks(cursor)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/tasks/dependencies" && handlers.dependencies) {
        return new Response(JSON.stringify(handlers.dependencies()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;
}

function mkTask(id: string): task.Task {
  return {
    id,
    eventId: "event_1",
    title: id,
    description: null,
    status: "todo",
    priority: "medium",
    assigneeId: null,
    dueAt: null,
    origin: "internal",
    archivedAt: null,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    version: 1,
  };
}

function envWith(taskSvc: Fetcher): Env {
  return { SVC_TASK: taskSvc, SVC_EVENT: taskSvc, SVC_IDENTITY: taskSvc } as unknown as Env;
}

afterEach(() => vi.restoreAllMocks());

describe("createHttpUpstream.listTasks pagination", () => {
  it("stops and returns all tasks when the cursor is exhausted (no truncation warning)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // two pages: page 0 -> nextCursor, page 1 -> no cursor (natural end)
    const up = createHttpUpstream(
      envWith(
        fakeTaskFetcher({
          tasks: (cursor) =>
            cursor === undefined
              ? { items: [mkTask("t0")], nextCursor: "c1" }
              : { items: [mkTask("t1")], nextCursor: null },
        }),
      ),
    );
    const tasks = await up.listTasks(ctx, "event_1");
    expect(tasks.map((t) => t.id)).toEqual(["t0", "t1"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("caps at MAX_PAGES and emits a structured truncation warning when more pages remain", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let served = 0;
    // Every page always advertises a nextCursor -> the loop can only stop at the cap.
    const up = createHttpUpstream(
      envWith(
        fakeTaskFetcher({
          tasks: () => {
            const id = `t${served++}`;
            return { items: [mkTask(id)], nextCursor: "always-more" };
          },
        }),
      ),
    );
    const tasks = await up.listTasks(ctx, "event_1");
    // Exactly MAX_PAGES fetches (25), one task each; nothing infinite.
    expect(tasks).toHaveLength(25);
    expect(served).toBe(25);
    expect(warn).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((warn.mock.calls[0] as unknown[])[0] as string);
    expect(payload).toMatchObject({
      service: "gantt-service",
      event: "gantt.tasks.truncated",
      requestId: "req_test",
      eventId: "event_1",
      maxPages: 25,
      loadedTasks: 25,
    });
  });

  it("filters archived tasks out of the page accumulation", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const archived = { ...mkTask("t_arch"), archivedAt: "2026-08-02T00:00:00Z" };
    const up = createHttpUpstream(
      envWith(fakeTaskFetcher({ tasks: () => ({ items: [mkTask("t_live"), archived], nextCursor: null }) })),
    );
    const tasks = await up.listTasks(ctx, "event_1");
    expect(tasks.map((t) => t.id)).toEqual(["t_live"]);
  });
});

// A task-service fake for the date read-modify-write. GET /tasks/:id returns the CURRENT
// (mutable) version; PATCH /tasks/:id 409s while `conflictsLeft > 0` (modelling another
// writer that bumped the version between our read and write — the overlapping-resize race),
// then succeeds. Every PATCH attempt is counted so a test can assert the retry happened.
function rmwTaskFetcher(opts: { conflicts: number; startVersion?: number }): {
  fetcher: Fetcher;
  getCount: () => number;
  patchCount: () => number;
} {
  let version = opts.startVersion ?? 1;
  let conflictsLeft = opts.conflicts;
  let gets = 0;
  let patches = 0;
  const fetcher = {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const m = url.pathname.match(/^\/tasks\/([^/]+)$/);
      if (!m) return new Response("not found", { status: 404 });
      const id = decodeURIComponent(m[1]!);
      if (req.method === "GET") {
        gets++;
        return new Response(JSON.stringify({ ...mkTask(id), version }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (req.method === "PATCH") {
        patches++;
        if (conflictsLeft > 0) {
          conflictsLeft--;
          version++; // the "other writer" moved the version on — our next read sees it
          return new Response(
            JSON.stringify({
              error: { code: "TASK_VERSION_CONFLICT", message: "Version conflict (stale version)", retryable: false },
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          );
        }
        version++;
        return new Response(JSON.stringify({ ...mkTask(id), version, dueAt: "2026-09-10T00:00:00.000Z" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;
  return { fetcher, getCount: () => gets, patchCount: () => patches };
}

describe("createHttpUpstream.updateTaskDates — version-conflict retry (症状#8 稀リサイズエラー)", () => {
  it("retries the read-modify-write on a 409 and succeeds (spurious self-conflict absorbed)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetcher, getCount, patchCount } = rmwTaskFetcher({ conflicts: 1 });
    const up = createHttpUpstream(envWith(fetcher));
    const res = await up.updateTaskDates(ctx, "t1", {
      startsAt: "2026-09-07T00:00:00.000Z",
      endsAt: "2026-09-10T00:00:00.000Z",
    });
    expect(res.id).toBe("t1");
    // one conflict => two PATCH attempts, each preceded by a fresh GET (re-read version).
    expect(patchCount()).toBe(2);
    expect(getCount()).toBe(2);
    warn.mockRestore();
  });

  it("propagates the 409 only after retries are exhausted (a truly persistent conflict)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Always conflicts => 1 initial + RMW_MAX_RETRIES(3) retries = 4 attempts, then throw.
    const { fetcher, patchCount } = rmwTaskFetcher({ conflicts: 99 });
    const up = createHttpUpstream(envWith(fetcher));
    await expect(
      up.updateTaskDates(ctx, "t1", { startsAt: null, endsAt: "2026-09-10T00:00:00.000Z" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(patchCount()).toBe(4);
    warn.mockRestore();
  });

  it("does NOT retry a non-conflict error (404 propagates immediately, no extra attempts)", async () => {
    const fetcher = {
      async fetch(req: Request): Promise<Response> {
        if (req.method === "GET") {
          return new Response(JSON.stringify(mkTask("t1")), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        // PATCH 404 (task vanished) — not a version race, so it must surface at once.
        return new Response(
          JSON.stringify({ error: { code: "TASK_NOT_FOUND", message: "not found", retryable: false } }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      },
    } as unknown as Fetcher;
    const up = createHttpUpstream(envWith(fetcher));
    await expect(
      up.updateTaskDates(ctx, "t1", { startsAt: null, endsAt: "2026-09-10T00:00:00.000Z" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("createHttpUpstream.listDependencies contract", () => {
  const dep = (taskId: string, dependsOnId: string): task.TaskDependency => ({ taskId, dependsOnId });

  it("reads the task-service { items } wire shape", async () => {
    const up = createHttpUpstream(
      envWith(fakeTaskFetcher({ dependencies: () => ({ items: [dep("t1", "t0")] }) })),
    );
    expect(await up.listDependencies(ctx, "event_1")).toEqual([dep("t1", "t0")]);
  });

  it("returns an empty edge set when the event has no dependencies", async () => {
    const up = createHttpUpstream(envWith(fakeTaskFetcher({ dependencies: () => ({ items: [] }) })));
    expect(await up.listDependencies(ctx, "event_1")).toEqual([]);
  });
});
