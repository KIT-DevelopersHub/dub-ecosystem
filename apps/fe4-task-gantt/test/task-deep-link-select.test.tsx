// Deep-link task selection (①グローバル検索 extension): a Cmd/Ctrl+K "task" result
// navigates to /events/:eventId/tasks/:taskId — proves the task id is parsed from the
// path and the workspace auto-opens that task's detail panel once it loads.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { task, identity } from "@dub/types";
import { ApiClientProvider } from "../src/api/client-context";
import { TaskWorkspacePage } from "../src/components/TaskWorkspacePage";
import { MockApiClient } from "../src/api/mock-client";
import { parseTaskIdFromPath, parseEventIdFromPath } from "../src/routes/taskRoutes";

// A fresh QueryClient per render avoids inter-test cache bleed (mirrors App.tsx's own
// module-level `qc`, which this test intentionally does NOT reuse).
import { QueryClient } from "@tanstack/react-query";

const EVENT = "evt_test";
const PERMS: identity.PermissionKey[] = ["task:read", "task:write", "task:delete"];

const mk = (id: string, title: string): task.Task => ({
  id, eventId: EVENT, title, description: null, status: "todo",
  priority: "medium", assigneeId: "usr_a", dueAt: "2026-08-20T00:00:00Z", origin: "internal",
  archivedAt: null, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", version: 1,
});

function renderWorkspace(initialSelectedTaskId: string | null) {
  const client = new MockApiClient({
    users: [{ id: "usr_a", displayName: "Alice", avatarUrl: null }],
    tasks: [mk("t1", "会場予約"), mk("t2", "登壇者調整")],
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={client}>
        <ToastProvider>
          <TaskWorkspacePage eventId={EVENT} permissions={PERMS} initialSelectedTaskId={initialSelectedTaskId} />
        </ToastProvider>
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

describe("parseTaskIdFromPath / parseEventIdFromPath", () => {
  it("extracts eventId + taskId from a deep-linked task path", () => {
    expect(parseEventIdFromPath("/events/evt_1/tasks/tsk_9")).toBe("evt_1");
    expect(parseTaskIdFromPath("/events/evt_1/tasks/tsk_9")).toBe("tsk_9");
  });

  it("treats the legacy /board and /gantt sub-segments as NOT a task id", () => {
    expect(parseTaskIdFromPath("/events/evt_1/tasks/board")).toBeNull();
    expect(parseTaskIdFromPath("/events/evt_1/tasks/gantt")).toBeNull();
  });

  it("returns null for the bare workspace path (no task segment)", () => {
    expect(parseTaskIdFromPath("/events/evt_1/tasks")).toBeNull();
  });
});

describe("TaskWorkspacePage — deep-link initial selection", () => {
  it("auto-opens the detail panel for a task id present in the loaded list", async () => {
    renderWorkspace("t2");
    expect(await screen.findByTestId("fe4-detail-panel")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-detail-title")).toHaveValue("登壇者調整");
  });

  it("opens no panel when no deep-link id is given", async () => {
    renderWorkspace(null);
    await screen.findByTestId("fe4-gantt-row-t1");
    expect(screen.queryByTestId("fe4-detail-panel")).toBeNull();
  });

  it("ignores a deep-link id that never appears in the list (no crash, no panel)", async () => {
    renderWorkspace("does-not-exist");
    await screen.findByTestId("fe4-gantt-row-t1");
    expect(screen.queryByTestId("fe4-detail-panel")).toBeNull();
  });
});
