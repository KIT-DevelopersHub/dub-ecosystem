// スポンサー (名刺) のテスト。
//   (1) demo transport が /members/sponsor/* の契約に応答する (REAL api-client 経由): seed・登録 → 写真の往復・409
//   (2) 一覧: 表示 / 検索 / 権限で主ボタン・編集・削除が出し分く
//   (3) 撮影: カメラ非対応 → 写真を選ぶ → 保存で一覧に増える / 写真だけ失敗 → 再送 / カメラはアンマウントで止まる
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { identity, sponsor } from "@dub/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editorPermissions, FakeAuthProvider, viewerPermissions } from "../../auth/test-support.tsx";
import { createApiClient } from "../../lib/api-client.tsx";
import { createDemoFetch } from "../../lib/demo-seed.tsx";
import { createSponsorApi, type SponsorApi } from "./sponsorApi.tsx";
import { SponsorApiProvider } from "./SponsorProvider.tsx";
import { SponsorCardsScreen } from "./SponsorCardsScreen.tsx";
import { SponsorScanScreen } from "./SponsorScanScreen.tsx";
import { SHARE_NOTICE } from "./SponsorShared.tsx";
import { SponsorCompaniesScreen } from "./SponsorCompaniesScreen.tsx";
import { companyKey, groupCompanies, suggestCompanies } from "./companies.ts";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate, useRouter: () => null }));

const ADMIN = editorPermissions("sponsor", ["sponsor:read", "sponsor:write", "sponsor:admin"]);
const WRITER = editorPermissions("sponsor", ["sponsor:read", "sponsor:write"]);
const VIEWER = viewerPermissions("sponsor", ["sponsor:read"]);

function card(over: Partial<sponsor.BusinessCard> = {}): sponsor.BusinessCard {
  return {
    id: "card_1", companyName: "株式会社北陸テック", personName: "山田 太郎", department: "事業開発部", title: "部長",
    email: "yamada@example.jp", phone: "076-123-4567", note: "展示会で交換", hasImage: false, version: 1,
    createdBy: "usr_1" as sponsor.BusinessCard["createdBy"], createdByName: "鈴木 一郎",
    createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", ...over,
  };
}

const ROWS = [
  card(),
  card({ id: "card_2", companyName: "金沢クラウド合同会社", personName: "中村 花", department: "マーケティング部", title: "マネージャー", note: "ブース出展に興味" }),
  card({ id: "card_3", companyName: null, personName: null, department: null, title: null, email: null, phone: null, note: null }),
];

function fakeApi(overrides: Partial<SponsorApi> = {}): SponsorApi {
  const unused = () => Promise.reject(new Error("unused"));
  return {
    list: () => Promise.resolve({ cards: ROWS.map((r) => ({ ...r })) }),
    get: unused,
    create: unused,
    update: unused,
    remove: unused,
    uploadImage: unused,
    image: () => Promise.resolve(new Blob(["x"], { type: "image/jpeg" })),
    ...overrides,
  };
}

function renderWith(node: JSX.Element, api: SponsorApi, permissions: readonly identity.PermissionKey[] = ADMIN) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <FakeAuthProvider permissions={permissions}>
          <SponsorApiProvider value={api}>{node}</SponsorApiProvider>
        </FakeAuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const names = () => screen.queryAllByTestId("fe2-sponsor-card-name").map((el) => el.textContent);

