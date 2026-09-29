// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { identity } from "@dub/types";
import { AppAccessSection } from "../src/components/AppAccessSection";

function setup(selected: identity.PermissionKey[] = [], opts: { disabled?: boolean; locked?: identity.PermissionKey[] } = {}) {
  const onChange = vi.fn();
  render(
    <AppAccessSection
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
  });

  it("enabling an app emits its view key (閲覧まで default)", () => {
    const { onChange } = setup([]);
    fireEvent.click(screen.getByTestId("fe7-app-enable-gantt"));
    expect(onChange).toHaveBeenCalledWith(["app:gantt:view"]);
  });

  it("shows the nested 閲覧/編集作成 selector when enabled", () => {
    setup(["app:gantt:view"]);
    expect(screen.getByTestId("fe7-app-level-gantt")).toBeInTheDocument();
    expect(screen.getByTestId("fe7-app-level-gantt-view")).toBeInTheDocument();
    expect(screen.getByTestId("fe7-app-level-gantt-edit")).toBeInTheDocument();
  });

  it("choosing 編集・作成まで emits view+edit", () => {
    const { onChange } = setup(["app:gantt:view"]);
    fireEvent.click(screen.getByTestId("fe7-app-level-gantt-edit"));
    expect(onChange).toHaveBeenCalledWith(["app:gantt:edit", "app:gantt:view"].sort());
  });

  it("disabling an app clears both keys (independent of other apps)", () => {
    const { onChange } = setup(["app:gantt:edit", "app:gantt:view", "app:mail:view"]);
    fireEvent.click(screen.getByTestId("fe7-app-enable-gantt"));
    expect(onChange).toHaveBeenCalledWith(["app:mail:view"]);
  });

  it("locked app (管理) keeps its enable toggle disabled ON (self-lockout guard)", () => {
    setup(["app:admin:view", "app:admin:edit"], { locked: ["app:admin:view", "app:admin:edit"] });
    const sw = screen.getByTestId("fe7-app-enable-admin") as HTMLInputElement;
    expect(sw).toBeChecked();
    expect(sw).toBeDisabled();
  });
});
