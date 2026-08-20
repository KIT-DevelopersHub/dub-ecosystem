// PR16: マイタスクの「タスクを依頼」 routes a chosen 依頼先 through POST /task-requests
// (送る). The server branches self/same-team → task, other team → pending request; the
// UI just calls the issue endpoint and reports the outcome.
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ToastProvider } from "@dub/ui";
import type { common, identity } from "@dub/types";
import { ApiClientProvider } from "../src/api/client-context";
import { MockApiClient } from "../src/api/mock-client";
import { MyTasksPage } from "../src/components/MyTasksPage";

const ME = "usr_me" as common.UserId;
const BOB: identity.UserSummary = { id: "usr_bob" as common.UserId, displayName: "Bob（スポンサー）", avatarUrl: null };

function renderPage(client: MockApiClient) {
  return render(
    <ApiClientProvider client={client}>
      <ToastProvider>
        <MyTasksPage currentUserId={ME} people={[BOB]} teams={[]} events={[]} />
      </ToastProvider>
    </ApiClientProvider>,
  );
}

describe("MyTasksPage — 「タスクを依頼」 (send/receive)", () => {
  it("labels the primary action 「タスクを依頼」 and opens a 依頼 modal", async () => {
    renderPage(new MockApiClient({ currentUserId: ME }));
    const open = await screen.findByTestId("fe4-mytasks-create-open");
    expect(open).toHaveTextContent("タスクを依頼");
    fireEvent.click(open);
    expect(screen.getByTestId("fe4-mytask-create-submit")).toHaveTextContent("依頼する");
  });

  it("choosing a 依頼先 sends POST /task-requests (not a direct POST /tasks)", async () => {
    const client = new MockApiClient({ currentUserId: ME });
    renderPage(client);
    fireEvent.click(await screen.findByTestId("fe4-mytasks-create-open"));
    fireEvent.change(screen.getByTestId("fe4-mytask-create-title"), { target: { value: "スポンサー確認をお願い" } });
    fireEvent.change(screen.getByTestId("fe4-mytask-create-assignee"), { target: { value: "usr_bob" } });
    fireEvent.click(screen.getByTestId("fe4-mytask-create-submit"));

    await waitFor(() => {
      expect(client.calls.some((c) => c.path === "/api/v1/task-requests" && c.method === "POST")).toBe(true);
    });
    // and NOT a direct task create (that would bypass the request flow / hit the D4 guard).
    expect(client.calls.some((c) => c.path === "/api/v1/tasks" && c.method === "POST")).toBe(false);
  });

  it("with NO 依頼先, it still direct-creates a personal task (POST /tasks)", async () => {
    const client = new MockApiClient({ currentUserId: ME });
    renderPage(client);
    fireEvent.click(await screen.findByTestId("fe4-mytasks-create-open"));
    fireEvent.change(screen.getByTestId("fe4-mytask-create-title"), { target: { value: "自分用のメモタスク" } });
    fireEvent.click(screen.getByTestId("fe4-mytask-create-submit"));
    await waitFor(() => {
      expect(client.calls.some((c) => c.path === "/api/v1/tasks" && c.method === "POST")).toBe(true);
    });
  });
});
