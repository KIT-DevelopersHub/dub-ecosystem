// Passkey UI: login primary path + fallback, and the management dialog (step-up add,
// optimistic delete with rollback). The browser WebAuthn half is mocked — the real
// ceremony is covered by auth-service tests (software authenticator) and staging E2E.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import { ApiError, type ApiClient, type PasskeySummary } from "../lib/api-client.tsx";
import { LoginScreen } from "./screens/LoginScreen.tsx";
import { PasskeysDialog } from "./PasskeysDialog.tsx";

const webauthn = vi.hoisted(() => ({
  supported: true,
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}));
vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: () => webauthn.supported,
  startAuthentication: webauthn.startAuthentication,
  startRegistration: webauthn.startRegistration,
}));

const apiError = (status: number, code: string) => new ApiError(status, { error: { code, message: code, retryable: false } });

function makeApi(passkeys: Partial<ApiClient["auth"]["passkeys"]>): ApiClient {
  return { auth: { passwordLogin: vi.fn(), passkeys: { ...passkeys } } } as unknown as ApiClient;
}

let assignSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  webauthn.supported = true;
  webauthn.startAuthentication.mockReset();
  webauthn.startRegistration.mockReset();
  assignSpy = vi.fn();
  Object.defineProperty(globalThis, "location", {
    value: { ...globalThis.location, assign: assignSpy, pathname: "/", search: "" },
    writable: true,
    configurable: true,
  });
});
afterEach(() => vi.restoreAllMocks());

describe("LoginScreen — passkey", () => {
  it("passkey is the primary action and signs in", async () => {
    const loginOptions = vi.fn().mockResolvedValue({ challenge: "c" });
    const loginVerify = vi.fn().mockResolvedValue(undefined);
    webauthn.startAuthentication.mockResolvedValue({ id: "cred" });
    render(<LoginScreen api={makeApi({ loginOptions, loginVerify })} redirectPath="/home" />);

    fireEvent.click(screen.getByTestId("fe2-login-passkey"));
    await waitFor(() => expect(assignSpy).toHaveBeenCalledWith("/home"));
    expect(webauthn.startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: "c" } });
    expect(loginVerify).toHaveBeenCalledWith({ id: "cred" });
  });

  it("closing the OS prompt is not an error: it points at the password form", async () => {
    webauthn.startAuthentication.mockRejectedValue(Object.assign(new Error("closed"), { name: "NotAllowedError" }));
    render(<LoginScreen api={makeApi({ loginOptions: vi.fn().mockResolvedValue({}) })} />);
    fireEvent.click(screen.getByTestId("fe2-login-passkey"));
    await waitFor(() => expect(screen.getByTestId("fe2-login-hint")).toBeInTheDocument());
    expect(screen.queryByTestId("fe2-login-error")).toBeNull();
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("server rejection shows an error and keeps the password path", async () => {
    webauthn.startAuthentication.mockResolvedValue({ id: "cred" });
    const loginVerify = vi.fn().mockRejectedValue(apiError(401, "AUTH_PASSKEY_FAILED"));
    render(<LoginScreen api={makeApi({ loginOptions: vi.fn().mockResolvedValue({}), loginVerify })} />);
    fireEvent.click(screen.getByTestId("fe2-login-passkey"));
    await waitFor(() => expect(screen.getByTestId("fe2-login-error")).toHaveTextContent("パスワードでログイン"));
    expect(screen.getByTestId("fe2-login-submit")).toBeInTheDocument();
  });

  it("environment with passkeys off: button disappears, password becomes primary", async () => {
    render(<LoginScreen api={makeApi({ loginOptions: vi.fn().mockRejectedValue(apiError(404, "AUTH_PASSKEY_DISABLED")) })} />);
    fireEvent.click(screen.getByTestId("fe2-login-passkey"));
    await waitFor(() => expect(screen.queryByTestId("fe2-login-passkey")).toBeNull());
    expect(screen.queryByTestId("fe2-login-error")).toBeNull();
  });

  it("browser without WebAuthn: password form only", () => {
    webauthn.supported = false;
    render(<LoginScreen api={makeApi({})} />);
    expect(screen.queryByTestId("fe2-login-passkey")).toBeNull();
    expect(screen.getByTestId("fe2-login-submit")).toBeInTheDocument();
  });
});

