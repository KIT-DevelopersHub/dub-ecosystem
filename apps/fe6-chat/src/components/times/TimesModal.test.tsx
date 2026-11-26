import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { common, identity } from "@dub/types";
import { ChatRuntimeProvider, type ChatRuntime } from "../../context";
import { MockChatClient } from "../../api/mock-client";
import { MockRealtimeClient } from "../../realtime/mock-client";
import { demoSeed, ME } from "../../dev/seed";
import { ChatApp } from "../ChatApp";

const CHAT_EDITOR: identity.PermissionKey[] = ["app:chat:view", "app:chat:edit", "chat:create"];

function renderWith(keys: identity.PermissionKey[], api: MockChatClient) {
  const runtime: ChatRuntime = { api, can: (k) => keys.includes(k), currentUserId: ME as common.UserId, createRealtimeClient: () => new MockRealtimeClient() };
  render(
    <ChatRuntimeProvider value={runtime}>
      <ChatApp />
    </ChatRuntimeProvider>,
  );
}

describe("times channels (ChatApp, Dub chat)", () => {
  it("is offered only with chat:times", async () => {
    renderWith(CHAT_EDITOR, new MockChatClient(demoSeed()));
    await screen.findByText(/チャンネル/);
    expect(screen.queryByTestId("fe6-times-open")).toBeNull();
  });

  it("shows a dry-run preview first and creates owned chat channels only on the button", async () => {
    const user = userEvent.setup();
    const api = new MockChatClient(demoSeed());
    const bulk = vi.spyOn(api, "bulkCreateTimes");
    renderWith([...CHAT_EDITOR, "chat:times"], api);
    const open = await screen.findByTestId("fe6-times-open");
    expect(open).toHaveTextContent("＋ times 作成");
    await user.click(open);
    expect(await screen.findByText(/まだ何も作っていません/)).toBeInTheDocument();
    const planned = (await api.previewTimes()).items;
    expect(planned.length).toBeGreaterThan(0);
    expect(planned.every((i) => i.channelName?.startsWith("times-"))).toBe(true);
    expect(bulk).not.toHaveBeenCalled();
    const before = (await api.listChannels()).length;
    await user.click(screen.getByTestId("fe6-times-run"));
    await waitFor(() => expect(screen.getAllByText(/作成しました/).length).toBeGreaterThan(0));
    expect(bulk).toHaveBeenCalled();
    const after = await api.listChannels();
    expect(after.length).toBe(before + planned.length);
    expect((await api.previewTimes()).items).toEqual([]);
  });

  it("shows a friendly message on 412", async () => {
    const user = userEvent.setup();
    const api = new MockChatClient(demoSeed());
    api.previewTimes = () => Promise.reject(Object.assign(new Error("times_not_configured"), { status: 412 }));
    renderWith([...CHAT_EDITOR, "chat:times"], api);
    await user.click(await screen.findByTestId("fe6-times-open"));
    expect(await screen.findByText(/まだ使えるようになっていません/)).toBeInTheDocument();
  });
});
