import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { Modal, ConfirmDialog, Drawer, Button } from "../index";

const meta = {
  title: "Overlay/Modal",
  component: Modal,
  tags: ["autodocs"],
  args: { open: false, onClose: () => {}, title: "Modal", children: null },
} satisfies Meta<typeof Modal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>モーダルを開く</Button>
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title="タスクを編集"
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>キャンセル</Button>
              <Button onClick={() => setOpen(false)}>保存</Button>
            </>
          }
        >
          <p>モーダル本文。フォームや詳細を配置します。</p>
        </Modal>
      </>
    );
  },
};

export const ConfirmDialogStory: StoryObj<typeof ConfirmDialog> = {
  name: "ConfirmDialog",
  render: () => {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button variant="danger" onClick={() => setOpen(true)}>削除</Button>
        <ConfirmDialog
          open={open}
          title="本当に削除しますか？"
          message="この操作は取り消せません。"
          danger
          confirmLabel="削除する"
          onConfirm={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      </>
    );
  },
};

export const DrawerStory: StoryObj<typeof Drawer> = {
  name: "Drawer",
  render: () => {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button variant="secondary" onClick={() => setOpen(true)}>ドロワーを開く</Button>
        <Drawer open={open} onClose={() => setOpen(false)} title="フィルター" side="right">
          <p>右からスライドインするパネル。</p>
        </Drawer>
      </>
    );
  },
};
