import type { Meta, StoryObj } from "@storybook/react";
import { ToastProvider, useToast, Button } from "../index";
import type { ToastKind } from "../types";

// useToast is a hook; demo it via a ToastProvider host + trigger buttons.
function ToastDemo() {
  const { show } = useToast();
  const fire = (kind: ToastKind) =>
    show({
      kind,
      title: `${kind} トースト`,
      description: kind === "error" ? "エラーは閉じるまで残ります" : "5秒で自動的に消えます",
    });
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      <Button onClick={() => fire("success")}>success</Button>
      <Button variant="secondary" onClick={() => fire("info")}>info</Button>
      <Button variant="secondary" onClick={() => fire("warning")}>warning</Button>
      <Button variant="danger" onClick={() => fire("error")}>error</Button>
    </div>
  );
}

const meta = {
  title: "Overlay/Toast",
  component: ToastProvider,
  tags: ["autodocs"],
  args: { children: null },
} satisfies Meta<typeof ToastProvider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <ToastProvider>
      <ToastDemo />
    </ToastProvider>
  ),
};
