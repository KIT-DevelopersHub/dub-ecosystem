// カレンダー > ミーティング screen tests: permission gating (無効/閲覧/編集), the create
// dialog's submit payload, account notices and the sidebar ミーティング filter. Faked CalendarApi.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { common, identity, meeting } from "@dub/types";
import { meeting as meetingValues } from "@dub/types";
import { FakeAuthProvider, editorPermissions, viewerPermissions } from "../../auth/test-support.tsx";
import { ApiError } from "../../lib/api-client.tsx";
import type { CalendarApi } from "./calendarApi.tsx";
import { CalendarApiProvider, type CalendarCaps } from "./CalendarProvider.tsx";
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
    targets: meetingValues.legacyTargets(over.targetId ?? "all").map((t) => ({ ...t, name: over.targetName ?? "全体" })),
    startsAt: "2026-01-05T12:00:00.000Z", // weekly from a Monday long ago → visible in any month
    durationMinutes: 60,
    recurrence: "weekly",
    until: null,
    meetUrl: "https://meet.google.com/abc-defg-hij",
    htmlLink: "https://calendar.google.com/x",
    attendeeCount: 9,
    trackAttendance: false,
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
  const items = [
    mtg({}),
    mtg({ id: "mtg_member", title: "メンバー会", targetId: "role_member", targetName: "member", createdBy: "user_other" as meeting.Meeting["createdBy"] }),
  ];
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
    createMeeting: vi.fn((b: meeting.CreateMeetingRequest) => Promise.resolve(mtg({ ...b, targetId: b.targetId ?? "all", targets: (b.targets ?? []).map((t) => ({ ...t, name: t.id })), id: "mtg_new", description: b.description ?? null, until: b.until ?? null }))),
    updateMeeting: vi.fn(),
    deleteMeeting: vi.fn(() => Promise.resolve()),
    syncMeetings: vi.fn(),
    syncMeeting: vi.fn(),
    joinMeeting: vi.fn(async () => ({ meetUrl: "https://meet.google.com/abc-defg-hij", recordedFor: null })),
    listMeetingAttendees: vi.fn(async () => ({ items: [], responsesAvailable: true, notInvited: [] })),
    ...over,
  };
  return api;
}

