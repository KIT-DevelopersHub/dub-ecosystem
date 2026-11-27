// 会計のテスト。demo transport が /members/accounting/issuer の契約に応答すること (REAL api-client 経由) と、
// 画面のスケルトン・未設定表示・登録番号の検査・権限の出し分け・保存の楽観更新/ロールバック。
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import { privacyPolicy, type accounting, type identity } from "@dub/types";
import { describe, expect, it, vi } from "vitest";
import { editorPermissions, FakeAuthProvider, viewerPermissions } from "../../auth/test-support.tsx";
import { ApiError, createApiClient } from "../../lib/api-client.tsx";
import { createDemoFetch } from "../../lib/demo-seed.tsx";
import { createAccountingApi, type AccountingApi } from "./accountingApi.tsx";
import { AccountingApiProvider } from "./AccountingProvider.tsx";
import { AccountingScreen } from "./AccountingScreen.tsx";

const EDITOR = editorPermissions("accounting", ["accounting:read"]);
const VIEWER = viewerPermissions("accounting", ["accounting:read"]);

const ISSUER: accounting.AccountingIssuer = {
  name: "一般社団法人 Developers Hub", officeName: null, postalCode: "920-0000", address: "石川県金沢市", phone: null,
  email: "info@developershub.jp", url: "https://developershub.jp", invoiceRegistrationNo: null, taxRatePercent: 10,
  version: 3, updatedBy: "usr_1" as accounting.AccountingIssuer["updatedBy"], updatedByName: "佐藤", updatedAt: "2026-11-01T00:00:00Z",
};

const POLICY: accounting.PrivacyPolicy = {
  body: "## 1. 取得する情報\n\n- 氏名", version: 2, updatedBy: "usr_1" as accounting.PrivacyPolicy["updatedBy"], updatedByName: "佐藤", updatedAt: "2026-11-20T01:00:00Z",
};
const POLICY_RES: accounting.GetPrivacyPolicyResponse = {
  policy: POLICY,
  history: [{ version: 2, updatedByName: "佐藤", updatedAt: POLICY.updatedAt }, { version: 1, updatedByName: "鈴木", updatedAt: "2026-11-10T01:00:00Z" }],
};

function fakeApi(issuer: accounting.AccountingIssuer | null, over: Partial<AccountingApi> = {}): AccountingApi {
  return {
    getIssuer: vi.fn(async () => ({ issuer })),
    putIssuer: vi.fn(async ({ expectedVersion, ...s }) => ({ ...ISSUER, ...s, version: expectedVersion + 1, warnings: [] })),
    getPrivacyPolicy: vi.fn(async () => ({ policy: null, history: [] })),
    putPrivacyPolicy: vi.fn(async ({ body, expectedVersion }) => ({ ...POLICY, body, version: expectedVersion + 1, updatedAt: "2026-11-27T03:00:00Z" })),
    ...over,
  };
}

function mount(api: AccountingApi, permissions: readonly identity.PermissionKey[] = EDITOR) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <FakeAuthProvider permissions={[...permissions]}>
          <AccountingApiProvider value={api}><AccountingScreen /></AccountingApiProvider>
        </FakeAuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return qc;
}

const field = (key: string) => screen.getByTestId(`fe2-accounting-field-${key}`);

