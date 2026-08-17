import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import type { task, common } from "@dub/types";
import { MyTaskList } from "../src/components/MyTaskList";
import { TaskDetailDialog } from "../src/components/TaskDetailDialog";
import { createUserCache } from "../src/domain/user-cache";
import { ApiClientProvider } from "../src/api/client-context";
import { MockApiClient } from "../src/api/mock-client";
import { createTaskAttachment } from "../src/api/endpoints";

/** Render a node under a MockApiClient so TaskDetailDialog can fetch attachments. */
function renderWithClient(node: ReactElement, client: MockApiClient = new MockApiClient()) {
  return render(<ApiClientProvider client={client}>{node}</ApiClientProvider>);
}

const mk = (over: Partial<task.Task> & { id: string }): task.Task => ({
  id: over.id,
  eventId: over.eventId ?? "evt_1",
  title: over.title ?? `T-${over.id}`,
  description: over.description ?? null,
  status: over.status ?? "todo",
  priority: over.priority ?? "medium",
  assigneeId: over.assigneeId ?? "usr_me",
  teamId: over.teamId ?? null,
  createdBy: over.createdBy ?? "usr_boss",
  dueAt: over.dueAt ?? null,
  origin: "internal",
  archivedAt: null,
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
  version: 1,
});

const users = createUserCache([
  { id: "usr_me" as common.UserId, displayName: "自分", avatarUrl: null },
  { id: "usr_boss" as common.UserId, displayName: "上司", avatarUrl: null },
]);
const teamNames = new Map<common.TeamId, string>([["team_ops" as common.TeamId, "運営"]]);

describe("MyTaskList — row click opens detail (feedback #2)", () => {
  it("calls onSelect with the clicked task instead of navigating away", () => {
    const onSelect = vi.fn();
    const t = mk({ id: "t1", title: "動画編集" });
    render(
      <MyTaskList tasks={[t]} users={users} teamNames={teamNames} onSelect={onSelect} visibleCount={25} onShowMore={() => {}} />,
    );
    fireEvent.click(screen.getByTestId("fe4-mytask-row-t1"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(t);
  });

  it("opens the detail on Enter (keyboard)", () => {
    const onSelect = vi.fn();
    const t = mk({ id: "t2" });
    render(
      <MyTaskList tasks={[t]} users={users} teamNames={teamNames} onSelect={onSelect} visibleCount={25} onShowMore={() => {}} />,
    );
    fireEvent.keyDown(screen.getByTestId("fe4-mytask-row-t2"), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(t);
  });
});

describe("TaskDetailDialog (feedback #2)", () => {
  it("shows the 内容(description) when present", () => {
    const t = mk({ id: "t3", description: "登壇者へ最終案内メールを送る。CC に運営を入れる。" });
    renderWithClient(<TaskDetailDialog task={t} users={users} teamNames={teamNames} onClose={() => {}} />);
    expect(screen.getByTestId("fe4-mytask-detail-description")).toHaveTextContent("最終案内メール");
    expect(screen.queryByTestId("fe4-mytask-detail-description-empty")).toBeNull();
  });

  it("shows an empty note when there is no description", () => {
    const t = mk({ id: "t4", description: null });
    renderWithClient(<TaskDetailDialog task={t} users={users} teamNames={teamNames} onClose={() => {}} />);
    expect(screen.getByTestId("fe4-mytask-detail-description-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("fe4-mytask-detail-description")).toBeNull();
  });

  it("renders nothing when task is null (closed)", () => {
    renderWithClient(<TaskDetailDialog task={null} users={users} teamNames={teamNames} onClose={() => {}} />);
    expect(screen.queryByTestId("fe4-mytask-detail")).toBeNull();
  });

  it("offers 「ガントで開く」 that calls onOpenWorkspace with the task", () => {
    const onOpenWorkspace = vi.fn();
    const t = mk({ id: "t5" });
    renderWithClient(
      <TaskDetailDialog task={t} users={users} teamNames={teamNames} onClose={() => {}} onOpenWorkspace={onOpenWorkspace} />,
    );
    fireEvent.click(screen.getByTestId("fe4-mytask-detail-open"));
    expect(onOpenWorkspace).toHaveBeenCalledWith(t);
  });

  it("lists a task's attachments (url link) fetched on open", async () => {
    const t = mk({ id: "t6" });
    const client = new MockApiClient({ tasks: [t] });
    await createTaskAttachment(client, t.id as common.TaskId, {
      kind: "url",
      name: "参考リンク",
      url: "https://example.com/spec",
    });
    renderWithClient(<TaskDetailDialog task={t} users={users} teamNames={teamNames} onClose={() => {}} />, client);
    await waitFor(() =>
      expect(screen.getByTestId("fe4-mytask-detail-attach-url")).toHaveTextContent("参考リンク"),
    );
    expect(screen.getByTestId("fe4-mytask-detail-attach-url")).toHaveAttribute("href", "https://example.com/spec");
  });

  it("shows an empty note when a task has no attachments", async () => {
    const t = mk({ id: "t7" });
    renderWithClient(<TaskDetailDialog task={t} users={users} teamNames={teamNames} onClose={() => {}} />, new MockApiClient({ tasks: [t] }));
    await waitFor(() => expect(screen.getByTestId("fe4-mytask-detail-attachments-empty")).toBeInTheDocument());
  });
});
