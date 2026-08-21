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
  it("カードにタイトルが出て、クリックした詳細に承諾/却下・取消が入る", async () => {
    const client = new MockApiClient({
      currentUserId: ME,
      requests: [
        req({ id: "treq_in", fromUserId: "usr_alice", toUserId: ME, title: "スポンサー資料の確認" }),
        req({ id: "treq_out", fromUserId: ME, toUserId: "usr_bob", title: "ロゴ提供のお願い" }),
      ],
    });
    renderPage(client);
    // カード自体はタイトル＋相手名だけ（本文/優先度/アクションは出さない）。
    expect(await screen.findByTestId("fe4-request-in-treq_in")).toHaveTextContent("スポンサー資料の確認");
    expect(screen.getByTestId("fe4-request-out-treq_out")).toHaveTextContent("ロゴ提供のお願い");
    // アクションはカード上にはなく、クリックした詳細モーダルに集約される。
    expect(screen.queryByTestId("fe4-request-accept-treq_in")).not.toBeInTheDocument();
    // 受け取り(自分がボール)のカードを開くと承諾/却下が出る。
    fireEvent.click(screen.getByTestId("fe4-request-card-treq_in"));
    expect(await screen.findByTestId("fe4-request-accept-treq_in")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-request-decline-treq_in")).toBeInTheDocument();
  });

  it("承諾 calls POST /task-requests/:id/accept and removes the row", async () => {
    const client = new MockApiClient({
      currentUserId: ME,
      requests: [req({ id: "treq_in", fromUserId: "usr_alice", toUserId: ME, title: "承諾する依頼" })],
    });
    renderPage(client);
    fireEvent.click(await screen.findByTestId("fe4-request-card-treq_in")); // open detail
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
    fireEvent.click(await screen.findByTestId("fe4-request-card-treq_out")); // open detail
    fireEvent.click(await screen.findByTestId("fe4-request-cancel-treq_out"));
    await waitFor(() => {
      expect(client.calls.some((c) => c.path === "/api/v1/task-requests/treq_out/cancel" && c.method === "POST")).toBe(true);
    });
  });

  it("詳細ダイヤログはガント同等の編集フィールドを備える(タイトル/ステータス/優先度/開始・期日/詳細/添付+保存)", async () => {
    const client = new MockApiClient({
      currentUserId: ME,
      requests: [req({ id: "treq_in", fromUserId: "usr_alice", toUserId: ME, title: "編集できる依頼" })],
    });
    renderPage(client);
    fireEvent.click(await screen.findByTestId("fe4-request-card-treq_in")); // open detail
    // ガントのタスク詳細と同じ編集フィールド群がその場に出る。
    expect(await screen.findByTestId("fe4-request-detail-title-treq_in")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-request-detail-status-treq_in")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-request-detail-priority-treq_in")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-request-detail-start-treq_in")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-request-detail-due-treq_in")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-request-detail-desc-treq_in")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-request-attach-treq_in-section")).toBeInTheDocument();
    // 承諾/却下 も同じ詳細内に残る。
    expect(screen.getByTestId("fe4-request-accept-treq_in")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-request-decline-treq_in")).toBeInTheDocument();
    // タイトルを編集して保存すると、カードのタイトルが楽観的に更新される(セッション内)。
    const titleInput = screen.getByTestId("fe4-request-detail-title-treq_in") as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: "編集後タイトル" } });
    fireEvent.click(screen.getByTestId("fe4-request-save-treq_in"));
    await waitFor(() => expect(screen.getByTestId("fe4-request-in-treq_in")).toHaveTextContent("編集後タイトル"));
  });

  it("ボール保持で左右が決まる: 自分がボール=右(self) / 渡した=左(other・←)", async () => {
    const client = new MockApiClient({
      currentUserId: ME,
      requests: [
        // 他人→自分・自分が承諾/却下する番 → ボールは自分 → 右
        req({ id: "treq_in", fromUserId: "usr_alice", toUserId: ME, title: "自分がボール" }),
        // 自分→他人・相手の承諾待ち → ボールは相手 → 左（自分側に ←）
        req({ id: "treq_out", fromUserId: ME, toUserId: "usr_bob", title: "渡した依頼" }),
      ],
    });
    renderPage(client);
    const incomingRow = await screen.findByTestId("fe4-request-in-treq_in");
    const outgoingRow = screen.getByTestId("fe4-request-out-treq_out");
    // 受け取り(自分がボール)は右=self、送り(渡した)は左=other。
    expect(incomingRow).toHaveAttribute("data-side", "self");
    expect(outgoingRow).toHaveAttribute("data-side", "other");
    // 渡した依頼(左)には「あなたが渡した」← が自分側に描かれる。受け取り(右)には無い。
    expect(outgoingRow).toContainElement(screen.getByLabelText("あなたが渡した依頼"));
    expect(incomingRow.querySelector('[aria-label="あなたが渡した依頼"]')).toBeNull();
  });
});
