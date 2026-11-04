// 人事 → 出席 のテスト。
//   (1) demo transport が /meetings/attendance・/join・/me/regulars・PUT に契約どおり応答する
//   (2) 画面: メンバー別の出席率 (低い順) / 定例ごとの回と出欠 / 種類の絞り込み / 空の状態
//   (3) 編集者はその場で直せる (楽観的・失敗で戻る)、閲覧者はバッジだけ
//   (4) applyAttendance: 修正を重ねて率を数え直す
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { identity, meeting } from "@dub/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editorPermissions, FakeAuthProvider, viewerPermissions } from "../../auth/test-support.tsx";
import { createApiClient } from "../../lib/api-client.tsx";
import { createDemoFetch } from "../../lib/demo-seed.tsx";
import { createHrApi, type HrApi } from "./hrApi.tsx";
import { HrApiProvider } from "./HrProvider.tsx";
import { HrAttendanceScreen, periodRange } from "./HrAttendanceScreen.tsx";
import { applyAttendance } from "./hrHooks.ts";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), useRouter: () => null }));

const EDITOR = editorPermissions("hr", ["hr:read", "hr:write"]);
const VIEWER = viewerPermissions("hr", ["hr:read"]);

const rec = (userId: string, status: meeting.AttendanceStatus, source: meeting.AttendanceSource = "join"): meeting.AttendanceRecord => ({
  userId,
  status,
  source,
  joinedAt: source === "join" ? "2026-10-12T12:01:00Z" : null,
  recordedBy: userId,
  updatedAt: "2026-10-12T12:01:00Z",
});

function report(): meeting.AttendanceReportResponse {
  return {
    from: "2026-08-11",
    to: "2026-11-02",
    meetings: [
      {
        id: "mtg_all",
        title: "全体定例",
        targetId: "all",
        targetName: "全体",
        kind: "all_hands",
        durationMinutes: 60,
        recurrence: "weekly",
        expectedUserIds: ["u_a", "u_b", "u_c"],
        occurrences: [
          { date: "2026-10-19", startsAt: "2026-10-19T12:00:00Z", records: [rec("u_a", "present"), rec("u_b", "excused", "manual")] },
          { date: "2026-10-12", startsAt: "2026-10-12T12:00:00Z", records: [rec("u_a", "present"), rec("u_c", "present")] },
        ],
      },
      {
        id: "mtg_dev",
        title: "開発定例",
        targetId: "role_dev",
        targetName: "開発",
        kind: "team",
        durationMinutes: 30,
        recurrence: "weekly",
        expectedUserIds: ["u_a", "u_b"],
        occurrences: [{ date: "2026-10-21", startsAt: "2026-10-21T11:00:00Z", records: [] }],
      },
    ],
    members: [
      { userId: "u_b", name: "Bさん", email: "b@x", expected: 3, present: 0, excused: 1, rate: 0 },
      { userId: "u_c", name: "Cさん", email: "c@x", expected: 2, present: 1, excused: 0, rate: 0.5 },
      { userId: "u_a", name: "Aさん", email: "a@x", expected: 3, present: 2, excused: 0, rate: 2 / 3 },
    ],
  };
}

function fakeApi(over: Partial<HrApi> = {}): HrApi {
  const unused = () => Promise.reject(new Error("unused"));
  return {
    list: unused, get: unused, create: unused, update: unused, moveStage: unused, addNote: unused, join: unused, remove: unused,
    onboarding: unused, setCheck: unused, teams: () => Promise.resolve({ teams: [] }),
    attendance: () => Promise.resolve(report()),
    setAttendance: vi.fn(async (_m, _d, userId, status) => ({ record: status ? { ...rec(userId, status, "manual"), recordedBy: "usr_hr" } : null })),
    ...over,
  };
}

function renderWith(api: HrApi, permissions: readonly identity.PermissionKey[] = EDITOR): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <FakeAuthProvider permissions={permissions}>
          <HrApiProvider value={api}>
            <HrAttendanceScreen />
          </HrApiProvider>
        </FakeAuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const memberOrder = () =>
  within(screen.getByTestId("fe2-hr-att-member-table"))
    .queryAllByTestId(/^fe2-hr-att-rate-/)
    .map((el) => el.getAttribute("data-testid")!.replace("fe2-hr-att-rate-", ""));

describe("demo transport (定例の出席)", () => {
  beforeEach(() => sessionStorage.clear());

  it("serves the report, records a member's join of the open 定例, and takes corrections", async () => {
    const fetchImpl = createDemoFetch();
    const api = createApiClient({ baseUrl: "https://demo.local", fetchImpl });
    const hrApi = createHrApi(api);
    const r = await hrApi.attendance(periodRange("12w"));
    expect(r.meetings.map((m) => m.id).sort()).toEqual(["mtg_all", "mtg_lead", "mtg_member_now"]);
    expect(r.meetings.find((m) => m.id === "mtg_all")!.occurrences.length).toBeGreaterThan(0);
    expect(r.members.length).toBeGreaterThan(0);

    localStorage.setItem("dub_demo_account", "usr_member");
    try {
      const mine = await api.request<meeting.ListMyRegularMeetingsResponse>({ method: "GET", path: "/api/v1/meetings/me/regulars" });
      expect(mine.items[0]).toMatchObject({ id: "mtg_member_now", joinOpen: true, attended: false });
      const joined = await api.request<meeting.JoinMeetingResponse>({ method: "POST", path: "/api/v1/meetings/mtg_member_now/join" });
      expect(joined.recordedFor).not.toBeNull();
      const again = await api.request<meeting.ListMyRegularMeetingsResponse>({ method: "GET", path: "/api/v1/meetings/me/regulars" });
      expect(again.items[0]!.attended).toBe(true);
      await expect(api.request({ method: "POST", path: "/api/v1/meetings/mtg_lead/join" })).rejects.toMatchObject({ status: 403 });
    } finally {
      localStorage.removeItem("dub_demo_account");
    }

    const date = joinedDate(await hrApi.attendance(periodRange("4w")));
    const set = await hrApi.setAttendance("mtg_member_now", date, "usr_carol", "excused");
    expect(set.record).toMatchObject({ status: "excused", source: "manual" });
    expect((await hrApi.setAttendance("mtg_member_now", date, "usr_carol", null)).record).toBeNull();
  });
});

