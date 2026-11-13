// 人事 → 出席 のテスト (Meet 参加記録ベース)。
//   (1) demo transport: Meet 由来の出席・未確定の参加者 (候補つき)・ゲスト・確定の記憶・割合・
//       Dub からの参加・「Googleと連携」
//   (2) 画面: Meet の状態 (再連携が必要 / 今すぐ取り込む)・率 (低い順)・参加時間・未確定の確定 (楽観的)・
//       手修正と「自動」に戻す (楽観的・失敗で戻る)・閲覧者・空の状態
//   (3) applyAttendance / applyConfirm
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { identity, meeting } from "@dub/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { editorPermissions, FakeAuthProvider, viewerPermissions } from "../../auth/test-support.tsx";
import { createApiClient } from "../../lib/api-client.tsx";
import { createDemoFetch } from "../../lib/demo-seed.tsx";
import { createHrApi, type HrApi } from "./hrApi.tsx";
import { HrApiProvider } from "./HrProvider.tsx";
import { HrAttendanceScreen, periodRange, presenceLabel } from "./HrAttendanceScreen.tsx";
import { applyAttendance, applyConfirm } from "./hrHooks.ts";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), useRouter: () => null }));

const EDITOR = editorPermissions("hr", ["hr:read", "hr:write"]);
const VIEWER = viewerPermissions("hr", ["hr:read"]);

const presence = (min: number, start = "2026-10-19T12:00:00Z"): meeting.MeetPresence => ({
  firstJoin: start,
  lastLeave: new Date(Date.parse(start) + min * 60_000).toISOString(),
  durationSeconds: min * 60,
  approx: false,
});

function rec(userId: string, status: meeting.AttendanceStatus, source: meeting.AttendanceSource, meet: meeting.MeetPresence | null = null): meeting.AttendanceRecord {
  return { userId, status, source, joinedAt: null, meet, recordedBy: source === "manual" ? "usr_hr" : null, updatedAt: null };
}

function part(over: Partial<meeting.MeetParticipant>): meeting.MeetParticipant {
  return { key: "k", kind: "signed_in", displayName: "?", googleUserId: null, userId: null, suggestions: [], ...presence(50), ...over };
}

function report(): meeting.AttendanceReportResponse {
  return {
    from: "2026-08-11",
    to: "2026-11-02",
    settings: { minPercent: 50 },
    meetApi: { ready: true, lastRunAt: "2026-10-19T13:15:00Z" },
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
          {
            date: "2026-10-19",
            startsAt: "2026-10-19T12:00:00Z",
            records: [rec("u_a", "present", "meet_api", presence(56)), rec("u_b", "excused", "manual")],
            participants: [
              part({ key: "u:ga", googleUserId: "ga", userId: "u_a", displayName: "Aさん" }),
              part({ key: "u:gc", googleUserId: "gc", displayName: "Cさん本人", suggestions: [{ userId: "u_c", name: "Cさん" }], ...presence(45) }),
              part({ key: "anon", kind: "anonymous", displayName: "見学", ...presence(20) }),
            ],
            ingest: { status: "done", ingestedAt: "2026-10-19T13:15:00Z", error: null },
          },
          {
            date: "2026-10-12",
            startsAt: "2026-10-12T12:00:00Z",
            records: [rec("u_a", "present", "meet_api", presence(58, "2026-10-12T12:00:00Z")), rec("u_c", "present", "join")],
            participants: [],
            ingest: null,
          },
        ],
      },
    ],
    members: [
      { userId: "u_c", name: "Cさん", email: "c@x", expected: 2, present: 1, excused: 0, rate: 0.5 },
      { userId: "u_b", name: "Bさん", email: "b@x", expected: 2, present: 0, excused: 1, rate: 0 },
      { userId: "u_a", name: "Aさん", email: "a@x", expected: 2, present: 2, excused: 0, rate: 1 },
    ],
  };
}

