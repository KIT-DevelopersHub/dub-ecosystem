import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { chat, common, identity } from "@dub/types";
import { ChatRuntimeProvider, type ChatRuntime } from "../../context";
import { MockChatClient } from "../../api/mock-client";
import { MockRealtimeClient } from "../../realtime/mock-client";
import { demoSeed, ME } from "../../dev/seed";
import { ChatApp } from "../ChatApp";

const CHAT_EDITOR: identity.PermissionKey[] = ["app:chat:view", "app:chat:edit", "chat:create"];
const config = { prefix: "times-", isPrivate: false, autoCreate: true };
const item = (userId: string, status: chat.SlackTimesItem["status"], channelName: string | null): chat.SlackTimesItem => ({
  userId,
  displayName: userId,
  email: `${userId}@example.com`,
  channelName,
  slackUserId: channelName ? `U_${userId}` : null,
  slackChannelId: null,
  status,
  error: null,
});

function renderWith(keys: identity.PermissionKey[], api: MockChatClient) {
  const runtime: ChatRuntime = { api, can: (k) => keys.includes(k), currentUserId: ME as common.UserId, createRealtimeClient: () => new MockRealtimeClient() };
  render(
    <ChatRuntimeProvider value={runtime}>
      <ChatApp />
    </ChatRuntimeProvider>,
  );
}

type TimesApi = MockChatClient & {
  previewSlackTimes: () => Promise<chat.SlackTimesPreviewResponse>;
  bulkCreateSlackTimes: (userIds?: string[]) => Promise<chat.SlackTimesBulkResponse>;
};

function withTimes(): TimesApi {
  const api = new MockChatClient(demoSeed()) as TimesApi;
  api.previewSlackTimes = vi.fn(async () => ({
    config,
    items: [item("alice", "planned", "times-alice"), item("nos", "no_slack_account", null)],
    recordedCount: 1,
  }));
  api.bulkCreateSlackTimes = vi.fn(async () => ({ results: [item("alice", "created", "times-alice")], remaining: 0 }));
  return api;
}

describe("Slack times (ChatApp)", () => {
  it("is offered only with chat:slack_times", async () => {
    renderWith(CHAT_EDITOR, withTimes());
    await screen.findByText(/チャンネル/);
    expect(screen.queryByTestId("fe6-slack-times-open")).toBeNull();
  });

  it("shows a dry-run preview first and creates only on the button", async () => {
    const user = userEvent.setup();
    const api = withTimes();
    renderWith([...CHAT_EDITOR, "chat:slack_times"], api);
    await user.click(await screen.findByTestId("fe6-slack-times-open"));
    expect(await screen.findByText(/作成予定（1 人・まだ何も作っていません）/)).toBeInTheDocument();
    expect(screen.getByText(/#times-alice/)).toBeInTheDocument();
    expect(screen.getByTestId("fe6-slack-times-no-account")).toHaveTextContent("nos");
    expect(api.bulkCreateSlackTimes).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("fe6-slack-times-run"));
    await waitFor(() => expect(screen.getByText(/作成しました/)).toBeInTheDocument());
    expect(api.bulkCreateSlackTimes).toHaveBeenCalledTimes(1);
  });

  it("shows the scope list from a 412", async () => {
    const user = userEvent.setup();
    const api = withTimes();
    api.previewSlackTimes = () =>
      Promise.reject(Object.assign(new Error("Slack アプリの権限が足りません: channels:manage, channels:write.invites"), { status: 412 }));
    renderWith([...CHAT_EDITOR, "chat:slack_times"], api);
    await user.click(await screen.findByTestId("fe6-slack-times-open"));
    expect(await screen.findByText(/channels:write\.invites/)).toBeInTheDocument();
  });
});
