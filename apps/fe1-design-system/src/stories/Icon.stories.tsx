import type { Meta, StoryObj } from "@storybook/react";
import { Icon } from "../index";
import type { IconName } from "../types";

const NAMES: IconName[] = [
  "home", "calendar", "check-square", "bell", "message-circle", "users",
  "settings", "search", "plus", "edit", "trash", "chevron-down",
  "chevron-right", "external-link", "alert-triangle", "info", "x", "menu",
  "log-out", "shield",
];

const meta = {
  title: "Primitives/Icon",
  component: Icon,
  tags: ["autodocs"],
  args: { name: "home", size: "md", "aria-label": "ホーム" },
} satisfies Meta<typeof Icon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Registry: Story = {
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
      {NAMES.map((name) => (
        <div key={name} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, width: 96 }}>
          <Icon name={name} aria-label={name} />
          <span style={{ fontSize: 12, color: "var(--dub-color-text-muted)" }}>{name}</span>
        </div>
      ))}
    </div>
  ),
};