function fakeApi(over: Partial<HrApi> = {}): HrApi {
  const unused = () => Promise.reject(new Error("unused"));
  return {
    list: unused, get: unused, create: unused, update: unused, moveStage: unused, addNote: unused, join: unused, remove: unused, registerResult: unused,
    onboarding: unused, setCheck: unused, teams: () => Promise.resolve({ teams: [] }), orgMembers: unused,
    attendance: () => Promise.resolve(report()),
    setAttendance: vi.fn(async (_m, _d, userId, status) => ({ record: status ? rec(userId, status, "manual") : null })),
    ingestAttendance: vi.fn(async () => ({ occurrences: 2, participants: 7, complete: true, skipped: null })),
    confirmParticipant: vi.fn(async () => ({ ok: true as const })),
    updateAttendanceSettings: vi.fn(async (b) => b),
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
const statusOf = (u: string) => screen.getByTestId(`fe2-hr-att-status-mtg_all-${u}`).textContent;

describe("demo transport (定例の出席 / Meet)", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.removeItem("dub_demo_account");
  });

  it("serves Meet attendance, an unmatched account with a suggestion, guests; confirming is remembered", async () => {
    const api = createApiClient({ baseUrl: "https://demo.local", fetchImpl: createDemoFetch() });
    const hrApi = createHrApi(api);
    let r = await hrApi.attendance(periodRange("4w"));
    expect(r.meetApi.ready).toBe(true);
    const all = r.meetings.find((m) => m.id === "mtg_all")!;
    const o = all.occurrences.find((x) => x.participants.some((p) => p.displayName === "佐藤太郎"))!;
    expect(o.ingest?.status).toBe("done");
    expect(o.records.some((x) => x.source === "meet_api" && x.meet)).toBe(true);
    const bob = o.participants.find((p) => p.displayName === "佐藤太郎")!;
    expect(o.participants.some((p) => p.kind === "anonymous")).toBe(true);
    {
      expect(bob).toMatchObject({ userId: null, suggestions: [{ userId: "usr_bob", name: "佐藤 太郎" }] });
      await hrApi.confirmParticipant(bob.googleUserId!, "usr_bob");
      r = await hrApi.attendance(periodRange("4w"));
      const again = r.meetings.find((m) => m.id === "mtg_all")!.occurrences.find((x) => x.date === o.date)!;
      expect(again.participants.find((p) => p.googleUserId === bob.googleUserId)!.userId).toBe("usr_bob");
      expect(again.records.find((x) => x.userId === "usr_bob")!.source).toBe("meet_api");
    }
    expect(await hrApi.updateAttendanceSettings({ minPercent: 80 })).toEqual({ minPercent: 80 });
    expect((await hrApi.attendance(periodRange("4w"))).settings.minPercent).toBe(80);
  });

  it("a member: joins the open 定例, then 「Googleと連携」 links them", async () => {
    localStorage.setItem("dub_demo_account", "usr_member");
    const api = createApiClient({ baseUrl: "https://demo.local", fetchImpl: createDemoFetch() });
    const mine = await api.request<meeting.ListMyRegularMeetingsResponse>({ method: "GET", path: "/api/v1/meetings/me/regulars" });
    expect(mine.googleLinked).toBe(false);
    expect(mine.items[0]).toMatchObject({ id: "mtg_member_now", joinOpen: true });
    const joined = await api.request<meeting.JoinMeetingResponse>({ method: "POST", path: "/api/v1/meetings/mtg_member_now/join" });
    expect(joined.recordedFor).not.toBeNull();
    const start = await api.request<meeting.StartGoogleLinkResponse>({ method: "POST", path: "/api/v1/meetings/me/google-link/start", body: { redirectUri: "x" } });
    const state = new URL(start.authUrl).searchParams.get("state")!;
    await api.request({ method: "POST", path: "/api/v1/meetings/me/google-link/callback", body: { code: "demo", state } });
    const after = await api.request<meeting.ListMyRegularMeetingsResponse>({ method: "GET", path: "/api/v1/meetings/me/regulars" });
    expect(after.googleLinked).toBe(true);
    expect(after.items[0]!.attended).toBe(true);
  });
});

