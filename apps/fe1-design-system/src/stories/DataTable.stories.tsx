import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { DataTable } from "../index";
import type { ColumnDef, SortState } from "../types";

interface Row {
  id: string;
  name: string;
  status: string;
  updated: string;
}

const ROWS: Row[] = [
  { id: "1", name: "Kickoff", status: "完了", updated: "2026-08-01" },
  { id: "2", name: "設計レビュー", status: "進行中", updated: "2026-08-05" },
  { id: "3", name: "実装", status: "未着手", updated: "2026-08-09" },
];

const columns: ColumnDef<Row>[] = [
  { key: "name", header: "タスク", cell: (r) => r.name, sortable: true },
  { key: "status", header: "状態", cell: (r) => r.status },
  { key: "updated", header: "更新日", cell: (r) => r.updated, sortable: true, align: "right" },
];

const meta = {
  title: "Table/DataTable",
  component: DataTable,
  tags: ["autodocs"],
  args: { columns, rows: ROWS, rowKey: (r: Row) => r.id },
} satisfies Meta<typeof DataTable<Row>>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [sort, setSort] = useState<SortState>({ key: "name", direction: "asc" });
    return <DataTable columns={columns} rows={ROWS} rowKey={(r) => r.id} sort={sort} onSortChange={setSort} />;
  },
};

export const Loading: Story = {
  render: () => <DataTable columns={columns} rows={[]} rowKey={(r) => r.id} loading />,
};

export const Empty: Story = {
  render: () => (
    <DataTable columns={columns} rows={[]} rowKey={(r) => r.id} emptyState="データがありません" />
  ),
};
