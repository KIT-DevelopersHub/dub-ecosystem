// チャットの詳細設定: 作成できるチャンネル（作成できない / パブリックのみ / パブリックとプライベート）。
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { policy, type identity } from "@dub/types";
import { ChatCreateScopeSection } from "../src/components/ChatCreateScopeSection";
import { buildRoleUpdate } from "../src/lib/permissionMatrix";

const EDITOR: identity.PermissionKey[] = ["app:chat:edit", "app:chat:view", "chat:create", "chat:create_private"];

function Harness({ initial, level }: { initial: identity.PermissionKey[]; level: policy.AppAccessLevel }) {
  const [selected, setSelected] = useState(initial);
  return (
    <>
      <ChatCreateScopeSection selected={selected} level={level} onChange={setSelected} idPrefix="t" />
      <output data-testid="keys">{selected.join(" ")}</output>
    </>
  );
}

const keys = () => (screen.getByTestId("keys").textContent ?? "").split(" ");

describe("ChatCreateScopeSection", () => {
  it("現在の範囲を選択状態で出す", () => {
    render(<Harness initial={["app:chat:edit", "app:chat:view", "chat:create"]} level="edit" />);
    expect(screen.getByTestId("t-chat-create-scope-public")).toHaveAttribute("aria-selected", "true");
  });

  it("3 択を順に選ぶと鍵が揃う", async () => {
    render(<Harness initial={EDITOR} level="edit" />);
    await userEvent.click(screen.getByTestId("t-chat-create-scope-public"));
    expect(keys()).toContain("chat:create");
    expect(keys()).not.toContain("chat:create_private");

    await userEvent.click(screen.getByTestId("t-chat-create-scope-none"));
    expect(keys()).not.toContain("chat:create");
    expect(keys()).not.toContain("chat:create_private");
    expect(screen.getByText(/DM も新しく作成できません/)).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("t-chat-create-scope-all"));
    expect(keys()).toEqual(expect.arrayContaining(["chat:create", "chat:create_private"]));
  });

  it("閲覧のときは触れず、理由を出す", () => {
    render(<Harness initial={["app:chat:view", "chat:create"]} level="view" />);
    expect(screen.getByTestId("t-chat-create-scope-locked")).toBeInTheDocument();
    expect((screen.getByTestId("t-chat-create-scope-none") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("保存の差分", () => {
  it("「作成できない」にした変更が PATCH に残る", () => {
    const next = policy.setChatCreateScope(EDITOR, "none");
    const patch = buildRoleUpdate({ name: "r", permissions: EDITOR }, { name: "r", permissions: next });
    expect(patch?.permissions).toEqual(["app:chat:edit", "app:chat:view"]);
  });
});
