// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { identity, chat } from "@dub/types";
import { AppAccessSection, type ChatDeletionControls } from "../src/components/AppAccessSection";

function setup(
  selected: identity.PermissionKey[] = [],
  opts: { disabled?: boolean; locked?: identity.PermissionKey[]; chatDeletion?: ChatDeletionControls } = {},
) {
  const onChange = vi.fn();
  render(
    <AppAccessSection
      selected={selected}
      onChange={onChange}
      disabled={opts.disabled}
      lockedKeys={opts.locked ?? []}
      {...(opts.chatDeletion ? { chatDeletion: opts.chatDeletion } : {})}
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

describe("AppAccessSection — チャット 削除権限（4段階）+ 挙動", () => {
  const behavior: ChatDeletionControls = {
    behavior: "hard",
    onBehaviorChange: vi.fn(),
    protectReacted: false,
    onProtectReactedChange: vi.fn(),
  };

  it("shows the 削除権限 selector only when chat is enabled", () => {
    setup([]); // chat off
    expect(screen.queryByTestId("fe7-chatdel-right")).toBeNull();
    setup(["app:chat:view"]);
    expect(screen.getByTestId("fe7-chatdel-right")).toBeInTheDocument();
  });

  it("without the org policy, offers only 3 steps (own_protected hidden)", () => {
    setup(["app:chat:view"]);
    expect(screen.queryByTestId("fe7-chatdel-right-own_protected")).toBeNull();
    for (const v of ["none", "own", "any"]) {
      expect(screen.getByTestId(`fe7-chatdel-right-${v}`)).toBeInTheDocument();
    }
  });

  it("with the org policy, offers the full 4 steps including own_protected", () => {
    setup(["app:chat:view"], { chatDeletion: behavior });
    for (const v of ["none", "own_protected", "own", "any"]) {
      expect(screen.getByTestId(`fe7-chatdel-right-${v}`)).toBeInTheDocument();
    }
  });

  it("derives 削除権限 from the keys (moderate ⇒ 全員削除)", () => {
    setup(["app:chat:view", "chat:moderate"], { chatDeletion: behavior });
    expect(screen.getByTestId("fe7-chatdel-right-any")).toHaveAttribute("aria-selected", "true");
  });

  it("derives「リアクション付きは削除不可」when chat:delete + protectReacted ON", () => {
    setup(["app:chat:view", "chat:delete"], { chatDeletion: { ...behavior, protectReacted: true } });
    expect(screen.getByTestId("fe7-chatdel-right-own_protected")).toHaveAttribute("aria-selected", "true");
  });

  it("derives「自分の投稿のみ削除」when chat:delete + protectReacted OFF", () => {
    setup(["app:chat:view", "chat:delete"], { chatDeletion: { ...behavior, protectReacted: false } });
    expect(screen.getByTestId("fe7-chatdel-right-own")).toHaveAttribute("aria-selected", "true");
  });

  it("choosing 自分の投稿のみ削除 emits chat:delete (own-only)", () => {
    const { onChange } = setup(["app:chat:view"]);
    fireEvent.click(screen.getByTestId("fe7-chatdel-right-own"));
    expect(onChange).toHaveBeenCalledWith(["app:chat:view", "chat:delete"]);
  });

  it("choosing 全員削除 emits chat:moderate (not chat:delete)", () => {
    const { onChange } = setup(["app:chat:view", "chat:delete"]);
    fireEvent.click(screen.getByTestId("fe7-chatdel-right-any"));
    expect(onChange).toHaveBeenCalledWith(["app:chat:view", "chat:moderate"]);
  });

  it("choosing リアクション付きは削除不可 emits chat:delete AND turns protectReacted ON", () => {
    const onChange = vi.fn();
    const onProtectReactedChange = vi.fn();
    render(
      <AppAccessSection
        selected={["app:chat:view"]}
        onChange={onChange}
        chatDeletion={{ ...behavior, protectReacted: false, onProtectReactedChange }}
      />,
    );
    fireEvent.click(screen.getByTestId("fe7-chatdel-right-own_protected"));
    expect(onChange).toHaveBeenCalledWith(["app:chat:view", "chat:delete"]);
    expect(onProtectReactedChange).toHaveBeenCalledWith(true);
  });

  it("switching from リアクション付きは削除不可 to 自分の投稿のみ削除 turns protectReacted OFF", () => {
    const onChange = vi.fn();
    const onProtectReactedChange = vi.fn();
    render(
      <AppAccessSection
        selected={["app:chat:view", "chat:delete"]}
        onChange={onChange}
        chatDeletion={{ ...behavior, protectReacted: true, onProtectReactedChange }}
      />,
    );
    fireEvent.click(screen.getByTestId("fe7-chatdel-right-own"));
    expect(onChange).toHaveBeenCalledWith(["app:chat:view", "chat:delete"]);
    expect(onProtectReactedChange).toHaveBeenCalledWith(false);
  });

  it("choosing 全員削除（モデレート）leaves protectReacted untouched (moderators exempt)", () => {
    const onProtectReactedChange = vi.fn();
    render(
      <AppAccessSection
        selected={["app:chat:view", "chat:delete"]}
        onChange={vi.fn()}
        chatDeletion={{ ...behavior, protectReacted: true, onProtectReactedChange }}
      />,
    );
    fireEvent.click(screen.getByTestId("fe7-chatdel-right-any"));
    expect(onProtectReactedChange).not.toHaveBeenCalled();
  });

  it("hides the 挙動 toggle for 削除権限なし, shows + drives it otherwise", () => {
    // none => no behaviour toggle even when chatDeletion is provided
    setup(["app:chat:view"], { chatDeletion: behavior });
    expect(screen.queryByTestId("fe7-chatdel-mode")).toBeNull();

    // own => toggle visible, reflects current value, drives onBehaviorChange
    const onBehaviorChange = vi.fn();
    setup(["app:chat:view", "chat:delete"], { chatDeletion: { ...behavior, onBehaviorChange } });
    expect(screen.getByTestId("fe7-chatdel-mode-hard")).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByTestId("fe7-chatdel-mode-tombstone"));
    expect(onBehaviorChange).toHaveBeenCalledWith("tombstone" satisfies chat.MessageDeletionMode);
  });

  it("no longer renders a standalone リアクション保護 toggle (folded into the selector)", () => {
    setup(["app:chat:view", "chat:delete"], { chatDeletion: behavior });
    expect(screen.queryByTestId("fe7-chatdel-protect")).toBeNull();
  });
});
