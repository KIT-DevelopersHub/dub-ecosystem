// カレンダー > ミーティング screen tests: permission gating (無効/閲覧/編集), the create
// dialog's submit payload, account notices and the sidebar ミーティング filter. Faked CalendarApi.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { common, identity, meeting } from "@dub/types";
import { FakeAuthProvider, editorPermissions, viewerPermissions } from "../../auth/test-support.tsx";
import { ApiError } from "../../lib/api-client.tsx";
import type { CalendarApi } from "./calendarApi.tsx";
import { CalendarApiProvider } from "./CalendarProvider.tsx";
import { CalendarScreen } from "./CalendarScreen.tsx";
import { userPrefKey } from "./calendar-prefs";
import { findCreatedMeeting } from "./useMeetings.tsx";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

const ME = "usr_test" as common.UserId;

const EDIT: identity.PermissionKey[] = editorPermissions("calendar", ["task:read", "calendar:meetings_view", "calendar:meetings_edit"]);
const VIEW: identity.PermissionKey[] = editorPermissions("calendar", ["task:read", "calendar:meetings_view"]);
const NONE: identity.PermissionKey[] = editorPermissions("calendar", ["task:read"]);

function mtg(over: Partial<meeting.Meeting>): meeting.Meeting {
  return {
    id: "mtg_all",
    title: "全体定例",
    description: null,
    targetId: "all",
    targetName: "全体",
    startsAt: "2026-01-05T12:00:00.000Z", // weekly from a Monday long ago → visible in any month
    durationMinutes: 60,
    recurrence: "weekly",
    until: null,
    meetUrl: "https://meet.google.com/abc-defg-hij",
    htmlLink: "https://calendar.google.com/x",
    attendeeCount: 9,
    createdBy: ME,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const TARGETS: meeting.MeetingTarget[] = [
  { id: "all", name: "全体", memberCount: 9, isMine: false },
  { id: "role_lead", name: "統括", memberCount: 2, isMine: true },
  { id: "role_member", name: "member", memberCount: 4, isMine: false },
];

function fakeApi(over: Partial<CalendarApi> = {}, account: meeting.MeetingAccountState = { email: "hackit.dub@gmail.com", calendarReady: true }) {
  const items = [mtg({}), mtg({ id: "mtg_member", title: "メンバー会", targetId: "role_member", targetName: "member" })];
  const api: CalendarApi = {
    listTasks: vi.fn(),
    listAllTasks: vi.fn(),
    listMyTasks: vi.fn(() => Promise.resolve([])),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    listRoles: vi.fn(() => Promise.resolve([])),
    listTeams: vi.fn(async () => ({ teams: [], myTeamIds: [] })),
    listTeamTasks: vi.fn(async () => []),
    getUsers: vi.fn(() => Promise.resolve([])),
    searchUsers: vi.fn(async () => []),
    listUserTasks: vi.fn(async () => []),
    listMeetings: vi.fn(() => Promise.resolve({ items, account })),
    listMeetingTargets: vi.fn(() => Promise.resolve({ items: TARGETS })),
    createMeeting: vi.fn((b: meeting.CreateMeetingRequest) => Promise.resolve(mtg({ ...b, id: "mtg_new", description: b.description ?? null, until: b.until ?? null }))),
    updateMeeting: vi.fn(),
    deleteMeeting: vi.fn(() => Promise.resolve()),
    syncMeetings: vi.fn(),
    ...over,
  };
  return api;
}

function wrap(ui: ReactNode, api: CalendarApi, permissions: readonly identity.PermissionKey[]): JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <FakeAuthProvider permissions={permissions}>
        <ToastProvider>
          <CalendarApiProvider value={api} currentUserId={ME}>
            {ui}
          </CalendarApiProvider>
        </ToastProvider>
      </FakeAuthProvider>
    </QueryClientProvider>
  );
}

// Meetings are drawn by the shared views as items with a "meet:<id>:<day>" id.
const chipsOf = (id: string) => screen.queryAllByTestId(new RegExp(`^calendar-item-meet:${id}:`));

