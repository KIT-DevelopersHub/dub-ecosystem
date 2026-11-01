import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { common, identity } from "@dub/types";
import { ChatRuntimeProvider, type ChatRuntime } from "../context";
import { MockChatClient } from "../api/mock-client";
import { MockRealtimeClient } from "../realtime/mock-client";
import { demoSeed, ME } from "../dev/seed";
import { ChatApp } from "./ChatApp";

function renderWith(keys: identity.PermissionKey[]) {
  const runtime: ChatRuntime = {
    api: new MockChatClient(demoSeed()),
    can: (k) => keys.includes(k),
    currentUserId: ME as common.UserId,
    createRealtimeClient: () => new MockRealtimeClient(),
  };
  render(
    <ChatRuntimeProvider value={runtime}>
      <ChatApp />
    </ChatRuntimeProvider>,
  );
}

const EDITOR: identity.PermissionKey[] = ["app:chat:view", "app:chat:edit", "chat:create", "chat:moderate"];

describe("shared sidebar sections (ChatApp)", () => {
  it("everyone sees the org-wide sections; without chat:manage_sections there is no organizing UI", async () => {
    renderWith(EDITOR);
    expect(await screen.findByText("運営")).toBeInTheDocument();
    expect(screen.queryByTestId("fe6-section-create")).toBeNull();
    expect(screen.queryByTestId("fe6-section-menu")).toBeNull();
    expect(screen.queryByTestId("fe6-channel-move-menu")).toBeNull();
  });

  it("chat:manage_sections (with 編集) unlocks create / rename / delete / move", async () => {
    renderWith([...EDITOR, "chat:manage_sections"]);
    expect(await screen.findByTestId("fe6-section-create")).toBeInTheDocument();
    expect(screen.getAllByTestId("fe6-section-menu").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("fe6-channel-move-menu").length).toBeGreaterThan(0);
  });

  it("chat:manage_sections without 編集 is not enough (mirrors the server rule)", async () => {
    renderWith(["app:chat:view", "chat:manage_sections"]);
    expect(await screen.findByText("運営")).toBeInTheDocument();
    expect(screen.queryByTestId("fe6-section-create")).toBeNull();
  });
});
