// #881: 依頼者 is optional and settable — defaults to the creator in both create forms,
// can be changed / cleared there and in the detail panel, and is the My Tasks "from".
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders as render } from "./helpers-providers";
import type { identity, task } from "@dub/types";
import { TaskCreateModal } from "../src/components/TaskCreateModal";
import { MyTaskCreateModal } from "../src/components/MyTaskCreateModal";
import { TaskDetailPanel } from "../src/components/TaskDetailPanel";
import { MockApiClient } from "../src/api/mock-client";
import { requesterOf } from "../src/domain/my-tasks";

beforeEach(() => localStorage.clear());

const ME = "usr_me";
const USERS = [
  { id: ME, displayName: "自分" },
  { id: "usr_rita", displayName: "依頼さん" },
] as identity.UserSummary[];

const mkTask = (over: Partial<task.Task> = {}): task.Task => ({
  id: "t1", eventId: "evt_1", title: "T", description: null, status: "todo",
  priority: "medium", assigneeId: null, teamId: null, startAt: null, dueAt: null,
  origin: "internal", archivedAt: null, createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z", version: 1, ...over,
});

describe("依頼者 in the create forms", () => {
  it("タスク作成: defaults to me, and a cleared 依頼者 is sent as null", async () => {
    const onCreate = vi.fn(async () => true);
    render(
      <TaskCreateModal open onClose={() => {}} users={USERS} teams={[]} parentOptions={[]} scopeTasks={[]} onCreate={onCreate} currentUserId={ME} />,
    );
    const sel = screen.getByTestId("fe4-create-requester") as HTMLSelectElement;
    expect(sel.value).toBe(ME);
    fireEvent.change(screen.getByTestId("fe4-create-title"), { target: { value: "x" } });
    fireEvent.change(sel, { target: { value: "" } });
    fireEvent.click(screen.getByTestId("fe4-create-submit"));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect((onCreate.mock.calls[0] as unknown as [{ requesterId: string | null }])[0].requesterId).toBeNull();
  });

  it("タスク発行: defaults to me, and another 依頼者 can be chosen", async () => {
    const onCreate = vi.fn(async () => {});
    render(
      <MyTaskCreateModal open onClose={() => {}} people={USERS} teams={[]} parentOptions={[]} scopeTasks={[]} onCreate={onCreate} currentUserId={ME} />,
    );
    const sel = screen.getByTestId("fe4-mytask-create-requester") as HTMLSelectElement;
    expect(sel.value).toBe(ME);
    fireEvent.change(screen.getByTestId("fe4-mytask-create-title"), { target: { value: "x" } });
    fireEvent.change(sel, { target: { value: "usr_rita" } });
    fireEvent.click(screen.getByTestId("fe4-mytask-create-submit"));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect((onCreate.mock.calls[0] as unknown as [{ requesterId: string | null }])[0].requesterId).toBe("usr_rita");
  });
});

describe("依頼者 in the detail panel", () => {
  it("changing / clearing the 依頼者 auto-saves requesterId", async () => {
    const onSave = vi.fn();
    render(
      <TaskDetailPanel task={mkTask({ requesterId: ME })} users={USERS} canWrite canDelete onSave={onSave} onDelete={() => {}} onClose={() => {}} autosaveDebounceMs={0} />,
    );
    fireEvent.change(screen.getByTestId("fe4-detail-requester"), { target: { value: "" } });
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0].requesterId).toBeNull();
  });

  it("is disabled when the task is read-only", () => {
    render(
      <TaskDetailPanel task={mkTask({ requesterId: ME })} users={USERS} canWrite={false} canDelete={false} onSave={() => {}} onDelete={() => {}} onClose={() => {}} />,
    );
    expect((screen.getByTestId("fe4-detail-requester") as HTMLSelectElement).disabled).toBe(true);
  });
});

describe("requesterOf / mock-client persistence", () => {
  it("requesterId wins (null = なし); absent falls back to createdBy", () => {
    expect(requesterOf({ requesterId: "usr_rita", createdBy: ME })).toBe("usr_rita");
    expect(requesterOf({ requesterId: null, createdBy: ME })).toBeNull();
    expect(requesterOf({ createdBy: ME })).toBe(ME);
  });

  it("the mock persists set / clear like task-service", async () => {
    const client = new MockApiClient({ tasks: [], currentUserId: ME });
    const created = await client.request<task.Task>({ method: "POST", path: "/api/v1/tasks", body: { eventId: "evt_1", title: "T" } });
    expect(created.requesterId).toBe(ME);
    const set = await client.request<task.Task>({ method: "PATCH", path: `/api/v1/tasks/${created.id}`, body: { version: 1, requesterId: "usr_rita" } });
    expect(set.requesterId).toBe("usr_rita");
    const cleared = await client.request<task.Task>({ method: "PATCH", path: `/api/v1/tasks/${created.id}`, body: { version: 2, requesterId: null } });
    expect(cleared.requesterId).toBeNull();
  });
});
