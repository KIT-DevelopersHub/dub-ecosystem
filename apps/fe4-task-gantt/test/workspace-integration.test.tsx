import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { task, identity } from "@dub/types";
import { App } from "../src/App";
import { MockApiClient } from "../src/api/mock-client";

const EVENT = "evt_test";
const PERMS: identity.PermissionKey[] = ["task:read", "task:write", "task:delete"];

const mk = (id: string, title: string, status: task.TaskStatus, due: string): task.Task => ({
  id, eventId: EVENT, title, description: null, status,
  priority: "medium", assigneeId: "usr_a", dueAt: due, origin: "internal",
  archivedAt: null, createdAt: `2026-08-0${id.length}T00:00:00Z`, updatedAt: "2026-08-01T00:00:00Z", version: 1,
});

function seedClient(): MockApiClient {
  return new MockApiClient({
    users: [{ id: "usr_a", displayName: "Alice", avatarUrl: null }],
    tasks: [
      mk("t1", "会場予約", "done", "2026-08-10T00:00:00Z"),
      mk("t2", "登壇者調整", "todo", "2026-08-20T00:00:00Z"),
    ],
  });
}

const renderApp = () => render(<App client={seedClient()} eventId={EVENT} permissions={PERMS} />);

describe("TaskWorkspacePage — gantt-only workspace", () => {
  it("renders the gantt with no list/board view switcher", async () => {
    renderApp();
    expect(await screen.findByTestId("fe4-gantt-view")).toBeInTheDocument();
    expect(screen.queryByTestId("fe4-view-switcher")).toBeNull();
    expect(await screen.findByTestId("fe4-gantt-row-t1")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-gantt-row-t2")).toBeInTheDocument();
  });

  it("keeps the day/week/month zoom control", async () => {
    renderApp();
    expect(await screen.findByTestId("fe4-gantt-zoom-day")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("fe4-gantt-zoom-day"));
    expect(screen.getByTestId("fe4-gantt-zoom-day")).toHaveAttribute("aria-selected", "true");
  });

  it("filters the bars by status and clears back", async () => {
    renderApp();
    await screen.findByTestId("fe4-gantt-row-t1");
    // narrow to done → only t1 remains
    fireEvent.click(screen.getByTestId("fe4-filter-status-done"));
    await waitFor(() => expect(screen.queryByTestId("fe4-gantt-row-t2")).toBeNull());
    expect(screen.getByTestId("fe4-gantt-row-t1")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-filter-count")).toHaveTextContent("1");
    // clear → both back
    fireEvent.click(screen.getByTestId("fe4-filter-clear"));
    await waitFor(() => expect(screen.getByTestId("fe4-gantt-row-t2")).toBeInTheDocument());
  });

  it("creates a task via the modal and it appears on the gantt", async () => {
    renderApp();
    await screen.findByTestId("fe4-gantt-row-t1");
    fireEvent.click(screen.getByTestId("fe4-create-open"));
    const modal = await screen.findByTestId("fe4-mytask-create-modal");
    fireEvent.change(within(modal).getByTestId("fe4-mytask-create-title"), { target: { value: "新しい打合せ" } });
    fireEvent.change(within(modal).getByTestId("fe4-mytask-create-due"), { target: { value: "2026-08-25" } });
    fireEvent.click(within(modal).getByTestId("fe4-mytask-create-submit"));
    expect((await screen.findAllByText("新しい打合せ")).length).toBeGreaterThan(0);
  });

  it("③ gantt発行ダイアログは 対象イベント欄を出さず、作成タスクにヘッダーのeventIdを裏で自動セットする", async () => {
    const client = seedClient();
    render(<App client={client} eventId={EVENT} permissions={PERMS} />);
    await screen.findByTestId("fe4-gantt-row-t1");
    fireEvent.click(screen.getByTestId("fe4-create-open"));
    const modal = await screen.findByTestId("fe4-mytask-create-modal");
    // 対象イベント欄は非表示（ヘッダー選択中イベントで確定）
    expect(within(modal).queryByTestId("fe4-mytask-create-event")).toBeNull();
    // 開始日・終了日は横並びの2フィールドとして存在
    expect(within(modal).getByTestId("fe4-mytask-create-start")).toBeInTheDocument();
    expect(within(modal).getByTestId("fe4-mytask-create-due")).toBeInTheDocument();
    fireEvent.change(within(modal).getByTestId("fe4-mytask-create-title"), { target: { value: "撤収作業" } });
    fireEvent.click(within(modal).getByTestId("fe4-mytask-create-submit"));
    await waitFor(() => {
      const post = client.calls.find((c) => c.path === "/api/v1/tasks" && c.method === "POST");
      expect(post).toBeTruthy();
      expect((post?.body as { eventId?: string }).eventId).toBe(EVENT);
    });
  });

  it("edits a task from the detail panel", async () => {
    renderApp();
    fireEvent.click(await screen.findByTestId("fe4-gantt-row-t2"));
    const panel = await screen.findByTestId("fe4-detail-panel");
    fireEvent.change(within(panel).getByTestId("fe4-detail-title"), { target: { value: "登壇者の最終調整" } });
    fireEvent.click(within(panel).getByTestId("fe4-detail-save"));
    expect((await screen.findAllByText("登壇者の最終調整")).length).toBeGreaterThan(0);
  });

  it("deletes a task from the detail panel", async () => {
    renderApp();
    fireEvent.click(await screen.findByTestId("fe4-gantt-row-t2"));
    fireEvent.click(await screen.findByTestId("fe4-detail-delete"));
    fireEvent.click(await screen.findByRole("button", { name: "削除する" })); // ConfirmDialog modal (#375)
    await waitFor(() => expect(screen.queryByTestId("fe4-gantt-row-t2")).toBeNull());
    expect(screen.getByTestId("fe4-gantt-row-t1")).toBeInTheDocument();
  });
});
