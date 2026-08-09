import type { Meta, StoryObj } from "@storybook/react";
import { Button, IconButton } from "../index";
import type { Variant } from "../types";

const VARIANTS: Variant[] = ["primary", "secondary", "ghost", "danger"];

const meta = {
  title: "Primitives/Button",
  component: Button,
  tags: ["autodocs"],
  args: { children: "Button", variant: "primary", size: "md" },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Variants: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      {VARIANTS.map((v) => (
        <Button key={v} variant={v}>{v}</Button>
      ))}
    </div>
  ),
};

export const Loading: Story = { args: { loading: true, children: "保存中" } };
export const Disabled: Story = { args: { disabled: true, children: "無効" } };

// IconButton (icon-only, aria-label required).
export const IconButtonStory: StoryObj<typeof IconButton> = {
  name: "IconButton",
  render: () => (
    <div style={{ display: "flex", gap: 12 }}>
      <IconButton name="plus" aria-label="追加" variant="primary" />
      <IconButton name="edit" aria-label="編集" variant="secondary" />
      <IconButton name="trash" aria-label="削除" variant="danger" />
      <IconButton name="settings" aria-label="設定" variant="ghost" />
    </div>
  ),
};
