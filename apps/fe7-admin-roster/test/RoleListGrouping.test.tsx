// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RoleListPage } from "../src/components/RoleListPage";
import type { RoleView } from "../src/contracts/pending";
import { renderWithProviders, makeMe } from "./renderWithProviders";

const ORG = "org_devhub";
const role = (id: string, name: string, isSystem = false): RoleView => ({ id, orgId: ORG, name, permissions: ["event:read"], isSystem });

// API order deliberately starts with an auto team role (collapsed by default).
const ROLES: RoleView[] = [
  role("role_auto_team_dev", "チーム: 開発チーム"),
  role("role_sys_admin", "admin", true),
  role("role_sys_member", "member", true),
  role("role_ops_lead", "統括"),
  role("role_ops_dev", "開発"),
  role("role_auto_team_pr", "チーム: 広報チーム"),
  role("role_auto_position_member", "役職: Member"),
  role("role_01BOT", "commander-bot"),
];

function renderPage() {
  const me = makeMe(["identity:read", "identity:admin", "audit:read", "event:read"]);
  return renderWithProviders(<RoleListPage />, { me, seed: { me, roles: ROLES } });
}

describe("RoleListPage grouped sections", () => {
  beforeEach(() => localStorage.clear());

  it("renders one section per genre in order, with counts, every role present", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("fe7-roles-group-system")).toBeInTheDocument());
    const order = [...screen.getByTestId("fe7-roles-list").querySelectorAll("section")].map((el) => el.dataset.testid);
    expect(order).toEqual([
      "fe7-roles-group-system",
      "fe7-roles-group-ops",
      "fe7-roles-group-team",
      "fe7-roles-group-position",
      "fe7-roles-group-other",
    ]);
    expect(screen.getByTestId("fe7-roles-group-count-system")).toHaveTextContent("2");
    expect(screen.getByTestId("fe7-roles-group-count-ops")).toHaveTextContent("2");
    expect(screen.getByTestId("fe7-roles-group-count-team")).toHaveTextContent("2");
    expect(screen.getByTestId("fe7-roles-group-count-position")).toHaveTextContent("1");
    expect(screen.getByTestId("fe7-roles-group-count-other")).toHaveTextContent("1");
    // default selection = first role of the first section, not raw API order
    expect(screen.getByTestId("fe7-roles-open-role_sys_admin")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("fe7-roles-panel-role_sys_admin")).toBeInTheDocument();
  });

  it("auto groups start collapsed; expanding shows prefix-stripped labels and keeps selection behavior", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("fe7-roles-group-team")).toBeInTheDocument());
    const toggle = screen.getByTestId("fe7-roles-group-toggle-team");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("fe7-roles-open-role_auto_team_dev")).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const tab = screen.getByTestId("fe7-roles-open-role_auto_team_dev");
    expect(within(tab).getByText("開発チーム")).toBeInTheDocument();
    expect(within(tab).queryByText("チーム: 開発チーム")).not.toBeInTheDocument();

    await user.click(tab);
    await waitFor(() => expect(screen.getByTestId("fe7-roles-panel-role_auto_team_dev")).toBeInTheDocument());
    expect(tab).toHaveAttribute("aria-selected", "true");
    // selection is single across sections
    expect(screen.getByTestId("fe7-roles-open-role_sys_admin")).toHaveAttribute("aria-selected", "false");
    // the panel header keeps the real (unstripped) name
    expect(within(screen.getByTestId("fe7-roles-panel-role_auto_team_dev")).getByText("チーム: 開発チーム")).toBeInTheDocument();
    // open state is remembered
    expect(JSON.parse(localStorage.getItem("fe7.roles.groupOpen")!)).toMatchObject({ team: true });
  });

  it("collapsing an open group hides its tabs; the stored state is restored on remount", async () => {
    const user = userEvent.setup();
    const first = renderPage();
    await waitFor(() => expect(screen.getByTestId("fe7-roles-open-role_ops_lead")).toBeInTheDocument());
    await user.click(screen.getByTestId("fe7-roles-group-toggle-ops"));
    expect(screen.queryByTestId("fe7-roles-open-role_ops_lead")).not.toBeInTheDocument();
    first.unmount();

    renderPage();
    await waitFor(() => expect(screen.getByTestId("fe7-roles-group-ops")).toBeInTheDocument());
    expect(screen.getByTestId("fe7-roles-group-toggle-ops")).toHaveAttribute("aria-expanded", "false");
  });

  it("the filter spans groups, expands matching groups and hides non-matching ones", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("fe7-roles-filter")).toBeInTheDocument());
    await user.type(screen.getByTestId("fe7-roles-filter"), "開発");
    // 運営「開発」 and チーム「開発チーム」 match; the collapsed team group is shown expanded
    expect(screen.getByTestId("fe7-roles-open-role_ops_dev")).toBeInTheDocument();
    expect(screen.getByTestId("fe7-roles-open-role_auto_team_dev")).toBeInTheDocument();
    expect(screen.queryByTestId("fe7-roles-open-role_auto_team_pr")).not.toBeInTheDocument();
    expect(screen.getByTestId("fe7-roles-group-count-team")).toHaveTextContent("1 / 2");
    expect(screen.queryByTestId("fe7-roles-group-system")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe7-roles-group-other")).not.toBeInTheDocument();

    await user.clear(screen.getByTestId("fe7-roles-filter"));
    await user.type(screen.getByTestId("fe7-roles-filter"), "zzz");
    expect(screen.getByTestId("fe7-roles-no-match")).toBeInTheDocument();
  });
});
