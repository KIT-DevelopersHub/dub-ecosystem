import type { Meta, StoryObj } from "@storybook/react";
import {
  Skeleton,
  SkeletonList,
  SkeletonTable,
  SkeletonCard,
} from "../index";

const meta = {
  title: "State/Skeleton",
  component: Skeleton,
  tags: ["autodocs"],
} satisfies Meta<typeof Skeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Variants: Story = {
  name: "Variants",
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 320 }}>
      <Skeleton variant="text" width="80%" />
      <Skeleton variant="circle" width={48} />
      <Skeleton variant="rect" width="100%" height={96} />
    </div>
  ),
};

export const Pulse: Story = {
  name: "Pulse animation",
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 320 }}>
      <Skeleton animation="pulse" width="90%" />
      <Skeleton animation="pulse" width="60%" />
    </div>
  ),
};

export const List: StoryObj<typeof SkeletonList> = {
  name: "SkeletonList (avatar)",
  render: () => (
    <div style={{ maxWidth: 360 }}>
      <SkeletonList rows={4} avatar />
    </div>
  ),
};

export const Table: StoryObj<typeof SkeletonTable> = {
  name: "SkeletonTable",
  render: () => (
    <div style={{ maxWidth: 560 }}>
      <SkeletonTable rows={5} columns={4} />
    </div>
  ),
};

export const Card: StoryObj<typeof SkeletonCard> = {
  name: "SkeletonCard (media)",
  render: () => (
    <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(2, 1fr)", maxWidth: 560 }}>
      <SkeletonCard media lines={2} />
      <SkeletonCard media lines={2} />
    </div>
  ),
};
