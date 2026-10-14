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
import type { CalendarApi } from "./calendarApi.tsx";
import { CalendarApiProvider } from "./CalendarProvider.tsx";
import { CalendarScreen } from "./CalendarScreen.tsx";
import { MEETING_FILTER_STORAGE_KEY } from "./meeting-form";

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
    resolve(mtg({ id: "mtg_new", title: "統括定例", targetId: "role_lead", recurrence: "none" }));
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

describe("サイドバー ミーティング", () => {
  it("defaults to 全体 + own targets, toggling shows other roles and is remembered", async () => {
    render(wrap(<CalendarScreen />, fakeApi(), VIEW));
    await waitFor(() => expect(chipsOf("mtg_all").length).toBeGreaterThan(0));
    expect(chipsOf("mtg_member")).toHaveLength(0);
    expect(screen.getByTestId("calendar-meeting-filter-all")).toBeChecked();
    expect(screen.getByTestId("calendar-meeting-filter-role_lead")).toBeChecked();

    await userEvent.click(screen.getByTestId("calendar-meeting-filter-role_member"));
    await waitFor(() => expect(chipsOf("mtg_member").length).toBeGreaterThan(0));
    expect(JSON.parse(localStorage.getItem(MEETING_FILTER_STORAGE_KEY)!)).toEqual(["all", "role_lead", "role_member"]);
  });
});
