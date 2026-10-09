// Screen behaviour of the Google Calendar-style calendar: week view by default,
// 予定の追加 (作成 button and slot click), edit and delete — all optimistic over an
// in-memory CalendarApi.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { common, task } from "@dub/types";
import { CalendarApiProvider, type CalendarCaps } from "./CalendarProvider.tsx";
import { CalendarScreen } from "./CalendarScreen.tsx";
import type { CalendarApi } from "./calendarApi.tsx";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

const ME = "usr_me" as common.UserId;
const local = (h: number, m = 0) => new Date(2026, 9, 10, h, m); // Sat 2026-10-10

function mk(id: string, over: Partial<task.Task> = {}): task.Task {
  return {
    id: id as common.TaskId,
    version: 3,
    title: id,
    description: null,
    status: "todo",
    priority: "medium",
    assigneeId: ME,
    startAt: null,
    dueAt: null,
    origin: "internal",
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function memoryApi(seed: task.Task[]) {
  const rows = [...seed];
  const api: CalendarApi = {
    listTasks: async () => ({ items: rows, nextCursor: null }),
    listAllTasks: async () => rows,
    listMyTasks: vi.fn(async () => [...rows]),
    createTask: vi.fn(async (req: task.CreateTaskRequest) => {
      const t = mk(`t_${rows.length + 1}`, { ...req, description: req.description ?? null, version: 1 } as Partial<task.Task>);
      rows.push(t);
      return t;
    }),
    updateTask: vi.fn(async (id: common.TaskId, req: task.UpdateTaskRequest) => {
      const i = rows.findIndex((t) => t.id === id);
      rows[i] = { ...rows[i]!, ...req, version: req.version + 1 } as task.Task;
      return rows[i]!;
    }),
    deleteTask: vi.fn(async (id: common.TaskId) => {
      rows.splice(
        rows.findIndex((t) => t.id === id),
        1,
      );
    }),
  };
  return api;
}

function renderScreen(api: CalendarApi, caps?: CalendarCaps) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <CalendarApiProvider value={api} currentUserId={ME} {...(caps ? { caps } : {})}>
          <CalendarScreen />
        </CalendarApiProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

// jsdom has no PointerEvent; without it fireEvent drops clientY/button.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventShim extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  window.PointerEvent = PointerEventShim as unknown as typeof PointerEvent;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(local(8));
});
afterEach(() => vi.useRealTimers());

