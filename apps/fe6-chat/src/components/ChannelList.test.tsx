import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Channel } from "../api/contract";
import { ChannelList, type SectionActions } from "./ChannelList";

function chan(id: string, over: Partial<Channel> = {}): Channel {
  return {
    id,
    orgId: "org",
    type: "topic",
    visibility: "public",
    name: id,
    topic: null,
    eventId: null,
    archived: false,
    memberCount: 1,
    version: 1,
    createdAt: "t",
    updatedAt: "t",
    ...over,
  };
}

function setup(assignments: Record<string, string> = { dev: "sec_ops" }) {
  const actions: SectionActions = { onCreate: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onMove: vi.fn() };
  render(
    <ChannelList
      channels={[chan("dev"), chan("general")]}
      unread={{}}
      activeChannelId={null}
      canCreate={false}
      onSelect={() => {}}
      sections={[
        { id: "sec_ops", name: "運営", position: 0, createdAt: "t" },
        { id: "sec_empty", name: "空", position: 1, createdAt: "t" },
      ]}
      assignments={assignments}
      sectionActions={actions}
    />,
  );
  return actions;
}

describe("ChannelList sections", () => {
  beforeEach(() => localStorage.clear());

  it("renders user sections first (empty ones with a hint), then default groups", () => {
    setup();
    const blocks = screen.getAllByTestId("fe6-sidebar-section");
    expect(blocks.map((b) => b.getAttribute("data-section-id"))).toEqual(["sec_ops", "sec_empty"]);
    expect(within(blocks[0]!).getAllByTestId("fe6-channel-list-item").map((b) => b.getAttribute("data-channel-id"))).toEqual(["dev"]);
    expect(blocks[1]!.textContent).toContain("チャンネルをここに移動できます");
    expect(screen.getByTestId("fe6-section-create")).toBeInTheDocument();
  });

  it("moves a channel via the row menu and persists collapse", async () => {
    const actions = setup();
    const general = screen.getAllByTestId("fe6-channel-move-menu")[1]!;
    await userEvent.click(within(general).getByRole("button", { name: "セクションに移動" }));
    await userEvent.click(screen.getByTestId("fe6-channel-move-to-sec_ops"));
    expect(actions.onMove).toHaveBeenCalledWith("general", "sec_ops");

    const ops = screen.getAllByTestId("fe6-sidebar-section")[0]!;
    await userEvent.click(within(ops).getByRole("button", { name: /運営/, expanded: true }));
    expect(localStorage.getItem("fe6.chat.collapsedSections")).toBe('["sec_ops"]');
  });

  it("offers remove + new-section for an assigned channel", async () => {
    const actions = setup();
    const dev = screen.getAllByTestId("fe6-channel-move-menu")[0]!;
    await userEvent.click(within(dev).getByRole("button", { name: "セクションに移動" }));
    expect(screen.getByTestId("fe6-channel-move-to-sec_ops")).toBeDisabled();
    await userEvent.click(screen.getByTestId("fe6-channel-move-remove"));
    expect(actions.onMove).toHaveBeenCalledWith("dev", null);
    await userEvent.click(within(dev).getByRole("button", { name: "セクションに移動" }));
    await userEvent.click(screen.getByTestId("fe6-channel-move-new"));
    expect(actions.onCreate).toHaveBeenCalledWith("dev");
  });
});
