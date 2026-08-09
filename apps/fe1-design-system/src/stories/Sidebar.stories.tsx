import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { Sidebar } from "../index";
import type { SidebarItem } from "../types";

const ITEMS: SidebarItem[] = [
  { id: "home", label: "ホーム", icon: "home" },
  { id: "events", label: "イベント", icon: "calendar", badgeCount: 5 },
  { id: "tasks", label: "タスク", icon: "check-square" },
  {
    id: "team",
    label: "チーム",
    icon: "users",
    children: [
      { id: "members", label: "メンバー" },
      { id: "roles", label: "ロール", icon: "shield" },
    ],
  },
  { id: "settings", label: "設定", icon: "settings" },
];

const meta = {
  title: "Layout/Sidebar",
  component: Sidebar,
  tags: ["autodocs"],
  args: { items: ITEMS },
} satisfies Meta<typeof Sidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [active, setActive] = useState("home");
    return (
      <div style={{ width: 260 }}>
        <Sidebar
          items={ITEMS}
          activeId={active}
          renderLink={(item, node) => (
            <a
              href={`#${item.id}`}
              onClick={(e) => {
                e.preventDefault();
                setActive(item.id);
              }}
              style={{ textDecoration: "none", color: "inherit", display: "block" }}
            >
              {node}
            </a>
          )}
        />
      </div>
    );
  },
};

export const Collapsed: Story = {
  render: () => (
    <div style={{ width: 72 }}>
      <Sidebar items={ITEMS} activeId="home" collapsed />
    </div>
  ),
};
