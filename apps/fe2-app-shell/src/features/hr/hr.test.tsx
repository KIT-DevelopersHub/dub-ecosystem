// 人事アプリのテスト。
//   (1) demo transport が /members/hr/* の契約に応答する (REAL api-client 経由): 全ステータスの seed・
//       寛容な遷移と /join 必須・採用で名簿に在籍が増える・チェックでステータスが自動で進む
//   (2) 表: 全員表示 / 絞り込みと件数 (オンボーディング前 含む) / 並べ替え / 検索 / その場でステータス変更
//       (楽観的・失敗で戻る) / 採用は確認ダイアログ経由 / 閲覧者はプルダウンなし
//   (3) オンボーディング: チェックが一瞬も外れない (押した値を即座に表示) / 進捗バーが埋まる
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { hr, identity } from "@dub/types";
import { describe, expect, it, vi } from "vitest";
import { editorPermissions, FakeAuthProvider, viewerPermissions } from "../../auth/test-support.tsx";
import { createApiClient } from "../../lib/api-client.tsx";
import { createDemoFetch } from "../../lib/demo-seed.tsx";
import { createHrApi, type HrApi } from "./hrApi.tsx";
import { HrApiProvider } from "./HrProvider.tsx";
import { HrApplicantsScreen } from "./HrApplicantsScreen.tsx";
import { HrOnboardingScreen } from "./HrOnboardingScreen.tsx";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), useRouter: () => null }));

const EDITOR = editorPermissions("hr", ["hr:read", "hr:write", "hr:admin"]);
const VIEWER = viewerPermissions("hr", ["hr:read"]);

function demoApi(fetchImpl = createDemoFetch()): HrApi {
  return createHrApi(createApiClient({ baseUrl: "https://demo.local", fetchImpl }));
}

function applicant(over: Partial<hr.ApplicantListItem> = {}): hr.ApplicantListItem {
  return {
    id: "app_1", name: "青木 陽向", nameKana: "あおき ひなた", email: null, department: "情報工学科", grade: "1年", desiredTeamId: null,
    source: null, motivation: null, interviewAt: null, stage: "scheduling", memberId: null, participationId: null, version: 1,
    createdBy: "usr_1", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", latestNote: null, ...over,
  };
}

const ROWS: hr.ApplicantListItem[] = [
  applicant(),
  applicant({ id: "app_2", name: "井上 さくら", nameKana: "いのうえ さくら", stage: "interview_set", latestNote: "Meet で確定", updatedAt: "2026-10-03T00:00:00Z" }),
  applicant({ id: "app_3", name: "小林 葵", nameKana: "こばやし あおい", stage: "hired", memberId: "m1", updatedAt: "2026-10-02T00:00:00Z" }),
  applicant({ id: "app_4", name: "佐野 陸", nameKana: "さの りく", stage: "onboarding", memberId: "m2", updatedAt: "2026-10-04T00:00:00Z" }),
  applicant({ id: "app_5", name: "高橋 美咲", nameKana: "たかはし みさき", stage: "onboarded", memberId: "m3" }),
];

function fakeApi(overrides: Partial<HrApi> = {}): HrApi {
  const unused = () => Promise.reject(new Error("unused"));
  return {
    list: () => Promise.resolve({ applicants: ROWS.map((r) => ({ ...r })) }),
    get: unused,
    create: unused,
    update: unused,
    moveStage: unused,
    addNote: unused,
    join: unused,
    remove: unused,
    onboarding: unused,
    setCheck: unused,
    teams: () => Promise.resolve({ teams: [] }),
    ...overrides,
  };
}

function renderWith(node: JSX.Element, api: HrApi, permissions: readonly identity.PermissionKey[] = EDITOR): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <FakeAuthProvider permissions={permissions}>
          <HrApiProvider value={api}>{node}</HrApiProvider>
        </FakeAuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const countOf = (id: string) => screen.getByTestId(`fe2-hr-filter-${id}-count`).textContent;
const rowNames = () => screen.queryAllByTestId(/^fe2-hr-row-app_\d+$/).map((el) => el.textContent);
const statusSelect = (id: string) => screen.getByTestId(`fe2-hr-row-${id}-status`) as HTMLSelectElement;

