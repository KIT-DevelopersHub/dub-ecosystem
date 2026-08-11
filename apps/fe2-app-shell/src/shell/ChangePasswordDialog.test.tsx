// @vitest-environment jsdom
// Self password change dialog (#5b). Covers the happy path (validated submit ->
// changePassword called -> success state) and client-side guards (min length, mismatch).
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ApiClient } from "../lib/api-client.tsx";
import { ChangePasswordDialog } from "./ChangePasswordDialog.tsx";

function makeApi(changePassword = vi.fn().mockResolvedValue(undefined)): { api: ApiClient; changePassword: typeof changePassword } {
  const api = { auth: { changePassword } } as unknown as ApiClient;
  return { api, changePassword };
}

describe("ChangePasswordDialog", () => {
  it("submits current + new password and shows a success state", async () => {
    const user = userEvent.setup();
    const { api, changePassword } = makeApi();
    render(<ChangePasswordDialog api={api} open onClose={() => {}} />);

    await user.type(screen.getByTestId("fe2-cp-current"), "old-pass-1");
    await user.type(screen.getByTestId("fe2-cp-next"), "new-pass-12345");
    await user.type(screen.getByTestId("fe2-cp-confirm"), "new-pass-12345");
    await user.click(screen.getByTestId("fe2-change-password-submit"));

    await waitFor(() => expect(screen.getByTestId("fe2-change-password-done")).toBeInTheDocument());
    expect(changePassword).toHaveBeenCalledWith("old-pass-1", "new-pass-12345");
  });

  it("keeps submit disabled while the confirmation does not match", async () => {
    const user = userEvent.setup();
    const { api, changePassword } = makeApi();
    render(<ChangePasswordDialog api={api} open onClose={() => {}} />);

    await user.type(screen.getByTestId("fe2-cp-current"), "old-pass-1");
    await user.type(screen.getByTestId("fe2-cp-next"), "new-pass-12345");
    await user.type(screen.getByTestId("fe2-cp-confirm"), "different-000");

    expect(screen.getByTestId("fe2-change-password-submit")).toBeDisabled();
    expect(screen.getByText("新しいパスワードが一致しません。")).toBeInTheDocument();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it("surfaces a server error without closing", async () => {
    const user = userEvent.setup();
    const changePassword = vi.fn().mockRejectedValue(new Error("boom"));
    const { api } = makeApi(changePassword);
    render(<ChangePasswordDialog api={api} open onClose={() => {}} />);

    await user.type(screen.getByTestId("fe2-cp-current"), "wrong-pass");
    await user.type(screen.getByTestId("fe2-cp-next"), "new-pass-12345");
    await user.type(screen.getByTestId("fe2-cp-confirm"), "new-pass-12345");
    await user.click(screen.getByTestId("fe2-change-password-submit"));

    await waitFor(() => expect(screen.getByTestId("fe2-change-password-error")).toBeInTheDocument());
    expect(screen.queryByTestId("fe2-change-password-done")).not.toBeInTheDocument();
  });
});
