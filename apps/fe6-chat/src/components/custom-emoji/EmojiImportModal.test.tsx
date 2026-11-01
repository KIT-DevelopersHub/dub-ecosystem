import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { common, identity } from "@dub/types";
import { ChatRuntimeProvider, type ChatRuntime } from "../../context";
import { MockChatClient } from "../../api/mock-client";
import { MockRealtimeClient } from "../../realtime/mock-client";
import { demoSeed, ME } from "../../dev/seed";
import { ChatApp } from "../ChatApp";

beforeEach(() => {
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = vi.fn(() => "blob:x");
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = vi.fn();
});

function renderWith(keys: identity.PermissionKey[], api = new MockChatClient(demoSeed())) {
  const runtime: ChatRuntime = {
    api,
    can: (k) => keys.includes(k),
    currentUserId: ME as common.UserId,
    createRealtimeClient: () => new MockRealtimeClient(),
  };
  render(
    <ChatRuntimeProvider value={runtime}>
      <ChatApp />
    </ChatRuntimeProvider>,
  );
  return api;
}

const CHAT_EDITOR: identity.PermissionKey[] = ["app:chat:view", "app:chat:edit", "chat:create", "chat:moderate", "chat:delete_channel", "chat:slack_import"];

describe("Slack emoji import (ChatApp)", () => {
  it("is offered only with chat:emoji_import (chat:slack_import alone is not enough)", async () => {
    renderWith(CHAT_EDITOR);
    await screen.findByTestId("fe6-slack-import-open");
    expect(screen.queryByTestId("fe6-emoji-import-sidebar")).toBeNull();
  });

  it("runs to completion, shows 取り込み済み / 全件, and refreshes the emoji list", async () => {
    const user = userEvent.setup();
    const api = renderWith([...CHAT_EDITOR, "chat:emoji_import"]);
    await user.click(await screen.findByTestId("fe6-emoji-import-sidebar"));
    const modal = await screen.findByTestId("fe6-emoji-import-modal");
    expect(modal.querySelector('[data-feature="custom-emoji-v1"]')).not.toBeNull();
    await user.click(screen.getByTestId("fe6-emoji-import-start"));
    await waitFor(() => expect(screen.getByTestId("fe6-emoji-import-count")).toHaveTextContent("取り込み済み 15 / 15 件"), { timeout: 5000 });
    expect(screen.getByText("完了しました")).toBeInTheDocument();
    expect((await api.listCustomEmojis()).map((e) => e.name)).toContain("partyparrot");
  });

  it("shows the server's reason when the import is refused", async () => {
    const user = userEvent.setup();
    const api = new MockChatClient(demoSeed());
    api.importSlackEmojis = () => Promise.reject(Object.assign(new Error("x"), { status: 412 }));
    renderWith([...CHAT_EDITOR, "chat:emoji_import"], api);
    await user.click(await screen.findByTestId("fe6-emoji-import-sidebar"));
    await user.click(await screen.findByTestId("fe6-emoji-import-start"));
    expect(await screen.findByText(/SLACK_BOT_TOKEN/)).toBeInTheDocument();
  });
});
