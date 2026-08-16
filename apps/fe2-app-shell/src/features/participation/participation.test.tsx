// 参加届 feature tests: the api adapter maps onto the shell ApiClient.request, and
// ParticipationForm drives the ParticipationApi (fill → validate → submit → サンクス).
// The submit targets the PUBLIC endpoint and the サンクス is generic (no member echo).
// All run against a faked ParticipationApi / ApiClient — no real network, green offline.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, RequestInput } from "../../lib/api-client.tsx";
import { createParticipationApi, type ParticipationApi } from "./participationApi.tsx";
import { ParticipationApiProvider } from "./ParticipationProvider.tsx";
import { ParticipationPage } from "./ParticipationPage.tsx";
import { ParticipationListPage } from "./ParticipationListPage.tsx";
import type { Participation, PublicParticipationResponse } from "./contracts.ts";

function fakeApiClient(result: unknown = undefined): { api: ApiClient; calls: RequestInput[] } {
  const calls: RequestInput[] = [];
  const request = vi.fn(<TRes,>(input: RequestInput): Promise<TRes> => {
    calls.push(input);
    return Promise.resolve(result as TRes);
  });
  return { api: { request } as unknown as ApiClient, calls };
}

const CREATED: PublicParticipationResponse = { accepted: true, matchKind: "created_new" };

function makeApi(overrides: Partial<ParticipationApi> = {}): ParticipationApi {
  return {
    listTeams: () => Promise.resolve({ teams: [{ id: "t1", key: "venue", name: "会場", color: null, description: null }] }),
    submit: vi.fn(() => Promise.resolve(CREATED)),
    list: vi.fn(() => Promise.resolve({ participations: [] })),
    ...overrides,
  } as ParticipationApi;
}

function wrap(ui: ReactNode, api: ParticipationApi): JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ParticipationApiProvider value={api}>{ui}</ParticipationApiProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

/** Fill the three required fields (氏名 + 学校メール + Gmail) with valid values. */
async function fillRequired(name = "新規 太郎"): Promise<void> {
  await userEvent.type(screen.getByTestId("participation-name"), name);
  await userEvent.type(screen.getByTestId("participation-school-email"), "taro@school.ac.jp");
  await userEvent.type(screen.getByTestId("participation-gmail"), "taro@gmail.com");
}

describe("createParticipationApi", () => {
  it("submit POSTs the PUBLIC endpoint /api/v1/public/participation", async () => {
    const { api, calls } = fakeApiClient(CREATED);
    await createParticipationApi(api).submit({ name: "A", schoolEmail: "a@s.jp", gmail: "a@gmail.com" });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/v1/public/participation" });
  });

  it("listTeams GETs /api/v1/members/teams", async () => {
    const { api, calls } = fakeApiClient({ teams: [] });
    await createParticipationApi(api).listTeams();
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/v1/members/teams" });
  });

  it("list GETs /api/v1/members/participation", async () => {
    const { api, calls } = fakeApiClient({ participations: [] });
    await createParticipationApi(api).list();
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/v1/members/participation" });
  });
});