beforeEach(() => {
  navigate.mockReset();
  // jsdom に canvas は無い: 縮小できない環境として扱わせる (選んだ JPEG をそのまま使う経路)。
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => vi.restoreAllMocks());

describe("demo transport (スポンサー)", () => {
  const demoApi = () => createSponsorApi(createApiClient({ baseUrl: "https://demo.local", fetchImpl: createDemoFetch() }));

  it("seeds cards newest first, incl. one without a photo and one without text", async () => {
    const { cards } = await demoApi().list();
    expect(cards.length).toBeGreaterThanOrEqual(3);
    expect([...cards].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((c) => c.id)).toEqual(cards.map((c) => c.id));
    expect(cards.some((c) => !c.hasImage)).toBe(true);
    expect(cards.some((c) => c.hasImage && c.companyName === null && c.personName === null)).toBe(true);
  });

  it("POST → PUT image → GET image round-trips, and PATCH with a stale version is 409", async () => {
    const api = demoApi();
    const created = await api.create({ companyName: "能登ソフト", personName: null });
    expect(created).toMatchObject({ companyName: "能登ソフト", hasImage: false, createdByName: "デモ 管理者" });
    const withImage = await api.uploadImage(created.id, new Blob(["jpegbytes"], { type: "image/jpeg" }));
    expect(withImage.hasImage).toBe(true);
    const img = await api.image(created.id);
    expect(img.size).toBe("jpegbytes".length);
    expect((await api.list()).cards[0]!.id).toBe(created.id);
    await expect(api.update(created.id, { note: "x", expectedVersion: created.version })).rejects.toMatchObject({ status: 409 });
    const updated = await api.update(created.id, { note: "協賛に前向き", expectedVersion: withImage.version });
    expect(updated.note).toBe("協賛に前向き");
    await api.remove(created.id);
    expect((await api.list()).cards.find((c) => c.id === created.id)).toBeUndefined();
  });
});

describe("SponsorCardsScreen (一覧)", () => {
  it("shows a skeleton first, then the cards with the display name fallback", async () => {
    renderWith(<SponsorCardsScreen />, fakeApi());
    expect(screen.getByTestId("fe2-sponsor-loading")).toBeTruthy();
    await screen.findByTestId("fe2-sponsor-card-card_1");
    expect(names()).toEqual(["株式会社北陸テック", "金沢クラウド合同会社", "名刺（未入力）"]);
    // 名簿形式: 同じ行に「誰が・いつ」登録したかが出る。
    const row = screen.getByTestId("fe2-sponsor-card-card_1").closest("tr")!;
    expect(within(row).getByText("鈴木 一郎")).toBeTruthy();
    expect(within(row).getByText(/2026\/11\/01/)).toBeTruthy();
  });

  it("sorts by 登録者 / 登録日時 and searches by 登録者", async () => {
    const api = fakeApi({
      list: () =>
        Promise.resolve({
          cards: [
            card({ id: "a", companyName: "A社", createdByName: "鈴木 一郎", createdAt: "2026-11-01T00:00:00Z" }),
            card({ id: "b", companyName: "B社", createdByName: "青木 次郎", createdAt: "2026-11-03T00:00:00Z" }),
            card({ id: "c", companyName: "C社", createdByName: "佐藤 三郎", createdAt: "2026-11-02T00:00:00Z" }),
          ],
        }),
    });
    renderWith(<SponsorCardsScreen />, api);
    await screen.findByTestId("fe2-sponsor-card-a");
    expect(names()).toEqual(["B社", "C社", "A社"]);
    fireEvent.click(screen.getByRole("button", { name: /登録日時/ }));
    expect(names()).toEqual(["A社", "C社", "B社"]);
    fireEvent.change(screen.getByTestId("fe2-sponsor-search"), { target: { value: "青木" } });
    await waitFor(() => expect(names()).toEqual(["B社"]));
    fireEvent.change(screen.getByTestId("fe2-sponsor-search"), { target: { value: "" } });
    await waitFor(() => expect(names()).toHaveLength(3));
  });

  it("filters by 登録者 with the shared FilterBar / FilterChips, and offers クリア when nothing matches", async () => {
    renderWith(<SponsorCardsScreen />, fakeApi());
    await screen.findByTestId("fe2-sponsor-card-card_1");
    const bar = screen.getByTestId("fe2-sponsor-filters");
    const chip = within(bar).getByRole("button", { name: /鈴木 一郎/ });
    expect(chip.textContent).toContain("3");
    fireEvent.click(chip);
    expect(names()).toHaveLength(3);
    fireEvent.change(screen.getByTestId("fe2-sponsor-search"), { target: { value: "該当なし" } });
    const empty = await screen.findByTestId("fe2-sponsor-no-match");
    fireEvent.click(within(empty).getByRole("button", { name: "条件をクリア" }));
    await waitFor(() => expect(names()).toHaveLength(3));
    expect(within(screen.getByTestId("fe2-sponsor-filters")).queryByText("クリア")).toBeNull();
  });

  it("searches by company / name / department / memo", async () => {
    renderWith(<SponsorCardsScreen />, fakeApi());
    await screen.findByTestId("fe2-sponsor-card-card_1");
    const search = screen.getByTestId("fe2-sponsor-search");
    fireEvent.change(search, { target: { value: "中村" } });
    expect(names()).toEqual(["金沢クラウド合同会社"]);
    fireEvent.change(search, { target: { value: "事業開発" } });
    expect(names()).toEqual(["株式会社北陸テック"]);
    fireEvent.change(search, { target: { value: "ブース" } });
    expect(names()).toEqual(["金沢クラウド合同会社"]);
    fireEvent.change(search, { target: { value: "該当なし" } });
    expect(screen.getByTestId("fe2-sponsor-no-match")).toBeTruthy();
  });

  it("empty list offers the scan CTA; a failed load offers retry", async () => {
    renderWith(<SponsorCardsScreen />, fakeApi({ list: () => Promise.resolve({ cards: [] }) }));
    expect(await screen.findByTestId("fe2-sponsor-empty-scan")).toBeTruthy();
  });

  it("a failed load shows ErrorState with retry", async () => {
    const list = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ cards: [card()] });
    renderWith(<SponsorCardsScreen />, fakeApi({ list }));
    const err = await screen.findByTestId("fe2-sponsor-error");
    fireEvent.click(within(err).getByRole("button"));
    expect(await screen.findByTestId("fe2-sponsor-card-card_1")).toBeTruthy();
  });

  it("a viewer sees no scan button and no edit / delete in the detail", async () => {
    renderWith(<SponsorCardsScreen />, fakeApi(), VIEWER);
    await screen.findByTestId("fe2-sponsor-card-card_1");
    expect(screen.queryByTestId("fe2-sponsor-scan")).toBeNull();
    fireEvent.click(screen.getByTestId("fe2-sponsor-card-card_1"));
    const detail = await screen.findByTestId("fe2-sponsor-detail");
    expect(within(detail).getByTestId("fe2-sponsor-mailto").getAttribute("href")).toBe("mailto:yamada@example.jp");
    expect(within(detail).getByTestId("fe2-sponsor-tel").getAttribute("href")).toBe("tel:0761234567");
    expect(within(detail).queryByTestId("fe2-sponsor-edit")).toBeNull();
    expect(within(detail).queryByTestId("fe2-sponsor-remove")).toBeNull();
    expect(within(detail).queryByTestId("fe2-sponsor-retake-photo")).toBeNull();
  });

  it("a writer can edit (optimistic) but not delete; 409 rolls back and re-reads", async () => {
    let reject!: (e: unknown) => void;
    const update = vi.fn(() => new Promise<sponsor.BusinessCard>((_r, j) => (reject = j)));
    const get = vi.fn(() => Promise.resolve(card({ companyName: "北陸テック（他の人が更新）", version: 2 })));
    renderWith(<SponsorCardsScreen />, fakeApi({ update, get }), WRITER);
    expect(await screen.findByTestId("fe2-sponsor-scan")).toBeTruthy();
    fireEvent.click(screen.getByTestId("fe2-sponsor-card-card_1"));
    const detail = await screen.findByTestId("fe2-sponsor-detail");
    expect(within(detail).queryByTestId("fe2-sponsor-remove")).toBeNull();
    fireEvent.click(within(detail).getByTestId("fe2-sponsor-edit"));
    fireEvent.change(within(detail).getByTestId("fe2-sponsor-field-companyName"), { target: { value: "北陸テック株式会社" } });
    fireEvent.click(within(detail).getByTestId("fe2-sponsor-edit-save"));
    await waitFor(() => expect(names()[0]).toBe("北陸テック株式会社"));
    expect(update).toHaveBeenCalledWith("card_1", expect.objectContaining({ companyName: "北陸テック株式会社", expectedVersion: 1 }));
    const { ApiError } = await import("../../lib/api-client.tsx");
    await act(async () => reject(new ApiError(409, { error: { code: "SPONSOR_VERSION_CONFLICT", message: "conflict", retryable: false } })));
    await waitFor(() => expect(names()[0]).toBe("北陸テック（他の人が更新）"));
    expect(await screen.findByText("他の人が更新しました")).toBeTruthy();
  });

  it("an admin deletes after confirming (optimistic)", async () => {
    const remove = vi.fn(() => Promise.resolve());
    renderWith(<SponsorCardsScreen />, fakeApi({ remove }));
    await screen.findByTestId("fe2-sponsor-card-card_2");
    fireEvent.click(screen.getByTestId("fe2-sponsor-card-card_2"));
    fireEvent.click(await screen.findByTestId("fe2-sponsor-remove"));
    const dialog = await screen.findByTestId("fe2-sponsor-remove-confirm");
    fireEvent.click(within(dialog).getByRole("button", { name: "削除する" }));
    await waitFor(() => expect(screen.queryByTestId("fe2-sponsor-card-card_2")).toBeNull());
    expect(remove).toHaveBeenCalledWith("card_2");
  });
});