beforeEach(() => localStorage.clear());

describe("カレンダー > ミーティング permissions", () => {
  it("無効 (no meetings keys): no filter, no buttons, meetings never fetched", async () => {
    const api = fakeApi();
    render(wrap(<CalendarScreen />, api, NONE));
    await screen.findByTestId("calendar-sidebar");
    expect(screen.queryByTestId("calendar-meeting-filter")).not.toBeInTheDocument();
    expect(screen.queryByTestId("calendar-meetings-create")).not.toBeInTheDocument();
    expect(api.listMeetings).not.toHaveBeenCalled();
  });

  it("閲覧: meetings are listed, but no create/sync and no edit/delete in the detail", async () => {
    render(wrap(<CalendarScreen />, fakeApi(), VIEW));
    await screen.findByTestId("calendar-meeting-filter");
    await waitFor(() => expect(chipsOf("mtg_all").length).toBeGreaterThan(0));
    expect(screen.queryByTestId("calendar-meetings-create")).not.toBeInTheDocument();
    expect(screen.queryByTestId("calendar-meetings-sync")).not.toBeInTheDocument();
    await userEvent.click(chipsOf("mtg_all")[0]!);
    const detail = await screen.findByTestId("calendar-meeting-detail");
    expect(within(detail).getByTestId("calendar-meeting-detail-join")).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-meeting-detail-edit")).not.toBeInTheDocument();
    expect(screen.queryByTestId("calendar-meeting-detail-delete")).not.toBeInTheDocument();
  });

  it("meetings_edit on a カレンダー 閲覧 role is capped at 閲覧", async () => {
    const perms = viewerPermissions("calendar", ["task:read", "calendar:meetings_view", "calendar:meetings_edit"]);
    render(wrap(<CalendarScreen />, fakeApi(), perms));
    await screen.findByTestId("calendar-meeting-filter");
    expect(screen.queryByTestId("calendar-meetings-create")).not.toBeInTheDocument();
  });
});