describe("ParticipationPage", () => {
  it("blocks submit with an empty name", async () => {
    const api = makeApi();
    render(wrap(<ParticipationPage />, api));
    await userEvent.click(screen.getByTestId("participation-submit"));
    expect(screen.getByText("氏名を入力してください")).toBeInTheDocument();
    expect(api.submit).not.toHaveBeenCalled();
  });

  it("requires both the school email and the Gmail address", async () => {
    const api = makeApi();
    render(wrap(<ParticipationPage />, api));
    await userEvent.type(screen.getByTestId("participation-name"), "太郎");
    await userEvent.click(screen.getByTestId("participation-submit"));
    expect(screen.getByText("学校のメールアドレスを入力してください")).toBeInTheDocument();
    expect(screen.getByText("Gmail アドレスを入力してください")).toBeInTheDocument();
    expect(api.submit).not.toHaveBeenCalled();
  });

  it("rejects a malformed email", async () => {
    const api = makeApi();
    render(wrap(<ParticipationPage />, api));
    await userEvent.type(screen.getByTestId("participation-name"), "太郎");
    await userEvent.type(screen.getByTestId("participation-school-email"), "not-an-email");
    await userEvent.type(screen.getByTestId("participation-gmail"), "taro@gmail.com");
    await userEvent.click(screen.getByTestId("participation-submit"));
    expect(screen.getByText("メールアドレスの形式が正しくありません")).toBeInTheDocument();
    expect(api.submit).not.toHaveBeenCalled();
  });

  it("submits both emails and shows the サンクス outcome", async () => {
    const api = makeApi();
    render(wrap(<ParticipationPage />, api));
    await fillRequired("新規 太郎");
    await userEvent.click(screen.getByTestId("participation-submit"));
    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1));
    expect((api.submit as any).mock.calls[0][0]).toMatchObject({
      name: "新規 太郎",
      schoolEmail: "taro@school.ac.jp",
      gmail: "taro@gmail.com",
    });
    expect(await screen.findByTestId("participation-thanks")).toBeInTheDocument();
    expect(screen.getByText(/運営メンバー名簿に追加しました/)).toBeInTheDocument();
  });

  it("reports an update for a linked_existing match", async () => {
    const linked: PublicParticipationResponse = { accepted: true, matchKind: "linked_existing" };
    const api = makeApi({ submit: vi.fn(() => Promise.resolve(linked)) });
    render(wrap(<ParticipationPage />, api));
    await fillRequired("既存 花子");
    await userEvent.click(screen.getByTestId("participation-submit"));
    expect(await screen.findByText(/登録済みの情報を更新しました/)).toBeInTheDocument();
  });

  it("links to the public form for sharing", () => {
    render(wrap(<ParticipationPage />, makeApi()));
    const link = screen.getByTestId("participation-public-link").querySelector("a");
    expect(link?.getAttribute("href")).toBe("/participate");
  });
});

const SUBMISSION: Participation = {
  id: "p_1", orgId: "org", memberId: "m_1", name: "黒川", nameKana: "くろかわ", grade: "3",
  department: "情報工学科", contact: "kurokawa@school.ac.jp", schoolEmail: "kurokawa@school.ac.jp",
  gmail: "kurokawa.dev@gmail.com", desiredTeamId: "t1", desiredActivity: "both", note: "よろしく",
  status: "submitted", matchKind: "linked_existing", submittedBy: "u_1",
  submittedAt: "2026-08-15T10:00:00.000Z", createdAt: "2026-08-15T10:00:00.000Z", updatedAt: "2026-08-15T10:00:00.000Z",
};

describe("ParticipationListPage", () => {
  it("renders submitted 参加届 rows with the school email + Gmail", async () => {
    const api = makeApi({ list: vi.fn(() => Promise.resolve({ participations: [SUBMISSION] })) });
    render(wrap(<ParticipationListPage />, api));
    expect(await screen.findByTestId("participation-list-table")).toBeInTheDocument();
    expect(screen.getByText("kurokawa@school.ac.jp")).toBeInTheDocument();
    expect(screen.getByText("kurokawa.dev@gmail.com")).toBeInTheDocument();
    // 希望チーム resolves via the canonical team list (t1 → 会場).
    expect(screen.getByText("会場")).toBeInTheDocument();
  });

  it("opens the detail drawer on row click", async () => {
    const api = makeApi({ list: vi.fn(() => Promise.resolve({ participations: [SUBMISSION] })) });
    render(wrap(<ParticipationListPage />, api));
    await userEvent.click(await screen.findByText("黒川"));
    const detail = await screen.findByTestId("participation-detail");
    expect(detail).toBeInTheDocument();
    expect(within(detail).getByText("よろしく")).toBeInTheDocument();
    expect(within(detail).getByText("情報工学科")).toBeInTheDocument();
  });

  it("shows an empty state when there are no submissions", async () => {
    const api = makeApi({ list: vi.fn(() => Promise.resolve({ participations: [] })) });
    render(wrap(<ParticipationListPage />, api));
    expect(await screen.findByText("まだ参加届はありません")).toBeInTheDocument();
  });
});