function wrap(ui: ReactNode, api: CalendarApi, permissions: readonly identity.PermissionKey[], caps?: CalendarCaps): JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <FakeAuthProvider permissions={permissions}>
        <ToastProvider>
          <CalendarApiProvider value={api} currentUserId={ME} {...(caps ? { caps } : {})}>
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

  it("the detail lists invitees with their Google Calendar answers for the clicked occurrence", async () => {
    const api = fakeApi({
      listMeetingAttendees: vi.fn(async () => ({
        responsesAvailable: true,
        items: [
          { userId: "usr_a" as common.UserId, name: "山田 恵美", email: null, response: "accepted" as const, comment: null },
          { userId: null, name: "外部 ゲスト", email: "guest@example.com", response: "tentative" as const, comment: null },
          { userId: "usr_b" as common.UserId, name: "佐藤 太郎", email: null, response: "declined" as const, comment: "授業です" },
          { userId: "usr_c" as common.UserId, name: "鈴木 一郎", email: null, response: "needsAction" as const, comment: null },
        ],
        notInvited: [],
      })),
    });
    render(wrap(<CalendarScreen />, api, VIEW));
    await waitFor(() => expect(chipsOf("mtg_all").length).toBeGreaterThan(0));
    const chip = chipsOf("mtg_all")[0]!;
    await userEvent.click(chip);
    const section = await screen.findByTestId("calendar-meeting-attendees");
    await waitFor(() => expect(within(section).getAllByTestId("calendar-meeting-attendees-row")).toHaveLength(4));
    expect(section).toHaveTextContent("参加者 4人");
    expect(within(section).getByTestId("calendar-meeting-attendees-summary")).toHaveTextContent("参加 1 · 未定 1 · 不参加 1 · 未返信 1");
    expect(within(section).getAllByTestId("calendar-meeting-attendees-response").map((b) => b.textContent)).toEqual(["参加", "未定", "不参加", "未返信"]);
    expect(section).toHaveTextContent("guest@example.com");
    expect(section).toHaveTextContent("「授業です」");
    // A weekly meeting asks for the clicked occurrence (its JST date, from the chip id).
    const day = chip.getAttribute("data-testid")!.split(":").pop();
    expect(api.listMeetingAttendees).toHaveBeenCalledWith("mtg_all", day);
  });

  it("answers Google could not provide are hidden, the invitee list still shows", async () => {
    const api = fakeApi({
      listMeetingAttendees: vi.fn(async () => ({
        responsesAvailable: false,
        items: [{ userId: "usr_a" as common.UserId, name: "山田 恵美", email: null, response: "needsAction" as const, comment: null }],
        notInvited: [],
      })),
    });
    render(wrap(<CalendarScreen />, api, VIEW));
    await waitFor(() => expect(chipsOf("mtg_all").length).toBeGreaterThan(0));
    await userEvent.click(chipsOf("mtg_all")[0]!);
    const section = await screen.findByTestId("calendar-meeting-attendees");
    await within(section).findByTestId("calendar-meeting-attendees-unavailable");
    expect(within(section).getAllByTestId("calendar-meeting-attendees-row")).toHaveLength(1);
    expect(within(section).queryByTestId("calendar-meeting-attendees-response")).not.toBeInTheDocument();
  });

  it("#908: target members Dub could not invite are listed — メールアドレス未連携 / 未招待 — and view-only users get no resync", async () => {
    const api = fakeApi({
      listMeetingAttendees: vi.fn(async () => ({
        responsesAvailable: true,
        items: [{ userId: "usr_a" as common.UserId, name: "山田 恵美", email: null, response: "accepted" as const, comment: null }],
        notInvited: [
          { userId: "usr_b" as common.UserId, name: "佐藤 太郎", reason: "no_email" as const },
          { userId: "usr_c" as common.UserId, name: "鈴木 一郎", reason: "pending" as const },
        ],
      })),
    });
    render(wrap(<CalendarScreen />, api, VIEW));
    await waitFor(() => expect(chipsOf("mtg_all").length).toBeGreaterThan(0));
    await userEvent.click(chipsOf("mtg_all")[0]!);
    const section = await screen.findByTestId("calendar-meeting-attendees");
    const missing = await within(section).findByTestId("calendar-meeting-attendees-not-invited");
    expect(missing).toHaveTextContent("招待できていないメンバー 2人");
    expect(within(missing).getAllByTestId("calendar-meeting-attendees-not-invited-reason").map((b) => b.textContent)).toEqual(["メールアドレス未連携", "未招待"]);
    // Not counted as invited.
    expect(section).toHaveTextContent("参加者 1人");
    expect(within(section).queryByTestId("calendar-meeting-attendees-resync")).not.toBeInTheDocument();
  });

  it("#908: 参加者を再同期 (editor) syncs that meeting and re-reads its attendees", async () => {
    let synced = false;
    const api = fakeApi({
      listMeetingAttendees: vi.fn(async () => ({
        responsesAvailable: true,
        items: synced ? [{ userId: "usr_c" as common.UserId, name: "鈴木 一郎", email: null, response: "needsAction" as const, comment: null }] : [],
        notInvited: synced ? [] : [{ userId: "usr_c" as common.UserId, name: "鈴木 一郎", reason: "pending" as const }],
      })),
      syncMeeting: vi.fn(async () => {
        synced = true;
        return { invitedAdded: 1, invitedRemoved: 0, notInvited: [] };
      }),
    });
    render(wrap(<CalendarScreen />, api, EDIT));
    await waitFor(() => expect(chipsOf("mtg_all").length).toBeGreaterThan(0));
    await userEvent.click(chipsOf("mtg_all")[0]!);
    const section = await screen.findByTestId("calendar-meeting-attendees");
    await within(section).findByTestId("calendar-meeting-attendees-not-invited");
    await userEvent.click(within(section).getByTestId("calendar-meeting-attendees-resync"));
    expect(api.syncMeeting).toHaveBeenCalledWith("mtg_all");
    await waitFor(() => expect(within(section).getAllByTestId("calendar-meeting-attendees-row")).toHaveLength(1));
    expect(within(section).queryByTestId("calendar-meeting-attendees-not-invited")).not.toBeInTheDocument();
    expect(await screen.findByText("参加者を再同期しました（追加 1 人・解除 0 人）")).toBeInTheDocument();
  });

  it("a 定例 shows that attendance is taken, and Meet に参加 goes through the join (records attendance)", async () => {
    const tab = { opener: {}, location: { href: "" }, close: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    const api = fakeApi({
      listMeetings: vi.fn(async () => ({ items: [mtg({ trackAttendance: true })], account: { email: "hackit.dub@gmail.com", calendarReady: true } })),
    });
    render(wrap(<CalendarScreen />, api, VIEW));
    await waitFor(() => expect(chipsOf("mtg_all").length).toBeGreaterThan(0));
    await userEvent.click(chipsOf("mtg_all")[0]!);
    const detail = await screen.findByTestId("calendar-meeting-detail");
    expect(within(detail).getByTestId("calendar-meeting-detail-attendance")).toHaveTextContent("全体定例");
    await userEvent.click(within(detail).getByTestId("calendar-meeting-detail-join"));
    expect(api.joinMeeting).toHaveBeenCalledWith("mtg_all");
    await waitFor(() => expect(tab.location.href).toBe("https://meet.google.com/abc-defg-hij"));
    open.mockRestore();
  });

  it("meetings_edit on a カレンダー 閲覧 role is capped at 閲覧", async () => {
    const perms = viewerPermissions("calendar", ["task:read", "calendar:meetings_view", "calendar:meetings_edit"]);
    render(wrap(<CalendarScreen />, fakeApi(), perms));
    await screen.findByTestId("calendar-meeting-filter");
    expect(screen.queryByTestId("calendar-meetings-create")).not.toBeInTheDocument();
  });
});

