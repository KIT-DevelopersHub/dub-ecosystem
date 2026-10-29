// 人事アプリのテスト。
//   (1) demo transport が /members/hr/* の契約に応答する (REAL api-client 経由): 段階遷移の規則・
//       参加確定で名簿に在籍が増える・オンボーディングのチェック
//   (2) 画面: パイプラインの描画 / 「次へ」で楽観的に列移動・失敗でロールバック / 閲覧者は操作不可 /
//       オンボーディングのチェック
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { hr, identity } from "@dub/types";
import { describe, expect, it, vi } from "vitest";
import { editorPermissions, FakeAuthProvider, viewerPermissions } from "../../auth/test-support.tsx";
import { createApiClient } from "../../lib/api-client.tsx";
import { createDemoFetch } from "../../lib/demo-seed.tsx";
import { createHrApi, type HrApi } from "./hrApi.tsx";
import { HrApiProvider } from "./HrProvider.tsx";
import { HrPipelineScreen } from "./HrPipelineScreen.tsx";
import { HrOnboardingScreen } from "./HrOnboardingScreen.tsx";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), useRouter: () => null }));

const EDITOR = editorPermissions("hr", ["hr:read", "hr:write", "hr:admin"]);
const VIEWER = viewerPermissions("hr", ["hr:read"]);

function demoApi(): HrApi {
  return createHrApi(createApiClient({ baseUrl: "https://demo.local", fetchImpl: createDemoFetch() }));
}

function applicant(over: Partial<hr.Applicant> = {}): hr.Applicant {
  return {
    id: "app_1", name: "青木 陽向", nameKana: null, email: null, department: "情報工学科", grade: "1年", desiredTeamId: null,
    source: null, motivation: null, stage: "applied", memberId: null, participationId: null, version: 1, createdBy: "usr_1",
    createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", ...over,
  };
}