describe("HrAttendanceScreen", () => {
  it("shows the Meet state, rates lowest first, and each member's status with Meet times", async () => {
    const api = fakeApi();
    renderWith(api);
    await screen.findByTestId("fe2-hr-att-member-table");
    expect(screen.getByTestId("fe2-hr-att-meet-ready").textContent).toContain("最終取り込み");
    expect(memberOrder()).toEqual(["u_b", "u_c", "u_a"]);
    expect(statusOf("u_a")).toBe("出席");
    expect(screen.getByTestId("fe2-hr-att-time-mtg_all-u_a").textContent).toBe("21:00–21:56・56分");
    expect(statusOf("u_c")).toBe("欠席");
    expect(screen.getByTestId("fe2-hr-att-ingest-mtg_all").textContent).toContain("取り込み済み");
    expect(screen.getByTestId("fe2-hr-att-guests-mtg_all").textContent).toContain("見学（20分）");
    fireEvent.click(screen.getByTestId("fe2-hr-att-ingest"));
    await waitFor(() => expect(api.ingestAttendance).toHaveBeenCalled());
  });

  it("without the Meet records scope: 再連携が必要 and no ingest", async () => {
    renderWith(fakeApi({ attendance: async () => ({ ...report(), meetApi: { ready: false, lastRunAt: null } }) }));
    expect((await screen.findByTestId("fe2-hr-att-meet-missing")).textContent).toContain("再連携が必要です");
    expect(screen.getByTestId("fe2-hr-att-ingest")).toBeDisabled();
  });

  it("confirming an unmatched participant (suggestion preselected) marks them by Meet time, optimistically", async () => {
    const api = fakeApi({ confirmParticipant: vi.fn(() => new Promise<{ ok: true }>(() => {})) });
    renderWith(api);
    await screen.findByTestId("fe2-hr-att-unmatched-mtg_all");
    expect((screen.getByTestId("fe2-hr-att-pick-mtg_all-gc") as HTMLSelectElement).value).toBe("u_c");
    fireEvent.click(screen.getByTestId("fe2-hr-att-confirm-mtg_all-gc"));
    await waitFor(() => expect(api.confirmParticipant).toHaveBeenCalledWith("gc", "u_c"));
    await waitFor(() => expect(statusOf("u_c")).toBe("出席")); // 45 min ≥ 50% of 60
    expect(screen.queryByTestId("fe2-hr-att-unmatched-mtg_all")).toBeNull();
    expect(screen.getByTestId("fe2-hr-att-rate-u_c").textContent).toBe("100%");
  });

  it("a manual correction wins; 自動 returns to the Meet result; a failure rolls back", async () => {
    const api = fakeApi();
    renderWith(api);
    await screen.findByTestId("fe2-hr-att-member-table");
    fireEvent.change(screen.getByTestId("fe2-hr-att-set-mtg_all-u_a"), { target: { value: "absent" } });
    await waitFor(() => expect(statusOf("u_a")).toBe("欠席"));
    expect(api.setAttendance).toHaveBeenCalledWith("mtg_all", "2026-10-19", "u_a", "absent");
    fireEvent.change(screen.getByTestId("fe2-hr-att-set-mtg_all-u_a"), { target: { value: "auto" } });
    await waitFor(() => expect(statusOf("u_a")).toBe("出席"));
    expect(api.setAttendance).toHaveBeenLastCalledWith("mtg_all", "2026-10-19", "u_a", null);
  });

  it("a failed correction rolls back", async () => {
    renderWith(fakeApi({ setAttendance: () => Promise.reject(new Error("boom")) }));
    await screen.findByTestId("fe2-hr-att-member-table");
    fireEvent.change(screen.getByTestId("fe2-hr-att-set-mtg_all-u_c"), { target: { value: "present" } });
    await waitFor(() => expect((screen.getByTestId("fe2-hr-att-set-mtg_all-u_c") as HTMLSelectElement).value).toBe("auto"));
    expect(statusOf("u_c")).toBe("欠席");
  });

  it("the threshold setting is sent", async () => {
    const api = fakeApi();
    renderWith(api);
    await screen.findByTestId("fe2-hr-att-member-table");
    fireEvent.change(screen.getByTestId("fe2-hr-att-min-percent"), { target: { value: "80" } });
    await waitFor(() => expect(api.updateAttendanceSettings).toHaveBeenCalledWith({ minPercent: 80 }));
  });

  it("a viewer sees statuses and 未確定, no controls", async () => {
    renderWith(fakeApi(), VIEWER);
    await screen.findByTestId("fe2-hr-att-member-table");
    expect(screen.queryByTestId("fe2-hr-att-set-mtg_all-u_a")).toBeNull();
    expect(screen.queryByTestId("fe2-hr-att-ingest")).toBeNull();
    expect(within(screen.getByTestId("fe2-hr-att-unmatched-mtg_all")).getByText("未確定")).toBeTruthy();
  });

  it("no 定例 → explains how to turn attendance on", async () => {
    renderWith(fakeApi({ attendance: async () => ({ ...report(), meetings: [], members: [] }) }));
    expect((await screen.findByTestId("fe2-hr-att-empty")).textContent).toContain("出席を取る");
  });
});

describe("cache helpers", () => {
  it("applyAttendance: manual overrides, null recomputes the automatic record", () => {
    const v = { meetingId: "mtg_all", date: "2026-10-19", userId: "u_a" };
    const manual = applyAttendance(report(), { ...v, status: "absent" });
    expect(manual.meetings[0]!.occurrences[0]!.records.find((r) => r.userId === "u_a")).toMatchObject({ status: "absent", source: "manual", meet: { durationSeconds: 3360 } });
    expect(manual.members.find((m) => m.userId === "u_a")!.present).toBe(1);
    const auto = applyAttendance(manual, { ...v, status: null });
    expect(auto.meetings[0]!.occurrences[0]!.records.find((r) => r.userId === "u_a")).toMatchObject({ status: "present", source: "meet_api" });
  });

  it("applyConfirm matches the account and applies the threshold", () => {
    const r = applyConfirm({ ...report(), settings: { minPercent: 90 } }, "gc", "u_c");
    const o = r.meetings[0]!.occurrences[0]!;
    expect(o.participants.find((p) => p.googleUserId === "gc")!.userId).toBe("u_c");
    expect(o.records.find((x) => x.userId === "u_c")).toMatchObject({ status: "absent", source: "meet_api" }); // 45 < 54 min
  });

  it("presenceLabel", () => {
    expect(presenceLabel({ ...presence(30), approx: true })).toBe("21:00–21:30・約30分");
    expect(presenceLabel({ ...presence(30), lastLeave: null })).toBe("21:00–参加中・30分");
  });
});
