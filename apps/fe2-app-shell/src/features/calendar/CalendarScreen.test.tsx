// Screen behaviour of the Google Calendar-style calendar: week view by default,
// 予定の追加 (作成 button and slot click), edit and delete — all optimistic over an
// in-memory CalendarApi.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { common, task } from "@dub/types";
import { FakeAuthProvider, editorPermissions } from "../../auth/test-support.tsx";
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

function memoryApi(seed: task.Task[], teamRows: task.Task[] = [], peopleRows: task.Task[] = []) {
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
    listRoles: vi.fn(async () => [
      { id: "role_lead", orgId: "org_devhub", name: "統括", permissions: [], isSystem: false },
      { id: "role_pr", orgId: "org_devhub", name: "広報", permissions: [], isSystem: false },
    ]),
    getUsers: vi.fn(async (ids: readonly common.UserId[]) =>
      ids.map((id) => ({ id, displayName: id === ME ? "山田" : "佐藤", avatarUrl: null })),
    ),
    listTeams: vi.fn(async () => ({
      teams: [
        { id: "team_hq", key: "hq", name: "統括チーム", color: "#1e3a5f", description: null },
        { id: "team_dev", key: "dev", name: "開発チーム", color: null, description: null },
      ],
      myTeamIds: ["team_hq"],
    })),
    listTeamTasks: vi.fn(async (teamId: common.TeamId) => teamRows.filter((t) => t.teamId === teamId)),
    searchUsers: vi.fn(async (q: string) =>
      [
        { id: ME, displayName: "山田", avatarUrl: null },
        { id: "usr_sato" as common.UserId, displayName: "佐藤 花子", avatarUrl: null, email: "sato@example.jp" },
      ].filter((u) => u.displayName.includes(q)),
    ),
    listUserTasks: vi.fn(async (userId: common.UserId) => peopleRows.filter((t) => t.assigneeId === userId)),
    listMeetings: vi.fn(async () => ({ items: [], account: { email: null, calendarReady: false } })),
    listMeetingTargets: vi.fn(async () => ({ items: [] })),
    createMeeting: vi.fn(),
    updateMeeting: vi.fn(),
    deleteMeeting: vi.fn(),
    syncMeetings: vi.fn(),
  };
  return api;
}

function renderScreen(api: CalendarApi, caps?: CalendarCaps) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      {/* No meetings keys: ミーティング stays hidden (covered by meetings.test.tsx). */}
      <FakeAuthProvider permissions={editorPermissions("calendar", ["task:read"])}>
        <ToastProvider>
          <CalendarApiProvider value={api} currentUserId={ME} {...(caps ? { caps } : {})}>
            <CalendarScreen />
          </CalendarApiProvider>
        </ToastProvider>
      </FakeAuthProvider>
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

