import type { Meta, StoryObj } from "@storybook/react";
import { Menu } from "../index";

const meta = {
  title: "Overlay/Menu",
  component: Menu,
  tags: ["autodocs"],
  args: {
    label: "設定",
    icon: "settings",
    items: [
      { id: "password", label: "パスワード変更", icon: "lock", onSelect: () => {} },
    ],
  },
} satisfies Meta<typeof Menu>;

export default meta;
type Story = StoryObj<typeof meta>;

// The header "設定" dropdown as used in FE2: a gear trigger opening a short action
// list. Closes on select, outside-click and Escape.
export const SettingsMenu: Story = {
  render: (args) => (
    <div style={{ padding: 48, display: "flex", justifyContent: "flex-end" }}>
      <Menu {...args} />
    </div>
  ),
};

// Icon-only trigger (40px square) — matches the header AppLauncher/bell controls.
// This is how FE2 renders the header 設定 menu.
export const IconOnly: Story = {
  args: {
    label: "設定",
    menuLabel: "設定",
    icon: "settings",
    iconOnly: true,
    items: [{ id: "password", label: "パスワード変更", icon: "lock", onSelect: () => {} }],
  },
  render: (args) => (
    <div style={{ padding: 48, display: "flex", justifyContent: "flex-end" }}>
      <Menu {...args} />
    </div>
  ),
};

export const MultipleItems: Story = {
  args: {
    label: "操作",
    icon: "settings",
    items: [
      { id: "password", label: "パスワード変更", icon: "lock", onSelect: () => {} },
      { id: "theme", label: "テーマ", icon: "settings", onSelect: () => {} },
      { id: "soon", label: "近日公開", disabled: true, onSelect: () => {} },
    ],
  },
  render: (args) => (
    <div style={{ padding: 48, display: "flex", justifyContent: "flex-end" }}>
      <Menu {...args} />
    </div>
  ),
};
