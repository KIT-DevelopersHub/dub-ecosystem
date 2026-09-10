// @vitest-environment jsdom
// Draft autosave + restore regression for the ACTUAL reachable "ロール編集" surface.
//
// P1-2 originally wired useDraftAutosave into RoleEditorPage's roleId-edit branch, but
// RoleListPage no longer navigates there for existing roles (see routes.tsx — editing
// is inline via RolePermissionsEditor). That left the real edit UI completely
// unprotected: reloading mid-edit lost changes with no beforeunload warning and no
// restore. This test drives the SAME path a user hits (RoleListPage -> select a role
// -> edit inline) to make sure the fix lives where it is actually reachable.
import { describe, it, expect, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RoleListPage } from "../src/components/RoleListPage";
import { renderWithProviders } from "./renderWithProviders";

const ROLE_ID = "role_organizer";
const KEY = `fe7.role.${ROLE_ID}`;
const NAME_FIELD = `fe7-role-${ROLE_ID}-name`;
const DRAFT_NOTICE = `fe7-role-${ROLE_ID}-draft-notice`;

describe("RolePermissionsEditor (inline, via RoleListPage) — draft autosave", () => {
  beforeEach(() => {
    try {
      globalThis.localStorage?.clear();
    } catch {
      /* storage disabled */
    }
  });

  async function openOrganizer() {
    const user = userEvent.setup();
    const result = renderWithProviders(<RoleListPage />);
    await waitFor(() => expect(screen.getByTestId(`fe7-roles-open-${ROLE_ID}`)).toBeInTheDocument());
    await user.click(screen.getByTestId(`fe7-roles-open-${ROLE_ID}`));
    await waitFor(() => expect(screen.getByTestId(NAME_FIELD)).toBeInTheDocument());
    return { user, ...result };
  }

  it("auto-saves an edited role name to localStorage under fe7.role.<id>", async () => {
    const { user } = await openOrganizer();
    await user.clear(screen.getByTestId(NAME_FIELD));
    await user.type(screen.getByTestId(NAME_FIELD), "renamed-organizer");
    await waitFor(() => expect(globalThis.localStorage.getItem(KEY)).toContain("renamed-organizer"));
  });

  it("restores the draft (with the notice) when the panel is reopened", async () => {
    globalThis.localStorage.setItem(
      KEY,
      JSON.stringify({ name: "restored-name", permissions: ["event:read"] }),
    );
    const user = userEvent.setup();
    renderWithProviders(<RoleListPage />);
    await waitFor(() => expect(screen.getByTestId(`fe7-roles-open-${ROLE_ID}`)).toBeInTheDocument());
    await user.click(screen.getByTestId(`fe7-roles-open-${ROLE_ID}`));
    await waitFor(() => expect(screen.getByTestId(NAME_FIELD)).toBeInTheDocument());

    expect((screen.getByTestId(NAME_FIELD) as HTMLInputElement).value).toBe("restored-name");
    expect(screen.getByTestId(DRAFT_NOTICE)).toBeInTheDocument();
  });

  it("clears the draft when discarded from the notice, falling back to the server role", async () => {
    globalThis.localStorage.setItem(
      KEY,
      JSON.stringify({ name: "restored-name", permissions: ["event:read"] }),
    );
    const user = userEvent.setup();
    renderWithProviders(<RoleListPage />);
    await waitFor(() => expect(screen.getByTestId(`fe7-roles-open-${ROLE_ID}`)).toBeInTheDocument());
    await user.click(screen.getByTestId(`fe7-roles-open-${ROLE_ID}`));
    await waitFor(() => expect(screen.getByTestId(DRAFT_NOTICE)).toBeInTheDocument());

    await user.click(screen.getByTestId(`${DRAFT_NOTICE}-discard`));
    expect(globalThis.localStorage.getItem(KEY)).toBeNull();
    expect((screen.getByTestId(NAME_FIELD) as HTMLInputElement).value).not.toBe("restored-name");
  });
});
