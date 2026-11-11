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

// 回答一覧 / オンボーディング案内 は人事のタブ帯 (HrTabs = useNavigate) の中に描かれる。
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), useRouter: () => null }));
import { ApiError, type ApiClient, type RequestInput } from "../../lib/api-client.tsx";
import { FakeAuthProvider, editorPermissions, viewerPermissions } from "../../auth/test-support.tsx";
import { createParticipationApi, type ParticipationApi } from "./participationApi.tsx";
import { ParticipationApiProvider } from "./ParticipationProvider.tsx";
import { ParticipationForm } from "./ParticipationForm.tsx";
import { PUBLIC_PARTICIPATION_PATH, parsePrefillHash, prefillPath } from "./prefillLink.ts";
import { OnboardingAdminPage } from "./OnboardingAdminPage.tsx";
import { ParticipationListPage } from "./ParticipationListPage.tsx";
import { PublicOnboardingPage } from "./PublicOnboardingPage.tsx";
import type { OnboardingGuide, OnboardingItem, OnboardingTeam, Participation, ParticipationCandidate, PublicParticipationResponse, RosterMember } from "./contracts.ts";

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

function onboardingItem(over: Partial<OnboardingItem> & Pick<OnboardingItem, "id">): OnboardingItem {
  return {
    title: "項目", description: null, url: null, sortOrder: 1024,
    createdAt: "2026-10-13T00:00:00.000Z", updatedAt: "2026-10-13T00:00:00.000Z",
    ...over,
  };
}

const TEAMS: OnboardingTeam[] = [
  { id: "team_dev", name: "開発チーム", color: "#0d9488" },
  { id: "team_pr", name: "広報チーム", color: null },
];
const AT = "2026-10-13T00:00:00.000Z";

function guide(items: OnboardingItem[], over: Partial<OnboardingGuide> = {}): OnboardingGuide {
  return { items, teams: [], meetings: [], ...over };
}

function makeApi(overrides: Partial<ParticipationApi> = {}): ParticipationApi {
  return {
    listTeams: () => Promise.resolve({ teams: [{ id: "t1", key: "venue", name: "会場", color: null, description: null }] }),
    submit: vi.fn(() => Promise.resolve(ACCEPTED)),
    list: vi.fn(() => Promise.resolve({ participations: [] })),
    candidates: vi.fn(() => Promise.resolve({ candidates: [] })),
    overview: vi.fn(() => Promise.resolve({ teams: [], members: [] })),
    orgOverview: vi.fn(() => Promise.resolve({ teams: [], members: [] })),
    resolve: vi.fn((id: string) =>
      Promise.resolve({ participation: { ...SUBMISSION, id, reviewState: "added" as const }, member: null }),
    ),
    listOnboarding: vi.fn(() => Promise.resolve(guide([]))),
    createOnboarding: vi.fn((input) => Promise.resolve(onboardingItem({ id: "onb_new", ...input }))),
    updateOnboarding: vi.fn((id, patch) => Promise.resolve(onboardingItem({ id, ...patch }))),
    deleteOnboarding: vi.fn(() => Promise.resolve()),
    reorderOnboarding: vi.fn((ids: string[]) => Promise.resolve({ items: ids.map((id) => onboardingItem({ id })) })),
    saveOnboardingMeeting: vi.fn(() => Promise.resolve({ meetings: [] })),
    publicOnboarding: vi.fn(() => Promise.resolve(guide([]))),
    ...overrides,
  } as ParticipationApi;
}

// Default subject: 参加届 app at 編集 (+ identity:admin) — what member-service demands to
// 反映確定 a submission. Pass `permissions` to render as a 閲覧 subject instead.
function wrap(
  ui: ReactNode,
  api: ParticipationApi,
  permissions = editorPermissions("participation", ["identity:read", "identity:admin", "members:roster_view"]),
): JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <FakeAuthProvider permissions={permissions}>
        <ToastProvider>
          <ParticipationApiProvider value={api}>{ui}</ParticipationApiProvider>
        </ToastProvider>
      </FakeAuthProvider>
    </QueryClientProvider>
  );
}

