import type { Meta, StoryObj } from "@storybook/react";
import { Spinner } from "../index";

const meta = {
  title: "Primitives/Spinner",
  component: Spinner,
  tags: ["autodocs"],
  args: { size: "md" },
} satisfies Meta<typeof Spinner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Sizes: Story = {
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
      <Spinner size="sm" />
      <Spinner size="md" />
      <Spinner size="lg" />
    </div>
  ),
};