describe("定例ミーティングを設定", () => {
  it("submits the JST date + time as a UTC startsAt and shows the new meeting optimistically", async () => {
    let resolve!: (m: meeting.Meeting) => void;
    const api = fakeApi({ createMeeting: vi.fn(() => new Promise<meeting.Meeting>((r) => (resolve = r))) });
    render(wrap(<CalendarScreen />, api, EDIT));
    const create = await screen.findByTestId("calendar-meetings-create");
    await waitFor(() => expect(create).toBeEnabled());
    expect(create.closest("[data-feature]")).toHaveAttribute("data-feature", "cal-meet-v1");
    await userEvent.click(create);

    const dialog = await screen.findByTestId("calendar-meeting-form");
    expect(within(dialog).getByTestId("calendar-meeting-form-hint")).toHaveTextContent("hackit.dub@gmail.com");
    // Submitting empty shows the title error and sends nothing.
    await userEvent.click(within(dialog).getByTestId("calendar-meeting-form-submit"));
    expect(await within(dialog).findByText("タイトルを入力してください")).toBeInTheDocument();
    expect(api.createMeeting).not.toHaveBeenCalled();

    await userEvent.type(within(dialog).getByTestId("calendar-meeting-form-title"), "統括定例");
    await userEvent.selectOptions(within(dialog).getByTestId("calendar-meeting-form-target"), "role_lead");
    // Today at 12:00 JST — same calendar day in any test TZ, so it lands in the visible week.
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    fireEvent.change(within(dialog).getByTestId("calendar-meeting-form-date"), { target: { value: date } });
    await userEvent.selectOptions(within(dialog).getByTestId("calendar-meeting-form-time"), "12:00");
    await userEvent.selectOptions(within(dialog).getByTestId("calendar-meeting-form-duration"), "30");
    await userEvent.selectOptions(within(dialog).getByTestId("calendar-meeting-form-recurrence"), "none");
    expect(within(dialog).queryByTestId("calendar-meeting-form-until")).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByTestId("calendar-meeting-form-submit"));

    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    expect(api.createMeeting).toHaveBeenCalledWith({
      title: "統括定例",
      description: null,
      targetId: "role_lead",
      startsAt: new Date(Date.UTC(y, m - 1, d, 12 - 9, 0)).toISOString(),
      durationMinutes: 30,
      recurrence: "none",
      until: null,
    });
    // Optimistic chip before the server answers (統括 is one of the caller's default-on targets).
    await waitFor(() => expect(chipsOf("tmp_[a-z0-9]+").length).toBe(1));
    // …marked 作成中 with no Meet link, and no second registration meanwhile.
    expect(within(chipsOf("tmp_[a-z0-9]+")[0]!).getByTestId("calendar-item-pending")).toHaveTextContent("作成中…");
    expect(screen.getByTestId("calendar-meetings-create")).toBeDisabled();
    await userEvent.click(chipsOf("tmp_[a-z0-9]+")[0]!);
    expect(await screen.findByTestId("calendar-meeting-detail-no-meet")).toHaveTextContent("作成中…");
    expect(screen.queryByTestId("calendar-meeting-detail-join")).not.toBeInTheDocument();
    resolve(mtg({ id: "mtg_new", title: "統括定例", targetId: "role_lead", recurrence: "none" }));
    await waitFor(() => expect(screen.getByTestId("calendar-meetings-create")).toBeEnabled());
  });

  it("a 504 is not a failure when the re-read list has the meeting", async () => {
    const made = mtg({ id: "mtg_made", title: "全体定例2", startsAt: "2026-01-06T12:00:00.000Z" });
    const timeout = new ApiError(504, { error: { code: "UPSTREAM_TIMEOUT", message: "Gateway Timeout" } } as never);
    let listed = [mtg({})];
    const api = fakeApi({
      listMeetings: vi.fn(async () => ({ items: listed, account: { email: "hackit.dub@gmail.com", calendarReady: true } })),
      createMeeting: vi.fn(async () => {
        listed = [...listed, made];
        throw timeout;
      }),
    });
    render(wrap(<CalendarScreen />, api, EDIT));
    const create = await screen.findByTestId("calendar-meetings-create");
    await waitFor(() => expect(create).toBeEnabled());
    await userEvent.click(create);
    const dialog = await screen.findByTestId("calendar-meeting-form");
    await userEvent.type(within(dialog).getByTestId("calendar-meeting-form-title"), "全体定例2");
    fireEvent.change(within(dialog).getByTestId("calendar-meeting-form-date"), { target: { value: "2026-01-06" } });
    await userEvent.selectOptions(within(dialog).getByTestId("calendar-meeting-form-time"), "21:00");
    await userEvent.click(within(dialog).getByTestId("calendar-meeting-form-submit"));

    expect(await screen.findByText("ミーティングを登録しました")).toBeInTheDocument();
    expect(screen.queryByText("ミーティングを登録できませんでした")).not.toBeInTheDocument();
  });

  it("an unconnected shared account shows the banner and disables create", async () => {
    render(wrap(<CalendarScreen />, fakeApi({}, { email: null, calendarReady: false }), EDIT));
    expect(await screen.findByTestId("calendar-meetings-no-account")).toHaveTextContent("共有 Google アカウントが未接続です");
    expect(screen.getByTestId("calendar-meetings-create")).toBeDisabled();
  });

  it("a connected account without calendar access asks to reconnect", async () => {
    render(wrap(<CalendarScreen />, fakeApi({}, { email: "hackit.dub@gmail.com", calendarReady: false }), EDIT));
    expect(await screen.findByTestId("calendar-meetings-reconnect")).toHaveTextContent("再接続してください");
  });

  it("delete asks for confirmation, then removes the meeting", async () => {
    const api = fakeApi();
    render(wrap(<CalendarScreen />, api, EDIT));
    await waitFor(() => expect(chipsOf("mtg_all").length).toBeGreaterThan(0));
    await userEvent.click(chipsOf("mtg_all")[0]!);
    await userEvent.click(await screen.findByTestId("calendar-meeting-detail-delete"));
    const confirm = await screen.findByTestId("calendar-meeting-detail-confirm");
    expect(api.deleteMeeting).not.toHaveBeenCalled();
    await userEvent.click(within(confirm).getByRole("button", { name: "削除する" }));
    await waitFor(() => expect(api.deleteMeeting).toHaveBeenCalledWith("mtg_all"));
  });
});

