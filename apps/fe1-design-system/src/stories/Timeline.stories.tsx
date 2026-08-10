import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { Timeline } from "../index";
import type { TimelineRow, TimelineDependency, TimelineScale } from "../index";

const day = (iso: string) => Date.parse(iso);
const rows: TimelineRow[] = [
  { id: "t1", label: "要件定義", startMs: day("2026-01-05"), endMs: day("2026-01-09"), progressPercent: 100 },
  { id: "t2", label: "設計", startMs: day("2026-01-08"), endMs: day("2026-01-14"), progressPercent: 60 },
  { id: "t3", label: "実装", startMs: day("2026-01-12"), endMs: day("2026-01-26"), progressPercent: 20 },
  { id: "t4", label: "レビュー（未定）", startMs: null, endMs: null, progressPercent: 0 },
];
const dependencies: TimelineDependency[] = [
  { id: "d1", fromId: "t1", toId: "t2" },
  { id: "d2", fromId: "t2", toId: "t3", violated: true },
];

const meta = {
  title: "DataViz/Timeline",
  component: Timeline,
  tags: ["autodocs"],
  args: { rows, dependencies },
} satisfies Meta<typeof Timeline>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Interactive: Story = {
  render: (args) => {
    const [scale, setScale] = useState<TimelineScale>("week");
    const [selected, setSelected] = useState<string | null>(null);
    return (
      <Timeline
        {...args}
        scale={scale}
        onScaleChange={setScale}
        selectedRowId={selected}
        onRowClick={setSelected}
      />
    );
  },
};

export const Truncated: Story = { args: { truncated: true } };
