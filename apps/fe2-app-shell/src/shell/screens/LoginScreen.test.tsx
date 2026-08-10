import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ApiClient } from "../../lib/api-client.tsx";
import { ApiError } from "../../lib/api-client.tsx";
import { LoginScreen } from "./LoginScreen.tsx";

function makeApi(over: Partial<ApiClient["auth"]>): ApiClient {
  return {
    auth: {
      passwordLogin: vi.fn(),
      logout: vi.fn(),
      me: vi.fn(),
      ...over,
    },
  } as unknown as ApiClient;
}

let assignSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  assignSpy = vi.fn();
  // jsdom location.assign is a no-op that warns; replace it so we can assert nav.
  Object.defineProperty(globalThis, "location", {
    value: { ...globalThis.location, assign: assignSpy, pathname: "/", search: "" },
    writable: true,
    configurable: true,
  });
});
afterEach(() => vi.restoreAllMocks());

describe("LoginScreen — email/password", () => {
  it("submits email+password and navigates to redirectPath on success", async () => {
    const passwordLogin = vi.fn().mockResolvedValue(undefined);
    render(<LoginScreen api={makeApi({ passwordLogin })} redirectPath="/dashboard" />);

    fireEvent.change(screen.getByTestId("fe2-login-email"), { target: { value: "admin@dub.local" } });
    fireEvent.change(screen.getByTestId("fe2-login-password"), { target: { value: "demo-admin-pw" } });
    fireEvent.click(screen.getByTestId("fe2-login-submit"));

    await waitFor(() => expect(passwordLogin).toHaveBeenCalledWith("admin@dub.local", "demo-admin-pw"));
    await waitFor(() => expect(assignSpy).toHaveBeenCalledWith("/dashboard"));
  });

  it("shows an error and does not navigate when credentials are rejected", async () => {
    const passwordLogin = vi.fn().mockRejectedValue(
      new ApiError(401, { error: { code: "AUTH_INVALID_CREDENTIALS", message: "bad", retryable: false } }),
    );
    render(<LoginScreen api={makeApi({ passwordLogin })} />);

    fireEvent.change(screen.getByTestId("fe2-login-email"), { target: { value: "admin@dub.local" } });
    fireEvent.change(screen.getByTestId("fe2-login-password"), { target: { value: "nope" } });
    fireEvent.click(screen.getByTestId("fe2-login-submit"));

    await waitFor(() => expect(screen.getByTestId("fe2-login-error")).toBeInTheDocument());
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("has no Google login button (Google OAuth removed)", () => {
    render(<LoginScreen api={makeApi({})} />);
    expect(screen.queryByTestId("fe2-login-google")).toBeNull();
  });

  it("disables submit until both fields are filled", () => {
    render(<LoginScreen api={makeApi({})} />);
    expect(screen.getByTestId("fe2-login-submit")).toBeDisabled();
    fireEvent.change(screen.getByTestId("fe2-login-email"), { target: { value: "a@b.c" } });
    expect(screen.getByTestId("fe2-login-submit")).toBeDisabled();
    fireEvent.change(screen.getByTestId("fe2-login-password"), { target: { value: "pw" } });
    expect(screen.getByTestId("fe2-login-submit")).not.toBeDisabled();
  });
});
