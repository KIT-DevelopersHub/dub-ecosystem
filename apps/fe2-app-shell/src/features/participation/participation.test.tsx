// 参加届 feature tests: the api adapter maps onto the shell ApiClient.request, and
// ParticipationForm drives the ParticipationApi (fill → validate → submit → サンクス).
// The submit targets the PUBLIC endpoint and the サンクス is generic (no roster reflect —
// 名簿への反映は運営が回答一覧で確定する). ParticipationListPage の「追加する」フローも
// ここで検証する。All run against a faked ParticipationApi / ApiClient — no real network.
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
import type { Participation, ParticipationCandidate, PublicParticipationResponse, RosterMember } from "./contracts.ts";

/** Minimal roster member fixture for the manual-link search. */
function rosterMember(over: Partial<RosterMember> & Pick<RosterMember, "id" | "name">): RosterMember {
  return {
    orgId: "org", roleTitle: null, status: "invited", teamIds: [], department: null, grade: null,
    identityUserId: null, contact: null, schoolEmail: null, gmail: null, lastName: null, firstName: null,
    lastNameKana: null, firstNameKana: null, lastNameRomaji: null, firstNameRomaji: null, phone: null,
    note: null, sortOrder: 1024, version: 1, createdAt: "2026-08-15T10:00:00.000Z", updatedAt: "2026-08-15T10:00:00.000Z",
    ...over,
  } as RosterMember;
}

function fakeApiClient(result: unknown = undefined): { api: ApiClient; calls: RequestInput[] } {
  const calls: RequestInput[] = [];
  const request = vi.fn(<TRes,>(input: RequestInput): Promise<TRes> => {
    calls.push(input);
    return Promise.resolve(result as TRes);
  });
  return { api: { request } as unknown as ApiClient, calls };
}

const ACCEPTED: PublicParticipationResponse = { accepted: true };

