// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { identity } from "@dub/types";
import { AppAccessSection } from "../src/components/AppAccessSection";

const catalog = identity.PERMISSION_CATALOG;

function setup(
  selected: identity.PermissionKey[] = [],
  opts: { disabled?: boolean; locked?: identity.PermissionKey[] } = {},
) {
  const onChange = vi.fn();
  render(
    <AppAccessSection
      catalog={catalog}
      selected={selected}
      onChange={onChange}
      disabled={opts.disabled}
      lockedKeys={opts.locked ?? []}
    />,
  );
  return { onChange };
}

describe("AppAccessSection — per-app enable + nested level", () => {
  it("renders one enable toggle per app INCLUDING gantt and participation (individually)", () => {
    setup();
    expect(screen.getByTestId("fe7-app-enable-gantt")).toBeInTheDocument();
    expect(screen.getByTestId("fe7-app-enable-participation")).toBeInTheDocument();
    expect(screen.getByTestId("fe7-app-enable-tasks")).toBeInTheDocument();
    expect(screen.getByTestId("fe7-app-enable-members")).toBeInTheDocument();
  });

  it("hides the nested level selector until the app is enabled (OFF = collapsed)", () => {
    setup([]);
    expect(screen.queryByTestId("fe7-app-level-gantt")).toBeNull();
    expect(screen.queryByTestId("fe7-app-level-mail")).toBeNull();
  });

  it("a shared-domain app (gantt) offers only 閲覧/編集・作成, no 管理 and no 詳細", () => {
    setup(["app:gantt:view"]);
    expect(screen.getByTestId("fe7-app-level-gantt-view")).toBeInTheDocument();
    expect(screen.getByTestId("fe7-app-level-gantt-edit")).toBeInTheDocument();
    expect(screen.queryByTestId("fe7-app-level-gantt-manage")).toBeNull();
    expect(screen.queryByTestId("fe7-app-details-toggle-gantt")).toBeNull();
  });

  it("a single-owner app (mail) offers 閲覧/編集・作成/管理 and a 詳細 disclosure", () => {
    setup(["app:mail:view"]);
    expect(screen.getByTestId("fe7-app-level-mail-view")).toBeInTheDocument();
    expect(screen.getByTestId("fe7-app-level-mail-edit")).toBeInTheDocument();
    expect(screen.getByTestId("fe7-app-level-mail-manage")).toBeInTheDocument();
    expect(screen.queryByTestId("fe7-app-detail-mail-mail:admin")).toBeNull();
    fireEvent.click(screen.getByTestId("fe7-app-details-toggle-mail"));
    expect(screen.getByTestId("fe7-app-detail-mail-mail:admin")).toBeInTheDocument();
    expect(screen.getByTestId("fe7-app-detail-mail-mail:read")).toBeInTheDocument();
  });

  it("enabling a shared-domain app (gantt) emits only its own view key (no capability keys)", () => {
    const { onChange } = setup([]);
    fireEvent.click(screen.getByTestId("fe7-app-enable-gantt"));
    expect(onChange).toHaveBeenCalledWith(["app:gantt:view"]);
  });

  it("enabling a single-owner app (mail) emits its view key + mail:read (folded capability)", () => {
    const { onChange } = setup([]);
    fireEvent.click(screen.getByTestId("fe7-app-enable-mail"));
    expect(onChange).toHaveBeenCalledWith(["app:mail:view", "mail:read"].sort());
  });

  it("choosing 編集・作成まで on gantt emits view+edit (access keys only, shared domain)", () => {
    const { onChange } = setup(["app:gantt:view"]);
    fireEvent.click(screen.getByTestId("fe7-app-level-gantt-edit"));
    expect(onChange).toHaveBeenCalledWith(["app:gantt:edit", "app:gantt:view"].sort());
  });

  it("choosing 管理まで on mail emits every mail key at or below 管理", () => {
    const { onChange } = setup(["app:mail:view", "mail:read"]);
    fireEvent.click(screen.getByTestId("fe7-app-level-mail-manage"));
    expect(onChange).toHaveBeenCalledWith(
      ["app:mail:edit", "app:mail:view", "mail:admin", "mail:read", "mail:read_all", "mail:send"].sort(),
    );
  });

  it("toggling a 詳細 key directly flips just that one key", () => {
    const { onChange } = setup(["app:mail:view", "app:mail:edit", "mail:read", "mail:send"]);
    fireEvent.click(screen.getByTestId("fe7-app-details-toggle-mail"));
    fireEvent.click(screen.getByTestId("fe7-app-detail-mail-mail:admin"));
    expect(onChange).toHaveBeenCalledWith(
      ["app:mail:edit", "app:mail:view", "mail:admin", "mail:read", "mail:send"].sort(),
    );
  });

  it("disabling an app clears every key it owns (independent of other apps)", () => {
    const { onChange } = setup(["app:gantt:edit", "app:gantt:view", "app:mail:view", "mail:read"]);
    fireEvent.click(screen.getByTestId("fe7-app-enable-gantt"));
    expect(onChange).toHaveBeenCalledWith(["app:mail:view", "mail:read"].sort());
  });

  it("locked app (管理/ロール管理) keeps its enable toggle disabled ON (self-lockout guard)", () => {
    setup(["app:admin:view", "app:admin:edit"], { locked: ["app:admin:view", "app:admin:edit"] });
    const sw = screen.getByTestId("fe7-app-enable-admin") as HTMLInputElement;
    expect(sw).toBeChecked();
    expect(sw).toBeDisabled();
  });
});
