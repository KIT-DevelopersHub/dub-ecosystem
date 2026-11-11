import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Button } from "@dub/ui";
import type { identity, notification } from "@dub/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient, RequestInput } from "../lib/api-client.tsx";
import { AuthProvider, useAppCapability } from "./AuthProvider.tsx";
import { editorPermissions, fakeMe, viewerPermissions } from "./test-support.tsx";
import { usePermissionGate, type PermissionScope } from "./PermissionGate.tsx";

function Screen({ onAdd, scope }: { onAdd: () => void; scope?: PermissionScope }): JSX.Element {
  const { canEdit } = useAppCapability("members");
  const gate = usePermissionGate({ appId: "members", locked: !canEdit || scope === "scope", ...(scope ? { scope } : {}), testId: "d" });
  return (
    <>
      <Button onClick={gate.guard(onAdd)} testId="add">
        追加
      </Button>
      {gate.dialog}
    </>
  );
}

function renderWith(permissions: identity.PermissionKey[], node: JSX.Element, request = vi.fn(() => Promise.resolve({ id: "nfb_1" }))) {
  const api = { auth: { me: () => Promise.resolve(fakeMe(permissions)) }, request } as unknown as ApiClient;
  const utils = render(
    <QueryClientProvider client={new QueryClient()}>
      <AuthProvider api={api}>{node}</AuthProvider>
    </QueryClientProvider>,
  );
  return { request, ...utils };
}

const bodyOf = (request: ReturnType<typeof vi.fn>) =>
  (request.mock.calls[0] as unknown as [RequestInput<notification.CreateFeedbackRequest>])[0];

afterEach(() => sessionStorage.clear());

describe("usePermissionGate — 権限不足ダイアログ + 権限を申請する", () => {
  it("閲覧のみで押すと操作の代わりにダイアログを出し、申請すると permission_request を送って申請済みになる", async () => {
    const onAdd = vi.fn();
    const { request } = renderWith(viewerPermissions("members"), <Screen onAdd={onAdd} />);
    await waitFor(() => expect(screen.getByTestId("add")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("add"));

    expect(onAdd).not.toHaveBeenCalled();
    expect(await screen.findByRole("dialog", { name: "権限が不足しています" })).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("d-request"));

    expect(await screen.findByTestId("d-request-done")).toBeInTheDocument();
    expect(screen.getByTestId("d-request")).toBeDisabled();
    const input = bodyOf(request);
    expect(input.method).toBe("POST");
    expect(input.path).toBe("/api/v1/feedback");
    expect(input.body?.kind).toBe("permission_request");
    expect(input.body?.message).toContain("申請者: Test User");
    expect(input.body?.message).toContain("の編集");
  });

  it("編集権限があれば操作をそのまま実行し、ダイアログは出さない", async () => {
    const onAdd = vi.fn();
    renderWith(editorPermissions("members"), <Screen onAdd={onAdd} />);
    await waitFor(async () => {
      await userEvent.click(screen.getByTestId("add"));
      expect(onAdd).toHaveBeenCalled();
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("同じセッションでは開き直しても申請済みのまま(管理者への重複通知を防ぐ)", async () => {
    const first = renderWith(viewerPermissions("members"), <Screen onAdd={vi.fn()} />);
    await userEvent.click(await screen.findByTestId("add"));
    await userEvent.click(await screen.findByTestId("d-request"));
    await screen.findByTestId("d-request-done");
    first.unmount();
    const second = renderWith(viewerPermissions("members"), <Screen onAdd={vi.fn()} />);
    await userEvent.click(await screen.findByTestId("add"));
    expect(await screen.findByTestId("d-request-done")).toBeInTheDocument();
    expect(screen.getByTestId("d-request")).toBeDisabled();
    expect(second.request).not.toHaveBeenCalled();
  });

  it("送信に失敗したらエラーを出し、再度押せる", async () => {
    const request = vi.fn(() => Promise.reject(new Error("network")));
    renderWith(viewerPermissions("members"), <Screen onAdd={vi.fn()} />, request as never);
    await userEvent.click(await screen.findByTestId("add"));
    await userEvent.click(await screen.findByTestId("d-request"));
    expect(await screen.findByTestId("d-request-error")).toBeInTheDocument();
    expect(screen.getByTestId("d-request")).not.toBeDisabled();
  });

  it("閉じるで閉じられる", async () => {
    renderWith(viewerPermissions("members"), <Screen onAdd={vi.fn()} />);
    await userEvent.click(await screen.findByTestId("add"));
    await userEvent.click(await screen.findByTestId("d-close"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("scope は「編集範囲の拡大」として送る", async () => {
    const { request } = renderWith(editorPermissions("members"), <Screen onAdd={vi.fn()} scope="scope" />);
    await userEvent.click(await screen.findByTestId("add"));
    await userEvent.click(await screen.findByTestId("d-request"));
    await screen.findByTestId("d-request-done");
    expect(bodyOf(request).body?.message).toContain("編集範囲の拡大");
  });
});
