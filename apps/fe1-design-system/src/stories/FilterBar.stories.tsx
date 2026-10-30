import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { FilterBar, FilterChip, FilterChips } from "../index";

const meta = {
  title: "Inputs/FilterBar",
  component: FilterBar,
  tags: ["autodocs"],
  args: { children: null },
} satisfies Meta<typeof FilterBar>;

export default meta;
type Story = StoryObj<typeof meta>;

// Multiple selection + a lone toggle chip (gantt-style).
export const Multiple: Story = {
  render: () => {
    const [status, setStatus] = useState<string[]>([]);
    const [archived, setArchived] = useState(false);
    const active = status.length + (archived ? 1 : 0);
    return (
      <FilterBar
        aria-label="タスクの絞り込み"
        activeCount={active}
        onClear={() => {
          setStatus([]);
          setArchived(false);
        }}
      >
        <FilterChips
          multiple
          value={status}
          onChange={setStatus}
          options={[
            { value: "todo", label: "未着手" },
            { value: "in_progress", label: "進行中" },
            { value: "done", label: "完了" },
          ]}
        />
        <FilterChip selected={archived} onToggle={() => setArchived((v) => !v)}>
          アーカイブ含む
        </FilterChip>
      </FilterBar>
    );
  },
};

// Single selection with counts (人事-style).
export const SingleWithCounts: Story = {
  render: () => {
    const [v, setV] = useState("all");
    return (
      <FilterBar aria-label="ステータスで絞り込み" activeCount={v === "all" ? 0 : 1} onClear={() => setV("all")}>
        <FilterChips
          value={v}
          onChange={setV}
          options={[
            { value: "all", label: "すべて", count: 12 },
            { value: "scheduling", label: "面談日程調整中", count: 4 },
            { value: "withdrawn", label: "辞退", count: 1 },
          ]}
        />
      </FilterBar>
    );
  },
};
