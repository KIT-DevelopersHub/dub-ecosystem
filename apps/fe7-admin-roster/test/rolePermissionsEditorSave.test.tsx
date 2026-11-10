// @vitest-environment jsdom
// 保存の回帰テスト: 「その他」の変更が差分なしにならないこと、保存後に離脱ガードが残らないこと。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { identity } from "@dub/types";
import { policy } from "@dub/types";
import { RoleListPage } from "../src/components/RoleListPage";
import { createMockClient } from "../src/api/mockClient";
import type { RoleView } from "../src/contracts/pending";
import { makeMe, renderWithProviders } from "./renderWithProviders";

const ID = "role_custom";
const NS = `fe7-role-${ID}`;
const me = makeMe(["identity:read", "identity:admin"]);

function setup(permissions: identity.PermissionKey[]) {
  const role: RoleView = { id: ID, orgId: "org_devhub", name: "custom", permissions, isSystem: false, mailVisibleRoleIds: [] };
  const mock = createMockClient({ me, roles: [role] });
  const patch = vi.fn(async (path: string, body: { permissions?: identity.PermissionKey[] }) => {
    // 実サーバーと同じく保存時に正規化する。
    const normalized = body.permissions ? { ...body, permissions: policy.normalizeAppAccessKeys(body.permissions) } : body;
    return mock.patch(path, normalized);
  });
  const client = { ...mock, patch } as typeof mock;
  return { patch, ...renderWithProviders(<RoleListPage />, { me, client }) };
}

async function openRole(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTestId(`fe7-roles-open-${ID}`));
  await screen.findByTestId(`${NS}-save`);
}

async function save(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId(`${NS}-save`));
  const dialog = await screen.findByTestId(`${NS}-save-confirm`);
  await user.click(within(dialog).getByRole("button", { name: /保存|確認|OK/ }));
}

function leavePrompted(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  globalThis.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("RolePermissionsEditor — save", () => {
  beforeEach(() => globalThis.localStorage.clear());

  it("saves an その他 key that a granted app implies but the stored role lacks", async () => {
    const user = userEvent.setup();
    const { patch } = setup(["app:lp:view"]);
    await openRole(user);
    await user.click(screen.getByTestId(`${NS}-other-detail-infra`));
    await user.click(screen.getByTestId(`${NS}-other-toggle-infra:read`));
    await user.click(screen.getByTestId(`${NS}-other-dialog-close`));
    await save(user);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0]![1].permissions).toContain("infra:read");
  });

  it("shows an app's required その他 key as fixed instead of a switch that cannot be saved", async () => {
    const user = userEvent.setup();
    setup(["app:lp:view", "infra:read"]);
    await openRole(user);
    await user.click(screen.getByTestId(`${NS}-other-detail-infra`));
    expect(screen.getByTestId(`${NS}-other-toggle-infra:read`)).toBeDisabled();
    expect(screen.getByTestId(`${NS}-other-required-infra:read`)).toHaveTextContent("LP管理に必要");
  });

  it("does not stay dirty after the server adds implied keys on save", async () => {
    const user = userEvent.setup();
    // drive:settings_edit は保存時に drive:settings_view が補われる。
    const { patch } = setup(["app:driveshare:view", "drive:read", "drive:settings_edit", "file:read"]);
    await openRole(user);
    await user.click(screen.getByTestId(`${NS}-other-detail-infra`));
    await user.click(screen.getByTestId(`${NS}-other-toggle-infra:deploy`));
    await user.click(screen.getByTestId(`${NS}-other-dialog-close`));
    expect(leavePrompted()).toBe(true);
    await save(user);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(leavePrompted()).toBe(false));
  });
});
