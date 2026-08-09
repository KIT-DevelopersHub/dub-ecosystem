import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { Tabs } from "../index";

const meta = {
  title: "Layout/Tabs",
  component: Tabs,
  tags: ["autodocs"],
  args: { items: [], activeId: "", onChange: () => {} },
} satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [active, setActive] = useState("overview");
    return (
      <Tabs
        activeId={active}
        onChange={setActive}
        items={[
          { id: "overview", label: "概要" },
          { id: "activity", label: "アクティビティ" },
          { id: "members", label: "メンバー" },
          { id: "archived", label: "アーカイブ", disabled: true },
        ]}
      />
    );
  },
};