/** Replace the default 全体 chip with one found by typing (Backspace removes, Enter adds). */
async function pickOnlyTarget(dialog: HTMLElement, query: string): Promise<void> {
  const input = within(dialog).getByTestId("calendar-meeting-form-target");
  await userEvent.click(input);
  await userEvent.keyboard("{Backspace}");
  await userEvent.type(input, query);
  await userEvent.keyboard("{Enter}");
}

/** The one way to create a meeting (#884): 作成 → ミーティング tab (once the meetings have loaded). */
async function openMeetingTab(): Promise<HTMLElement> {
  await waitFor(() => expect(chipsOf("mtg_all").length).toBeGreaterThan(0));
  await userEvent.click(screen.getByTestId("calendar-create"));
  const panel = await screen.findByTestId("calendar-create-panel");
  await userEvent.click(within(panel).getByRole("tab", { name: /ミーティング/ }));
  return within(panel).findByTestId("calendar-meeting-form");
}

describe("定例ミーティングを設定", () => {
  it("submits the JST date + time as a UTC startsAt and shows the new meeting optimistically", async () => {
    let resolve!: (m: meeting.Meeting) => void;
    const api = fakeApi({ createMeeting: vi.fn(() => new Promise<meeting.Meeting>((r) => (resolve = r))) });
    render(wrap(<CalendarScreen />, api, EDIT));
    expect(await screen.findByTestId("calendar-create-row")).toHaveAttribute("data-feature", "cal-meet-v1");
    const dialog = await openMeetingTab();
    expect(within(dialog).getByTestId("calendar-meeting-form-hint")).toHaveTextContent("hackit.dub@gmail.com");
    // Submitting empty shows the title error and sends nothing.
    await userEvent.click(within(dialog).getByTestId("calendar-meeting-form-submit"));
    expect(await within(dialog).findByText("タイトルを入力してください")).toBeInTheDocument();
    expect(api.createMeeting).not.toHaveBeenCalled();

    await userEvent.type(within(dialog).getByTestId("calendar-meeting-form-title"), "統括定例");
    await pickOnlyTarget(dialog, "統括");
    // Today at 12:00 JST — same calendar day in any test TZ, so it lands in the visible week.
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    fireEvent.change(within(dialog).getByTestId("calendar-meeting-form-date"), { target: { value: date } });
    await userEvent.selectOptions(within(dialog).getByTestId("calendar-meeting-form-time"), "12:00");
    await userEvent.selectOptions(within(dialog).getByTestId("calendar-meeting-form-duration"), "30");
    await userEvent.selectOptions(within(dialog).getByTestId("calendar-meeting-form-recurrence"), "none");
    expect(within(dialog).queryByTestId("calendar-meeting-form-until")).not.toBeInTheDocument();
    // 定例として出席を取る (チーム定例: target is a role).
    expect(within(dialog).getByText("チーム定例として出席を取る")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByText("チーム定例として出席を取る"));
    await userEvent.click(within(dialog).getByTestId("calendar-meeting-form-submit"));

    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    expect(api.createMeeting).toHaveBeenCalledWith({
      title: "統括定例",
      description: null,
      targets: [{ kind: "role", id: "role_lead" }],
      targetId: "role_lead",
      startsAt: new Date(Date.UTC(y, m - 1, d, 12 - 9, 0)).toISOString(),
      durationMinutes: 30,
      recurrence: "none",
      until: null,
      trackAttendance: true,
    });
    // Optimistic chip before the server answers (統括 is one of the caller's default-on targets).
    await waitFor(() => expect(chipsOf("tmp_[a-z0-9]+").length).toBe(1));
    // …marked 作成中 with no Meet link, and no second registration meanwhile.
    expect(within(chipsOf("tmp_[a-z0-9]+")[0]!).getByTestId("calendar-item-pending")).toHaveTextContent("作成中…");
    const again = await openMeetingTab();
    expect(within(again).getByTestId("calendar-meeting-form-submit")).toBeDisabled();
    await userEvent.click(within(again).getByTestId("calendar-meeting-form-cancel"));
    await userEvent.click(chipsOf("tmp_[a-z0-9]+")[0]!);
    expect(await screen.findByTestId("calendar-meeting-detail-no-meet")).toHaveTextContent("作成中…");
    expect(screen.queryByTestId("calendar-meeting-detail-join")).not.toBeInTheDocument();
    resolve(mtg({ id: "mtg_new", title: "統括定例", targetId: "role_lead", recurrence: "none" }));
    await waitFor(() => expect(screen.queryAllByTestId("calendar-item-pending")).toHaveLength(0));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("calendar-meeting-detail")).not.toBeInTheDocument());
    expect(within(await openMeetingTab()).getByTestId("calendar-meeting-form-submit")).toBeEnabled();
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
    const dialog = await openMeetingTab();
    await userEvent.type(within(dialog).getByTestId("calendar-meeting-form-title"), "全体定例2");
    fireEvent.change(within(dialog).getByTestId("calendar-meeting-form-date"), { target: { value: "2026-01-06" } });
    await userEvent.selectOptions(within(dialog).getByTestId("calendar-meeting-form-time"), "21:00");
    await userEvent.click(within(dialog).getByTestId("calendar-meeting-form-submit"));

    expect(await screen.findByText("ミーティングを登録しました")).toBeInTheDocument();
    expect(screen.queryByText("ミーティングを登録できませんでした")).not.toBeInTheDocument();
  });

  it("an unconnected shared account still shows the meeting form, with 登録 off and why", async () => {
    const api = fakeApi({}, { email: null, calendarReady: false });
    render(wrap(<CalendarScreen />, api, EDIT));
    expect(await screen.findByTestId("calendar-meetings-no-account")).toHaveTextContent("共有 Google アカウントが未接続です");
    await userEvent.click(screen.getByTestId("calendar-create"));
    const panel = await screen.findByTestId("calendar-create-panel");
    await userEvent.click(within(panel).getByRole("tab", { name: /ミーティング/ }));
    // Same fields as with a connected account: never the plain 予定 form.
    expect(within(panel).queryByTestId("calendar-event-form")).not.toBeInTheDocument();
    const form = within(panel).getByTestId("calendar-meeting-form");
    for (const f of ["title", "target", "date", "time", "duration", "recurrence", "until", "description", "track"]) {
      expect(within(form).getByTestId(`calendar-meeting-form-${f}`)).toBeInTheDocument();
    }
    expect(within(form).getByTestId("calendar-meeting-form-hint")).toHaveTextContent("共有アカウント（未接続）");
    expect(within(form).getByTestId("calendar-meeting-form-no-account")).toHaveTextContent("共有 Google アカウントが未接続です");
    expect(within(form).getByTestId("calendar-meeting-form-submit")).toBeDisabled();
    expect(api.createMeeting).not.toHaveBeenCalled();
  });

  it("a connected account without calendar access asks to reconnect", async () => {
    render(wrap(<CalendarScreen />, fakeApi({}, { email: "hackit.dub@gmail.com", calendarReady: false }), EDIT));
    expect(await screen.findByTestId("calendar-meetings-reconnect")).toHaveTextContent("再接続してください");
    await userEvent.click(screen.getByTestId("calendar-create"));
    const panel = await screen.findByTestId("calendar-create-panel");
    await userEvent.click(within(panel).getByRole("tab", { name: /ミーティング/ }));
    const form = within(panel).getByTestId("calendar-meeting-form");
    expect(within(form).getByTestId("calendar-meeting-form-reconnect")).toHaveTextContent("再接続してください");
    expect(within(form).getByTestId("calendar-meeting-form-submit")).toBeDisabled();
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

describe("対象を複数選ぶ", () => {
  it("adds a role and a member as chips (Enter / click), removes with × and Backspace, and sends targets[]", async () => {
    const api = fakeApi({
      listMeetingTargets: vi.fn(() => Promise.resolve({ items: TARGETS, people: [{ id: "usr_hana" as meeting.MeetingPersonOption["id"], name: "花子" }] })),
    });
    render(wrap(<CalendarScreen />, api, EDIT));
    const dialog = await openMeetingTab();
    const chips = () => within(dialog).queryAllByTestId("calendar-meeting-form-target-chip").map((c) => c.getAttribute("data-value"));
    expect(chips()).toEqual(["all:all"]);

    const input = within(dialog).getByTestId("calendar-meeting-form-target");
    await userEvent.type(input, "統括{Enter}");
    await userEvent.type(input, "花");
    await userEvent.click(within(dialog).getByRole("option", { name: /花子/ }));
    expect(chips()).toEqual(["all:all", "role:role_lead", "person:usr_hana"]);

    await userEvent.click(within(dialog).getByRole("button", { name: "全体 を外す" }));
    expect(chips()).toEqual(["role:role_lead", "person:usr_hana"]);
    await userEvent.keyboard("{Backspace}");
    expect(chips()).toEqual(["role:role_lead"]);
    await userEvent.type(input, "花{Enter}");
    expect(chips()).toEqual(["role:role_lead", "person:usr_hana"]);

    await userEvent.type(within(dialog).getByTestId("calendar-meeting-form-title"), "合同定例");
    await userEvent.click(within(dialog).getByTestId("calendar-meeting-form-submit"));
    expect(api.createMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ targets: [{ kind: "role", id: "role_lead" }, { kind: "person", id: "usr_hana" }], targetId: "role_lead" }),
    );
  });

  it("no chip left is a form error, and nothing is sent", async () => {
    const api = fakeApi();
    render(wrap(<CalendarScreen />, api, EDIT));
    const dialog = await openMeetingTab();
    await userEvent.type(within(dialog).getByTestId("calendar-meeting-form-title"), "x");
    await userEvent.click(within(dialog).getByTestId("calendar-meeting-form-target"));
    await userEvent.keyboard("{Backspace}");
    await userEvent.click(within(dialog).getByTestId("calendar-meeting-form-submit"));
    expect(await within(dialog).findByText("対象を1つ以上追加してください")).toBeInTheDocument();
    expect(api.createMeeting).not.toHaveBeenCalled();
  });
});