const PK: PasskeySummary = { id: "pk1", label: "MacBook", createdAt: "2026-10-01T00:00:00Z", lastUsedAt: null, backedUp: true };

function renderDialog(passkeys: Partial<ApiClient["auth"]["passkeys"]>, onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const api = makeApi(passkeys);
  const ui = (open: boolean) => (
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <PasskeysDialog api={api} open={open} onClose={onClose} />
      </ToastProvider>
    </QueryClientProvider>
  );
  const r = render(ui(true));
  return { rerender: (open: boolean) => r.rerender(ui(open)) };
}

describe("PasskeysDialog", () => {
  it("shows a skeleton while loading, then the list", async () => {
    let resolve!: (v: { items: PasskeySummary[] }) => void;
    renderDialog({ list: vi.fn(() => new Promise<{ items: PasskeySummary[] }>((r) => (resolve = r))) });
    expect(screen.getByTestId("fe2-passkeys-loading")).toBeInTheDocument();
    resolve({ items: [PK] });
    await waitFor(() => expect(screen.getByTestId("fe2-passkeys-list")).toHaveTextContent("MacBook"));
  });

  it("adds a passkey only after the step-up password, and lists it", async () => {
    const user = userEvent.setup();
    const registerOptions = vi.fn().mockResolvedValue({ challenge: "r" });
    const registerVerify = vi.fn().mockResolvedValue({ passkey: { ...PK, id: "pk2", label: "iPhone" } });
    webauthn.startRegistration.mockResolvedValue({ id: "pk2" });
    renderDialog({ list: vi.fn().mockResolvedValue({ items: [] }), registerOptions, registerVerify });

    await user.click(await screen.findByTestId("fe2-passkeys-add"));
    expect(screen.getByTestId("fe2-passkeys-add-submit")).toBeDisabled(); // no password yet
    await user.type(screen.getByTestId("fe2-passkeys-password"), "my-password");
    await user.clear(screen.getByTestId("fe2-passkeys-label"));
    await user.type(screen.getByTestId("fe2-passkeys-label"), "iPhone");
    await user.click(screen.getByTestId("fe2-passkeys-add-submit"));

    await waitFor(() => expect(screen.getByTestId("fe2-passkeys-list")).toHaveTextContent("iPhone"));
    expect(registerOptions).toHaveBeenCalledWith("my-password");
    expect(registerVerify).toHaveBeenCalledWith({ id: "pk2" }, "iPhone");
  });

  it("a wrong step-up password is shown inline", async () => {
    const user = userEvent.setup();
    renderDialog({
      list: vi.fn().mockResolvedValue({ items: [] }),
      registerOptions: vi.fn().mockRejectedValue(apiError(403, "AUTH_STEP_UP_FAILED")),
    });
    await user.click(await screen.findByTestId("fe2-passkeys-add"));
    await user.type(screen.getByTestId("fe2-passkeys-password"), "wrong");
    await user.click(screen.getByTestId("fe2-passkeys-add-submit"));
    await waitFor(() => expect(screen.getByTestId("fe2-passkeys-add-error")).toHaveTextContent("パスワードが正しくありません"));
    expect(webauthn.startRegistration).not.toHaveBeenCalled();
  });

  it("delete is optimistic and rolls back when the server refuses (last sign-in method)", async () => {
    const user = userEvent.setup();
    let reject!: (e: unknown) => void;
    const remove = vi.fn(() => new Promise<void>((_, r) => (reject = r)));
    renderDialog({ list: vi.fn().mockResolvedValue({ items: [PK] }), remove });

    await user.click(await screen.findByTestId("fe2-passkeys-delete"));
    await user.click(screen.getByRole("button", { name: "削除する" }));
    await waitFor(() => expect(screen.getByTestId("fe2-passkeys-empty")).toBeInTheDocument()); // removed at once
    reject(apiError(409, "AUTH_LAST_AUTH_METHOD"));
    await waitFor(() => expect(screen.getByTestId("fe2-passkeys-list")).toHaveTextContent("MacBook")); // rolled back
    expect(await screen.findByText("最後のログイン手段は削除できません。")).toBeInTheDocument();
  });

  it("rename is optimistic", async () => {
    const user = userEvent.setup();
    const server = { items: [PK] };
    const rename = vi.fn(async (_id: string, label: string) => {
      server.items = [{ ...PK, label }];
    });
    renderDialog({ list: vi.fn(async () => ({ items: [...server.items] })), rename });
    await user.click(await screen.findByTestId("fe2-passkeys-rename"));
    await user.clear(screen.getByTestId("fe2-passkeys-rename-input"));
    await user.type(screen.getByTestId("fe2-passkeys-rename-input"), "仕事用Mac");
    await user.click(screen.getByTestId("fe2-passkeys-rename-save"));
    await waitFor(() => expect(screen.getByTestId("fe2-passkeys-list")).toHaveTextContent("仕事用Mac"));
    expect(rename).toHaveBeenCalledWith("pk1", "仕事用Mac");
  });

  it("rename failure restores the old label and explains", async () => {
    const user = userEvent.setup();
    renderDialog({ list: vi.fn().mockResolvedValue({ items: [PK] }), rename: vi.fn().mockRejectedValue(apiError(500, "INTERNAL")) });
    await user.click(await screen.findByTestId("fe2-passkeys-rename"));
    await user.clear(screen.getByTestId("fe2-passkeys-rename-input"));
    await user.type(screen.getByTestId("fe2-passkeys-rename-input"), "新しい名前");
    await user.click(screen.getByTestId("fe2-passkeys-rename-save"));
    expect(await screen.findByText("名前を変更できませんでした")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("fe2-passkeys-list")).toHaveTextContent("MacBook"));
  });

  it("overlapping deletes: a failure brings back only its own row", async () => {
    const user = userEvent.setup();
    const B: PasskeySummary = { ...PK, id: "pk2", label: "iPhone" };
    const pending: Record<string, { resolve: () => void; reject: (e: unknown) => void }> = {};
    const remove = vi.fn((id: string) => new Promise<void>((resolve, reject) => (pending[id] = { resolve, reject })));
    // list() is re-fetched after each mutation; keep it consistent with the server truth.
    const server = { items: [PK, B] };
    renderDialog({ list: vi.fn(async () => ({ items: [...server.items] })), remove });

    const del = async (label: string) => {
      const row = (await screen.findAllByTestId("fe2-passkeys-item")).find((r) => r.textContent?.includes(label))!;
      await user.click(row.querySelector('[data-testid="fe2-passkeys-delete"]')!);
      await user.click(screen.getByRole("button", { name: "削除する" }));
    };
    await del("MacBook");
    await del("iPhone");
    await waitFor(() => expect(screen.getByTestId("fe2-passkeys-empty")).toBeInTheDocument());

    server.items = [PK]; // B really deleted, A refused
    pending.pk2!.resolve();
    pending.pk1!.reject(apiError(409, "AUTH_LAST_AUTH_METHOD"));
    await waitFor(() => expect(screen.getByTestId("fe2-passkeys-list")).toHaveTextContent("MacBook"));
    expect(screen.getByTestId("fe2-passkeys-list")).not.toHaveTextContent("iPhone");
  });

  it("closing clears the typed step-up password", async () => {
    const user = userEvent.setup();
    const { rerender } = renderDialog({ list: vi.fn().mockResolvedValue({ items: [] }) }, vi.fn());
    await user.click(await screen.findByTestId("fe2-passkeys-add"));
    await user.type(screen.getByTestId("fe2-passkeys-password"), "secret");
    await user.click(screen.getByTestId("fe2-passkeys-close"));
    rerender(false);
    rerender(true);
    expect(screen.queryByTestId("fe2-passkeys-password")).toBeNull();
  });
});
