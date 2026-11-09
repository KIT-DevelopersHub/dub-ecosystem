import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { identity, notification } from "@dub/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient, RequestInput } from "../lib/api-client.tsx";
import { AuthProvider } from "./AuthProvider.tsx";
import { editorPermissions, fakeMe, viewerPermissions } from "./test-support.tsx";
import { AppReadOnlyNotice, ScopeReadOnlyNotice } from "./AppReadOnlyNotice.tsx";

function renderWith(permissions: identity.PermissionKey[], node: JSX.Element, request = vi.fn(() => Promise.resolve({ id: "nfb_1" }))) {
  const api = { auth: { me: () => Promise.resolve(fakeMe(permissions)) }, request } as unknown as ApiClient;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AuthProvider api={api}>{node}</AuthProvider>
    </QueryClientProvider>,
  );
  return request;
}

afterEach(() => sessionStorage.clear());

describe("AppReadOnlyNotice — 権限が不足しています + 権限を申請する", () => {
  it("閲覧のみなら理由と申請ボタンを出し、押すと permission_request を送って申請済みになる", async () => {
    const request = renderWith(viewerPermissions("members"), <AppReadOnlyNotice appId="members" testId="n" />);
    expect(await screen.findByText("権限が不足しています")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("n-request"));

    expect(await screen.findByTestId("n-request-done")).toBeInTheDocument();
    expect(screen.getByTestId("n-request")).toBeDisabled();
    expect(request).toHaveBeenCalledTimes(1);
    const input = (request.mock.calls[0] as unknown as [RequestInput<notification.CreateFeedbackRequest>])[0];
    expect(input.method).toBe("POST");
    expect(input.path).toBe("/api/v1/feedback");
    expect(input.body?.kind).toBe("permission_request");
    expect(input.body?.message).toContain("申請者: Test User");
    expect(input.body?.message).toContain("の編集");
  });

  it("同じセッションでは再表示しても申請済みのまま(管理者への重複通知を防ぐ)", async () => {
    const first = renderWith(viewerPermissions("members"), <AppReadOnlyNotice appId="members" testId="a" />);
    await userEvent.click(await screen.findByTestId("a-request"));
    await screen.findByTestId("a-request-done");
    const second = renderWith(viewerPermissions("members"), <AppReadOnlyNotice appId="members" testId="b" />);
    expect(await screen.findByTestId("b-request-done")).toBeInTheDocument();
    expect(screen.getByTestId("b-request")).toBeDisabled();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("送信に失敗したらエラーを出し、再度押せる", async () => {
    const request = vi.fn(() => Promise.reject(new Error("network")));
    renderWith(viewerPermissions("members"), <AppReadOnlyNotice appId="members" testId="n" />, request as never);
    await userEvent.click(await screen.findByTestId("n-request"));
    expect(await screen.findByTestId("n-request-error")).toBeInTheDocument();
    expect(screen.getByTestId("n-request")).not.toBeDisabled();
  });

  it("編集権限があれば何も出さない", async () => {
    renderWith(editorPermissions("members"), <div data-testid="root"><AppReadOnlyNotice appId="members" testId="n" /></div>);
    await waitFor(() => expect(screen.getByTestId("root")).toBeInTheDocument());
    expect(screen.queryByTestId("n")).not.toBeInTheDocument();
  });

  it("ScopeReadOnlyNotice も申請ボタンを出し、編集範囲の拡大として送る", async () => {
    const request = renderWith(
      editorPermissions("members"),
      <ScopeReadOnlyNotice appId="members" message="範囲の外です。" testId="s" />,
    );
    await userEvent.click(await screen.findByTestId("s-request"));
    await screen.findByTestId("s-request-done");
    const input = (request.mock.calls[0] as unknown as [RequestInput<notification.CreateFeedbackRequest>])[0];
    expect(input.body?.message).toContain("編集範囲の拡大");
  });
});
