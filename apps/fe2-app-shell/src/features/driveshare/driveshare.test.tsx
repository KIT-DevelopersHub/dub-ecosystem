// DriveShare feature tests: the api adapter maps onto the shell ApiClient.request,
// the pure helpers are correct, and the manager screen drives the DriveShareApi
// (list → select → permissions, grant validation, role change, revoke confirm, link
// toggle). All run against a faked DriveShareApi / ApiClient — no real network, green
// without a live backend.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, RequestInput } from "../../lib/api-client.tsx";
import {
  createDriveShareApi,
  isValidEmail,
  roleLabel,
  type DriveShareApi,
  type ListFilesResult,
  type ListPermissionsResult,
  type SharePermission,
} from "./driveShareApi.tsx";
import { DriveShareApiProvider } from "./DriveShareProvider.tsx";
import { DriveShareScreen } from "./DriveShareScreen.tsx";

function fakeApi(result: unknown = undefined): { api: ApiClient; calls: RequestInput[] } {
  const calls: RequestInput[] = [];
  const request = vi.fn(<TRes,>(input: RequestInput): Promise<TRes> => {
    calls.push(input);
    return Promise.resolve(result as TRes);
  });
  return { api: { request } as unknown as ApiClient, calls };
}

function wrap(ui: ReactNode, api: DriveShareApi): JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <DriveShareApiProvider value={api}>{ui}</DriveShareApiProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

const OWNER: SharePermission = { id: "p_owner", type: "user", role: "owner", emailAddress: "hackit@gmail.com", displayName: "Hackit 運営", domain: null };
const READER: SharePermission = { id: "p_reader", type: "user", role: "reader", emailAddress: "sponsor@example.com", displayName: "協賛担当", domain: null };

const FILES: ListFilesResult = {
  files: [
    { id: "fld_root", name: "Hackit 2026 共有", mimeType: "application/vnd.google-apps.folder", isFolder: true, ownerName: "Hackit 運営", modifiedTime: "2026-08-10T09:00:00Z", webViewLink: null, linkShared: false },
    { id: "fil_budget", name: "予算管理.xlsx", mimeType: "application/vnd.google-apps.spreadsheet", isFolder: false, ownerName: "Hackit 運営", modifiedTime: "2026-08-11T23:10:00Z", webViewLink: null, linkShared: false },
  ],
  nextCursor: null,
};
const PERMS: ListPermissionsResult = { fileId: "fil_budget", permissions: [OWNER, READER] };

function stubApi(over: Partial<DriveShareApi> = {}): DriveShareApi {
  return {
    listFiles: () => Promise.resolve(FILES),
    listPermissions: () => Promise.resolve(PERMS),
    grant: (_f, req) => Promise.resolve({ permission: { id: "p_new", type: "user", role: req.role, emailAddress: req.emailAddress, displayName: null, domain: null } }),
    updateRole: (_f, id, role) => Promise.resolve({ permission: { ...READER, id, role } }),
    revoke: () => Promise.resolve({ revoked: true }),
    setLinkSharing: (_f, req) => Promise.resolve({ fileId: "fil_budget", permissions: req.enabled ? [OWNER, READER, { id: "p_anyone", type: "anyone", role: "reader", emailAddress: null, displayName: null, domain: null }] : [OWNER, READER] }),
    ...over,
  };
}

describe("createDriveShareApi", () => {
  it("listFiles GETs /api/v1/driveshare/files and forwards q/limit", async () => {
    const { api, calls } = fakeApi({ files: [], nextCursor: null });
    await createDriveShareApi(api).listFiles({ q: "予算", limit: 50 });
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/v1/driveshare/files", query: { q: "予算", limit: 50 } });
  });

  it("listFiles omits the query object entirely when no params are given", async () => {
    const { api, calls } = fakeApi({ files: [], nextCursor: null });
    await createDriveShareApi(api).listFiles();
    expect(calls[0]!.query).toBeUndefined();
  });

  it("listPermissions GETs the file's permissions", async () => {
    const { api, calls } = fakeApi(PERMS);
    await createDriveShareApi(api).listPermissions("fld_root");
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/v1/driveshare/files/fld_root/permissions" });
  });

  it("grant POSTs the email + role", async () => {
    const { api, calls } = fakeApi({ permission: READER });
    await createDriveShareApi(api).grant("fil_budget", { emailAddress: "x@example.com", role: "writer" });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/v1/driveshare/files/fil_budget/permissions", body: { emailAddress: "x@example.com", role: "writer" } });
  });

  it("updateRole PATCHes the permission and revoke DELETEs it", async () => {
    const { api, calls } = fakeApi({ permission: READER });
    const d = createDriveShareApi(api);
    await d.updateRole("fil_budget", "p_reader", "commenter");
    expect(calls[0]).toMatchObject({ method: "PATCH", path: "/api/v1/driveshare/files/fil_budget/permissions/p_reader", body: { role: "commenter" } });
    await d.revoke("fil_budget", "p_reader");
    expect(calls[1]).toMatchObject({ method: "DELETE", path: "/api/v1/driveshare/files/fil_budget/permissions/p_reader" });
  });

  it("setLinkSharing PUTs the toggle", async () => {
    const { api, calls } = fakeApi(PERMS);
    await createDriveShareApi(api).setLinkSharing("fil_budget", { enabled: true, role: "reader" });
    expect(calls[0]).toMatchObject({ method: "PUT", path: "/api/v1/driveshare/files/fil_budget/link", body: { enabled: true, role: "reader" } });
  });
});