function makeApi(overrides: Partial<ParticipationApi> = {}): ParticipationApi {
  return {
    listTeams: () => Promise.resolve({ teams: [{ id: "t1", key: "venue", name: "会場", color: null, description: null }] }),
    submit: vi.fn(() => Promise.resolve(ACCEPTED)),
    list: vi.fn(() => Promise.resolve({ participations: [] })),
    candidates: vi.fn(() => Promise.resolve({ candidates: [] })),
    overview: vi.fn(() => Promise.resolve({ teams: [], members: [] })),
    resolve: vi.fn((id: string) =>
      Promise.resolve({ participation: { ...SUBMISSION, id, reviewState: "added" as const }, member: null }),
    ),
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

/** Fill the required fields (氏名[姓/名] + 学校メール + Gmail) with valid values. */
async function fillRequired(last = "新規", first = "太郎"): Promise<void> {
  await userEvent.type(screen.getByTestId("participation-last-name"), last);
  await userEvent.type(screen.getByTestId("participation-first-name"), first);
  await userEvent.type(screen.getByTestId("participation-school-email"), "taro@school.ac.jp");
  await userEvent.type(screen.getByTestId("participation-gmail"), "taro@gmail.com");
}

describe("createParticipationApi", () => {
  it("submit POSTs the PUBLIC endpoint /api/v1/public/participation", async () => {
    const { api, calls } = fakeApiClient(ACCEPTED);
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

  it("candidates GETs the per-participation candidates endpoint", async () => {
    const { api, calls } = fakeApiClient({ candidates: [] });
    await createParticipationApi(api).candidates("p_1");
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/v1/members/participation/p_1/candidates" });
  });

  it("resolve POSTs the per-participation resolve endpoint", async () => {
    const { api, calls } = fakeApiClient({ participation: SUBMISSION, member: null });
    await createParticipationApi(api).resolve("p_1", { action: "create" });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/v1/members/participation/p_1/resolve", body: { action: "create" } });
  });
});

describe("ParticipationPage", () => {
  it("blocks submit with an empty 姓/名", async () => {
    const api = makeApi();
    render(wrap(<ParticipationPage />, api));
    await userEvent.click(screen.getByTestId("participation-submit"));
    expect(screen.getByText("苗字を入力してください")).toBeInTheDocument();
    expect(screen.getByText("名前を入力してください")).toBeInTheDocument();
    expect(api.submit).not.toHaveBeenCalled();
  });

  it("requires both the school email and the Gmail address", async () => {
    const api = makeApi();
    render(wrap(<ParticipationPage />, api));
    await userEvent.type(screen.getByTestId("participation-last-name"), "山田");
    await userEvent.type(screen.getByTestId("participation-first-name"), "太郎");
    await userEvent.click(screen.getByTestId("participation-submit"));
    expect(screen.getByText("学校のメールアドレスを入力してください")).toBeInTheDocument();
    expect(screen.getByText("Gmail アドレスを入力してください")).toBeInTheDocument();
    expect(api.submit).not.toHaveBeenCalled();
  });

  it("rejects a malformed email", async () => {
    const api = makeApi();
    render(wrap(<ParticipationPage />, api));
    await userEvent.type(screen.getByTestId("participation-last-name"), "山田");
    await userEvent.type(screen.getByTestId("participation-first-name"), "太郎");
    await userEvent.type(screen.getByTestId("participation-school-email"), "not-an-email");
    await userEvent.type(screen.getByTestId("participation-gmail"), "taro@gmail.com");
    await userEvent.click(screen.getByTestId("participation-submit"));
    expect(screen.getByText("メールアドレスの形式が正しくありません")).toBeInTheDocument();
    expect(api.submit).not.toHaveBeenCalled();
  });

  it("rejects a malformed phone number", async () => {
    const api = makeApi();
    render(wrap(<ParticipationPage />, api));
    await fillRequired();
    await userEvent.type(screen.getByTestId("participation-phone"), "not-a-phone");
    await userEvent.click(screen.getByTestId("participation-submit"));
    expect(screen.getByText("電話番号の形式が正しくありません")).toBeInTheDocument();
    expect(api.submit).not.toHaveBeenCalled();
  });

  it("submits split 姓/名 + both emails and shows a neutral サンクス (no roster claim)", async () => {
    const api = makeApi();
    render(wrap(<ParticipationPage />, api));
    await fillRequired("新規", "太郎");
    await userEvent.type(screen.getByTestId("participation-phone"), "090-1234-5678");
    await userEvent.click(screen.getByTestId("participation-submit"));
    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1));
    expect((api.submit as any).mock.calls[0][0]).toMatchObject({
      lastName: "新規",
      firstName: "太郎",
      name: "新規 太郎",
      phone: "090-1234-5678",
      schoolEmail: "taro@school.ac.jp",
      gmail: "taro@gmail.com",
    });
    expect(await screen.findByTestId("participation-thanks")).toBeInTheDocument();
    expect(screen.getByText(/運営が内容を確認します/)).toBeInTheDocument();
  });

  it("links to the public form for sharing", () => {
    render(wrap(<ParticipationPage />, makeApi()));
    const link = screen.getByTestId("participation-public-link").querySelector("a");
    expect(link?.getAttribute("href")).toBe("/participate");
  });
});

const SUBMISSION: Participation = {
  id: "p_1", orgId: "org", memberId: null, name: "黒川", lastName: "黒川", firstName: null,
  nameKana: "くろかわ", lastNameKana: "くろかわ", firstNameKana: null,
  nameRomaji: "Kurokawa", lastNameRomaji: "Kurokawa", firstNameRomaji: null, grade: "3",
  department: "情報工学科", contact: "kurokawa@school.ac.jp", phone: "090-1111-2222", schoolEmail: "kurokawa@school.ac.jp",
  gmail: "kurokawa.dev@gmail.com", desiredTeamId: "t1", desiredActivity: "both", note: "よろしく",
  status: "submitted", matchKind: "created_new", reviewState: "pending", submittedBy: "u_1",
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
    // 未処理は「未処理」バッジ + 「追加する」ボタンが出る。
    expect(screen.getByTestId("participation-add-p_1")).toBeInTheDocument();
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

  it("「追加する」→ 候補なし → 新規で追加 (create) を確定する", async () => {
    const resolve = vi.fn((id: string) =>
      Promise.resolve({ participation: { ...SUBMISSION, id, reviewState: "added" as const, matchKind: "created_new" as const }, member: null }),
    );
    const api = makeApi({
      list: vi.fn(() => Promise.resolve({ participations: [SUBMISSION] })),
      candidates: vi.fn(() => Promise.resolve({ candidates: [] })),
      resolve,
    });
    render(wrap(<ParticipationListPage />, api));
    await userEvent.click(await screen.findByTestId("participation-add-p_1"));
    // 候補なしダイアログ → 新規で追加。
    expect(await screen.findByTestId("participation-resolve-new")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("participation-resolve-create"));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith("p_1", { action: "create" }));
  });

  it("「追加する」→ 招待中候補あり → 同一人物で結合 (link) を確定する", async () => {
    const candidate: ParticipationCandidate = {
      memberId: "m_inv", name: "黒川", status: "invited", schoolEmail: "kurokawa@school.ac.jp",
      gmail: null, version: 3, matchedBy: ["email", "name"],
    };
    const resolve = vi.fn((id: string) =>
      Promise.resolve({ participation: { ...SUBMISSION, id, reviewState: "added" as const, matchKind: "linked_existing" as const }, member: null }),
    );
    const api = makeApi({
      list: vi.fn(() => Promise.resolve({ participations: [SUBMISSION] })),
      candidates: vi.fn(() => Promise.resolve({ candidates: [candidate] })),
      resolve,
    });
    render(wrap(<ParticipationListPage />, api));
    await userEvent.click(await screen.findByTestId("participation-add-p_1"));
    // 候補ありダイアログ → 候補の「この人に結びつける」。
    await userEvent.click(await screen.findByTestId("participation-link-m_inv"));
    await waitFor(() =>
      expect(resolve).toHaveBeenCalledWith("p_1", { action: "link", memberId: "m_inv", expectedVersion: 3 }),
    );
  });

  it("「追加する」→ 候補なし → 名簿から手動で検索して別人に link する", async () => {
    // 自動候補ゼロだが、名簿には氏名が一致しない招待中メンバーがいる（漢字違いのユースケース）。
    const invited = rosterMember({ id: "m_manual", name: "畔川", status: "invited", schoolEmail: "kurokawa@school.ac.jp", version: 5 });
    const resolve = vi.fn((id: string) =>
      Promise.resolve({ participation: { ...SUBMISSION, id, reviewState: "added" as const, matchKind: "linked_existing" as const }, member: null }),
    );
    const api = makeApi({
      list: vi.fn(() => Promise.resolve({ participations: [SUBMISSION] })),
      candidates: vi.fn(() => Promise.resolve({ candidates: [] })),
      overview: vi.fn(() => Promise.resolve({ teams: [], members: [invited] })),
      resolve,
    });
    render(wrap(<ParticipationListPage />, api));
    await userEvent.click(await screen.findByTestId("participation-add-p_1"));
    // 候補なし3択 → 名簿から手動で紐付け。
    await userEvent.click(await screen.findByTestId("participation-resolve-manual"));
    // 検索して該当メンバーを選ぶ。
    await userEvent.type(await screen.findByTestId("participation-manual-search"), "畔");
    await userEvent.click(await screen.findByTestId("participation-manual-link-m_manual"));
    await waitFor(() =>
      expect(resolve).toHaveBeenCalledWith("p_1", { action: "link", memberId: "m_manual", expectedVersion: 5 }),
    );
  });

  it("「しない」→ 確認 → 対象外 (skip) を確定する", async () => {
    const resolve = vi.fn((id: string) =>
      Promise.resolve({ participation: { ...SUBMISSION, id, reviewState: "skipped" as const }, member: null }),
    );
    const api = makeApi({ list: vi.fn(() => Promise.resolve({ participations: [SUBMISSION] })), resolve });
    render(wrap(<ParticipationListPage />, api));
    await userEvent.click(await screen.findByTestId("participation-skip-p_1"));
    const dialog = await screen.findByTestId("participation-skip-confirm");
    await userEvent.click(within(dialog).getByRole("button", { name: "対象外にする" }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith("p_1", { action: "skip" }));
  });

  it("反映済み(canUnlink)の行は「紐付けを取り消す」→ 確認 → unlink を確定する", async () => {
    const added = { ...SUBMISSION, reviewState: "added" as const, matchKind: "linked_existing" as const, canUnlink: true };
    const resolve = vi.fn((id: string) =>
      Promise.resolve({ participation: { ...added, id, reviewState: "pending" as const, canUnlink: false }, member: null }),
    );
    const api = makeApi({ list: vi.fn(() => Promise.resolve({ participations: [added] })), resolve });
    render(wrap(<ParticipationListPage />, api));
    await userEvent.click(await screen.findByTestId("participation-unlink-p_1"));
    const dialog = await screen.findByTestId("participation-unlink-confirm");
    await userEvent.click(within(dialog).getByRole("button", { name: "紐付けを取り消す" }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith("p_1", { action: "unlink" }));
  });

  it("反映済みでも canUnlink=false（過去の自動反映など）は取消ボタンを出さない", async () => {
    const added = { ...SUBMISSION, reviewState: "added" as const, canUnlink: false };
    const api = makeApi({ list: vi.fn(() => Promise.resolve({ participations: [added] })) });
    render(wrap(<ParticipationListPage />, api));
    await screen.findByTestId("participation-reviewstate-p_1");
    expect(screen.queryByTestId("participation-unlink-p_1")).toBeNull();
  });
});