describe("会計 demo transport", () => {
  it("starts unset, saves with a version check and normalizes the registration number", async () => {
    const api = createAccountingApi(createApiClient({ baseUrl: "http://demo", fetchImpl: createDemoFetch() }));
    expect((await api.getIssuer()).issuer).toBeNull();
    const base = { name: "法人", officeName: null, postalCode: null, address: null, phone: null, email: null, url: null, taxRatePercent: 10 as const };
    const saved = await api.putIssuer({ ...base, invoiceRegistrationNo: "t7000012050002", expectedVersion: 0 });
    expect(saved).toMatchObject({ version: 1, invoiceRegistrationNo: "T7000012050002", warnings: [] });
    await expect(api.putIssuer({ ...base, invoiceRegistrationNo: null, expectedVersion: 0 })).rejects.toMatchObject({ status: 409 });
    await expect(api.putIssuer({ ...base, invoiceRegistrationNo: "T12", expectedVersion: 1 })).rejects.toMatchObject({ status: 400 });
    // 確認用の数字が合わない番号は保存して warnings で知らせる。
    const warned = await api.putIssuer({ ...base, invoiceRegistrationNo: "T1234567890123", expectedVersion: 1 });
    expect(warned).toMatchObject({ version: 2, invoiceRegistrationNo: "T1234567890123", warnings: ["check_digit"] });
  });
});

