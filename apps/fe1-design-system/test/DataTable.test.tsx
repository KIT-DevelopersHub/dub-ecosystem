import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DataTable } from "../src/components/DataTable";
import type { ColumnDef } from "../src/types";

interface Row {
  id: string;
  name: string;
}
const rows: Row[] = [
  { id: "1", name: "Alpha" },
  { id: "2", name: "Beta" },
];
const columns: ColumnDef<Row>[] = [
  { key: "name", header: "名前", cell: (r) => r.name, sortable: true },
];

describe("DataTable", () => {
  it("renders one row per datum", () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("renders emptyState when no rows and not loading", () => {
    render(
      <DataTable
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        emptyState={<span>データなし</span>}
      />,
    );
    expect(screen.getByText("データなし")).toBeInTheDocument();
  });

  it("fires onSortChange toggling direction", async () => {
    const onSortChange = vi.fn();
    render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        sort={{ key: "name", direction: "asc" }}
        onSortChange={onSortChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /名前/ }));
    expect(onSortChange).toHaveBeenCalledWith({ key: "name", direction: "desc" });
  });

  it("selection: select-all toggles all keys", async () => {
    const onChange = vi.fn();
    render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        testId="tbl"
        selection={{ selectedKeys: [], onChange }}
      />,
    );
    await userEvent.click(screen.getByTestId("tbl-select-all"));
    expect(onChange).toHaveBeenCalledWith(["1", "2"]);
  });

  it("selection: individual row toggle adds its key", async () => {
    const onChange = vi.fn();
    render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        selection={{ selectedKeys: [], onChange }}
      />,
    );
    const [first] = screen.getAllByLabelText("行を選択");
    await userEvent.click(first!);
    expect(onChange).toHaveBeenCalledWith(["1"]);
  });

  it("applies minWidth + noWrap to header and body cells (wide-table horizontal scroll)", () => {
    const wideColumns: ColumnDef<Row>[] = [
      { key: "name", header: "名前", cell: (r) => r.name, minWidth: "12rem", noWrap: true },
    ];
    render(<DataTable columns={wideColumns} rows={rows} rowKey={(r) => r.id} />);
    // header carries the min-width so the column keeps its natural width…
    const th = screen.getByRole("columnheader", { name: "名前" });
    expect(th).toHaveStyle({ minWidth: "12rem" });
    // …and each body cell also gets min-width + the nowrap class (no 2–3 line wrap).
    const cell = screen.getByText("Alpha");
    expect(cell).toHaveStyle({ minWidth: "12rem" });
    expect(cell.className).toMatch(/noWrap/);
  });
});