describe("CalendarScreen", () => {
  it("opens on the week view with today's header and the week's 予定", async () => {
    renderScreen(
      memoryApi([
        mk("meeting", { title: "運営定例", startAt: local(10).toISOString(), dueAt: local(11).toISOString() }),
        mk("deadline", { title: "提出締切", dueAt: "2026-10-08T00:00:00.000Z" }),
      ]),
    );
    expect(await screen.findByTestId("calendar-item-meeting")).toHaveTextContent("運営定例");
    expect(screen.getByTestId("calendar-item-meeting")).toHaveTextContent("10:00～11:00");
    expect(within(screen.getByTestId("calendar-allday")).getByTestId("calendar-item-deadline")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-range-label")).toHaveTextContent("2026年 10月");
    expect(screen.getByTestId("calendar-dayhead-2026-10-10")).toHaveTextContent("10");
  });

  it("adds a 予定 from the 作成 button (assigned to self, local-offset times)", async () => {
    const user = userEvent.setup();
    const api = memoryApi([]);
    renderScreen(api);
    await screen.findByTestId("calendar-timegrid");

    await user.click(screen.getByTestId("calendar-create"));
    const dialog = await screen.findByTestId("calendar-edit-dialog");
    await user.type(within(dialog).getByTestId("calendar-form-title"), "スポンサー打ち合わせ");
    await user.click(within(dialog).getByTestId("calendar-form-save"));

    await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1));
    const req = vi.mocked(api.createTask).mock.calls[0]![0];
    expect(req).toMatchObject({ title: "スポンサー打ち合わせ", assigneeId: ME });
    // Default slot = next whole hour (now 8:00 → 9:00–10:00), written with an offset.
    expect(Date.parse(req.startAt!)).toBe(local(9).getTime());
    expect(Date.parse(req.dueAt!)).toBe(local(10).getTime());
    expect(req.startAt).not.toMatch(/T00:00:00(\.0+)?Z$/);
    expect(await screen.findByText("スポンサー打ち合わせ")).toBeInTheDocument();
  });

  it("clicking an empty time slot opens the quick-create popover for that hour", async () => {
    const user = userEvent.setup();
    const api = memoryApi([]);
    renderScreen(api);
    const col = await screen.findByTestId("calendar-col-2026-10-10");

    // 14:10 → books 14:00–15:00 (Google: the half-hour it landed in, one hour long).
    const y = (14 + 10 / 60) * 48;
    fireEvent.pointerDown(col, { clientY: y, button: 0, pointerId: 1 });
    fireEvent.pointerUp(col, { clientY: y, button: 0, pointerId: 1 });

    const panel = await screen.findByTestId("calendar-create-panel");
    expect(within(panel).getByTestId("calendar-form-start-time")).toHaveValue("14:00");
    expect(within(panel).getByTestId("calendar-form-end-time")).toHaveValue("15:00");
    expect(screen.getByTestId("calendar-ghost")).toBeInTheDocument();

    await user.type(within(panel).getByTestId("calendar-form-title"), "会場下見{Enter}");
    await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1));
    expect(Date.parse(vi.mocked(api.createTask).mock.calls[0]![0].startAt!)).toBe(local(14).getTime());
  });

  it("edits and deletes a 予定 from its detail card", async () => {
    const user = userEvent.setup();
    const api = memoryApi([mk("ev", { title: "旧タイトル", startAt: local(10).toISOString(), dueAt: local(11).toISOString() })]);
    renderScreen(api);

    await user.click(await screen.findByTestId("calendar-item-ev"));
    const detail = await screen.findByTestId("calendar-event-detail");
    expect(within(detail).getByTestId("calendar-detail-when")).toHaveTextContent("10月10日（土曜日）⋅10:00～11:00");

    await user.click(within(detail).getByTestId("calendar-detail-edit"));
    const dialog = await screen.findByTestId("calendar-edit-dialog");
    const title = within(dialog).getByTestId("calendar-form-title");
    await user.clear(title);
    await user.type(title, "新タイトル");
    await user.click(within(dialog).getByTestId("calendar-form-save"));
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith("ev", expect.objectContaining({ version: 3, title: "新タイトル" })));
    expect(await screen.findByText("新タイトル")).toBeInTheDocument();

    await user.click(screen.getByTestId("calendar-item-ev"));
    await user.click(within(await screen.findByTestId("calendar-event-detail")).getByTestId("calendar-detail-delete"));
    await waitFor(() => expect(api.deleteTask).toHaveBeenCalledWith("ev"));
    await waitFor(() => expect(screen.queryByTestId("calendar-item-ev")).not.toBeInTheDocument());
  });

  it("rolls the optimistic 予定 back when saving fails", async () => {
    const user = userEvent.setup();
    const api = memoryApi([]);
    vi.mocked(api.createTask).mockRejectedValueOnce(new Error("boom"));
    renderScreen(api);
    await screen.findByTestId("calendar-timegrid");

    await user.click(screen.getByTestId("calendar-create"));
    const dialog = await screen.findByTestId("calendar-edit-dialog");
    await user.type(within(dialog).getByTestId("calendar-form-title"), "失敗する予定");
    await user.click(within(dialog).getByTestId("calendar-form-save"));

    expect(await screen.findByText("予定を保存できませんでした")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("失敗する予定")).not.toBeInTheDocument());
  });

  it("shows month view and hides a status via マイカレンダー", async () => {
    const user = userEvent.setup();
    renderScreen(
      memoryApi([
        mk("a", { title: "完了した予定", status: "done", dueAt: "2026-10-20T00:00:00.000Z" }),
        mk("b", { title: "未着手の予定", dueAt: "2026-10-21T00:00:00.000Z" }),
      ]),
    );
    await screen.findByTestId("calendar-timegrid");
    fireEvent.keyDown(document, { key: "m" });
    expect(await screen.findByTestId("calendar-month")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-item-a")).toBeInTheDocument();

    await user.click(screen.getByTestId("calendar-filter-done"));
    expect(screen.queryByTestId("calendar-item-a")).not.toBeInTheDocument();
    expect(screen.getByTestId("calendar-item-b")).toBeInTheDocument();
  });

  it("disables 作成 without write permission", async () => {
    renderScreen(memoryApi([]), { canWrite: false, canDelete: false });
    await screen.findByTestId("calendar-timegrid");
    expect(screen.getByTestId("calendar-create")).toBeDisabled();
  });
});
