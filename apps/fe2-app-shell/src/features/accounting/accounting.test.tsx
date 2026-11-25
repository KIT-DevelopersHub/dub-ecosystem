// 会計のテスト。demo transport が /members/accounting/issuer の契約に応答すること (REAL api-client 経由) と、
// 画面のスケルトン・未設定表示・登録番号の検査・権限の出し分け・保存の楽観更新/ロールバック。
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { accounting, identity } from "@dub/types";
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

function fakeApi(issuer: accounting.AccountingIssuer | null, over: Partial<AccountingApi> = {}): AccountingApi {
  return {
    getIssuer: vi.fn(async () => ({ issuer })),
    putIssuer: vi.fn(async ({ expectedVersion, ...s }) => ({ ...ISSUER, ...s, version: expectedVersion + 1 })),
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
    expect(saved).toMatchObject({ version: 1, invoiceRegistrationNo: "T7000012050002" });
    await expect(api.putIssuer({ ...base, invoiceRegistrationNo: null, expectedVersion: 0 })).rejects.toMatchObject({ status: 409 });
    await expect(api.putIssuer({ ...base, invoiceRegistrationNo: "T12", expectedVersion: 1 })).rejects.toMatchObject({ status: 400 });
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

  it("blocks a registration number whose check digit does not match", async () => {
    const api = fakeApi(ISSUER);
    mount(api);
    fireEvent.change(await screen.findByTestId("fe2-accounting-field-invoiceRegistrationNo"), { target: { value: "T1234567890123" } });
    fireEvent.click(screen.getByTestId("fe2-accounting-save"));
    expect(await screen.findByText(/登録番号が正しくありません/)).toBeInTheDocument();
    expect(api.putIssuer).not.toHaveBeenCalled();
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
