import type { Meta, StoryObj } from "@storybook/react";
import { Tooltip, Popover, Button } from "../index";

const meta = {
  title: "Overlay/Tooltip",
  component: Tooltip,
  tags: ["autodocs"],
  args: { content: "Tooltip", children: null },
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div style={{ padding: 48 }}>
      <Tooltip content="保存します（Cmd+S）">
        <Button>ホバー / フォーカス</Button>
      </Tooltip>
    </div>
  ),
};

export const PopoverStory: StoryObj<typeof Popover> = {
  name: "Popover",
  render: () => (
    <div style={{ padding: 48 }}>
      <Popover trigger={<Button variant="secondary">メニューを開く</Button>}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 160 }}>
          <Button variant="ghost">プロフィール</Button>
          <Button variant="ghost">設定</Button>
          <Button variant="ghost">ログアウト</Button>
        </div>
      </Popover>
    </div>
  ),
};
