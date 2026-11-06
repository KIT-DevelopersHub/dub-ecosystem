// 作成できるチャンネルの 3 択が、チャット画面の作成導線にそのまま反映されること。
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { common, identity } from "@dub/types";
import { ChatRuntimeProvider, type ChatRuntime } from "../context";
import { MockChatClient } from "../api/mock-client";
import { MockRealtimeClient } from "../realtime/mock-client";
import { demoSeed, ME } from "../dev/seed";
import { ChatApp } from "./ChatApp";

const GENERAL = "chn_general00000000000000000";
const EDITOR: identity.PermissionKey[] = ["app:chat:view", "app:chat:edit"];

function renderWith(keys: identity.PermissionKey[]) {
  const api = new MockChatClient(demoSeed());
  const runtime: ChatRuntime = {
    api,
    can: (k) => keys.includes(k),
    currentUserId: ME as common.UserId,
    createRealtimeClient: () => new MockRealtimeClient(),
  };
  render(
    <ChatRuntimeProvider value={runtime}>
      <ChatApp initialChannelId={GENERAL} />
    </ChatRuntimeProvider>,
  );
  return api;
}

describe("作成導線と作成範囲", () => {
  it("パブリックとプライベート: Private を選んで作成できる", async () => {
    const api = renderWith([...EDITOR, "chat:create", "chat:create_private"]);
    const create = vi.spyOn(api, "createChannel");
    await userEvent.click(await screen.findByTestId("fe6-channel-create"));
    expect(screen.queryByTestId("fe6-create-private-denied")).not.toBeInTheDocument();

    await userEvent.type(screen.getByTestId("fe6-create-name"), "secret");
    await userEvent.click(screen.getByTestId("fe6-create-private"));
    await userEvent.click(screen.getByTestId("fe6-create-submit"));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ visibility: "private" }));
  });

  it("パブリックのみ: Private は選べず、理由を出す", async () => {
    renderWith([...EDITOR, "chat:create"]);
    await userEvent.click(await screen.findByTestId("fe6-channel-create"));
    expect(screen.getByTestId("fe6-create-private")).toBeDisabled();
    expect(screen.getByTestId("fe6-create-private-denied")).toBeInTheDocument();
  });

  it("作成できない: チャンネルも DM も作成導線を出さない", async () => {
    renderWith(EDITOR);
    await screen.findByTestId("fe6-channel-list");
    expect(screen.queryByTestId("fe6-channel-create")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe6-dm-new")).not.toBeInTheDocument();
  });

  it("閲覧のロールは chat:create を持っていても導線を出さない (サーバが 403 を返すため)", async () => {
    renderWith(["app:chat:view", "chat:create", "chat:create_private"]);
    await screen.findByTestId("fe6-channel-list");
    expect(screen.queryByTestId("fe6-channel-create")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe6-dm-new")).not.toBeInTheDocument();
  });
});
