import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { SegmentedControl } from "../index";

const meta = {
  title: "Inputs/SegmentedControl",
  component: SegmentedControl,
  tags: ["autodocs"],
  args: { options: [] },
} satisfies Meta<typeof SegmentedControl>;

export default meta;
type Story = StoryObj<typeof meta>;

// Controlled: a view switcher (list / board / gantt) — the classic segmented use.
export const Default: Story = {
  render: () => {
    const [view, setView] = useState<"list" | "board" | "gantt">("list");
    return (
      <SegmentedControl
        aria-label="表示"
        value={view}
        onChange={setView}
        options={[
          { value: "list", label: "リスト", icon: "menu" },
          { value: "board", label: "ボード", icon: "check-square" },
          { value: "gantt", label: "ガント", icon: "calendar" },
        ]}
      />
    );
  },
};

// Uncontrolled: no value passed, so the first enabled option is auto-selected.
export const Uncontrolled: Story = {
  render: () => (
    <SegmentedControl
      caption="粒度"
      options={[
        { value: "month", label: "月" },
        { value: "week", label: "週" },
        { value: "day", label: "日" },
      ]}
    />
  ),
};

export const Sizes: Story = {
  render: () => {
    const opts = [
      { value: "a", label: "全体" },
      { value: "b", label: "自分" },
      { value: "c", label: "未対応", disabled: true },
    ];
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <SegmentedControl size="sm" defaultValue="a" options={opts} aria-label="sm" />
        <SegmentedControl size="md" defaultValue="a" options={opts} aria-label="md" />
        <SegmentedControl size="lg" defaultValue="a" options={opts} aria-label="lg" />
      </div>
    );
  },
};