describe("予定の作成で繰り返し", () => {
  it("a repeating 予定 hands what was typed to the meeting form, which registers it", async () => {
    const api = fakeApi();
    render(wrap(<CalendarScreen />, api, EDIT));
    await waitFor(() => expect(chipsOf("mtg_all").length).toBeGreaterThan(0));
    await userEvent.click(screen.getByTestId("calendar-create"));
    const panel = await screen.findByTestId("calendar-create-panel");
    await userEvent.type(within(panel).getByTestId("calendar-form-title"), "統括定例 Meeting");
    await userEvent.selectOptions(within(panel).getByTestId("calendar-form-start-time"), "19:00");
    await userEvent.selectOptions(within(panel).getByTestId("calendar-form-end-time"), "20:00");
    expect(within(panel).getByTestId("calendar-form-save")).toHaveTextContent("保存");
    await userEvent.selectOptions(within(panel).getByTestId("calendar-form-repeat"), "weekly");
    expect(within(panel).getByTestId("calendar-form-repeat-note")).toHaveTextContent("定例ミーティング");
    await userEvent.click(within(panel).getByTestId("calendar-form-save"));

    expect(api.createTask).not.toHaveBeenCalled();
    const dialog = await screen.findByTestId("calendar-meeting-form");
    expect(within(dialog).getByTestId("calendar-meeting-form-title")).toHaveValue("統括定例 Meeting");
    expect(within(dialog).getByTestId("calendar-meeting-form-time")).toHaveValue("19:00");
    expect(within(dialog).getByTestId("calendar-meeting-form-duration")).toHaveValue("60");
    expect(within(dialog).getByTestId("calendar-meeting-form-recurrence")).toHaveValue("weekly");
    await pickOnlyTarget(dialog, "統括");
    await userEvent.click(within(dialog).getByTestId("calendar-meeting-form-submit"));
    expect(api.createMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ title: "統括定例 Meeting", targetId: "role_lead", durationMinutes: 60, recurrence: "weekly" }),
    );
  });

  it("繰り返さない stays a plain 予定; no 繰り返し without meetings_edit", async () => {
    const api = fakeApi({ createTask: vi.fn(() => new Promise<never>(() => undefined)) });
    const { unmount } = render(wrap(<CalendarScreen />, api, EDIT));
    await waitFor(() => expect(chipsOf("mtg_all").length).toBeGreaterThan(0));
    await userEvent.click(screen.getByTestId("calendar-create"));
    const panel = await screen.findByTestId("calendar-create-panel");
    await userEvent.type(within(panel).getByTestId("calendar-form-title"), "単発");
    await userEvent.click(within(panel).getByTestId("calendar-form-save"));
    await waitFor(() => expect(api.createTask).toHaveBeenCalled());
    expect(screen.queryByTestId("calendar-meeting-form")).not.toBeInTheDocument();
    unmount();

    render(wrap(<CalendarScreen />, fakeApi(), VIEW));
    await userEvent.click(await screen.findByTestId("calendar-create"));
    await screen.findByTestId("calendar-create-panel");
    expect(screen.queryByTestId("calendar-form-repeat")).not.toBeInTheDocument();
  });
});