function joinedDate(r: meeting.AttendanceReportResponse): string {
  return r.meetings.find((m) => m.id === "mtg_member_now")!.occurrences[0]!.date;
}

describe("HrAttendanceScreen", () => {
  afterEach(() => vi.useRealTimers());

  it("shows member rates lowest first and each 定例's latest occurrence", async () => {
    renderWith(fakeApi());
    await screen.findByTestId("fe2-hr-att-member-table");
    expect(memberOrder()).toEqual(["u_b", "u_c", "u_a"]);
    expect(screen.getByTestId("fe2-hr-att-rate-u_a").textContent).toBe("67%");
    expect(screen.getByTestId("fe2-hr-att-count-mtg_all").textContent).toBe("出席 1 / 3 人");
    expect((screen.getByTestId("fe2-hr-att-set-mtg_all-u_b") as HTMLSelectElement).value).toBe("excused");
    // An older occurrence.
    fireEvent.change(screen.getByTestId("fe2-hr-att-occ-mtg_all"), { target: { value: "2026-10-12" } });
    expect(screen.getByTestId("fe2-hr-att-count-mtg_all").textContent).toBe("出席 2 / 3 人");
  });

  it("the kind filter recounts the rates for that kind only", async () => {
    renderWith(fakeApi());
    await screen.findByTestId("fe2-hr-att-member-table");
    fireEvent.click(screen.getByRole("tab", { name: "チーム定例" }));
    expect(screen.queryByTestId("fe2-hr-att-meeting-mtg_all")).toBeNull();
    expect(memberOrder()).toEqual(["u_a", "u_b"]); // both 0% on 開発定例 → by name
    expect(screen.getByTestId("fe2-hr-att-rate-u_a").textContent).toBe("0%");
  });

  it("an editor corrects attendance optimistically", async () => {
    let resolve!: (v: meeting.SetAttendanceResponse) => void;
    const setAttendance = vi.fn(() => new Promise<meeting.SetAttendanceResponse>((r) => (resolve = r)));
    renderWith(fakeApi({ setAttendance }));
    await screen.findByTestId("fe2-hr-att-member-table");
    fireEvent.change(screen.getByTestId("fe2-hr-att-set-mtg_all-u_c"), { target: { value: "present" } });
    await waitFor(() => expect(screen.getByTestId("fe2-hr-att-count-mtg_all").textContent).toBe("出席 2 / 3 人"));
    expect(setAttendance).toHaveBeenCalledWith("mtg_all", "2026-10-19", "u_c", "present");
    expect(screen.getByTestId("fe2-hr-att-rate-u_c").textContent).toBe("100%");
    await act(async () => resolve({ record: rec("u_c", "present", "manual") }));
    expect(screen.getByTestId("fe2-hr-att-count-mtg_all").textContent).toBe("出席 2 / 3 人");
  });

  it("a failed correction rolls back", async () => {
    renderWith(fakeApi({ setAttendance: () => Promise.reject(new Error("boom")) }));
    await screen.findByTestId("fe2-hr-att-member-table");
    fireEvent.change(screen.getByTestId("fe2-hr-att-set-mtg_all-u_a"), { target: { value: "absent" } });
    await waitFor(() => expect(screen.getByTestId("fe2-hr-att-count-mtg_all").textContent).toBe("出席 1 / 3 人"));
    expect((screen.getByTestId("fe2-hr-att-set-mtg_all-u_a") as HTMLSelectElement).value).toBe("present");
  });

  it("a viewer sees badges, no selects", async () => {
    renderWith(fakeApi(), VIEWER);
    await screen.findByTestId("fe2-hr-att-member-table");
    expect(screen.queryByTestId("fe2-hr-att-set-mtg_all-u_a")).toBeNull();
    expect(within(screen.getByTestId("fe2-hr-att-mtg_all-u_b")).getByText("欠席連絡")).toBeTruthy();
  });

  it("no 定例 → explains how to turn attendance on", async () => {
    renderWith(fakeApi({ attendance: () => Promise.resolve({ from: "x", to: "y", meetings: [], members: [] }) }));
    expect((await screen.findByTestId("fe2-hr-att-empty")).textContent).toContain("出席を取る");
  });
});

describe("applyAttendance", () => {
  it("replaces the member's record on that occurrence and recounts the rate", () => {
    const next = applyAttendance(report(), { meetingId: "mtg_all", date: "2026-10-19", userId: "u_b", status: "present" }, rec("u_b", "present", "manual"));
    expect(next.meetings[0]!.occurrences[0]!.records.filter((r) => r.userId === "u_b")).toHaveLength(1);
    expect(next.members.find((m) => m.userId === "u_b")).toMatchObject({ present: 1, excused: 0, rate: 1 / 3 });
    const cleared = applyAttendance(next, { meetingId: "mtg_all", date: "2026-10-19", userId: "u_b", status: null }, null);
    expect(cleared.members.find((m) => m.userId === "u_b")).toMatchObject({ present: 0, rate: 0 });
  });
});
