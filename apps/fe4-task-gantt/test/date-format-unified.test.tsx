import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import type { common } from "@dub/types";
import { ApiClientProvider } from "../src/api/client-context";
import { MockApiClient } from "../src/api/mock-client";
import { MeTasksRoute, TaskRouteProvider } from "../src/routes/taskRoutes";

// ユーザー要望: (1)「期日」→「終了日」に統一。(2)タスクアプリ(タスク発行)とガント
// (タスク作成)で新規タスクの日付フィールドの持ち方を統一する。タスク発行フォームも
// 開始日 + 終了日 の2フィールドを持ち、startAt/dueAt を送ることを担保する回帰テスト。

const ME = "usr_me" as common.UserId;

function renderRoute(client: MockApiClient): ReactElement {
  return render(
    <ApiClientProvider client={client}>
      <TaskRouteProvider value={{ currentUserId: ME, permissions: ["task:read", "task:write"] }}>
        <MeTasksRoute />
      </TaskRouteProvider>
    </ApiClientProvider>,
  ) as unknown as ReactElement;
}

describe("新規タスクの日付フォーマット統一（タスク発行 == ガント作成）", () => {
  it("タスク発行フォームは 開始日 + 終了日 の2フィールドを持ち、「終了日」表記になっている", async () => {
    const client = new MockApiClient({ currentUserId: ME });
    renderRoute(client);

    const openBtn = await screen.findByTestId("fe4-mytasks-create-open");
    await waitFor(() => expect(openBtn).not.toBeDisabled());
    fireEvent.click(openBtn);

    // 開始日・終了日 の両方が存在する（ガントの作成フォームと同じ持ち方）。
    expect(screen.getByTestId("fe4-mytask-create-start")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-mytask-create-due")).toBeInTheDocument();
    // 「期日」「期限」は廃止し「終了日」に統一。
    expect(screen.getByText("終了日")).toBeInTheDocument();
    expect(screen.queryByText("期日")).not.toBeInTheDocument();
    expect(screen.queryByText("期限")).not.toBeInTheDocument();
  });

  it("開始日と終了日を入れて発行すると POST /tasks に startAt と dueAt が両方乗る", async () => {
    const client = new MockApiClient({ currentUserId: ME });
    renderRoute(client);

    const openBtn = await screen.findByTestId("fe4-mytasks-create-open");
    await waitFor(() => expect(openBtn).not.toBeDisabled());
    fireEvent.click(openBtn);

    fireEvent.change(screen.getByTestId("fe4-mytask-create-title"), {
      target: { value: "登壇者へ最終案内メールを送る" },
    });
    fireEvent.change(screen.getByTestId("fe4-mytask-create-start"), {
      target: { value: "2026-09-10" },
    });
    fireEvent.change(screen.getByTestId("fe4-mytask-create-due"), {
      target: { value: "2026-09-20" },
    });
    fireEvent.click(screen.getByTestId("fe4-mytask-create-submit"));

    await waitFor(() => {
      const created = client.calls.find((c) => c.path === "/api/v1/tasks" && c.method === "POST");
      expect(created).toBeTruthy();
      const body = created?.body as { startAt?: string; dueAt?: string };
      expect(body.startAt).toBe("2026-09-10T00:00:00.000Z");
      expect(body.dueAt).toBe("2026-09-20T00:00:00.000Z");
    });
  });
});
