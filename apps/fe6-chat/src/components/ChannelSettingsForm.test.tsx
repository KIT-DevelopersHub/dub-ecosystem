import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Channel } from "../api/contract";
import { ChannelSettingsForm } from "./ChannelSettingsForm";

const channel: Channel = {
  id: "chn_1",
  orgId: "org",
  type: "topic",
  visibility: "public",
  name: "dev",
  topic: null,
  eventId: null,
  archived: false,
  memberCount: 3,
  version: 1,
  createdAt: "t",
  updatedAt: "t",
};

const noop = () => {};

describe("ChannelSettingsForm delete", () => {
  it("hides the delete button without onDelete", () => {
    render(<ChannelSettingsForm channel={channel} onSave={noop} onArchiveToggle={noop} />);
    expect(screen.queryByTestId("fe6-settings-delete")).toBeNull();
    expect(screen.getByTestId("fe6-settings-archive")).toBeInTheDocument();
  });

  it("confirms with an irreversible warning before deleting", async () => {
    const onDelete = vi.fn(async () => {});
    render(<ChannelSettingsForm channel={channel} onSave={noop} onArchiveToggle={noop} onDelete={onDelete} />);
    await userEvent.click(screen.getByTestId("fe6-settings-delete"));
    const dialog = await screen.findByTestId("fe6-settings-delete-confirm");
    expect(dialog.textContent).toContain("元に戻すことはできません");
    expect(onDelete).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "完全に削除する" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
  });

  it("delete-only (canEdit=false) shows just the delete section", () => {
    render(<ChannelSettingsForm channel={channel} canEdit={false} onSave={noop} onArchiveToggle={noop} onDelete={async () => {}} />);
    expect(screen.queryByTestId("fe6-settings-name")).toBeNull();
    expect(screen.queryByTestId("fe6-settings-archive")).toBeNull();
    expect(screen.getByTestId("fe6-settings-delete")).toBeInTheDocument();
  });
});