describe("helpers", () => {
  it("isValidEmail", () => {
    expect(isValidEmail("a@b.com")).toBe(true);
    expect(isValidEmail(" a@b.com ")).toBe(true);
    expect(isValidEmail("nope")).toBe(false);
  });
  it("roleLabel", () => {
    expect(roleLabel("owner")).toBe("オーナー");
    expect(roleLabel("writer")).toBe("編集者");
    expect(roleLabel("reader")).toBe("閲覧者");
  });
});

describe("DriveShareScreen", () => {
  it("lists files and shows the empty panel until one is selected", async () => {
    render(wrap(<DriveShareScreen />, stubApi()));
    await waitFor(() => expect(screen.getAllByTestId("fe2-driveshare-file").length).toBe(2));
    expect(screen.getByTestId("fe2-driveshare-noselection")).toBeInTheDocument();
  });

  it("selecting a file loads its permissions (owner is non-editable)", async () => {
    const user = userEvent.setup();
    render(wrap(<DriveShareScreen />, stubApi()));
    await waitFor(() => expect(screen.getAllByTestId("fe2-driveshare-file").length).toBe(2));
    await user.click(screen.getByRole("button", { name: /予算管理/ }));
    await waitFor(() => expect(screen.getByTestId("fe2-driveshare-panel")).toBeInTheDocument());
    const rows = await screen.findAllByTestId("fe2-driveshare-permission");
    expect(rows.length).toBe(2);
    // owner row shows a static badge, not a role select
    expect(within(rows[0]!).queryByTestId("fe2-driveshare-role-select")).toBeNull();
    // non-owner row is editable
    expect(within(rows[1]!).getByTestId("fe2-driveshare-role-select")).toBeInTheDocument();
  });

  it("grant is disabled for an invalid email and calls grant for a valid one", async () => {
    const user = userEvent.setup();
    const grant = vi.fn((_f: string, req: { emailAddress: string; role: "reader" | "commenter" | "writer" }) =>
      Promise.resolve({ permission: { id: "p_new", type: "user" as const, role: req.role, emailAddress: req.emailAddress, displayName: null, domain: null } }),
    );
    render(wrap(<DriveShareScreen />, stubApi({ grant })));
    await waitFor(() => expect(screen.getAllByTestId("fe2-driveshare-file").length).toBe(2));
    await user.click(screen.getByRole("button", { name: /予算管理/ }));
    await screen.findByTestId("fe2-driveshare-grant");

    const submit = screen.getByTestId("fe2-driveshare-grant-submit");
    expect(submit).toBeDisabled();

    await user.type(screen.getByTestId("fe2-driveshare-grant-email"), "new@example.com");
    expect(submit).not.toBeDisabled();
    await user.click(submit);
    await waitFor(() => expect(grant).toHaveBeenCalledWith("fil_budget", { emailAddress: "new@example.com", role: "reader" }));
  });

  it("changing a non-owner role calls updateRole", async () => {
    const user = userEvent.setup();
    const updateRole = vi.fn((_f: string, id: string, role: "reader" | "commenter" | "writer") =>
      Promise.resolve({ permission: { ...READER, id, role } }),
    );
    render(wrap(<DriveShareScreen />, stubApi({ updateRole })));
    await waitFor(() => expect(screen.getAllByTestId("fe2-driveshare-file").length).toBe(2));
    await user.click(screen.getByRole("button", { name: /予算管理/ }));
    const rows = await screen.findAllByTestId("fe2-driveshare-permission");
    const select = within(rows[1]!).getByTestId("fe2-driveshare-role-select");
    await user.selectOptions(select, "writer");
    await waitFor(() => expect(updateRole).toHaveBeenCalledWith("fil_budget", "p_reader", "writer"));
  });

  it("revoke goes through the confirm dialog", async () => {
    const user = userEvent.setup();
    const revoke = vi.fn(() => Promise.resolve({ revoked: true }));
    render(wrap(<DriveShareScreen />, stubApi({ revoke })));
    await waitFor(() => expect(screen.getAllByTestId("fe2-driveshare-file").length).toBe(2));
    await user.click(screen.getByRole("button", { name: /予算管理/ }));
    const rows = await screen.findAllByTestId("fe2-driveshare-permission");
    await user.click(within(rows[1]!).getByTestId("fe2-driveshare-revoke"));
    // confirm dialog appears; revoke only fires after confirming
    expect(revoke).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "剥奪する" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("fil_budget", "p_reader"));
  });

  it("toggling link sharing calls setLinkSharing", async () => {
    const user = userEvent.setup();
    const setLinkSharing = vi.fn((_f: string, req: { enabled: boolean }) =>
      Promise.resolve({ fileId: "fil_budget", permissions: PERMS.permissions }),
    );
    render(wrap(<DriveShareScreen />, stubApi({ setLinkSharing })));
    await waitFor(() => expect(screen.getAllByTestId("fe2-driveshare-file").length).toBe(2));
    await user.click(screen.getByRole("button", { name: /予算管理/ }));
    await screen.findByTestId("fe2-driveshare-link-switch");
    await user.click(screen.getByTestId("fe2-driveshare-link-switch"));
    await waitFor(() => expect(setLinkSharing).toHaveBeenCalledWith("fil_budget", { enabled: true, role: "reader" }));
  });
});