describe("SponsorScanScreen (撮影 → 入力 → 保存)", () => {
  const jpeg = () => new File(["photo"], "card.jpg", { type: "image/jpeg" });

  async function pickPhotoAndFill(company: string) {
    expect(await screen.findByTestId("fe2-sponsor-no-camera")).toBeTruthy();
    fireEvent.change(screen.getByTestId("fe2-sponsor-file"), { target: { files: [jpeg()] } });
    fireEvent.click(await screen.findByTestId("fe2-sponsor-use-photo"));
    fireEvent.change(await screen.findByTestId("fe2-sponsor-field-companyName"), { target: { value: company } });
  }

  it("without a camera: 写真を選ぶ → 保存 adds the card to the list and uploads the photo", async () => {
    const create = vi.fn((b: sponsor.CreateCardRequest) => Promise.resolve(card({ id: "card_new", ...b, personName: null, version: 1 })));
    const uploadImage = vi.fn((id: string) => Promise.resolve(card({ id, companyName: "能登ソフト", personName: null, hasImage: true, version: 2 })));
    renderWith(
      <>
        <SponsorCardsScreen />
        <SponsorScanScreen />
      </>,
      fakeApi({ create, uploadImage }),
    );
    await screen.findByTestId("fe2-sponsor-card-card_1");
    expect(screen.getByTestId("fe2-sponsor-share-notice").textContent).toBe(SHARE_NOTICE);
    await pickPhotoAndFill("能登ソフト");
    fireEvent.click(screen.getByTestId("fe2-sponsor-save"));
    expect(navigate).toHaveBeenCalledWith({ to: "/sponsor" });
    await waitFor(() => expect(names()[0]).toBe("能登ソフト"));
    await waitFor(() => expect(uploadImage).toHaveBeenCalledWith("card_new", expect.any(Blob)));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ companyName: "能登ソフト", personName: null }));
    await waitFor(() => expect(screen.getByTestId("fe2-sponsor-card-card_new")).toBeTruthy());
    expect(screen.queryByTestId("fe2-sponsor-retry-card_new")).toBeNull();
  });

  it("when only the photo upload fails, the card stays and 写真を再送 retries it", async () => {
    const create = vi.fn(() => Promise.resolve(card({ id: "card_new", companyName: "能登ソフト", personName: null })));
    const uploadImage = vi
      .fn<SponsorApi["uploadImage"]>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue(card({ id: "card_new", companyName: "能登ソフト", personName: null, hasImage: true, version: 2 }));
    renderWith(
      <>
        <SponsorCardsScreen />
        <SponsorScanScreen />
      </>,
      fakeApi({ create, uploadImage }),
    );
    await screen.findByTestId("fe2-sponsor-card-card_1");
    await pickPhotoAndFill("能登ソフト");
    fireEvent.click(screen.getByTestId("fe2-sponsor-save"));
    const retry = await screen.findByTestId("fe2-sponsor-retry-card_new");
    expect(screen.getByTestId("fe2-sponsor-card-card_new")).toBeTruthy();
    fireEvent.click(retry);
    await waitFor(() => expect(uploadImage).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("fe2-sponsor-retry-card_new")).toBeNull());
  });

  it("when the card itself fails to save, it is rolled back and the input is restored on the next scan", async () => {
    const create = vi.fn(() => Promise.reject(new Error("offline")));
    const api = fakeApi({ create });
    const view = renderWith(
      <>
        <SponsorCardsScreen />
        <SponsorScanScreen key="first" />
      </>,
      api,
    );
    await screen.findByTestId("fe2-sponsor-card-card_1");
    await pickPhotoAndFill("能登ソフト");
    fireEvent.click(screen.getByTestId("fe2-sponsor-save"));
    expect(await screen.findByText("名刺を保存できませんでした")).toBeTruthy();
    await waitFor(() => expect(names()).not.toContain("能登ソフト"));
    view.unmount();
    renderWith(<SponsorScanScreen />, api);
    expect(await screen.findByTestId("fe2-sponsor-restored")).toBeTruthy();
    expect((screen.getByTestId("fe2-sponsor-field-companyName") as HTMLInputElement).value).toBe("能登ソフト");
    // 共通の DraftRestoredNotice: 破棄で下書きを捨てて撮影からやり直す。
    fireEvent.click(screen.getByTestId("fe2-sponsor-restored-discard"));
    expect(await screen.findByTestId("fe2-sponsor-capture")).toBeTruthy();
    expect(screen.queryByTestId("fe2-sponsor-restored")).toBeNull();
  });

  it("starts the back camera and stops its track on unmount", async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn(() => Promise.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    try {
      const view = renderWith(<SponsorScanScreen />, fakeApi());
      await waitFor(() => expect(screen.getByTestId("fe2-sponsor-shutter")).not.toBeDisabled());
      expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ video: expect.objectContaining({ facingMode: "environment" }) }));
      expect(screen.getByTestId("fe2-sponsor-pick")).toBeTruthy(); // 写真を選ぶは常に出る
      view.unmount();
      expect(stop).toHaveBeenCalled();
    } finally {
      Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    }
  });

  it("a viewer cannot open the scan form", async () => {
    renderWith(<SponsorScanScreen />, fakeApi(), VIEWER);
    expect(await screen.findByTestId("fe2-sponsor-scan-forbidden")).toBeTruthy();
    expect(screen.queryByTestId("fe2-sponsor-capture")).toBeNull();
  });
});

