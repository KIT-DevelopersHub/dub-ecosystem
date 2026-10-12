import { describe, it, expect, vi } from "vitest";
import type { identity } from "@dub/types";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatRuntimeProvider } from "../context";
import { MockChatClient } from "../api/mock-client";
import { demoSeed } from "../dev/seed";
import { NewDmModal } from "./NewDmModal";

function setup(onStart = vi.fn(async (_peers: identity.UserSummary[]) => {})) {
  const seed = demoSeed();
  const api = new MockChatClient(seed);
  render(
    <ChatRuntimeProvider
      value={{ api, can: () => true, currentUserId: seed.currentUserId, createRealtimeClient: () => ({}) as never }}
    >
      <NewDmModal open onClose={() => {}} onStart={onStart} />
    </ChatRuntimeProvider>,
  );
  return { onStart, me: seed.currentUserId };
}

describe("NewDmModal", () => {
  it("lists members except me, and starts a DM with the picked person", async () => {
    const { onStart } = setup();
    const options = await screen.findAllByTestId("fe6-new-dm-option");
    expect(options.length).toBeGreaterThan(0);
    expect(options.some((o) => o.textContent?.includes("高岡 己太朗"))).toBe(false);
    expect(screen.getByTestId("fe6-new-dm-start")).toBeDisabled();

    await userEvent.click(screen.getByRole("option", { name: /佐藤 花子/ }));
    await userEvent.click(screen.getByTestId("fe6-new-dm-start"));
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
    expect(onStart.mock.calls[0]![0].map((u) => u.displayName)).toEqual(["佐藤 花子"]);
  });

  it("filters by name and labels a group DM by head count", async () => {
    setup();
    await userEvent.type(screen.getByTestId("fe6-new-dm-search"), "田中");
    await waitFor(() => expect(screen.getAllByTestId("fe6-new-dm-option")).toHaveLength(1));
    await userEvent.click(screen.getByRole("option", { name: /田中 大輔/ }));
    await userEvent.clear(screen.getByTestId("fe6-new-dm-search"));
    await userEvent.click(await screen.findByRole("option", { name: /鈴木 美咲/ }));
    expect(screen.getByTestId("fe6-new-dm-start")).toHaveTextContent("3 人で開始");
  });

  it("shows an error and keeps the dialog when starting fails", async () => {
    setup(vi.fn(async (_peers: identity.UserSummary[]) => Promise.reject(new Error("boom"))));
    await userEvent.click(await screen.findByRole("option", { name: /佐藤 花子/ }));
    await userEvent.click(screen.getByTestId("fe6-new-dm-start"));
    expect(await screen.findByRole("alert")).toHaveTextContent("DM を開始できませんでした");
    expect(screen.getByTestId("fe6-new-dm-picked")).toHaveTextContent("佐藤 花子");
  });
});
