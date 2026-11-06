// 運営メンバーの詳細設定: 閲覧・編集の範囲（組織図まで / メール名簿以外 / 全て）を選ぶ。
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { policy, type identity } from "@dub/types";
import { MembersScopeSection } from "../src/components/MembersScopeSection";

function Harness({ initial, level }: { initial: identity.PermissionKey[]; level: policy.AppAccessLevel }) {
  const [selected, setSelected] = useState(initial);
  return (
    <>
      <MembersScopeSection selected={selected} level={level} onChange={setSelected} idPrefix="t" />
      <output data-testid="keys">{selected.join(" ")}</output>
    </>
  );
}

describe("MembersScopeSection", () => {
  it("編集範囲を広げると閲覧範囲の鍵も付く", async () => {
    render(<Harness initial={["app:members:view", "app:members:edit"]} level="edit" />);
    await userEvent.click(screen.getByTestId("t-members-scope-edit-roster"));
    const keys = screen.getByTestId("keys").textContent ?? "";
    expect(keys).toContain("members:roster_edit");
    expect(keys).toContain("members:roster_view");
    expect(keys).not.toContain("members:mail_view");
    expect(screen.getByTestId("t-members-scope-view-roster")).toHaveAttribute("aria-selected", "true");
  });

  it("閲覧のときは編集範囲を触れず、理由を出す", () => {
    render(<Harness initial={["app:members:view"]} level="view" />);
    expect(screen.getByTestId("t-members-scope-edit-locked")).toBeInTheDocument();
    expect((screen.getByTestId("t-members-scope-edit-all") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("t-members-scope-view-all") as HTMLButtonElement).disabled).toBe(false);
  });

  it("無効のときは範囲を触れない", () => {
    render(<Harness initial={[]} level="none" />);
    expect((screen.getByTestId("t-members-scope-view-all") as HTMLButtonElement).disabled).toBe(true);
  });
});