/** Fill the required fields (氏名[姓/名] + 学校メール + Gmail) with valid values. */
async function fillRequired(last = "新規", first = "太郎", position: string | null = "member"): Promise<void> {
  await userEvent.type(screen.getByTestId("participation-last-name"), last);
  await userEvent.type(screen.getByTestId("participation-first-name"), first);
  await userEvent.type(screen.getByTestId("participation-school-email"), "taro@school.ac.jp");
  await userEvent.type(screen.getByTestId("participation-gmail"), "taro@gmail.com");
  if (position) await userEvent.selectOptions(screen.getByTestId("participation-position"), position);
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

describe("参加届の入力済みリンク", () => {
  const prefill = { lastName: "森", firstName: "結菜", lastNameKana: "もり", firstNameKana: "ゆいな", schoolEmail: "c1@st.example.ac.jp", grade: "2", department: "情報工学科" } as const;

  it("round-trips Japanese values and fills romaji from kana", () => {
    const hash = prefillPath(prefill).replace(PUBLIC_PARTICIPATION_PATH, "");
    expect(parsePrefillHash(hash)).toMatchObject({ ...prefill, lastNameRomaji: "Mori", firstNameRomaji: "Yuina", gmail: "" });
  });

  it("ignores broken links and drops invalid values", () => {
    expect(parsePrefillHash("")).toBeNull();
    expect(parsePrefillHash("#prefill=%%%")).toBeNull();
    expect(parsePrefillHash(`#prefill=${"a".repeat(5000)}`)).toBeNull();
    const hash = prefillPath({ lastName: "森", gmail: "broken" }).replace(PUBLIC_PARTICIPATION_PATH, "");
    expect(parsePrefillHash(hash)).toMatchObject({ lastName: "森", gmail: "" });
  });

  it("opens the form filled in and removes the data from the URL", async () => {
    window.history.replaceState(null, "", prefillPath(prefill));
    render(wrap(<ParticipationForm />, makeApi()));
    expect(await screen.findByTestId("participation-prefilled")).toBeTruthy();
    expect((screen.getByTestId("participation-last-name") as HTMLInputElement).value).toBe("森");
    expect((screen.getByTestId("participation-last-name-romaji") as HTMLInputElement).value).toBe("Mori");
    expect((screen.getByTestId("participation-school-email") as HTMLInputElement).value).toBe("c1@st.example.ac.jp");
    expect(window.location.hash).toBe("");
    window.history.replaceState(null, "", "/");
  });
});

describe("ParticipationForm", () => {
  it("blocks submit with an empty 姓/名", async () => {
    const api = makeApi();
    render(wrap(<ParticipationForm />, api));
    await userEvent.click(screen.getByTestId("participation-submit"));
    expect(screen.getByText("氏名（苗字）を入力してください")).toBeInTheDocument();
    expect(screen.getByText("氏名（名前）を入力してください")).toBeInTheDocument();
    expect(api.submit).not.toHaveBeenCalled();
  });

  it("requires both the school email and the Gmail address", async () => {
    const api = makeApi();
    render(wrap(<ParticipationForm />, api));
    await userEvent.type(screen.getByTestId("participation-last-name"), "山田");
    await userEvent.type(screen.getByTestId("participation-first-name"), "太郎");
    await userEvent.click(screen.getByTestId("participation-submit"));
    expect(screen.getByText("学校のメールアドレスを入力してください")).toBeInTheDocument();
    expect(screen.getByText("Gmail アドレスを入力してください")).toBeInTheDocument();
    expect(api.submit).not.toHaveBeenCalled();
  });

  it("rejects a malformed email", async () => {
    const api = makeApi();
    render(wrap(<ParticipationForm />, api));
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
    render(wrap(<ParticipationForm />, api));
    await fillRequired();
    await userEvent.type(screen.getByTestId("participation-phone"), "not-a-phone");
    await userEvent.click(screen.getByTestId("participation-submit"));
    expect(screen.getByText("電話番号の形式が正しくありません")).toBeInTheDocument();
    expect(api.submit).not.toHaveBeenCalled();
  });

  it("rejects a malformed 名列番号", async () => {
    const api = makeApi();
    render(wrap(<ParticipationForm />, api));
    await fillRequired();
    await userEvent.type(screen.getByTestId("participation-roster-number"), "3EP2");
    await userEvent.click(screen.getByTestId("participation-submit"));
    expect(screen.getByText("名列番号は 3EP2-26 の形式で入力してください")).toBeInTheDocument();
    expect(api.submit).not.toHaveBeenCalled();
  });

  it("asks 所属チーム from the roster teams and sends it as desiredTeamId", async () => {
    const teams: OnboardingTeam[] = [
      { id: "team_dev", name: "開発チーム", color: null },
      { id: "team_network", name: "ネットワークチーム", color: null },
    ];
    const api = makeApi({ publicOnboarding: vi.fn(() => Promise.resolve(guide([], { teams }))) });
    render(wrap(<ParticipationForm />, api));
    const select = await screen.findByTestId("participation-team");
    expect(within(select).getByRole("option", { name: "ネットワークチーム" })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "まだ決まっていない" })).toBeInTheDocument();
    await fillRequired();
    await userEvent.click(screen.getByTestId("participation-submit"));
    expect(screen.getByText("所属チームを選択してください")).toBeInTheDocument();
    expect(api.submit).not.toHaveBeenCalled();
    await userEvent.selectOptions(select, "team_network");
    await userEvent.click(screen.getByTestId("participation-submit"));
    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1));
    expect((api.submit as any).mock.calls[0][0]).toMatchObject({ desiredTeamId: "team_network" });
  });

  it("sends desiredTeamId = null for 「まだ決まっていない」", async () => {
    const teams: OnboardingTeam[] = [{ id: "team_dev", name: "開発チーム", color: null }];
    const api = makeApi({ publicOnboarding: vi.fn(() => Promise.resolve(guide([], { teams }))) });
    render(wrap(<ParticipationForm />, api));
    await userEvent.selectOptions(await screen.findByTestId("participation-team"), "__none__");
    await fillRequired();
    await userEvent.click(screen.getByTestId("participation-submit"));
    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1));
    expect((api.submit as any).mock.calls[0][0]).toMatchObject({ desiredTeamId: null });
  });

  it("requires 役職 (Org / Lead / Member) and sends it as position", async () => {
    const api = makeApi();
    render(wrap(<ParticipationForm />, api));
    const select = screen.getByTestId("participation-position");
    for (const label of ["Org", "Lead", "Member"]) {
      expect(within(select).getByRole("option", { name: label })).toBeInTheDocument();
    }
    await fillRequired("新規", "太郎", null);
    await userEvent.click(screen.getByTestId("participation-submit"));
    expect(screen.getByText("役職を選択してください")).toBeInTheDocument();
    expect(api.submit).not.toHaveBeenCalled();
    await userEvent.selectOptions(select, "leader");
    await userEvent.click(screen.getByTestId("participation-submit"));
    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1));
    expect((api.submit as any).mock.calls[0][0]).toMatchObject({ position: "leader" });
  });

  it("shows a skeleton while the teams load and omits the field when there are no teams", async () => {
    let resolve: (g: OnboardingGuide) => void = () => {};
    const api = makeApi({ publicOnboarding: vi.fn(() => new Promise<OnboardingGuide>((r) => (resolve = r))) });
    render(wrap(<ParticipationForm />, api));
    expect(await screen.findByTestId("participation-team-loading")).toBeInTheDocument();
    resolve(guide([]));
    await waitFor(() => expect(screen.queryByTestId("participation-team-loading")).not.toBeInTheDocument());
    expect(screen.queryByTestId("participation-team")).not.toBeInTheDocument();
  });

  it("submits split 姓/名 + both emails and shows a neutral サンクス (no roster claim)", async () => {
    const api = makeApi();
    render(wrap(<ParticipationForm />, api));
    await fillRequired("新規", "太郎");
    await userEvent.type(screen.getByTestId("participation-phone"), "090-1234-5678");
    await userEvent.type(screen.getByTestId("participation-roster-number"), "3ep2-26");
    await userEvent.click(screen.getByTestId("participation-submit"));
    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1));
    expect((api.submit as any).mock.calls[0][0]).toMatchObject({
      lastName: "新規",
      firstName: "太郎",
      name: "新規 太郎",
      phone: "090-1234-5678",
      rosterNumber: "3EP2-26",
      schoolEmail: "taro@school.ac.jp",
      gmail: "taro@gmail.com",
    });
    expect(await screen.findByTestId("participation-thanks")).toBeInTheDocument();
    expect(screen.getByText(/運営が内容を確認します/)).toBeInTheDocument();
  });

});