describe("AccountingScreen", () => {
  it("shows a skeleton while loading, then the unset note", async () => {
    let resolve: (v: accounting.GetIssuerResponse) => void = () => {};
    mount(fakeApi(null, { getIssuer: () => new Promise((r) => { resolve = r; }) }));
    expect(screen.getByTestId("fe2-accounting-skeleton")).toBeInTheDocument();
    resolve({ issuer: null });
    expect(await screen.findByTestId("fe2-accounting-unset")).toBeInTheDocument();
    expect(screen.getByText("未設定")).toBeInTheDocument();
  });

  it("blocks a malformed registration number with a field error and sends nothing", async () => {
    const api = fakeApi(ISSUER);
    mount(api);
    fireEvent.change(await screen.findByTestId("fe2-accounting-field-invoiceRegistrationNo"), { target: { value: "T123" } });
    fireEvent.click(screen.getByTestId("fe2-accounting-save"));
    expect(await screen.findByText(/T と 13 桁の数字で入力してください/)).toBeInTheDocument();
    expect(api.putIssuer).not.toHaveBeenCalled();
  });

  it("warns (without blocking) when the check digit does not match, and still saves", async () => {
    const api = fakeApi(ISSUER);
    mount(api);
    fireEvent.change(await screen.findByTestId("fe2-accounting-field-invoiceRegistrationNo"), { target: { value: "T1234567890123" } });
    // 入力中から注意が出て、保存ボタンは押せるまま。
    expect(screen.getByTestId("fe2-accounting-warning-invoiceRegistrationNo")).toHaveTextContent(
      "登録番号の確認用の数字が合いません。法人の場合は番号をご確認ください（個人事業者の番号はこの確認に当てはまらないことがあります）",
    );
    expect(screen.getByTestId("fe2-accounting-save")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("fe2-accounting-save"));
    await waitFor(() => expect(api.putIssuer).toHaveBeenCalledWith(expect.objectContaining({ invoiceRegistrationNo: "T1234567890123", expectedVersion: 3 })));
    expect(await screen.findByText("発行者情報を保存しました")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-accounting-warning-invoiceRegistrationNo")).toBeInTheDocument();
  });

  it("shows no warning for a matching or malformed number", async () => {
    mount(fakeApi(ISSUER));
    fireEvent.change(await screen.findByTestId("fe2-accounting-field-invoiceRegistrationNo"), { target: { value: "T7000012050002" } });
    expect(screen.queryByTestId("fe2-accounting-warning-invoiceRegistrationNo")).toBeNull();
    fireEvent.change(field("invoiceRegistrationNo"), { target: { value: "T123" } });
    expect(screen.queryByTestId("fe2-accounting-warning-invoiceRegistrationNo")).toBeNull();
  });

  it("saves the normalized values with the current version", async () => {
    const api = fakeApi(ISSUER);
    mount(api);
    fireEvent.change(await screen.findByTestId("fe2-accounting-field-invoiceRegistrationNo"), { target: { value: "t 7000-0120-50002" } });
    fireEvent.change(field("postalCode"), { target: { value: "9201234" } });
    fireEvent.click(screen.getByTestId("fe2-accounting-save"));
    await waitFor(() =>
      expect(api.putIssuer).toHaveBeenCalledWith({
        ...ISSUER, version: undefined, updatedBy: undefined, updatedByName: undefined, updatedAt: undefined,
        postalCode: "920-1234", invoiceRegistrationNo: "T7000012050002", expectedVersion: 3,
      }),
    );
    expect(field("invoiceRegistrationNo")).toHaveValue("T7000012050002");
    expect(await screen.findByText("発行者情報を保存しました")).toBeInTheDocument();
  });

  it("explains a conflict and keeps the typed input", async () => {
    const putIssuer = vi.fn(async () => {
      throw new ApiError(409, { error: { code: "ACCOUNTING_VERSION_CONFLICT", message: "conflict" } } as never);
    });
    mount(fakeApi(ISSUER, { putIssuer }));
    fireEvent.change(await screen.findByTestId("fe2-accounting-field-address"), { target: { value: "富山県" } });
    fireEvent.click(screen.getByTestId("fe2-accounting-save"));
    expect(await screen.findByText("他の人が先に更新しました。最新の内容を確認してください")).toBeInTheDocument();
    expect(field("address")).toHaveValue("富山県");
  });

  it("is read-only for a viewer", async () => {
    mount(fakeApi(ISSUER), VIEWER);
    expect(await screen.findByTestId("fe2-accounting-readonly")).toBeInTheDocument();
    expect(field("name")).toBeDisabled();
    expect(screen.getByTestId("fe2-accounting-save")).toBeDisabled();
  });
});

describe("会計 プライバシーポリシー demo transport", () => {
  it("keeps versions with history and rejects a stale version", async () => {
    const api = createAccountingApi(createApiClient({ baseUrl: "http://demo", fetchImpl: createDemoFetch() }));
    expect(await api.getPrivacyPolicy()).toEqual({ policy: null, history: [] });
    expect(await api.putPrivacyPolicy({ body: "初版\r\n", expectedVersion: 0 })).toMatchObject({ body: "初版", version: 1 });
    await api.putPrivacyPolicy({ body: "改定", expectedVersion: 1 });
    await expect(api.putPrivacyPolicy({ body: "古い", expectedVersion: 1 })).rejects.toMatchObject({ status: 409 });
    await expect(api.putPrivacyPolicy({ body: " ", expectedVersion: 2 })).rejects.toMatchObject({ status: 400 });
    const got = await api.getPrivacyPolicy();
    expect(got.policy).toMatchObject({ body: "改定", version: 2 });
    expect(got.history.map((h) => h.version)).toEqual([2, 1]);
  });
});

describe("AccountingScreen プライバシーポリシー", () => {
  const openTab = () => fireEvent.click(screen.getByTestId("fe2-accounting-tab-privacy"));
  const bodyField = () => screen.getByTestId("fe2-accounting-privacy-body");

  it("shows a skeleton, then the default draft when nothing is saved yet", async () => {
    let resolve: (v: accounting.GetPrivacyPolicyResponse) => void = () => {};
    mount(fakeApi(ISSUER, { getPrivacyPolicy: () => new Promise((r) => { resolve = r; }) }));
    openTab();
    expect(screen.getByTestId("fe2-accounting-privacy-skeleton")).toBeInTheDocument();
    resolve({ policy: null, history: [] });
    expect(await screen.findByTestId("fe2-accounting-privacy-unset")).toBeInTheDocument();
    expect(bodyField()).toHaveValue(privacyPolicy.DEFAULT_PRIVACY_POLICY);
    expect(screen.getByText("初期文案を表示中")).toBeInTheDocument();
    // 未保存でも初期文案をそのまま保存できる。
    expect(screen.getByTestId("fe2-accounting-privacy-save")).not.toBeDisabled();
  });

  it("previews the Markdown safely and lists the history", async () => {
    mount(fakeApi(ISSUER, { getPrivacyPolicy: vi.fn(async () => POLICY_RES) }));
    openTab();
    fireEvent.change(await screen.findByTestId("fe2-accounting-privacy-body"), { target: { value: "## 見出し\n\n<script>alert(1)</script>" } });
    const preview = screen.getByTestId("fe2-accounting-privacy-preview");
    expect(preview.querySelector("h3")).toHaveTextContent("見出し");
    expect(preview.querySelector("script")).toBeNull();
    expect(preview).toHaveTextContent("<script>alert(1)</script>");
    expect(screen.getByTestId("fe2-accounting-privacy-rev-2")).toHaveTextContent("佐藤");
    expect(screen.getByTestId("fe2-accounting-privacy-rev-1")).toHaveTextContent("鈴木");
    expect(screen.getByTestId("fe2-accounting-privacy-dirty")).toBeInTheDocument();
  });

  it("saves optimistically with the current version", async () => {
    let release: () => void = () => {};
    const putPrivacyPolicy = vi.fn(
      ({ body, expectedVersion }: accounting.PutPrivacyPolicyRequest) =>
        new Promise<accounting.PrivacyPolicy>((r) => { release = () => r({ ...POLICY, body, version: expectedVersion + 1 }); }),
    );
    mount(fakeApi(ISSUER, { getPrivacyPolicy: vi.fn(async () => POLICY_RES), putPrivacyPolicy }));
    openTab();
    fireEvent.change(await screen.findByTestId("fe2-accounting-privacy-body"), { target: { value: "改定した本文  " } });
    fireEvent.click(screen.getByTestId("fe2-accounting-privacy-save"));
    await waitFor(() => expect(putPrivacyPolicy).toHaveBeenCalledWith({ body: "改定した本文", expectedVersion: 2 }));
    // 返事を待たずに履歴の先頭に第 3 版が出る。
    expect(await screen.findByTestId("fe2-accounting-privacy-rev-3")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-accounting-privacy-save")).toBeDisabled();
    release();
    expect(await screen.findByText("プライバシーポリシーを保存しました")).toBeInTheDocument();
  });

  it("rolls back the history on a conflict but keeps the typed text", async () => {
    const putPrivacyPolicy = vi.fn(async () => {
      throw new ApiError(409, { error: { code: "ACCOUNTING_PRIVACY_POLICY_VERSION_CONFLICT", message: "conflict" } } as never);
    });
    mount(fakeApi(ISSUER, { getPrivacyPolicy: vi.fn(async () => POLICY_RES), putPrivacyPolicy }));
    openTab();
    fireEvent.change(await screen.findByTestId("fe2-accounting-privacy-body"), { target: { value: "私の変更" } });
    fireEvent.click(screen.getByTestId("fe2-accounting-privacy-save"));
    expect(await screen.findByText("他の人が先に更新しました。最新の内容を確認してください")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("fe2-accounting-privacy-rev-3")).toBeNull());
    expect(bodyField()).toHaveValue("私の変更");
  });

  it("blocks an empty body", async () => {
    const api = fakeApi(ISSUER, { getPrivacyPolicy: vi.fn(async () => POLICY_RES) });
    mount(api);
    openTab();
    fireEvent.change(await screen.findByTestId("fe2-accounting-privacy-body"), { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("fe2-accounting-privacy-save"));
    expect(await screen.findByText("本文を入力してください")).toBeInTheDocument();
    expect(api.putPrivacyPolicy).not.toHaveBeenCalled();
  });

  it("is read-only for a viewer", async () => {
    mount(fakeApi(ISSUER, { getPrivacyPolicy: vi.fn(async () => POLICY_RES) }), VIEWER);
    openTab();
    expect(await screen.findByTestId("fe2-accounting-privacy-readonly")).toBeInTheDocument();
    expect(bodyField()).toBeDisabled();
    expect(screen.getByTestId("fe2-accounting-privacy-save")).toBeDisabled();
    expect(screen.getByTestId("fe2-accounting-privacy-reset")).toBeDisabled();
  });
});
