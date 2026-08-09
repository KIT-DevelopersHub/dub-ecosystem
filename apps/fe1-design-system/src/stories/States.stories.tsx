import type { Meta, StoryObj } from "@storybook/react";
import { EmptyState, ErrorState, SkeletonLoader, Button } from "../index";

const meta = {
  title: "State/States",
  component: EmptyState,
  tags: ["autodocs"],
  args: { title: "EmptyState" },
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const EmptyStateStory: Story = {
  name: "EmptyState",
  render: () => (
    <EmptyState
      icon="calendar"
      title="イベントがありません"
      description="最初のイベントを作成しましょう。"
      action={<Button>イベントを作成</Button>}
    />
  ),
};

export const ErrorStateStory: StoryObj<typeof ErrorState> = {
  name: "ErrorState",
  render: () => (
    <ErrorState
      error={{ code: "FORBIDDEN", message: "この操作を行う権限がありません。", correlationId: "req-abc123" }}
      onRetry={() => {}}
    />
  ),
};

export const SkeletonLoaderStory: StoryObj<typeof SkeletonLoader> = {
  name: "SkeletonLoader",
  render: () => <SkeletonLoader lines={4} />,
};