const ALL_SECTIONS = ["group:schedule/kind", "group:schedule/label", "group:task/scope", "group:task/status"];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(local(8));
  // Sections start folded; most tests drive the checkboxes, so start them unfolded.
  localStorage.setItem("dub.calendar.openFilterSections", JSON.stringify(ALL_SECTIONS));
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe("CalendarScreen", () => {
  it("folds the filter sections, remembers it, and tells what a folded section hides", async () => {
    localStorage.removeItem("dub.calendar.openFilterSections");
    const user = userEvent.setup();
    const { unmount } = renderScreen(memoryApi([]));
    await screen.findByTestId("calendar-timegrid");

    const kind = screen.getByTestId("calendar-section-kind");
    expect(kind).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("calendar-filter-kind:meeting")).not.toBeInTheDocument();
    // The 予定 / タスク master checkboxes stay reachable while folded.
    expect(screen.getByTestId("calendar-filter-group:task")).toBeInTheDocument();

    await user.click(kind);
    expect(kind).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByTestId("calendar-filter-kind:vacation"));
    await user.click(kind);
    expect(kind).toHaveTextContent("1件オフ");
    expect(screen.queryByTestId("calendar-filter-kind:vacation")).not.toBeInTheDocument();

    await user.click(kind);
    unmount();
    renderScreen(memoryApi([]));
    await screen.findByTestId("calendar-timegrid");
    expect(screen.getByTestId("calendar-section-kind")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("calendar-section-status")).toHaveAttribute("aria-expanded", "false");
  });

  it("remembers the 表示/非表示 checkboxes per user across a reload", async () => {
    // Another account's choice on this browser must not leak in.
    localStorage.setItem("dub.calendar.prefs.hidden.usr_other", JSON.stringify(["kind:event"]));
    const user = userEvent.setup();
    const { unmount } = renderScreen(memoryApi([]));
    await screen.findByTestId("calendar-timegrid");
    expect(screen.getByTestId("calendar-filter-kind:event")).toBeChecked();
    await user.click(screen.getByTestId("calendar-filter-group:task"));
    await user.click(screen.getByTestId("calendar-filter-kind:vacation"));
    expect(JSON.parse(localStorage.getItem(`dub.calendar.prefs.hidden.${ME}`)!)).toEqual(["group:task", "kind:vacation"]);

    unmount();
    renderScreen(memoryApi([]));
    await screen.findByTestId("calendar-timegrid");
    expect(screen.getByTestId("calendar-filter-group:task")).not.toBeChecked();
    expect(screen.getByTestId("calendar-filter-kind:vacation")).not.toBeChecked();
    expect(screen.getByTestId("calendar-filter-kind:event")).toBeChecked();
  });

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

    // Like Google, 作成 opens the quick-create panel (not a separate form).
    await user.click(screen.getByTestId("calendar-create"));
    const dialog = await screen.findByTestId("calendar-create-panel");
    await user.type(within(dialog).getByTestId("calendar-form-title"), "スポンサー打ち合わせ");
    await user.click(within(dialog).getByTestId("calendar-form-save"));

    await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1));
    const req = vi.mocked(api.createTask).mock.calls[0]![0];
    expect(req).toMatchObject({ title: "スポンサー打ち合わせ", assigneeId: ME });
    // Default slot = next whole hour (now 8:00 → 9:00–10:00), written with an offset.
    expect(Date.parse(req.startAt!)).toBe(local(9).getTime());
    expect(Date.parse(req.dueAt!)).toBe(local(10).getTime());
    expect(req.startAt).not.toMatch(/T00:00:00(\.0+)?Z$/);
    expect(await screen.findByText("山田：スポンサー打ち合わせ")).toBeInTheDocument();
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
    expect(await screen.findByText("山田：新タイトル")).toBeInTheDocument();

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
    const dialog = await screen.findByTestId("calendar-create-panel");
    await user.type(within(dialog).getByTestId("calendar-form-title"), "失敗する予定");
    await user.click(within(dialog).getByTestId("calendar-form-save"));

    expect(await screen.findByText("予定を保存できませんでした")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("山田：失敗する予定")).not.toBeInTheDocument());
  });

  it("shows month view and hides a タスク status", async () => {
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

    await user.click(screen.getByTestId("calendar-filter-status:done"));
    expect(screen.queryByTestId("calendar-item-a")).not.toBeInTheDocument();
    expect(screen.getByTestId("calendar-item-b")).toBeInTheDocument();
  });

  it("registers a 休暇 (終日, tagged) and draws it in the 休暇 calendar", async () => {
    const user = userEvent.setup();
    const api = memoryApi([]);
    renderScreen(api);
    await screen.findByTestId("calendar-timegrid");

    await user.click(screen.getByTestId("calendar-create"));
    const panel = await screen.findByTestId("calendar-create-panel");
    await user.click(within(panel).getByTestId("calendar-kind-vacation"));
    expect(within(panel).getByTestId("calendar-vacation-note")).toBeInTheDocument();
    await user.click(within(panel).getByTestId("calendar-form-save"));

    await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1));
    const req = vi.mocked(api.createTask).mock.calls[0]![0];
    expect(req).toMatchObject({
      title: "休暇",
      description: "#休暇",
      startAt: "2026-10-10T00:00:00.000Z",
      dueAt: "2026-10-10T00:00:00.000Z",
    });
    expect(await screen.findByText("休暇を登録しました")).toBeInTheDocument();

    // Hidden/shown on its own via 予定 > 種類, independent of status.
    const bar = await within(screen.getByTestId("calendar-allday")).findByText("山田：休暇");
    expect(bar).toBeInTheDocument();
    await user.click(screen.getByTestId("calendar-filter-kind:vacation"));
    expect(within(screen.getByTestId("calendar-allday")).queryByText("山田：休暇")).not.toBeInTheDocument();
  });

  it("opens 休暇 detail without the tag and edits it in the edit dialog", async () => {
    const user = userEvent.setup();
    renderScreen(
      memoryApi([
        mk("off", { title: "夏休み", description: "#休暇\n連絡はチャットへ", startAt: "2026-10-08T00:00:00.000Z", dueAt: "2026-10-09T00:00:00.000Z" }),
      ]),
    );
    await user.click(await screen.findByTestId("calendar-item-off"));
    const detail = await screen.findByTestId("calendar-event-detail");
    expect(within(detail).getByTestId("calendar-detail-kind")).toHaveTextContent("休暇");
    expect(within(detail).getByText("連絡はチャットへ")).toBeInTheDocument();
    expect(within(detail).queryByText(/#休暇/)).not.toBeInTheDocument();

    await user.click(within(detail).getByTestId("calendar-detail-edit"));
    const editor = await screen.findByTestId("calendar-edit-dialog");
    expect(within(editor).getByTestId("calendar-kind-vacation")).toHaveAttribute("aria-selected", "true");
    expect(within(editor).getByTestId("calendar-form-description")).toHaveValue("連絡はチャットへ");
  });

  it("labels a 予定 with a role (個人 + every org role) and filters by ラベル", async () => {
    const user = userEvent.setup();
    const api = memoryApi([
      mk("mine", { title: "個人の予定", startAt: local(10).toISOString(), dueAt: local(11).toISOString() }),
    ]);
    renderScreen(api);
    await screen.findByTestId("calendar-item-mine");

    // Sidebar ラベル list is 個人 + the roles, with no manual management.
    const list = screen.getByTestId("calendar-group-group:schedule");
    expect(await within(list).findByText("統括")).toBeInTheDocument();
    expect(within(list).getByText("個人の予定")).toBeInTheDocument();
    expect(within(list).getByText("広報")).toBeInTheDocument();

    await user.click(screen.getByTestId("calendar-create"));
    const dialog = await screen.findByTestId("calendar-create-panel");
    const select = within(dialog).getByTestId("calendar-form-label");
    expect(select).toHaveValue("personal");
    await user.type(within(dialog).getByTestId("calendar-form-title"), "統括定例");
    await user.selectOptions(select, "role_lead");
    await user.click(within(dialog).getByTestId("calendar-form-save"));

    await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.createTask).mock.calls[0]![0].description).toBe("#予定\n#ラベル:role_lead");

    const created = await screen.findByText("統括：統括定例");
    await user.click(created);
    const detail = await screen.findByTestId("calendar-event-detail");
    expect(within(detail).getByTestId("calendar-detail-label")).toHaveTextContent("統括");
    expect(within(detail).queryByText(/#ラベル/)).not.toBeInTheDocument();
    await user.click(within(detail).getByLabelText("閉じる"));

    // Hiding 統括 hides only the labelled 予定.
    await user.click(screen.getByTestId("calendar-filter-label:role_lead"));
    expect(screen.queryByText("統括：統括定例")).not.toBeInTheDocument();
    expect(screen.getByTestId("calendar-item-mine")).toBeInTheDocument();
  });

  it("leads each 予定 with its owner: the person for 個人, the role for a label", async () => {
    const user = userEvent.setup();
    renderScreen(
      memoryApi([
        mk("off", { title: "休暇", description: "#休暇", dueAt: "2026-10-12T00:00:00.000Z" }),
        mk("other", { title: "面談", description: "#予定", assigneeId: "usr_sato" as common.UserId, dueAt: "2026-10-13T00:00:00.000Z" }),
        mk("lead", { title: "定例", description: "#ラベル:role_lead", dueAt: "2026-10-14T00:00:00.000Z" }),
      ]),
    );
    await screen.findByTestId("calendar-timegrid");
    await user.keyboard("m");
    expect(await screen.findByText("山田：休暇")).toBeInTheDocument();
    expect(await screen.findByText("佐藤：面談")).toBeInTheDocument();
    expect(await screen.findByText("統括：定例")).toBeInTheDocument();

    await user.click(screen.getByText("山田：休暇"));
    const detail = await screen.findByTestId("calendar-event-detail");
    expect(within(detail).getByTestId("calendar-detail-label")).toHaveTextContent("個人（山田）");
  });

  it("splits 予定 and タスク: each has its own switch, 個人の予定 and 個人のタスク apart", async () => {
    const user = userEvent.setup();
    renderScreen(
      memoryApi([
        mk("plan", { title: "面談", startAt: local(10).toISOString(), dueAt: local(11).toISOString() }),
        mk("mtg", { title: "定例", description: "#ミーティング", startAt: local(13).toISOString(), dueAt: local(14).toISOString() }),
        mk("todo", { title: "精算", dueAt: "2026-10-10T00:00:00.000Z" }),
        mk("done", { title: "提出", status: "done", dueAt: "2026-10-09T00:00:00.000Z" }),
      ]),
    );
    // タスク read apart from 予定 by their mark.
    expect(await screen.findByTestId("calendar-item-todo")).toHaveTextContent("○ 山田：精算");
    expect(screen.getByTestId("calendar-item-done")).toHaveTextContent("✓ 山田：提出");
    expect(screen.getByTestId("calendar-item-plan")).toHaveTextContent("山田：面談");
    expect(screen.getByTestId("calendar-item-plan")).not.toHaveTextContent("○");

    // A タスク opens read-only here (edited in マイタスク, so it never turns into a 予定).
    await user.click(screen.getByTestId("calendar-item-todo"));
    const detail = await screen.findByTestId("calendar-event-detail");
    expect(within(detail).getByTestId("calendar-detail-kind")).toHaveTextContent("タスク");
    expect(within(detail).queryByTestId("calendar-detail-edit")).not.toBeInTheDocument();
    await user.click(within(detail).getByLabelText("閉じる"));

    // タスクだけ消す: one click, 予定 stay.
    await user.click(screen.getByTestId("calendar-filter-group:task"));
    expect(screen.queryByTestId("calendar-item-todo")).not.toBeInTheDocument();
    expect(screen.getByTestId("calendar-item-plan")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-filter-status:todo")).toBeDisabled();
    await user.click(screen.getByTestId("calendar-filter-group:task"));

    // 個人のタスク and 個人の予定 are separate checkboxes.
    await user.click(screen.getByTestId("calendar-filter-scope:personal"));
    expect(screen.queryByTestId("calendar-item-todo")).not.toBeInTheDocument();
    expect(screen.getByTestId("calendar-item-plan")).toBeInTheDocument();
    await user.click(screen.getByTestId("calendar-filter-scope:personal"));
    await user.click(screen.getByTestId("calendar-filter-label:personal"));
    expect(screen.queryByTestId("calendar-item-plan")).not.toBeInTheDocument();
    expect(screen.getByTestId("calendar-item-todo")).toBeInTheDocument();
    await user.click(screen.getByTestId("calendar-filter-label:personal"));

    // ミーティング only: uncheck the other 種類.
    for (const k of ["event", "vacation", "rehearsal"]) await user.click(screen.getByTestId(`calendar-filter-kind:${k}`));
    expect(screen.getByTestId("calendar-item-mtg")).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-item-plan")).not.toBeInTheDocument();
  });

  it("shows a chosen team's tasks, not only the caller's own", async () => {
    const user = userEvent.setup();
    const api = memoryApi(
      [mk("mine", { title: "受付準備", teamId: "team_hq" as common.TeamId, dueAt: "2026-10-10T00:00:00.000Z" })],
      [
        mk("bobs", {
          title: "機材手配",
          teamId: "team_dev" as common.TeamId,
          assigneeId: "usr_bob" as common.UserId,
          dueAt: "2026-10-09T00:00:00.000Z",
        }),
      ],
    );
    renderScreen(api);
    await screen.findByTestId("calendar-item-mine");
    // The caller's own team shows as a row (担当・依頼 only) before anything is added.
    expect(await screen.findByTestId("calendar-filter-scope:team_hq")).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-item-bobs")).not.toBeInTheDocument();

    await user.selectOptions(await screen.findByTestId("calendar-add-team"), "team_dev");
    await waitFor(() => expect(api.listTeamTasks).toHaveBeenCalledWith("team_dev"));
    expect(await screen.findByTestId("calendar-item-bobs")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-item-mine")).toBeInTheDocument();

    await user.click(screen.getByTestId("calendar-filter-scope:team_dev"));
    expect(screen.queryByTestId("calendar-item-bobs")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("calendar-filter-scope:team_dev"));
    await user.click(screen.getByLabelText("開発チームの表示をやめる"));
    expect(screen.getByTestId("calendar-item-mine")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("calendar-item-bobs")).not.toBeInTheDocument());
  });

  it("keeps the caller's own items when a team fails to load", async () => {
    const user = userEvent.setup();
    const api = memoryApi([mk("mine", { title: "受付準備", dueAt: "2026-10-10T00:00:00.000Z" })]);
    vi.mocked(api.listTeamTasks).mockRejectedValue(new Error("400"));
    renderScreen(api);
    await screen.findByTestId("calendar-item-mine");
    await user.selectOptions(await screen.findByTestId("calendar-add-team"), "team_dev");
    expect(await screen.findByText("一部のチームのタスクを取得できませんでした")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-item-mine")).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-error")).not.toBeInTheDocument();
  });

  it("ユーザーを検索: adds a member's 予定, hides them by checkbox, and removes them", async () => {
    const user = userEvent.setup();
    const api = memoryApi(
      [mk("mine", { title: "受付準備", dueAt: "2026-10-10T00:00:00.000Z" })],
      [],
      [mk("satos", { title: "取材", assigneeId: "usr_sato" as common.UserId, dueAt: "2026-10-09T00:00:00.000Z" })],
    );
    renderScreen(api);
    await screen.findByTestId("calendar-item-mine");
    expect(screen.queryByTestId("calendar-item-satos")).not.toBeInTheDocument();

    await user.type(screen.getByRole("combobox", { name: "ユーザーを検索" }), "佐");
    // Yourself is never offered (already on the calendar).
    const option = await screen.findByTestId("calendar-people-option-usr_sato");
    expect(screen.queryByTestId(`calendar-people-option-${ME}`)).not.toBeInTheDocument();
    await user.click(option);
    await waitFor(() => expect(api.listUserTasks).toHaveBeenCalledWith("usr_sato"));
    expect(await screen.findByTestId("calendar-item-satos")).toHaveTextContent("佐藤：取材");
    expect(screen.getByTestId("calendar-item-mine")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("dub.calendar.watchedPeople") ?? "[]")).toEqual([{ id: "usr_sato", name: "佐藤 花子" }]);

    await user.click(screen.getByTestId("calendar-filter-person:usr_sato"));
    expect(screen.queryByTestId("calendar-item-satos")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("calendar-filter-person:usr_sato"));
    expect(screen.getByTestId("calendar-item-satos")).toBeInTheDocument();

    await user.click(screen.getByLabelText("佐藤 花子の表示をやめる"));
    await waitFor(() => expect(screen.queryByTestId("calendar-item-satos")).not.toBeInTheDocument());
    expect(screen.getByTestId("calendar-item-mine")).toBeInTheDocument();
  });

  it("picks a searched member with the keyboard", async () => {
    const user = userEvent.setup();
    const api = memoryApi([]);
    renderScreen(api);
    await screen.findByTestId("calendar-timegrid");
    await user.type(screen.getByRole("combobox", { name: "ユーザーを検索" }), "佐藤");
    await screen.findByTestId("calendar-people-option-usr_sato");
    await user.keyboard("{Enter}");
    expect(await screen.findByTestId("calendar-filter-person:usr_sato")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "ユーザーを検索" })).toHaveValue("");
  });

  it("disables 作成 without write permission", async () => {
    renderScreen(memoryApi([]), { canWrite: false, canDelete: false });
    await screen.findByTestId("calendar-timegrid");
    expect(screen.getByTestId("calendar-create")).toBeDisabled();
  });
});