const SUBMISSION: Participation = {
  id: "p_1", orgId: "org", memberId: null, name: "黒川", lastName: "黒川", firstName: null,
  nameKana: "くろかわ", lastNameKana: "くろかわ", firstNameKana: null,
  nameRomaji: "Kurokawa", lastNameRomaji: "Kurokawa", firstNameRomaji: null, grade: "3",
  department: "情報工学科", rosterNumber: null, studentNumber: null, contact: "kurokawa@school.ac.jp", phone: "090-1111-2222", schoolEmail: "kurokawa@school.ac.jp",
  gmail: "kurokawa.dev@gmail.com", desiredTeamId: "t1", desiredActivity: "both", note: "よろしく",
  status: "submitted", matchKind: "created_new", reviewState: "pending", submittedBy: "u_1",
  submittedAt: "2026-08-15T10:00:00.000Z", createdAt: "2026-08-15T10:00:00.000Z", updatedAt: "2026-08-15T10:00:00.000Z",
};

describe("ParticipationListPage — 3 段階 (policy) の 閲覧 tier", () => {
  it.each(["participation-add-p_1", "participation-skip-p_1"])("閲覧のみのとき %s を押すと反映せず権限不足ダイアログが出る", async (testId) => {
    const resolve = vi.fn();
    const api = makeApi({ list: vi.fn(() => Promise.resolve({ participations: [SUBMISSION] })), resolve });
    render(wrap(<ParticipationListPage />, api, viewerPermissions("participation", ["identity:read"])));
    expect(await screen.findByTestId("participation-list-table")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId(testId));
    expect(await screen.findByRole("dialog", { name: "権限が不足しています" })).toBeInTheDocument();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("閲覧のみのとき 紐付けを解除 も権限不足ダイアログになる", async () => {
    const linked: Participation = { ...SUBMISSION, memberId: "m_link", reviewState: "added", matchKind: "linked_existing" };
    const api = makeApi({ list: vi.fn(() => Promise.resolve({ participations: [linked] })) });
    render(wrap(<ParticipationListPage />, api, viewerPermissions("participation", ["identity:read"])));
    await userEvent.click(await screen.findByTestId("participation-unlink-p_1"));
    expect(await screen.findByRole("dialog", { name: "権限が不足しています" })).toBeInTheDocument();
  });
});

describe("ParticipationListPage", () => {
  it("renders submitted 参加届 rows with the school email + Gmail", async () => {
    const api = makeApi({ list: vi.fn(() => Promise.resolve({ participations: [SUBMISSION] })) });
    render(wrap(<ParticipationListPage />, api));
    expect(await screen.findByTestId("participation-list-table")).toBeInTheDocument();
    expect(screen.getByText("kurokawa@school.ac.jp")).toBeInTheDocument();
    expect(screen.getByText("kurokawa.dev@gmail.com")).toBeInTheDocument();
    // 所属チーム resolves via the canonical team list (t1 → 会場).
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

  it("追加済 →「紐付けを解除」→ 確認 → 未処理に戻す (unlink)", async () => {
    const linked: Participation = { ...SUBMISSION, memberId: "m_link", reviewState: "added", matchKind: "linked_existing" };
    let current = linked;
    const resolve = vi.fn((id: string) => {
      current = { ...linked, id, memberId: null, reviewState: "pending" };
      return Promise.resolve({ participation: current, member: null });
    });
    const api = makeApi({
      list: vi.fn(() => Promise.resolve({ participations: [current] })),
      overview: vi.fn(() => Promise.resolve({ teams: [], members: [rosterMember({ id: "m_link", name: "黒川 先輩", status: "added" })] })),
      resolve,
    });
    render(wrap(<ParticipationListPage />, api));
    // 追加済の行には「追加する」ではなく「紐付けを解除」が出る。
    await userEvent.click(await screen.findByTestId("participation-unlink-p_1"));
    expect(screen.queryByTestId("participation-add-p_1")).toBeNull();
    const dialog = await screen.findByTestId("participation-unlink-confirm");
    // 確認文に紐付け先のメンバー名が出る (誤解除の防止)。
    expect(await within(dialog).findByText(/黒川 先輩/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "解除して未処理に戻す" }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith("p_1", { action: "unlink" }));
    // 解除後は再び「追加する」で付け直せる。
    expect(await screen.findByTestId("participation-add-p_1")).toBeInTheDocument();
  });
});

describe("OnboardingAdminPage", () => {
  const ITEMS = [
    onboardingItem({ id: "onb_1", title: "Discord に参加", url: "https://discord.gg/x", sortOrder: 1024 }),
    onboardingItem({ id: "onb_2", title: "参加届を出す", description: "名前とメールを送る", sortOrder: 2048 }),
  ];

  it("shows the public URL and the items in order", async () => {
    const api = makeApi({ listOnboarding: vi.fn(() => Promise.resolve(guide(ITEMS))) });
    render(wrap(<OnboardingAdminPage />, api));
    expect(screen.getByTestId("onboarding-share-url").textContent).toMatch(/\/onboarding$/);
    expect(await screen.findByText("Discord に参加")).toBeInTheDocument();
    const rows = screen.getAllByTestId(/^onboarding-admin-item-/);
    expect(rows.map((r) => r.dataset.testid)).toEqual(["onboarding-admin-item-onb_1", "onboarding-admin-item-onb_2"]);
  });

  it("adds an item through the dialog and rejects a non-http link", async () => {
    const stored: OnboardingItem[] = [];
    const api = makeApi({
      listOnboarding: vi.fn(() => Promise.resolve(guide([...stored]))),
      createOnboarding: vi.fn((input) => {
        const item = onboardingItem({ id: "onb_new", ...input });
        stored.push(item);
        return Promise.resolve(item);
      }),
    });
    render(wrap(<OnboardingAdminPage />, api));
    await screen.findByTestId("onboarding-admin-empty");
    await userEvent.click(screen.getByTestId("onboarding-admin-add"));
    await userEvent.type(screen.getByTestId("onboarding-item-title"), "Slack に参加");
    await userEvent.type(screen.getByTestId("onboarding-item-url"), "javascript:alert(1)");
    await userEvent.click(screen.getByTestId("onboarding-item-save"));
    expect(screen.getByText("http:// または https:// で始まる URL を入力してください")).toBeInTheDocument();
    expect(api.createOnboarding).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByTestId("onboarding-item-url"));
    await userEvent.type(screen.getByTestId("onboarding-item-url"), "https://slack.com/x");
    await userEvent.click(screen.getByTestId("onboarding-item-save"));
    await waitFor(() => expect(api.createOnboarding).toHaveBeenCalledTimes(1));
    expect((api.createOnboarding as any).mock.calls[0][0]).toEqual({ title: "Slack に参加", description: null, url: "https://slack.com/x" });
    expect(await screen.findByText("Slack に参加")).toBeInTheDocument();
  });

  it("deletes after confirmation", async () => {
    const api = makeApi({ listOnboarding: vi.fn(() => Promise.resolve(guide(ITEMS))) });
    render(wrap(<OnboardingAdminPage />, api));
    await userEvent.click(await screen.findByTestId("onboarding-admin-delete-onb_1"));
    const dialog = screen.getByTestId("onboarding-admin-delete-confirm");
    await userEvent.click(within(dialog).getByText("削除する"));
    await waitFor(() => expect(api.deleteOnboarding).toHaveBeenCalledWith("onb_1"));
  });

  it("a 閲覧 subject gets the permission dialog instead of add / edit", async () => {
    const api = makeApi({ listOnboarding: vi.fn(() => Promise.resolve(guide(ITEMS))) });
    render(wrap(<OnboardingAdminPage />, api, viewerPermissions("participation")));
    expect(await screen.findByText("Discord に参加")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("onboarding-admin-add"));
    expect(await screen.findByRole("dialog", { name: "権限が不足しています" })).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("perm-dialog-participation-close"));
    await userEvent.click(screen.getByTestId("onboarding-admin-edit-onb_1"));
    expect(await screen.findByRole("dialog", { name: "権限が不足しています" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /項目/ })).toBeNull();
  });
});

describe("OnboardingAdminPage meetings", () => {
  it("lists 全体 + each team and saves a team meeting (schedule required, link optional)", async () => {
    const api = makeApi({
      listOnboarding: vi.fn(() =>
        Promise.resolve(
          guide([], { teams: TEAMS, meetings: [{ teamId: null, schedule: "10/20(火) 19:00〜", url: "https://meet.google.com/a", updatedAt: AT }] }),
        ),
      ),
    });
    render(wrap(<OnboardingAdminPage />, api));
    expect(await screen.findByText("10/20(火) 19:00〜")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-meeting-team_pr").textContent).toContain("未設定");

    await userEvent.click(screen.getByTestId("onboarding-meeting-edit-team_dev"));
    await userEvent.click(screen.getByTestId("onboarding-meeting-save"));
    expect(screen.getByText("日時を入力してください")).toBeInTheDocument();
    await userEvent.type(screen.getByTestId("onboarding-meeting-schedule"), "毎週水曜 20:00〜");
    await userEvent.type(screen.getByTestId("onboarding-meeting-url"), "https://meet.google.com/dev");
    await userEvent.click(screen.getByTestId("onboarding-meeting-save"));
    await waitFor(() =>
      expect(api.saveOnboardingMeeting).toHaveBeenCalledWith({
        teamId: "team_dev",
        schedule: "毎週水曜 20:00〜",
        url: "https://meet.google.com/dev",
      }),
    );
  });

  it("clears an existing meeting", async () => {
    const api = makeApi({
      listOnboarding: vi.fn(() =>
        Promise.resolve(guide([], { meetings: [{ teamId: null, schedule: "毎週木曜", url: null, updatedAt: AT }] })),
      ),
    });
    render(wrap(<OnboardingAdminPage />, api));
    await userEvent.click(await screen.findByTestId("onboarding-meeting-edit-all"));
    await userEvent.click(screen.getByTestId("onboarding-meeting-clear"));
    await waitFor(() => expect(api.saveOnboardingMeeting).toHaveBeenCalledWith({ teamId: null, schedule: null, url: null }));
  });

  it("meeting editing shows the permission dialog for a 閲覧 subject", async () => {
    const api = makeApi({ listOnboarding: vi.fn(() => Promise.resolve(guide([], { teams: TEAMS }))) });
    render(wrap(<OnboardingAdminPage />, api, viewerPermissions("participation")));
    expect(await screen.findByTestId("onboarding-meeting-team_dev")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("onboarding-meeting-edit-team_dev"));
    expect(await screen.findByRole("dialog", { name: "権限が不足しています" })).toBeInTheDocument();
  });
});

describe("PublicOnboardingPage", () => {
  const PUBLIC = guide([onboardingItem({ id: "onb_1", title: "Slack に参加する", url: "https://join.slack.com/x" })], {
    teams: TEAMS,
    meetings: [
      { teamId: null, schedule: "10/20(火) 19:00〜", url: "https://meet.google.com/all", updatedAt: AT },
      { teamId: "team_dev", schedule: "毎週水曜 20:00〜", url: "https://meet.google.com/dev", updatedAt: AT },
    ],
  });

  function renderPublic(data: OnboardingGuide): void {
    const { api } = fakeApiClient(data);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <PublicOnboardingPage api={api} />
        </ToastProvider>
      </QueryClientProvider>,
    );
  }

  it("asks for the team first, then shows the steps followed by 全体 and the team's meeting time + link", async () => {
    window.history.replaceState(null, "", "/onboarding");
    renderPublic(PUBLIC);
    await screen.findByTestId("onboarding-public-team-picker");
    expect(screen.queryByTestId("onboarding-public-steps")).toBeNull();

    await userEvent.click(screen.getByTestId("onboarding-public-team-team_dev"));
    const steps = screen.getAllByTestId(/^onboarding-public-step-/).map((el) => el.dataset.testid);
    expect(steps).toEqual(["onboarding-public-step-onb_1", "onboarding-public-step-all", "onboarding-public-step-team_dev"]);
    expect(screen.getByTestId("onboarding-public-when-all").textContent).toBe("10/20(火) 19:00〜");
    expect(screen.getByTestId("onboarding-public-when-team_dev").textContent).toBe("毎週水曜 20:00〜");
    expect(screen.getByText("開発チームのチームミーティングに出る")).toBeInTheDocument();
    expect(window.location.search).toBe("?team=team_dev");

    await userEvent.click(screen.getByTestId("onboarding-public-change-team"));
    expect(await screen.findByTestId("onboarding-public-team-picker")).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("restores the team from ?team= and says the team meeting is TBD when not set", async () => {
    window.history.replaceState(null, "", "/onboarding?team=team_pr");
    renderPublic(PUBLIC);
    expect(await screen.findByText("広報チームのチームミーティングに出る")).toBeInTheDocument();
    expect(screen.getByText("日時は運営から追って連絡します。")).toBeInTheDocument();
  });

  it("「まだ決まっていない」shows only the 全体 meeting", async () => {
    window.history.replaceState(null, "", "/onboarding");
    renderPublic(PUBLIC);
    await userEvent.click(await screen.findByTestId("onboarding-public-team-none"));
    const steps = screen.getAllByTestId(/^onboarding-public-step-/).map((el) => el.dataset.testid);
    expect(steps).toEqual(["onboarding-public-step-onb_1", "onboarding-public-step-all"]);
  });
});

describe("ParticipationListPage — 追加と同時のメール発行", () => {
  const ADDED_MEMBER = rosterMember({ id: "m_new", name: "田中 実", status: "added", version: 2, gmail: "minoru.tanaka@gmail.com" });
  const TANAKA: Participation = {
    ...SUBMISSION, id: "p_2", name: "田中 実", lastName: "田中", firstName: "実",
    lastNameKana: "たなか", firstNameKana: "みのる", lastNameRomaji: "Tanaka", firstNameRomaji: "Minoru",
  };
  // 人事: 参加届の編集 + members:onboard_mail だけ。identity:admin もロール管理の編集も無い。
  const hr = editorPermissions("participation", ["identity:read", "mail:admin", "members:mail_edit", "members:onboard_mail"]);

  function issueApi(over: Partial<ParticipationApi> = {}): ParticipationApi {
    return makeApi({
      list: vi.fn(() => Promise.resolve({ participations: [TANAKA] })),
      candidates: vi.fn(() => Promise.resolve({ candidates: [] })),
      resolve: vi.fn((id: string) =>
        Promise.resolve({ participation: { ...TANAKA, id, reviewState: "added" as const }, member: ADDED_MEMBER }),
      ),
      onboardAccount: vi.fn((_pid: string, input: { localPart: string; sendAccountMail?: boolean }) =>
        Promise.resolve({
          address: `${input.localPart}@developershub.jp`,
          identityUserId: "usr_new",
          member: { ...ADDED_MEMBER, identityUserId: "usr_new" },
          accountMail: { requested: input.sendAccountMail === true, sent: input.sendAccountMail === true, to: TANAKA.gmail },
        }),
      ),
      ...over,
    });
  }

  async function addAsNew(): Promise<void> {
    await userEvent.click(await screen.findByTestId("participation-add-p_2"));
    await userEvent.click(await screen.findByTestId("participation-resolve-create"));
  }

  it("members:onboard_mail だけで発行を聞き、ローマ字の案で 1 回の呼び出しにまとめて送る (ロールは送らない)", async () => {
    const api = issueApi();
    render(wrap(<ParticipationListPage />, api, hr));
    await addAsNew();
    expect(await screen.findByTestId("participation-issue-mail-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("participation-issue-mail-localpart")).toHaveValue("minoru.tanaka");
    // ロールは選ばせず、固定であることを明示する。
    expect(screen.getByTestId("participation-issue-mail-role-fixed")).toHaveTextContent("一般メンバー（固定）");
    expect(screen.queryByRole("checkbox", { name: "admin" })).toBeNull();
    // Gmail がある人はログイン情報のメールが最初から ON。
    expect(screen.getByLabelText(`ログイン情報を ${ADDED_MEMBER.gmail} に送る`)).toBeChecked();
    await userEvent.click(screen.getByTestId("participation-issue-mail-submit"));
    await waitFor(() =>
      expect(api.onboardAccount).toHaveBeenCalledWith("p_2", { localPart: "minoru.tanaka", sendAccountMail: true }),
    );
    await waitFor(() => expect(screen.queryByTestId("participation-issue-mail-dialog")).not.toBeInTheDocument());
  });

  it("メールのチェックを外すと案内メールを頼まない", async () => {
    const api = issueApi();
    render(wrap(<ParticipationListPage />, api, hr));
    await addAsNew();
    await userEvent.click(await screen.findByLabelText(`ログイン情報を ${ADDED_MEMBER.gmail} に送る`));
    await userEvent.click(screen.getByTestId("participation-issue-mail-submit"));
    await waitFor(() =>
      expect(api.onboardAccount).toHaveBeenCalledWith("p_2", { localPart: "minoru.tanaka", sendAccountMail: false }),
    );
  });

  it("失敗したらダイアログに理由を出し、そのままもう一度発行できる", async () => {
    const onboardAccount = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, { error: { code: "MAIL_EMAIL_ROUTING_CONFLICT", message: "このアドレスは既に使われています", retryable: false } }))
      .mockResolvedValueOnce({ address: "minoru.tanaka@developershub.jp", identityUserId: "usr_new", member: ADDED_MEMBER, accountMail: { requested: false, sent: false, to: null } });
    const api = issueApi({ onboardAccount });
    render(wrap(<ParticipationListPage />, api, hr));
    await addAsNew();
    await userEvent.click(await screen.findByTestId("participation-issue-mail-submit"));
    expect(await screen.findByText("このアドレスは既に使われています")).toBeInTheDocument();
    expect(screen.getByTestId("participation-issue-mail-submit")).toHaveTextContent("もう一度発行する");
    await userEvent.click(screen.getByTestId("participation-issue-mail-submit"));
    await waitFor(() => expect(onboardAccount).toHaveBeenCalledTimes(2));
  });

  it("作成済みの分を戻しきれなかった時は再試行させず、管理者への連絡を出す", async () => {
    const onboardAccount = vi.fn().mockRejectedValue(
      new ApiError(502, { error: { code: "GATEWAY_ONBOARD_PARTIAL", message: "途中で失敗しました", retryable: false } }),
    );
    render(wrap(<ParticipationListPage />, issueApi({ onboardAccount }), hr));
    await addAsNew();
    await userEvent.click(await screen.findByTestId("participation-issue-mail-submit"));
    expect(await screen.findByTestId("participation-issue-mail-stuck")).toHaveTextContent("管理者に連絡してください");
    expect(screen.getByTestId("participation-issue-mail-submit")).toBeDisabled();
  });

  it("「今はしない」なら何も発行しない", async () => {
    const api = issueApi();
    render(wrap(<ParticipationListPage />, api, hr));
    await addAsNew();
    await userEvent.click(await screen.findByTestId("participation-issue-mail-later"));
    expect(screen.queryByTestId("participation-issue-mail-dialog")).not.toBeInTheDocument();
    expect(api.onboardAccount).not.toHaveBeenCalled();
  });

  it("members:onboard_mail の無い人 (旧 5 条件を持つだけの人も) や、既にアカウントのある人には聞かない", async () => {
    const api = issueApi();
    const old5 = [
      ...editorPermissions("participation", ["identity:read", "identity:admin", "mail:admin", "members:mail_edit"]),
      ...editorPermissions("admin"),
      ...editorPermissions("members"),
    ];
    const { unmount } = render(wrap(<ParticipationListPage />, api, old5));
    await addAsNew();
    await waitFor(() => expect(api.resolve).toHaveBeenCalled());
    expect(screen.queryByTestId("participation-issue-mail-dialog")).not.toBeInTheDocument();
    unmount();

    const linked = issueApi({
      resolve: vi.fn((id: string) =>
        Promise.resolve({ participation: { ...TANAKA, id, reviewState: "added" as const }, member: { ...ADDED_MEMBER, identityUserId: "usr_old" } }),
      ),
    });
    render(wrap(<ParticipationListPage />, linked, hr));
    await addAsNew();
    await waitFor(() => expect(linked.resolve).toHaveBeenCalled());
    expect(screen.queryByTestId("participation-issue-mail-dialog")).not.toBeInTheDocument();
  });
});

describe("createParticipationApi — メール発行まわり", () => {
  it("onboardAccount は gateway の onboard-account 1 本に POST する", async () => {
    const { api, calls } = fakeApiClient({ address: "a@developershub.jp" });
    const papi = createParticipationApi(api);
    await papi.onboardAccount("p_1", { localPart: "a", sendAccountMail: true });
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ["POST", "/api/v1/admin/participation/p_1/onboard-account", { localPart: "a", sendAccountMail: true }],
    ]);
  });
});
