import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { common, identity } from "@dub/types";
import { ChatRuntimeProvider, type ChatRuntime } from "../../context";
import { MockChatClient } from "../../api/mock-client";
import { MockRealtimeClient } from "../../realtime/mock-client";
import { demoSeed, ME } from "../../dev/seed";
import { ChatApp } from "../ChatApp";

// The 取り込み entry follows ロール管理 > チャット > 「Slack から取り込み」 (chat:slack_import),
// not chat:create / chat:moderate — a maintainer with every other chat key sees no button.
function renderWith(keys: identity.PermissionKey[]) {
  const runtime: ChatRuntime = {
    api: new MockChatClient(demoSeed()),
    can: (k) => keys.includes(k),
    currentUserId: ME as common.UserId,
    createRealtimeClient: () => new MockRealtimeClient(),
  };
  return render(
    <ChatRuntimeProvider value={runtime}>
      <ChatApp />
    </ChatRuntimeProvider>,
  );
}

const CHAT_EDITOR: identity.PermissionKey[] = ["app:chat:view", "app:chat:edit", "chat:create", "chat:moderate", "chat:delete_channel"];

describe("ChatApp Slack import gate", () => {
  it("shows the import entry with chat:slack_import", async () => {
    renderWith([...CHAT_EDITOR, "chat:slack_import"]);
    expect(await screen.findByTestId("fe6-slack-import-open")).toBeTruthy();
  });

  it("hides it for 編集 + every other chat key", async () => {
    renderWith(CHAT_EDITOR);
    await screen.findAllByRole("button");
    expect(screen.queryByTestId("fe6-slack-import-open")).toBeNull();
  });
});
