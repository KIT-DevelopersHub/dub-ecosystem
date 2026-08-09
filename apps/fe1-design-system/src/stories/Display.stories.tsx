import type { Meta, StoryObj } from "@storybook/react";
import { Badge, Tag, Avatar } from "../index";
import type { BadgeTone } from "../types";

const TONES: BadgeTone[] = ["neutral", "brand", "success", "warning", "danger", "info"];

const meta = {
  title: "Primitives/Display",
  component: Badge,
  tags: ["autodocs"],
  args: { children: "Badge" },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BadgeTones: Story = {
  name: "Badge",
  render: () => (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {TONES.map((tone) => (
        <Badge key={tone} tone={tone}>{tone}</Badge>
      ))}
    </div>
  ),
};

export const Tags: StoryObj<typeof Tag> = {
  name: "Tag",
  render: () => (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <Tag tone="brand">読み取り専用</Tag>
      <Tag tone="info" onRemove={() => {}}>削除可能</Tag>
      <Tag tone="success" onRemove={() => {}}>承認済み</Tag>
    </div>
  ),
};

export const Avatars: StoryObj<typeof Avatar> = {
  name: "Avatar",
  render: () => (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <Avatar name="Taro Yamada" size="sm" />
      <Avatar name="Hanako Suzuki" size="md" />
      <Avatar name="Dub User" size="lg" />
    </div>
  ),
};
