import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import type { common, event, identity } from "@dub/types";
import { ApiClientProvider } from "../src/api/client-context";
import { MockApiClient } from "../src/api/mock-client";
import { getGantt } from "../src/api/endpoints";
import { MeTasksRoute, TaskRouteProvider } from "../src/routes/taskRoutes";
import { setCurrentEventId } from "../src/domain/current-event";
import { todayDateInput } from "../src/domain/task-form";

// ③ 統一「タスクを発行 / 新規タスク」ダイアログの日付は「期限」単一ではなく
//   開始日 + 終了日 の2フィールド。初期値は両方とも今日。作成時に startAt / dueAt
//   (= ガントのバー期間 [startAt, dueAt]) に結線される。

const ME = "usr_me" as common.UserId;
const EVT = "evt_conf" as common.EventId;
const EVENTS: event.EventSummary[] = [
  { id: EVT, title: "北陸ITカンファレンス2026", phase: "planning", startsAt: null },
];
const ROSTER: identity.UserSummary[] = [
  { id: "usr_me" as common.UserId, displayName: "自分 太郎", avatarUrl: null },
];

function renderRoute(client: MockApiClient): ReactElement {
  return render(
    <ApiClientProvider client={client}>
      <TaskRouteProvider value={{ currentUserId: ME, permissions: ["task:read", "task:write"] }}>
        <MeTasksRoute />
      </TaskRouteProvider>
    </ApiClientProvider>,
  ) as unknown as ReactElement;
}

function newClient(): MockApiClient {
  return new MockApiClient({ events: EVENTS, users: ROSTER, currentUserId: ME });
}

describe("③ 発行/新規ダイアログ — 開始日 + 終了日 の2フィールド", () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
  });

  it("開始日・終了日の2フィールドを持ち、初期値はともに今日", async () => {
    setCurrentEventId(EVT);
    renderRoute(newClient());
    fireEvent.click(await screen.findByTestId("fe4-mytasks-create-open"));

    const today = todayDateInput();
    const start = (await screen.findByTestId("fe4-mytask-create-start")) as HTMLInputElement;
    const end = (await screen.findByTestId("fe4-mytask-create-due")) as HTMLInputElement;
    expect(start.value).toBe(today);
    expect(end.value).toBe(today);
  });

  it("開始日/終了日が POST の startAt/dueAt に結線され、ガントのバー期間 [startAt, dueAt] になる", async () => {
    setCurrentEventId(EVT);
    const client = newClient();
    renderRoute(client);
    fireEvent.click(await screen.findByTestId("fe4-mytasks-create-open"));
    await waitFor(() =>
      expect((screen.getByTestId("fe4-mytask-create-event") as HTMLSelectElement).value).toBe(EVT),
    );

    fireEvent.change(screen.getByTestId("fe4-mytask-create-title"), { target: { value: "設営リハーサル" } });
    fireEvent.change(screen.getByTestId("fe4-mytask-create-start"), { target: { value: "2026-09-10" } });
    fireEvent.change(screen.getByTestId("fe4-mytask-create-due"), { target: { value: "2026-09-14" } });
    fireEvent.click(screen.getByTestId("fe4-mytask-create-submit"));

    await waitFor(() => {
      const created = client.calls.find((c) => c.path === "/api/v1/tasks" && c.method === "POST");
      expect(created).toBeTruthy();
      const body = created?.body as { startAt?: string; dueAt?: string };
      expect(body.startAt).toBe("2026-09-10T00:00:00.000Z");
      expect(body.dueAt).toBe("2026-09-14T00:00:00.000Z");
    });

    // ガント parity: the bar spans exactly [startAt, dueAt].
    const dto = await getGantt(client, EVT);
    const row = dto.rows.find((r) => r.title === "設営リハーサル");
    expect(row?.startsAt).toBe("2026-09-10T00:00:00.000Z");
    expect(row?.endsAt).toBe("2026-09-14T00:00:00.000Z");
  });

  it("終了日が開始日より前だと発行できない（バリデーション）", async () => {
    setCurrentEventId(EVT);
    renderRoute(newClient());
    fireEvent.click(await screen.findByTestId("fe4-mytasks-create-open"));

    fireEvent.change(screen.getByTestId("fe4-mytask-create-title"), { target: { value: "逆転した日付" } });
    fireEvent.change(screen.getByTestId("fe4-mytask-create-start"), { target: { value: "2026-09-20" } });
    fireEvent.change(screen.getByTestId("fe4-mytask-create-due"), { target: { value: "2026-09-10" } });

    expect(screen.getByTestId("fe4-mytask-create-date-error")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-mytask-create-submit")).toBeDisabled();
  });
});