describe("demo transport (人事)", () => {
  it("seeds every status and enforces the rules (permissive, /join required for roster statuses)", async () => {
    const api = demoApi();
    const { applicants } = await api.list();
    expect(new Set(applicants.map((a) => a.stage))).toEqual(
      new Set(["scheduling", "interview_set", "interviewed", "hired", "rejected", "onboarding", "onboarded", "withdrawn"]),
    );
    const first = applicants.find((a) => a.stage === "scheduling" && a.memberId === null)!;
    await expect(api.moveStage(first.id, { stage: "hired", expectedVersion: first.version })).rejects.toMatchObject({ status: 409 });
    const moved = await api.moveStage(first.id, { stage: "interviewed", expectedVersion: first.version });
    const back = await api.moveStage(first.id, { stage: "scheduling", expectedVersion: moved.applicant.version });
    expect(back.events.at(-1)).toMatchObject({ kind: "stage", fromStage: "interviewed", toStage: "scheduling" });
  });

  it("採用 adds a 在籍 roster member; checking every onboarding item → オンボーディング完了", async () => {
    const fetchImpl = createDemoFetch();
    const api = demoApi(fetchImpl);
    const target = (await api.list()).applicants.find((a) => a.stage === "interviewed")!;
    const res = await api.join(target.id, { expectedVersion: target.version });
    expect(res.applicant.stage).toBe("hired");
    const overview = (await (await fetchImpl("https://demo.local/api/v1/members/overview")).json()) as {
      members: Array<{ id: string; status: string; name: string }>;
    };
    expect(overview.members.find((m) => m.id === res.memberId)).toMatchObject({ name: target.name, status: "added" });

    const ob = await api.onboarding();
    let p = ob.members.find((m) => m.memberId === res.memberId)!;
    expect(p).toMatchObject({ done: 0, stage: "hired" });
    for (const it of ob.items) p = await api.setCheck(res.memberId, it.id, true);
    expect(p).toMatchObject({ completed: true, stage: "onboarded" });
    expect((await api.get(target.id)).applicant.stage).toBe("onboarded");
  });
});

describe("HrApplicantsScreen (表)", () => {
  it("lists everyone with filter counts, and each filter narrows the rows", async () => {
    renderWith(<HrApplicantsScreen />, fakeApi());
    await screen.findByTestId("fe2-hr-row-app_1");
    expect(rowNames()).toHaveLength(5);
    expect(countOf("all")).toBe("5");
    expect(countOf("before_onboarding")).toBe("2");
    expect(countOf("scheduling")).toBe("1");
    expect(countOf("withdrawn")).toBe("0");

    fireEvent.click(screen.getByTestId("fe2-hr-filter-before_onboarding"));
    expect(rowNames().sort()).toEqual(["佐野 陸", "小林 葵"].sort());
    fireEvent.click(screen.getByTestId("fe2-hr-filter-onboarded"));
    expect(rowNames()).toEqual(["高橋 美咲"]);
    fireEvent.click(screen.getByTestId("fe2-hr-filter-all"));
    expect(rowNames()).toHaveLength(5);
  });

  it("uses the shared FilterBar: one status at a time, クリア returns to すべて", async () => {
    renderWith(<HrApplicantsScreen />, fakeApi());
    await screen.findByTestId("fe2-hr-row-app_1");
    expect(screen.getByTestId("fe2-hr-filter-all")).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByTestId("fe2-hr-filter-clear")).toBeNull();
    fireEvent.click(screen.getByTestId("fe2-hr-filter-onboarded"));
    expect(screen.getByTestId("fe2-hr-filter-onboarded")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("fe2-hr-filter-all")).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByTestId("fe2-hr-filter-clear"));
    expect(screen.getByTestId("fe2-hr-filter-all")).toHaveAttribute("aria-checked", "true");
    expect(rowNames()).toHaveLength(5);
  });

  it("sorts by a column and searches by name / kana", async () => {
    renderWith(<HrApplicantsScreen />, fakeApi());
    await screen.findByTestId("fe2-hr-row-app_1");
    // 既定 = 更新日の新しい順。
    expect(rowNames()[0]).toBe("佐野 陸");
    fireEvent.click(within(screen.getByTestId("fe2-hr-table")).getByRole("button", { name: /氏名/ }));
    expect(rowNames()[0]).toBe("青木 陽向"); // あおき が先頭 (昇順)
    fireEvent.change(screen.getByTestId("fe2-hr-search"), { target: { value: "こばやし" } });
    expect(rowNames()).toEqual(["小林 葵"]);
  });

  it("changes status inline optimistically (no flicker) and rolls back on failure", async () => {
    let resolve!: (d: hr.ApplicantDetail) => void;
    const moveStage = vi.fn(() => new Promise<hr.ApplicantDetail>((r) => (resolve = r)));
    renderWith(<HrApplicantsScreen />, fakeApi({ moveStage }));
    await screen.findByTestId("fe2-hr-row-app_1");
    fireEvent.change(statusSelect("app_1"), { target: { value: "interview_set" } });
    // 応答前・同じ描画でもう新しい値。
    expect(statusSelect("app_1").value).toBe("interview_set");
    await waitFor(() => expect(moveStage).toHaveBeenCalledWith("app_1", { stage: "interview_set", expectedVersion: 1 }));
    expect(statusSelect("app_1").value).toBe("interview_set");
    await act(async () => resolve({ applicant: applicant({ stage: "interview_set", version: 2 }), events: [] }));
    expect(statusSelect("app_1").value).toBe("interview_set");
  });

  it("rolls the status back when the move fails", async () => {
    const moveStage = vi.fn(() => Promise.reject(new Error("boom")));
    renderWith(<HrApplicantsScreen />, fakeApi({ moveStage }));
    await screen.findByTestId("fe2-hr-row-app_1");
    fireEvent.change(statusSelect("app_1"), { target: { value: "rejected" } });
    await waitFor(() => expect(moveStage).toHaveBeenCalled());
    await waitFor(() => expect(statusSelect("app_1").value).toBe("scheduling"));
  });

  it("採用 for a non-member goes through the confirm dialog (→ 名簿に追加), not silently", async () => {
    const join = vi.fn(() => Promise.resolve<hr.JoinApplicantResponse>({ applicant: applicant({ stage: "hired", memberId: "m9", version: 2 }), memberId: "m9" }));
    const moveStage = vi.fn();
    renderWith(<HrApplicantsScreen />, fakeApi({ join, moveStage: moveStage as unknown as HrApi["moveStage"] }));
    await screen.findByTestId("fe2-hr-row-app_1");
    fireEvent.change(statusSelect("app_1"), { target: { value: "hired" } });
    expect(join).not.toHaveBeenCalled();
    const dialog = await screen.findByTestId("fe2-hr-join-confirm");
    fireEvent.click(within(dialog).getByRole("button", { name: "採用して名簿に追加" }));
    await waitFor(() => expect(join).toHaveBeenCalledWith("app_1", { expectedVersion: 1 }));
    expect(moveStage).not.toHaveBeenCalled();
  });

  it("a viewer sees badges instead of dropdowns and no register action", async () => {
    renderWith(<HrApplicantsScreen />, fakeApi(), VIEWER);
    await screen.findByTestId("fe2-hr-row-app_1");
    expect(screen.queryByTestId("fe2-hr-row-app_1-status")).toBeNull();
    expect(screen.queryByTestId("fe2-hr-new")).toBeNull();
  });
});