describe("企業 (名刺を会社名でまとめる)", () => {
  const cards = [
    card({ id: "k1", companyName: "株式会社北陸テック", personName: "山田 太郎", createdByName: "鈴木 一郎", createdAt: "2026-11-01T00:00:00Z" }),
    card({ id: "k2", companyName: "（株）北陸テック", personName: "川口 恵", createdByName: "佐藤 三郎", createdAt: "2026-11-03T00:00:00Z" }),
    card({ id: "k3", companyName: "株式会社北陸テック", personName: "山田 太郎", createdByName: "鈴木 一郎", createdAt: "2026-10-20T00:00:00Z" }),
    card({ id: "k4", companyName: "金沢クラウド合同会社", personName: "中村 花", createdAt: "2026-11-02T00:00:00Z" }),
    card({ id: "k5", companyName: null }),
  ];

  it("treats 株式会社 / (株) / 全角 / 空白 as the same company", () => {
    expect(companyKey("株式会社北陸テック")).toBe(companyKey("（株）北陸テック"));
    expect(companyKey("北陸 テック 株式会社")).toBe(companyKey("北陸テック"));
    const { companies, unassigned } = groupCompanies(cards);
    expect(unassigned).toBe(1);
    expect(companies.map((c) => [c.name, c.cards.length])).toEqual([
      ["株式会社北陸テック", 3],
      ["金沢クラウド合同会社", 1],
    ]);
    expect(companies[0]!.members).toEqual(["佐藤 三郎", "鈴木 一郎"]);
    expect(companies[0]!.lastAt).toBe("2026-11-03T00:00:00Z");
  });

  it("suggests existing companies for a differently written name", () => {
    const names = ["株式会社北陸テック", "金沢クラウド合同会社"];
    expect(suggestCompanies("北陸", names)).toEqual(["株式会社北陸テック"]);
    expect(suggestCompanies("ほくりく", names)).toEqual([]);
    expect(suggestCompanies("株式会社北陸テック", names)).toEqual([]);
  });

  it("lists companies; a row opens its cards (who / when) and then the card detail", async () => {
    renderWith(<SponsorCompaniesScreen />, fakeApi({ list: () => Promise.resolve({ cards: cards.map((c) => ({ ...c })) }) }));
    expect(screen.getByTestId("fe2-sponsor-companies-loading")).toBeTruthy();
    const table = await screen.findByTestId("fe2-sponsor-companies-table");
    expect(within(table).getByText("3 枚")).toBeTruthy();
    expect(screen.getByTestId("fe2-sponsor-unassigned").textContent).toContain("1 枚");
    fireEvent.click(within(table).getByText("株式会社北陸テック"));
    const detail = await screen.findByTestId("fe2-sponsor-company-detail");
    const row = within(detail).getByTestId("fe2-sponsor-company-card-k2").closest("tr")!;
    expect(within(row).getByText("佐藤 三郎")).toBeTruthy();
    fireEvent.click(within(detail).getByTestId("fe2-sponsor-company-card-k2"));
    expect(await screen.findByTestId("fe2-sponsor-detail")).toBeTruthy();
  });

  it("filters companies by 接点のあるメンバー", async () => {
    renderWith(<SponsorCompaniesScreen />, fakeApi({ list: () => Promise.resolve({ cards: cards.map((c) => ({ ...c })) }) }));
    const table = await screen.findByTestId("fe2-sponsor-companies-table");
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    fireEvent.click(within(screen.getByTestId("fe2-sponsor-companies-filters")).getByRole("button", { name: /佐藤 三郎/ }));
    await waitFor(() => expect(within(screen.getByTestId("fe2-sponsor-companies-table")).getAllByRole("row")).toHaveLength(2));
    expect(screen.getByText("株式会社北陸テック")).toBeTruthy();
  });

  it("the scan form offers an existing company and fills it in on tap", async () => {
    renderWith(<SponsorScanScreen />, fakeApi({ list: () => Promise.resolve({ cards: cards.map((c) => ({ ...c })) }) }));
    fireEvent.click(await screen.findByTestId("fe2-sponsor-skip-photo"));
    const field = await screen.findByTestId("fe2-sponsor-field-companyName");
    fireEvent.change(field, { target: { value: "北陸テック" } });
    const suggest = await screen.findByTestId("fe2-sponsor-company-suggest");
    fireEvent.click(within(suggest).getByRole("button", { name: "株式会社北陸テック" }));
    expect((field as HTMLInputElement).value).toBe("株式会社北陸テック");
    expect(screen.queryByTestId("fe2-sponsor-company-suggest")).toBeNull();
  });
});
