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

describe("createHttpUpstream.listDependencies response-shape tolerance", () => {
  const dep = (taskId: string, dependsOnId: string): task.TaskDependency => ({ taskId, dependsOnId });

  it("accepts a bare array response", async () => {
    const up = createHttpUpstream(envWith(fakeTaskFetcher({ dependencies: () => [dep("t1", "t0")] })));
    expect(await up.listDependencies(ctx, "event_1")).toEqual([dep("t1", "t0")]);
  });

  it("accepts a { dependencies } wrapper response", async () => {
    const up = createHttpUpstream(
      envWith(fakeTaskFetcher({ dependencies: () => ({ dependencies: [dep("t1", "t0")] }) })),
    );
    expect(await up.listDependencies(ctx, "event_1")).toEqual([dep("t1", "t0")]);
  });
});