describe("findCreatedMeeting", () => {
  const body: meeting.CreateMeetingRequest = { title: "全体定例", targetId: "all", startsAt: "2026-01-05T12:00:00Z", durationMinutes: 60, recurrence: "weekly" };

  it("finds a new meeting with the same title / target / start, ignoring ones already listed", async () => {
    const api = { listMeetings: vi.fn(async () => ({ items: [mtg({}), mtg({ id: "mtg_new" })], account: { email: null, calendarReady: true } })) };
    expect(await findCreatedMeeting(api, body, new Set(["mtg_all"]), [0])).toMatchObject({ id: "mtg_new" });
    expect(await findCreatedMeeting(api, body, new Set(["mtg_all", "mtg_new"]), [0, 0])).toBeNull();
    expect(api.listMeetings).toHaveBeenCalledTimes(3);
  });

  it("a different start or a failing list is not a match", async () => {
    const api = { listMeetings: vi.fn(async () => ({ items: [mtg({ startsAt: "2026-01-12T12:00:00Z" })], account: { email: null, calendarReady: true } })) };
    expect(await findCreatedMeeting(api, body, new Set(), [0])).toBeNull();
    const down = { listMeetings: vi.fn(() => Promise.reject(new Error("offline"))) };
    expect(await findCreatedMeeting(down, body, new Set(), [0])).toBeNull();
  });
});

describe("サイドバー ミーティング", () => {
  it("defaults to 全体 + own targets, toggling shows other roles and is remembered", async () => {
    render(wrap(<CalendarScreen />, fakeApi(), VIEW));
    await waitFor(() => expect(chipsOf("mtg_all").length).toBeGreaterThan(0));
    expect(chipsOf("mtg_member")).toHaveLength(0);
    expect(screen.getByTestId("calendar-meeting-filter-all")).toBeChecked();
    expect(screen.getByTestId("calendar-meeting-filter-role_lead")).toBeChecked();

    await userEvent.click(screen.getByTestId("calendar-meeting-filter-role_member"));
    await waitFor(() => expect(chipsOf("mtg_member").length).toBeGreaterThan(0));
    expect(JSON.parse(localStorage.getItem(userPrefKey("meetingTargets", ME))!)).toEqual({
      all: true,
      role_lead: true,
      role_member: true,
    });
  });

  it("a choice survives a reload and is drawn before the target list arrives", async () => {
    localStorage.setItem(userPrefKey("meetingTargets", ME), JSON.stringify({ all: false, role_member: true }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const api = fakeApi({ listMeetingTargets: vi.fn(() => gate.then(() => ({ items: TARGETS }))) });
    render(wrap(<CalendarScreen />, api, VIEW));
    await waitFor(() => expect(chipsOf("mtg_member").length).toBeGreaterThan(0));
    expect(chipsOf("mtg_all")).toHaveLength(0);
    release();
    await screen.findByTestId("calendar-meeting-filter-role_member");
    expect(chipsOf("mtg_member").length).toBeGreaterThan(0);
    expect(screen.getByTestId("calendar-meeting-filter-all")).not.toBeChecked();
  });

  it("another user's choice on the same browser does not apply", async () => {
    localStorage.setItem(userPrefKey("meetingTargets", "usr_other"), JSON.stringify({ all: false }));
    render(wrap(<CalendarScreen />, fakeApi(), VIEW));
    await waitFor(() => expect(chipsOf("mtg_all").length).toBeGreaterThan(0));
  });
});
