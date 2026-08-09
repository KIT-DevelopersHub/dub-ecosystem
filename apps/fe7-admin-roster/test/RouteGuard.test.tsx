// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { RouteGuard } from "../src/components/RouteGuard";
import { renderWithProviders, makeMe } from "./renderWithProviders";

describe("RouteGuard", () => {
  it("renders children when permission is held", () => {
    renderWithProviders(
      <RouteGuard requiredPermissions={["identity:admin"]}>
        <div data-testid="guarded">ok</div>
      </RouteGuard>,
      { me: makeMe(["identity:admin"]) },
    );
    expect(screen.getByTestId("guarded")).toBeInTheDocument();
  });

  it("shows 403 when the permission is missing (e.g. /admin/roles/new direct hit)", () => {
    renderWithProviders(
      <RouteGuard requiredPermissions={["identity:admin"]}>
        <div data-testid="guarded">ok</div>
      </RouteGuard>,
      { me: makeMe(["identity:read"]) },
    );
    expect(screen.queryByTestId("guarded")).not.toBeInTheDocument();
    expect(screen.getByTestId("fe7-guard-403")).toBeInTheDocument();
  });

  it("fail-closed (loading) while me is null", () => {
    renderWithProviders(
      <RouteGuard requiredPermissions={["identity:read"]}>
        <div data-testid="guarded">ok</div>
      </RouteGuard>,
      { me: null },
    );
    expect(screen.getByTestId("fe7-guard-loading")).toBeInTheDocument();
  });
});
