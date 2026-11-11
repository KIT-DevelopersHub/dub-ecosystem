import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { common, identity } from "@dub/types";
import { ChatRuntimeProvider, type ChatRuntime } from "../context";
import { ChatApiError } from "../api/client";
import type { Channel } from "../api/contract";
import { MockChatClient } from "../api/mock-client";
import { MockRealtimeClient } from "../realtime/mock-client";
import { demoSeed, ME } from "../dev/seed";
import { ChatApp } from "./ChatApp";

const GENERAL = "chn_general00000000000000000";
const KEYS: identity.PermissionKey[] = ["app:chat:view", "app:chat:edit", "chat:create", "chat:moderate", "chat:change_visibility"];

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

const sidebarGlyph = async () => {
  const row = (await screen.findAllByTestId("fe6-channel-list-item")).find((el) => el.getAttribute("data-channel-id") === GENERAL)!;
  return row.firstElementChild?.textContent;
};

async function openVisibility() {
  fireEvent.click(await screen.findByTestId("fe6-channel-settings-open"));
  fireEvent.click(screen.getByRole("tab", { name: /設定/ }));
}

// ChatApp 全体を描くので CI の負荷では既定の 5 秒を超えることがある。
describe("channel visibility switch (ChatApp)", { timeout: 20_000 }, () => {
  it("flips the sidebar lock at once, and rolls everything back when the server refuses", async () => {
    const api = renderWith(KEYS);
    let reject!: (e: unknown) => void;
    vi.spyOn(api, "updateChannelVisibility").mockImplementation(() => new Promise<Channel>((_, r) => (reject = r)));
    expect(await sidebarGlyph()).toBe("#");

    await openVisibility();
    fireEvent.click(screen.getByTestId("fe6-settings-visibility-change"));
    const confirm = await screen.findByTestId("fe6-settings-visibility-confirm");
    fireEvent.click(within(confirm).getByRole("button", { name: "Private に変更する" }));

    await waitFor(async () => expect(await sidebarGlyph()).toBe("🔒"));
    expect(screen.getByTestId("fe6-settings-visibility").textContent).toContain("Private");

    reject(new ChatApiError(409, { error: { code: "CHAT_VERSION_CONFLICT", message: "version conflict", retryable: false } }));
    await waitFor(async () => expect(await sidebarGlyph()).toBe("#"));
    expect(screen.getByTestId("fe6-settings-visibility").textContent).toContain("Public");
    expect(await screen.findByText("公開範囲を変更できませんでした")).toBeInTheDocument();
  });

  it("persists through the API on success", async () => {
    const api = renderWith(KEYS);
    const spy = vi.spyOn(api, "updateChannelVisibility");
    await openVisibility();
    fireEvent.click(screen.getByTestId("fe6-settings-visibility-change"));
    const confirm = await screen.findByTestId("fe6-settings-visibility-confirm");
    fireEvent.click(within(confirm).getByRole("button", { name: "Private に変更する" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(GENERAL, { visibility: "private", version: 1 }));
    expect((await api.getChannel(GENERAL)).channel.visibility).toBe("private");
    await waitFor(async () => expect(await sidebarGlyph()).toBe("🔒"));
  });

  it("needs 編集 as well as chat:change_visibility (mirrors the server rule)", async () => {
    renderWith(["app:chat:view", "chat:moderate", "chat:change_visibility"]);
    await openVisibility();
    expect(screen.getByTestId("fe6-settings-visibility")).toBeInTheDocument();
    expect(screen.queryByTestId("fe6-settings-visibility-change")).toBeNull();
  });
});