describe("ミーティングの入口を1つに (#884)", () => {
  const FIELDS = ["title", "date", "time", "duration", "recurrence", "until", "target", "description", "track", "hint", "submit"];

  it("there is no 「ミーティングを設定」 button: 作成 → ミーティング tab is the only entry, with every meeting field", async () => {
    render(wrap(<CalendarScreen />, fakeApi(), EDIT));
    const form = await openMeetingTab();
    expect(screen.queryByTestId("calendar-meetings-create")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ミーティングを設定" })).not.toBeInTheDocument();
    const panel = screen.getByTestId("calendar-create-panel");
    expect(within(panel).getByRole("tab", { name: /ミーティング/ })).toHaveAttribute("aria-selected", "true");
    for (const f of FIELDS) expect(within(form).getByTestId(`calendar-meeting-form-${f}`)).toBeInTheDocument();
    // The former dialog's title, labels (in its order), help texts and placeholder.
    expect(within(panel).getByText("定例ミーティングを設定")).toBeInTheDocument();
    const labels = Array.from(form.querySelectorAll("label"))
      .map((l) => l.textContent?.replace(/[*＊]/g, "").trim())
      .filter((t) => t && ["タイトル", "対象", "日付", "開始時刻", "所要時間", "繰り返し", "終了日（任意）", "メモ", "出席"].includes(t));
    expect(labels).toEqual(["タイトル", "対象", "日付", "開始時刻", "所要時間", "繰り返し", "終了日（任意）", "メモ", "出席"]);
    expect(within(form).getByText("全体・ロール・メンバーを入力して追加できます（複数可）。どれかに含まれる人を全員招待します")).toBeInTheDocument();
    expect(within(form).getByText("空欄なら終了しません")).toBeInTheDocument();
    expect(within(form).getByText("Google カレンダーの予定の説明欄に入ります")).toBeInTheDocument();
    expect(within(form).getByTestId("calendar-meeting-form-title")).toHaveAttribute("placeholder", "例: 全体定例");
    expect(within(form).getByTestId("calendar-meeting-form-track")).not.toBeChecked();
    // One dialog only: no second meeting dialog alongside.
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("the 作成 dialog's ミーティング tab is the same form and registers a meeting (not a 予定)", async () => {
    const api = fakeApi();
    render(wrap(<CalendarScreen />, api, EDIT));
    await waitFor(() => expect(chipsOf("mtg_all").length).toBeGreaterThan(0));
    await userEvent.click(screen.getByTestId("calendar-create"));
    const panel = await screen.findByTestId("calendar-create-panel");
    await userEvent.type(within(panel).getByTestId("calendar-form-title"), "打ち合わせ");
    await userEvent.click(within(panel).getByRole("tab", { name: /ミーティング/ }));
    const form = within(panel).getByTestId("calendar-meeting-form");
    for (const f of FIELDS) expect(within(form).getByTestId(`calendar-meeting-form-${f}`)).toBeInTheDocument();
    // The typed title carries over; the rest starts from the old 「ミーティングを設定」 defaults.
    expect(within(form).getByTestId("calendar-meeting-form-title")).toHaveValue("打ち合わせ");
    expect(within(form).getByTestId("calendar-meeting-form-time")).toHaveValue("21:00");
    expect(within(form).getByTestId("calendar-meeting-form-duration")).toHaveValue("60");
    expect(within(form).getByTestId("calendar-meeting-form-recurrence")).toHaveValue("weekly");
    await userEvent.click(within(form).getByTestId("calendar-meeting-form-submit"));
    await waitFor(() => expect(api.createMeeting).toHaveBeenCalledTimes(1));
    expect(api.createTask).not.toHaveBeenCalled();
    expect(api.createMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ title: "打ち合わせ", durationMinutes: 60, recurrence: "weekly", until: null, targets: [{ kind: "all", id: "all" }] }),
    );

    // Back to 予定 keeps the plain 予定 form in the same dialog.
    await userEvent.click(screen.getByTestId("calendar-create"));
    const again = await screen.findByTestId("calendar-create-panel");
    await userEvent.click(within(again).getByRole("tab", { name: /ミーティング/ }));
    await userEvent.click(within(again).getByRole("tab", { name: /^予定/ }));
    expect(within(again).getByTestId("calendar-event-form")).toBeInTheDocument();
    expect(within(again).queryByTestId("calendar-meeting-form")).not.toBeInTheDocument();
  });

  it("sends exactly the old 「ミーティングを設定」 payload, recurrence and until untouched", async () => {
    const api = fakeApi();
    render(wrap(<CalendarScreen />, api, EDIT));
    const form = await openMeetingTab();
    // The old dialog's defaults: 全体, 21:00, 60 min, 毎週.
    expect(within(form).getByTestId("calendar-meeting-form-time")).toHaveValue("21:00");
    expect(within(form).getByTestId("calendar-meeting-form-duration")).toHaveValue("60");
    expect(within(form).getByTestId("calendar-meeting-form-recurrence")).toHaveValue("weekly");
    await userEvent.type(within(form).getByTestId("calendar-meeting-form-title"), "  全体定例  ");
    fireEvent.change(within(form).getByTestId("calendar-meeting-form-date"), { target: { value: "2026-12-03" } });
    await userEvent.selectOptions(within(form).getByTestId("calendar-meeting-form-recurrence"), "biweekly");
    fireEvent.change(within(form).getByTestId("calendar-meeting-form-until"), { target: { value: "2027-03-31" } });
    await userEvent.type(within(form).getByTestId("calendar-meeting-form-description"), "議題");
    await userEvent.click(within(form).getByText("全体定例として出席を取る"));
    await userEvent.click(within(form).getByTestId("calendar-meeting-form-submit"));
    expect(api.createMeeting).toHaveBeenCalledWith({
      title: "全体定例",
      description: "議題",
      targets: [{ kind: "all", id: "all" }],
      targetId: "all",
      startsAt: "2026-12-03T12:00:00.000Z",
      durationMinutes: 60,
      recurrence: "biweekly",
      until: "2027-03-31",
      trackAttendance: true,
    });
  });

  it("編集 opens the same form prefilled and saves through updateMeeting", async () => {
    const api = fakeApi({ updateMeeting: vi.fn(async (_id: string, b: meeting.UpdateMeetingRequest) => mtg({ ...(b as Partial<meeting.Meeting>) })) as CalendarApi["updateMeeting"] });
    render(wrap(<CalendarScreen />, api, EDIT));
    await waitFor(() => expect(chipsOf("mtg_all").length).toBeGreaterThan(0));
    await userEvent.click(chipsOf("mtg_all")[0]!);
    await userEvent.click(await screen.findByTestId("calendar-meeting-detail-edit"));
    const dialog = await screen.findByTestId("calendar-meeting-edit-dialog");
    const form = within(dialog).getByTestId("calendar-meeting-form");
    expect(within(form).getByTestId("calendar-meeting-form-title")).toHaveValue("全体定例");
    expect(within(form).getByTestId("calendar-meeting-form-recurrence")).toHaveValue("weekly");
    expect(within(form).getByTestId("calendar-meeting-form-submit")).toHaveTextContent("保存");
    expect(within(dialog).queryByTestId("calendar-kind-switch")).not.toBeInTheDocument();
    await userEvent.click(within(form).getByTestId("calendar-meeting-form-submit"));
    await waitFor(() => expect(api.updateMeeting).toHaveBeenCalledWith("mtg_all", expect.objectContaining({ title: "全体定例", recurrence: "weekly", until: null })));
    expect(api.createMeeting).not.toHaveBeenCalled();
  });

  it("meetings_edit without 予定 write: 作成 opens straight on the meeting form (as the former button did)", async () => {
    const api = fakeApi();
    render(wrap(<CalendarScreen />, api, EDIT, { canWrite: false, canDelete: false }));
    await waitFor(() => expect(chipsOf("mtg_all").length).toBeGreaterThan(0));
    await userEvent.click(screen.getByTestId("calendar-create"));
    const panel = await screen.findByTestId("calendar-create-panel");
    const form = within(panel).getByTestId("calendar-meeting-form");
    expect(within(panel).queryByTestId("calendar-kind-switch")).not.toBeInTheDocument();
    expect(within(form).getByTestId("calendar-meeting-form-time")).toHaveValue("21:00");
    await userEvent.type(within(form).getByTestId("calendar-meeting-form-title"), "全体定例");
    await userEvent.click(within(form).getByTestId("calendar-meeting-form-submit"));
    await waitFor(() => expect(api.createMeeting).toHaveBeenCalledTimes(1));
  });

  it("without meetings_edit the ミーティング tab stays a plain 予定 (they never had 「ミーティングを設定」)", async () => {
    render(wrap(<CalendarScreen />, fakeApi(), VIEW));
    await userEvent.click(await screen.findByTestId("calendar-create"));
    const panel = await screen.findByTestId("calendar-create-panel");
    await userEvent.click(within(panel).getByRole("tab", { name: /ミーティング/ }));
    expect(within(panel).getByTestId("calendar-event-form")).toBeInTheDocument();
    expect(within(panel).queryByTestId("calendar-meeting-form")).not.toBeInTheDocument();
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

  it("a meeting I created for a role I am not in still shows by default", async () => {
    const mine = mtg({ id: "mtg_mine", title: "統括外の会", targetId: "role_member", targetName: "member" });
    render(wrap(<CalendarScreen />, fakeApi({ listMeetings: vi.fn(async () => ({ items: [mine], account: { email: "hackit.dub@gmail.com", calendarReady: true } })) }), VIEW));
    await waitFor(() => expect(chipsOf("mtg_mine").length).toBeGreaterThan(0));
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
