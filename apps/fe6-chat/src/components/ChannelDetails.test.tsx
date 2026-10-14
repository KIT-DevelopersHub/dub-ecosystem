import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { common, identity } from "@dub/types";
import type { Channel, ChannelMember } from "../api/contract";
import { ChannelDetails, type ChannelDetailsProps } from "./ChannelDetails";

const channel: Channel = {
  id: "chn_1",
  orgId: "org",
  type: "topic",
  visibility: "public",
  name: "dev",
  topic: "開発の話",
  eventId: null,
  archived: false,
  memberCount: 2,
  version: 1,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const ME = "usr_me" as common.UserId;
const BOB = "usr_bob" as common.UserId;
const users: Record<string, identity.UserSummary> = {
  [ME]: { id: ME, displayName: "自分", avatarUrl: null } as identity.UserSummary,
  [BOB]: { id: BOB, displayName: "佐藤", avatarUrl: null } as identity.UserSummary,
};
const members: ChannelMember[] = [
  { channelId: channel.id, userId: ME, role: "admin", joinedAt: "t" },
  { channelId: channel.id, userId: BOB, role: "member", joinedAt: "t" },
];

function setup(over: Partial<ChannelDetailsProps> = {}) {
  const props: ChannelDetailsProps = {
    open: true,
    onClose: vi.fn(),
    channel,
    currentUserId: ME,
    members,
    membersLoaded: true,
    resolveUser: (id) => users[id],
    canEdit: true,
    onUpdate: vi.fn(async () => {}),
    searchUsers: vi.fn(async () => []),
    onAddMember: vi.fn(),
    onRemoveMember: vi.fn(),
    ...over,
  };
  render(<ChannelDetails {...props} />);
  return props;
}

const openTab = (name: RegExp) => userEvent.click(screen.getByRole("tab", { name }));

describe("ChannelDetails", () => {
  it("moderator sees about + archive + delete together (not delete only)", async () => {
    setup({ onDelete: async () => {} });
    expect(screen.getByTestId("fe6-details-name-edit")).toBeInTheDocument();
    expect(screen.getByTestId("fe6-details-topic-edit")).toBeInTheDocument();
    await openTab(/設定/);
    expect(screen.getByTestId("fe6-settings-archive")).toBeInTheDocument();
    expect(screen.getByTestId("fe6-settings-delete")).toBeInTheDocument();
  });

  it("renames inline with the normalized handle", async () => {
    const props = setup();
    await userEvent.click(screen.getByTestId("fe6-details-name-edit"));
    const input = screen.getByTestId("fe6-details-name-input");
    await userEvent.clear(input);
    await userEvent.type(input, "New Dev");
    await userEvent.click(screen.getByTestId("fe6-details-name-save"));
    expect(props.onUpdate).toHaveBeenCalledWith({ name: "new-dev" });
  });

  it("read-only reader sees values without edit links, and no archive/delete", async () => {
    setup({ canEdit: false });
    expect(screen.getByTestId("fe6-details-name").textContent).toContain("dev");
    expect(screen.queryByTestId("fe6-details-name-edit")).toBeNull();
    await openTab(/設定/);
    expect(screen.queryByTestId("fe6-settings-archive")).toBeNull();
    expect(screen.queryByTestId("fe6-settings-delete")).toBeNull();
  });

  it("delete needs the explicit checkbox before it can run", async () => {
    const onDelete = vi.fn(async () => {});
    setup({ onDelete });
    await openTab(/設定/);
    await userEvent.click(screen.getByTestId("fe6-settings-delete"));
    const dialog = await screen.findByTestId("fe6-settings-delete-confirm");
    expect(dialog.textContent).toContain("元に戻すことはできません");
    const submit = within(dialog).getByTestId("fe6-settings-delete-submit");
    expect(submit).toBeDisabled();
    await userEvent.click(within(dialog).getByTestId("fe6-settings-delete-agree"));
    await userEvent.click(submit);
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
  });

  it("lists members with the channel-admin badge and confirms removal", async () => {
    const props = setup();
    await openTab(/メンバー/);
    const rows = screen.getAllByTestId("fe6-details-member");
    expect(rows[0]!.textContent).toContain("自分");
    expect(rows[0]!.textContent).toContain("チャンネル管理者");
    await userEvent.click(within(rows[1]!).getByTestId("fe6-details-remove-member"));
    const confirm = await screen.findByTestId("fe6-details-remove-confirm");
    await userEvent.click(within(confirm).getByRole("button", { name: "削除する" }));
    expect(props.onRemoveMember).toHaveBeenCalledWith(BOB);
  });

  it("adds a member from search, marking existing ones as joined", async () => {
    const carol = { id: "usr_carol", displayName: "鈴木", avatarUrl: null } as identity.UserSummary;
    const props = setup({ searchUsers: vi.fn(async () => [users[BOB]!, carol]) });
    await openTab(/メンバー/);
    await userEvent.click(screen.getByTestId("fe6-details-add-member"));
    const panel = await screen.findByTestId("fe6-details-add-panel");
    await waitFor(() => expect(within(panel).getByText("参加済み")).toBeInTheDocument());
    await userEvent.click(within(panel).getByTestId("fe6-details-add-pick"));
    expect(props.onAddMember).toHaveBeenCalledWith(carol);
  });

  it("moves the channel to a personal section", async () => {
    const onMove = vi.fn();
    setup({ sections: { items: [{ id: "sec_1", name: "運営", position: 0, createdAt: "t" }], currentSectionId: null, onMove } });
    await openTab(/設定/);
    await userEvent.selectOptions(screen.getByTestId("fe6-details-section"), "sec_1");
    expect(onMove).toHaveBeenCalledWith("sec_1");
  });

  it("offers leave only when onLeave is given", async () => {
    const onLeave = vi.fn(async () => {});
    setup({ onLeave });
    await userEvent.click(screen.getByTestId("fe6-details-leave"));
    const confirm = await screen.findByTestId("fe6-details-leave-confirm");
    await userEvent.click(within(confirm).getByRole("button", { name: "退出する" }));
    await waitFor(() => expect(onLeave).toHaveBeenCalledTimes(1));
  });
});
