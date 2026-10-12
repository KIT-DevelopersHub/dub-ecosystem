// @vitest-environment jsdom
// メール 詳細設定の「別のロール宛てのメールも閲覧」: ロール間の一方向設定。権限キーではなく
// mailVisibleRoleIds として保存される。
import { describe, it, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RolePermissionsEditor } from "../src/components/RolePermissionsEditor";
import { createMockClient } from "../src/api/mockClient";
import type { ResourceClient } from "../src/shell/contract";
import type { RoleView } from "../src/contracts/pending";
import { buildRoleUpdate } from "../src/lib/permissionMatrix";
import { renderWithProviders, makeMe } from "./renderWithProviders";

const ns = "fe7-role-role_organizer";
const lead = (mailVisibleRoleIds: string[] = []): RoleView => ({
  id: "role_organizer",
  orgId: "org_devhub",
  name: "organizer",
  isSystem: false,
  permissions: ["event:read", "event:write", "app:mail:view", "mail:read"],
  mailVisibleRoleIds,
});

function recordingClient() {
  const base = createMockClient({ me: makeMe(["identity:read", "identity:admin", "audit:read", "event:read"]) });
  const patches: { path: string; body: unknown }[] = [];
  const client: ResourceClient = {
    ...base,
    patch: (path: string, body?: unknown) => {
      patches.push({ path, body });
      return base.patch(path, body);
    },
  } as ResourceClient;
  return { client, patches };
}

async function openMailDialog(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(screen.getByTestId(`${ns}-app-access-table`)).toBeInTheDocument());
  await user.click(screen.getByTestId(`${ns}-app-name-mail`));
  const dialog = screen.getByTestId(`${ns}-app-dialog`);
  await waitFor(() => expect(within(dialog).getByTestId(`${ns}-mail-cross-role`)).toBeInTheDocument());
  return dialog;
}

describe("メール 詳細設定: 別のロール宛てのメールも閲覧", () => {
  it("lists the OTHER roles (never itself) and saves the picked ones as mailVisibleRoleIds", async () => {
    const user = userEvent.setup();
    const { client, patches } = recordingClient();
    renderWithProviders(<RolePermissionsEditor role={lead()} />, { client });
    const dialog = await openMailDialog(user);

    expect(within(dialog).queryByTestId(`${ns}-mail-cross-role-row-role_organizer`)).not.toBeInTheDocument();
    expect(within(dialog).getByTestId(`${ns}-mail-cross-role-row-role_member`)).toBeInTheDocument();
    await user.click(within(dialog).getByTestId(`${ns}-mail-cross-role-toggle-role_member`));
    expect(within(dialog).getByTestId(`${ns}-mail-cross-role-count`).textContent).toBe("1 / 2 ロール");
    await user.click(within(dialog).getByTestId(`${ns}-app-dialog-close`));

    // The table points at the setting so it is not buried at the bottom of the dialog.
    expect(screen.getByTestId(`${ns}-app-detail-extra-mail`).textContent).toBe("別ロール 1");

    await user.click(screen.getByTestId(`${ns}-save`));
    const confirm = await screen.findByTestId(`${ns}-save-confirm`);
    await user.click(within(confirm).getByRole("button", { name: "確認" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ path: expect.stringMatching(/\/identity\/roles\/role_organizer$/), body: { mailVisibleRoleIds: ["role_member"] } });
  });

  it("すべてのロールを選ぶ picks every other role, and toggles back to none", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RolePermissionsEditor role={lead()} />);
    const dialog = await openMailDialog(user);
    await user.click(within(dialog).getByTestId(`${ns}-mail-cross-role-all`));
    expect(within(dialog).getByTestId(`${ns}-mail-cross-role-count`).textContent).toBe("2 / 2 ロール");
    await user.click(within(dialog).getByTestId(`${ns}-mail-cross-role-all`));
    expect(within(dialog).getByTestId(`${ns}-mail-cross-role-count`).textContent).toBe("0 / 2 ロール");
  });

  it("is locked while the mail app is 無効", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RolePermissionsEditor role={{ ...lead(["role_member"]), permissions: ["event:read"] }} />);
    const dialog = await openMailDialog(user);
    expect(within(dialog).getByTestId(`${ns}-mail-cross-role-locked`)).toBeInTheDocument();
    expect((within(dialog).getByTestId(`${ns}-mail-cross-role-toggle-role_member`) as HTMLInputElement).disabled).toBe(true);
  });
});

describe("buildRoleUpdate — mailVisibleRoleIds", () => {
  const base = { name: "r", permissions: [] };
  it("is omitted when unchanged (order-insensitive) and sent whole when changed", () => {
    expect(buildRoleUpdate({ ...base, mailVisibleRoleIds: ["a", "b"] }, { ...base, mailVisibleRoleIds: ["b", "a"] })).toBeNull();
    expect(buildRoleUpdate({ ...base, mailVisibleRoleIds: ["a"] }, { ...base, mailVisibleRoleIds: [] })).toEqual({ mailVisibleRoleIds: [] });
    expect(buildRoleUpdate({ ...base }, { ...base, mailVisibleRoleIds: ["b", "a"] })).toEqual({ mailVisibleRoleIds: ["a", "b"] });
  });
});
