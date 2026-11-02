// Gmail への自動転送 settings dialog: skeleton → register (optimistic pending) → verified
// toggle (optimistic, rollback on failure) → remove (confirm, optimistic) and error copy.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { mail } from "@dub/types";
import type { MailApi } from "../mailApi.tsx";
import { MailApiProvider } from "../MailProvider.tsx";
import { ForwardSettingsDialog } from "./ForwardSettingsDialog.tsx";

const NONE: mail.MailForwardSetting = { target: null, status: "none", enabled: false, active: false, available: true, requestedAt: null, verifiedAt: null, lastResult: null, lastError: null, lastAt: null };
const PENDING: mail.MailForwardSetting = { ...NONE, target: "me@gmail.com", status: "pending", enabled: true, requestedAt: "2026-11-02T00:00:00.000Z" };
const VERIFIED: mail.MailForwardSetting = { ...PENDING, status: "verified", active: true, verifiedAt: "2026-11-02T00:01:00.000Z" };

function apiWith(over: Partial<MailApi>): MailApi {
  return { getForward: vi.fn().mockResolvedValue(NONE), registerForward: vi.fn(), updateForward: vi.fn(), removeForward: vi.fn(), ...over } as unknown as MailApi;
}
const renderDialog = (api: MailApi) =>
  render(
    <MailApiProvider value={api}>
      <ForwardSettingsDialog open onClose={() => {}} />
    </MailApiProvider>,
  );
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

describe("ForwardSettingsDialog", () => {
  it("shows a skeleton first, then the registration form", async () => {
    const d = deferred<mail.MailForwardSetting>();
    renderDialog(apiWith({ getForward: vi.fn().mockReturnValue(d.promise) }));
    expect(screen.getByTestId("fe2-mail-forward-loading")).toBeTruthy();
    d.resolve(NONE);
    expect(await screen.findByTestId("fe2-mail-forward-input")).toBeTruthy();
  });

  it("register: validates, then shows 確認待ち immediately (optimistic) before the API answers", async () => {
    const d = deferred<mail.MailForwardSetting>();
    const registerForward = vi.fn().mockReturnValue(d.promise);
    renderDialog(apiWith({ registerForward }));
    const input = await screen.findByTestId("fe2-mail-forward-input");
    await userEvent.type(input, "not-an-email");
    await userEvent.click(screen.getByTestId("fe2-mail-forward-submit"));
    expect(registerForward).not.toHaveBeenCalled();
    await userEvent.clear(input);
    await userEvent.type(input, "Me@Gmail.com");
    await userEvent.click(screen.getByTestId("fe2-mail-forward-submit"));
    expect(registerForward).toHaveBeenCalledWith({ target: "me@gmail.com" });
    expect(screen.getByTestId("fe2-mail-forward-pending")).toBeTruthy();
    expect(screen.getByTestId("fe2-mail-forward-status").textContent).toBe("確認待ち");
    d.resolve(PENDING);
    await waitFor(() => expect(screen.getByTestId("fe2-mail-forward-target").textContent).toBe("me@gmail.com"));
  });

  it("register failure rolls back to the form and explains why", async () => {
    renderDialog(apiWith({ registerForward: vi.fn().mockRejectedValue({ code: "MAIL_FORWARD_TARGET_IN_USE" }) }));
    await userEvent.type(await screen.findByTestId("fe2-mail-forward-input"), "me@gmail.com");
    await userEvent.click(screen.getByTestId("fe2-mail-forward-submit"));
    expect((await screen.findByTestId("fe2-mail-forward-failure")).textContent).toContain("使われています");
    expect(screen.getByTestId("fe2-mail-forward-input")).toBeTruthy();
  });

  it("verified: toggle off is optimistic and rolls back on failure", async () => {
    const updateForward = vi.fn().mockRejectedValue(new Error("boom"));
    renderDialog(apiWith({ getForward: vi.fn().mockResolvedValue(VERIFIED), updateForward }));
    const toggle = (await screen.findByTestId("fe2-mail-forward-toggle")) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(screen.getByTestId("fe2-mail-forward-status").textContent).toBe("転送中");
    await userEvent.click(toggle);
    expect(updateForward).toHaveBeenCalledWith({ enabled: false });
    await waitFor(() => expect(screen.getByTestId("fe2-mail-forward-failure").textContent).toContain("オフにできませんでした"));
    expect((screen.getByTestId("fe2-mail-forward-toggle") as HTMLInputElement).checked).toBe(true);
  });

  it("remove asks for confirmation, then returns to the form at once", async () => {
    const removeForward = vi.fn().mockResolvedValue(NONE);
    renderDialog(apiWith({ getForward: vi.fn().mockResolvedValue(VERIFIED), removeForward }));
    await userEvent.click(await screen.findByTestId("fe2-mail-forward-remove"));
    await userEvent.click(screen.getByRole("button", { name: "解除する" }));
    expect(removeForward).toHaveBeenCalled();
    expect(await screen.findByTestId("fe2-mail-forward-input")).toBeTruthy();
  });

  it("unavailable server: explains instead of offering the form; load failure offers retry", async () => {
    const { unmount } = renderDialog(apiWith({ getForward: vi.fn().mockResolvedValue({ ...NONE, available: false }) }));
    expect(await screen.findByTestId("fe2-mail-forward-unavailable")).toBeTruthy();
    unmount();
    renderDialog(apiWith({ getForward: vi.fn().mockRejectedValue(new Error("down")) }));
    expect(await screen.findByTestId("fe2-mail-forward-error")).toBeTruthy();
  });
});
