// @vitest-environment jsdom
// UserListPage roster <-> Email Routing sync: pulls the @developershub.jp addresses
// through the proxy and upserts them as roster users; degrades to a "未接続" notice
// when the proxy is unconfigured.
import { describe, it, expect } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { UserListPage } from "../src/components/UserListPage";
import { renderWithProviders, makeMe } from "./renderWithProviders";
import { createMockClient } from "../src/api/mockClient";
import type { ResourceClient } from "../src/shell/contract";

const ADMIN = makeMe(["identity:read", "identity:admin", "audit:read", "event:read", "mail:admin"]);

describe("UserListPage — Email Routing sync", () => {
  it("shows the sync + issue actions only when the admin holds mail:admin", async () => {
    const { unmount } = renderWithProviders(<UserListPage />, { me: ADMIN });
    await waitFor(() => expect(screen.getByTestId("fe7-users-table")).toBeInTheDocument());
    expect(screen.getByTestId("fe7-users-sync")).toBeInTheDocument();
    expect(screen.getByTestId("fe7-users-issue")).toBeInTheDocument();
    unmount();

    // identity:admin but no mail:admin -> can invite, cannot sync/issue
    renderWithProviders(<UserListPage />, { me: makeMe(["identity:read", "identity:admin"]) });
    await waitFor(() => expect(screen.getByTestId("fe7-users-table")).toBeInTheDocument());
    expect(screen.queryByTestId("fe7-users-sync")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe7-users-issue")).not.toBeInTheDocument();
    expect(screen.getByTestId("fe7-users-invite")).toBeInTheDocument();
  });

  it("syncs Email Routing addresses into the roster as source=email-routing rows", async () => {
    renderWithProviders(<UserListPage />, { me: ADMIN });
    await waitFor(() => expect(screen.getByTestId("fe7-users-row-user_alice")).toBeInTheDocument());
    // seeded routing addresses (info/support/noreply@developershub.jp) are not users yet
    expect(screen.queryByText("info@developershub.jp")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("fe7-users-sync"));

    await waitFor(() => expect(screen.getByText("info@developershub.jp")).toBeInTheDocument());
    expect(screen.getByText("support@developershub.jp")).toBeInTheDocument();
    expect(screen.getByText("noreply@developershub.jp")).toBeInTheDocument();
    // provenance badge is rendered for a synced row
    const infoRow = screen.getByText("info@developershub.jp").closest("tr")!;
    expect(infoRow.textContent).toContain("Email Routing");
  });

  it("renders a 未接続 notice when the proxy is unconfigured (no partial write)", async () => {
    // Wrap the mock so the addresses read fails as the gateway 503 does.
    const base = createMockClient({ me: ADMIN });
    const client: ResourceClient = {
      ...base,
      get: (path: string, query?: Record<string, unknown>) => {
        if (path.endsWith("/admin/email-routing/addresses")) {
          return Promise.reject({ error: { code: "MAIL_EMAIL_ROUTING_UNCONFIGURED", message: "unconfigured", retryable: false } });
        }
        return base.get(path, query);
      },
    };
    renderWithProviders(<UserListPage />, { me: ADMIN, client });
    await waitFor(() => expect(screen.getByTestId("fe7-users-sync")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("fe7-users-sync"));

    await waitFor(() => expect(screen.getByTestId("fe7-routing-unconfigured")).toBeInTheDocument());
    // roster unchanged (no new routing rows appeared)
    expect(screen.queryByText("info@developershub.jp")).not.toBeInTheDocument();
  });
});
