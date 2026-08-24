import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { task, identity } from "@dub/types";
import { App } from "../src/App";
import { MockApiClient } from "../src/api/mock-client";

const EVENT = "evt_test";
const PERMS: identity.PermissionKey[] = ["task:read", "task:write", "task:delete"];

const mk = (id: string, title: string): task.Task => ({
  id, eventId: EVENT, title, description: null, status: "todo",
  priority: "medium", assigneeId: "usr_a", dueAt: "2026-08-20T00:00:00Z", origin: "internal",
  archivedAt: null, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", version: 1,
});

function seed(): MockApiClient {
  return new MockApiClient({
    users: [{ id: "usr_a", displayName: "Alice", avatarUrl: null }],
    tasks: [mk("t1", "会場予約"), mk("t2", "登壇者調整")],
  });
}

async function openDetail(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByTestId("fe4-gantt-row-t2"));
  return screen.findByTestId("fe4-detail-panel");
}

describe("TaskDetailPanel (modal) — メモ/詳細 + 添付", () => {
  it("opens as a modal dialog (ワンクッション) with the メモ field and 添付 section", async () => {
    render(<App client={seed()} eventId={EVENT} permissions={PERMS} />);
    const panel = await openDetail();
    expect(within(panel).getByTestId("fe4-detail-description")).toBeInTheDocument();
    expect(within(panel).getByTestId("fe4-detail-attachments")).toBeInTheDocument();
    // empty state until anything is attached
    expect(within(panel).getByTestId("fe4-detail-attachments-empty")).toBeInTheDocument();
  });

  it("saves an edited メモ/詳細 through an optimistic PATCH", async () => {
    const client = seed();
    render(<App client={client} eventId={EVENT} permissions={PERMS} />);
    const panel = await openDetail();
    fireEvent.change(within(panel).getByTestId("fe4-detail-description"), {
      target: { value: "現地は9時集合。鍵は総務から受領。" },
    });
    fireEvent.click(within(panel).getByTestId("fe4-detail-save"));
    await waitFor(() =>
      expect(
        client.calls.some(
          (c) => c.method === "PATCH" && (c.body as { description?: string })?.description === "現地は9時集合。鍵は総務から受領。",
        ),
      ).toBe(true),
    );
  });

  it("adds a URL attachment, lists it, then deletes it", async () => {
    render(<App client={seed()} eventId={EVENT} permissions={PERMS} />);
    const panel = await openDetail();
    fireEvent.change(within(panel).getByTestId("fe4-detail-attach-url-name"), { target: { value: "議事録" } });
    fireEvent.change(within(panel).getByTestId("fe4-detail-attach-url"), { target: { value: "https://example.com/minutes" } });
    fireEvent.click(within(panel).getByTestId("fe4-detail-attach-url-add"));

    const link = await within(panel).findByTestId("fe4-detail-attach-open-url");
    expect(link).toHaveAttribute("href", "https://example.com/minutes");
    expect(link).toHaveTextContent("議事録");

    fireEvent.click(within(panel).getByTestId("fe4-detail-attach-remove"));
    await waitFor(() => expect(within(panel).queryByTestId("fe4-detail-attach-item")).toBeNull());
  });

  it("rejects a non-http URL with an inline error", async () => {
    render(<App client={seed()} eventId={EVENT} permissions={PERMS} />);
    const panel = await openDetail();
    fireEvent.change(within(panel).getByTestId("fe4-detail-attach-url"), { target: { value: "ftp://nope" } });
    fireEvent.click(within(panel).getByTestId("fe4-detail-attach-url-add"));
    expect(await within(panel).findByTestId("fe4-detail-attach-error")).toBeInTheDocument();
  });

  it("uploads a file attachment (stored as a self-contained data URL) and lists it", async () => {
    render(<App client={seed()} eventId={EVENT} permissions={PERMS} />);
    const panel = await openDetail();
    const file = new File(["hello world"], "notes.txt", { type: "text/plain" });
    fireEvent.change(within(panel).getByTestId("fe4-detail-attach-file"), { target: { files: [file] } });
    const link = await within(panel).findByTestId("fe4-detail-attach-open-file");
    expect(link).toHaveTextContent("notes.txt");
    expect(link).toHaveAttribute("download", "notes.txt");
  });
});
