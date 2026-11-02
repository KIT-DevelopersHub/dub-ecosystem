import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { auth as authTypes } from "@dub/types";
import { AuthProvider } from "../auth/AuthProvider.tsx";
import { fakeMe } from "../auth/test-support.tsx";
import type { ApiClient } from "../lib/api-client.tsx";
import { ApiError } from "../lib/api-client.tsx";
import StagingDebugMenu from "./StagingDebugMenu.tsx";
import { isDebugShortcut } from "./useStagingDebugShortcut.ts";

const ACCOUNTS: authTypes.DemoAccountsResponse = {
  accounts: [
    { email: "demo-admin@developershub.jp", userId: "usr_test", displayName: "Demo Admin", label: "admin", isDefault: true },
    { email: "demo-member@dev.developershub.jp", userId: "usr_member", displayName: "Demo Member", label: "member", isDefault: false },
  ],
};

function makeApi(over: Partial<ApiClient["auth"]> = {}): ApiClient {
  return {
    auth: {
      me: vi.fn().mockResolvedValue(fakeMe(["identity:admin"])),
      logout: vi.fn().mockResolvedValue(undefined),
      demoLogin: vi.fn().mockResolvedValue(undefined),
      demoAccounts: vi.fn().mockResolvedValue(ACCOUNTS),
      ...over,
    },
  } as unknown as ApiClient;
}

function renderMenu(api: ApiClient, showFab = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <AuthProvider api={api}>
          <StagingDebugMenu api={api} mode="staging" apiBaseUrl="https://gw.example" showFab={showFab} buildInfo={{ sha: "abc123", time: "t" }} />
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const pressShortcut = () => fireEvent.keyDown(window, { key: "D", metaKey: true, shiftKey: true });

let reloadSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  reloadSpy = vi.fn();
  Object.defineProperty(globalThis, "location", {
    value: { ...globalThis.location, reload: reloadSpy, pathname: "/", search: "", host: "localhost" },
    writable: true,
    configurable: true,
  });
});
afterEach(() => vi.restoreAllMocks());

describe("StagingDebugMenu", () => {
  it("opens from the floating button and shows current user, env and build", async () => {
    renderMenu(makeApi());
    fireEvent.click(screen.getByLabelText(/デバッグメニューを開く/));
    expect(await screen.findByTestId("fe2-staging-debug-menu")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("fe2-debug-current")).toHaveTextContent("usr_test"));
    expect(screen.getByTestId("fe2-debug-current")).toHaveTextContent("管理者（identity:admin）");
    expect(screen.getByTestId("fe2-debug-env")).toHaveTextContent("https://gw.example");
    expect(screen.getByTestId("fe2-debug-env")).toHaveTextContent("abc123");
  });

  it("toggles with ⌘⇧D even without the floating button", async () => {
    renderMenu(makeApi(), false);
    expect(screen.queryByTestId("fe2-staging-debug-fab")).toBeNull();
    pressShortcut();
    expect(await screen.findByTestId("fe2-staging-debug-menu")).toBeInTheDocument();
  });

  it("marks the signed-in account and switches to another in one click", async () => {
    const api = makeApi();
    renderMenu(api);
    pressShortcut();
    await screen.findByTestId("fe2-debug-accounts");
    expect(screen.getByTestId("fe2-debug-switch-demo-admin@developershub.jp")).toBeDisabled();
    fireEvent.click(screen.getByTestId("fe2-debug-switch-demo-member@dev.developershub.jp"));
    await waitFor(() => expect(api.auth.demoLogin).toHaveBeenCalledWith("demo-member@dev.developershub.jp"));
    expect(api.auth.logout).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(reloadSpy).toHaveBeenCalledTimes(1));
  });

  it("shows the server's refusal and does not reload", async () => {
    const demoLogin = vi.fn().mockRejectedValue(
      new ApiError(403, { error: { code: "AUTH_NOT_ON_ALLOWLIST", message: "This account is not permitted to log in", retryable: false } }),
    );
    renderMenu(makeApi({ demoLogin }));
    pressShortcut();
    await screen.findByTestId("fe2-debug-accounts");
    fireEvent.click(screen.getByTestId("fe2-debug-switch-demo-member@dev.developershub.jp"));
    expect(await screen.findByTestId("fe2-debug-switch-error")).toBeInTheDocument();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it("shows an empty state when no seed account is on the roster", async () => {
    renderMenu(makeApi({ demoAccounts: vi.fn().mockResolvedValue({ accounts: [] }) }));
    pressShortcut();
    expect(await screen.findByText("切り替え可能なアカウントがありません")).toBeInTheDocument();
  });
});

describe("isDebugShortcut", () => {
  const base = { key: "d", metaKey: false, ctrlKey: false, shiftKey: true, altKey: false, isComposing: false };
  it("accepts ⌘⇧D and Ctrl+Shift+D only", () => {
    expect(isDebugShortcut({ ...base, metaKey: true })).toBe(true);
    expect(isDebugShortcut({ ...base, ctrlKey: true, key: "D" })).toBe(true);
    expect(isDebugShortcut({ ...base, metaKey: true, shiftKey: false })).toBe(false);
    expect(isDebugShortcut({ ...base, metaKey: true, isComposing: true })).toBe(false);
    expect(isDebugShortcut({ ...base, metaKey: true, key: "k" })).toBe(false);
  });
});