describe("HrOnboardingScreen", () => {
  const onboarding = (checked: string[]) => () =>
    Promise.resolve<hr.ListOnboardingProgressResponse>({
      items: [
        { id: "i1", title: "Slack に参加", description: null, url: null },
        { id: "i2", title: "アイコン設定", description: null, url: null },
      ],
      members: [
        {
          memberId: "m1", name: "小林 葵", applicantId: "app_7", stage: checked.length === 2 ? "onboarded" : "onboarding", joinedAt: null,
          checkedItemIds: checked, total: 2, done: checked.length, completed: checked.length === 2,
        },
      ],
    });

  it("shows the checked state immediately (no revert) and fills the progress bar when complete", async () => {
    let resolve!: (p: hr.OnboardingProgress) => void;
    const setCheck = vi.fn(() => new Promise<hr.OnboardingProgress>((r) => (resolve = r)));
    renderWith(<HrOnboardingScreen />, fakeApi({ onboarding: onboarding(["i1"]), setCheck }));
    const box = (await screen.findByTestId("fe2-hr-ob-m1-i2")) as HTMLInputElement;
    expect(screen.getByTestId("fe2-hr-ob-m1-progress").getAttribute("aria-valuenow")).toBe("50");
    fireEvent.click(box);
    // サーバ応答前・同じ描画でチェック済み＆バーが 100%。
    expect(box.checked).toBe(true);
    expect(screen.getByTestId("fe2-hr-ob-m1-progress").getAttribute("aria-valuenow")).toBe("100");
    expect(screen.getByTestId("fe2-hr-ob-m1-done")).toBeTruthy();
    await waitFor(() => expect(setCheck).toHaveBeenCalledWith("m1", "i2", true));
    expect(box.checked).toBe(true);
    await act(async () =>
      resolve({ memberId: "m1", name: "小林 葵", applicantId: "app_7", stage: "onboarded", joinedAt: null, checkedItemIds: ["i1", "i2"], total: 2, done: 2, completed: true }),
    );
    expect(box.checked).toBe(true);
    expect(screen.getByTestId("fe2-hr-stage-onboarded")).toBeTruthy();
  });

  it("a completed member renders a full progress bar", async () => {
    renderWith(<HrOnboardingScreen />, fakeApi({ onboarding: onboarding(["i1", "i2"]) }));
    const bar = await screen.findByTestId("fe2-hr-ob-m1-progress");
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("100%");
  });

  it("shows an empty state when nobody is onboarding", async () => {
    renderWith(<HrOnboardingScreen />, fakeApi({ onboarding: () => Promise.resolve({ items: [], members: [] }) }));
    expect(await screen.findByTestId("fe2-hr-onboarding-empty")).toBeTruthy();
  });
});