function fakeApi(overrides: Partial<HrApi> = {}): HrApi {
  const unused = () => Promise.reject(new Error("unused"));
  return {
    list: () => Promise.resolve({ applicants: [applicant()] }),
    get: unused,
    create: unused,
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

describe("demo transport (人事)", () => {
  it("serves the seeded pipeline and enforces the stage rules", async () => {
    const api = demoApi();
    const { applicants } = await api.list();
    expect(new Set(applicants.map((a) => a.stage))).toEqual(
      new Set(["applied", "screening", "interview", "offered", "rejected", "joined"]),
    );
    const first = applicants.find((a) => a.stage === "applied")!;
    await expect(api.moveStage(first.id, { stage: "offered", expectedVersion: first.version })).rejects.toMatchObject({ status: 409 });
    const moved = await api.moveStage(first.id, { stage: "screening", expectedVersion: first.version });
    expect(moved.applicant.stage).toBe("screening");
    expect(moved.events.at(-1)).toMatchObject({ kind: "stage", fromStage: "applied", toStage: "screening" });
  });

  it("join adds a 在籍 roster member and the new member appears in onboarding", async () => {
    const fetchImpl = createDemoFetch();
    const api = createHrApi(createApiClient({ baseUrl: "https://demo.local", fetchImpl }));
    const offered = (await api.list()).applicants.find((a) => a.stage === "offered")!;
    const res = await api.join(offered.id, { expectedVersion: offered.version });
    expect(res.applicant.stage).toBe("joined");

    const overview = (await (await fetchImpl("https://demo.local/api/v1/members/overview")).json()) as {
      members: Array<{ id: string; status: string; name: string }>;
    };
    expect(overview.members.find((m) => m.id === res.memberId)).toMatchObject({ name: offered.name, status: "added" });

    const ob = await api.onboarding();
    const mine = ob.members.find((m) => m.memberId === res.memberId)!;
    expect(mine).toMatchObject({ done: 0, total: ob.items.length });
    const p = await api.setCheck(res.memberId, ob.items[0]!.id, true);
    expect(p.done).toBe(1);
  });
});

describe("HrPipelineScreen", () => {
  it("renders stage columns with cards", async () => {
    renderWith(<HrPipelineScreen />, fakeApi());
    const col = await screen.findByTestId("fe2-hr-column-applied");
    expect(within(col).getByText("青木 陽向")).toBeTruthy();
    expect(screen.getByTestId("fe2-hr-column-offered")).toBeTruthy();
  });

  it("moves a card to the next stage optimistically", async () => {
    let resolve!: (d: hr.ApplicantDetail) => void;
    const moveStage = vi.fn(() => new Promise<hr.ApplicantDetail>((r) => (resolve = r)));
    renderWith(<HrPipelineScreen />, fakeApi({ moveStage }));
    fireEvent.click(await screen.findByTestId("fe2-hr-card-app_1-next"));
    // 応答前にもう書類選考の列にいる (楽観的)。
    await waitFor(() => expect(within(screen.getByTestId("fe2-hr-column-screening")).getByText("青木 陽向")).toBeTruthy());
    expect(moveStage).toHaveBeenCalledWith("app_1", { stage: "screening", expectedVersion: 1 });
    resolve({ applicant: applicant({ stage: "screening", version: 2 }), events: [] });
  });

  it("rolls the card back when the move fails", async () => {
    const moveStage = vi.fn(() => Promise.reject(new Error("boom")));
    renderWith(<HrPipelineScreen />, fakeApi({ moveStage }));
    fireEvent.click(await screen.findByTestId("fe2-hr-card-app_1-next"));
    await waitFor(() => expect(moveStage).toHaveBeenCalled());
    await waitFor(() => expect(within(screen.getByTestId("fe2-hr-column-applied")).getByText("青木 陽向")).toBeTruthy());
  });

  it("a viewer sees the board but no move buttons or register action", async () => {
    renderWith(<HrPipelineScreen />, fakeApi(), VIEWER);
    await screen.findByTestId("fe2-hr-card-app_1");
    expect(screen.queryByTestId("fe2-hr-card-app_1-next")).toBeNull();
    expect(screen.queryByTestId("fe2-hr-new")).toBeNull();
  });
});

describe("HrOnboardingScreen", () => {
  it("ticks an onboarding item optimistically and shows 完了 when all are done", async () => {
    const setCheck = vi.fn((memberId: string, _itemId: string, _checked: boolean) =>
      Promise.resolve<hr.OnboardingProgress>({
        memberId, name: "小林 葵", applicantId: "app_7", joinedAt: null, checkedItemIds: ["i1", "i2"], total: 2, done: 2, completed: true,
      }),
    );
    const onboarding = () =>
      Promise.resolve<hr.ListOnboardingProgressResponse>({
        items: [
          { id: "i1", title: "Slack に参加", description: null, url: null },
          { id: "i2", title: "アイコン設定", description: null, url: null },
        ],
        members: [{ memberId: "m1", name: "小林 葵", applicantId: "app_7", joinedAt: null, checkedItemIds: ["i1"], total: 2, done: 1, completed: false }],
      });
    renderWith(<HrOnboardingScreen />, fakeApi({ onboarding, setCheck }));
    const box = await screen.findByTestId("fe2-hr-ob-m1-i2");
    fireEvent.click(box.querySelector("input") ?? box);
    await waitFor(() => expect(setCheck).toHaveBeenCalledWith("m1", "i2", true));
    expect(await screen.findByTestId("fe2-hr-ob-m1-done")).toBeTruthy();
  });

  it("shows an empty state when nobody is onboarding", async () => {
    renderWith(<HrOnboardingScreen />, fakeApi({ onboarding: () => Promise.resolve({ items: [], members: [] }) }));
    expect(await screen.findByTestId("fe2-hr-onboarding-empty")).toBeTruthy();
  });
});
