// PR17: マイタスクの依頼インボックス — 受け取った依頼(承諾/却下) + 送った依頼(取消).
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ToastProvider } from "@dub/ui";
import type { common, identity, task } from "@dub/types";
import { ApiClientProvider } from "../src/api/client-context";
import { MockApiClient } from "../src/api/mock-client";
import { MyTasksPage } from "../src/components/MyTasksPage";

const ME = "usr_me" as common.UserId;
const PEOPLE: identity.UserSummary[] = [
  { id: "usr_alice" as common.UserId, displayName: "会計・Alice", avatarUrl: null },
  { id: "usr_bob" as common.UserId, displayName: "スポンサー・Bob", avatarUrl: null },
];

function req(over: Partial<task.TaskRequest> & { id: string; fromUserId: string; toUserId: string }): task.TaskRequest {
  return {
    id: over.id,
    eventId: over.eventId ?? "evt_1",
    fromUserId: over.fromUserId as common.UserId,
    toUserId: over.toUserId as common.UserId,
    fromTeamId: null,
    toTeamId: null,
    title: over.title ?? over.id,
    description: null,
    priority: over.priority ?? "medium",
    dueAt: null,
    sourceTaskId: null,
    state: over.state ?? "pending",
    declineReason: null,
    createdTaskId: null,
    version: over.version ?? 1,
    createdAt: "2026-08-20T00:00:00.000Z",
    decidedAt: null,
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
}

function renderPage(client: MockApiClient) {
  return render(
    <ApiClientProvider client={client}>
      <ToastProvider>
        <MyTasksPage currentUserId={ME} people={PEOPLE} teams={[]} events={[]} />
      </ToastProvider>
    </ApiClientProvider>,
  );
}

describe("MyTasksPage — 依頼インボックス (受け取る)", () => {
  it("shows incoming (承諾/却下) and outgoing (取消) pending requests", async () => {
    const client = new MockApiClient({
      currentUserId: ME,
      requests: [
        req({ id: "treq_in", fromUserId: "usr_alice", toUserId: ME, title: "スポンサー資料の確認" }),
        req({ id: "treq_out", fromUserId: ME, toUserId: "usr_bob", title: "ロゴ提供のお願い" }),
      ],
    });
    renderPage(client);
    expect(await screen.findByTestId("fe4-request-in-treq_in")).toHaveTextContent("スポンサー資料の確認");
    expect(screen.getByTestId("fe4-request-accept-treq_in")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-request-decline-treq_in")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-request-out-treq_out")).toHaveTextContent("ロゴ提供のお願い");
    expect(screen.getByTestId("fe4-request-cancel-treq_out")).toBeInTheDocument();
  });

  it("承諾 calls POST /task-requests/:id/accept and removes the row", async () => {
    const client = new MockApiClient({
      currentUserId: ME,
      requests: [req({ id: "treq_in", fromUserId: "usr_alice", toUserId: ME, title: "承諾する依頼" })],
    });
    renderPage(client);
    fireEvent.click(await screen.findByTestId("fe4-request-accept-treq_in"));
    await waitFor(() => {
      expect(client.calls.some((c) => c.path === "/api/v1/task-requests/treq_in/accept" && c.method === "POST")).toBe(true);
    });
    await waitFor(() => expect(screen.queryByTestId("fe4-request-in-treq_in")).not.toBeInTheDocument());
  });

  it("取消 calls POST /task-requests/:id/cancel", async () => {
    const client = new MockApiClient({
      currentUserId: ME,
      requests: [req({ id: "treq_out", fromUserId: ME, toUserId: "usr_bob", title: "取り消す依頼" })],
    });
    renderPage(client);
    fireEvent.click(await screen.findByTestId("fe4-request-cancel-treq_out"));
    await waitFor(() => {
      expect(client.calls.some((c) => c.path === "/api/v1/task-requests/treq_out/cancel" && c.method === "POST")).toBe(true);
    });
  });

  it("ボール保持で左右が決まる: 自分の番=右(self) / 相手の番=左(other)", async () => {
    const client = new MockApiClient({
      currentUserId: ME,
      requests: [
        // 他人→自分・自分が承諾/却下する番 → ボールは自分 → 右
        req({ id: "treq_in", fromUserId: "usr_alice", toUserId: ME, title: "自分の番" }),
        // 自分→他人・相手の承諾待ち → ボールは相手 → 左
        req({ id: "treq_out", fromUserId: ME, toUserId: "usr_bob", title: "相手の番" }),
      ],
    });
    renderPage(client);
    const incomingRow = await screen.findByTestId("fe4-request-in-treq_in");
    const outgoingRow = screen.getByTestId("fe4-request-out-treq_out");
    // 受け取り(自分の番)は右=self、送り(相手の番)は左=other。
    expect(incomingRow).toHaveAttribute("data-side", "self");
    expect(outgoingRow).toHaveAttribute("data-side", "other");
    // 承諾/却下ボタンは自分側(右)の吹き出し内にある。
    expect(incomingRow).toContainElement(screen.getByTestId("fe4-request-accept-treq_in"));
    expect(incomingRow).toContainElement(screen.getByTestId("fe4-request-decline-treq_in"));
    // 取消ボタンは相手側(左)の吹き出し内にある。
    expect(outgoingRow).toContainElement(screen.getByTestId("fe4-request-cancel-treq_out"));
  });
});
