import { describe, it, expect, vi, beforeEach } from "vitest";
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

  describe("columnHiding (表示列 picker)", () => {
    const wide: ColumnDef<Row>[] = [
      { key: "name", header: "氏名", cell: (r) => r.name, hideable: false },
      { key: "email", header: "メール", cell: () => "a@b.c" },
      { key: "phone", header: "電話", cell: () => "090", defaultHidden: true },
    ];

    beforeEach(() => window.localStorage.clear());

    it("hides defaultHidden columns and shows the rest by default", () => {
      render(<DataTable columns={wide} rows={rows} rowKey={(r) => r.id} columnHiding={{ storageKey: "k" }} />);
      expect(screen.getByRole("columnheader", { name: "氏名" })).toBeInTheDocument();
      expect(screen.getByRole("columnheader", { name: "メール" })).toBeInTheDocument();
      expect(screen.queryByRole("columnheader", { name: "電話" })).not.toBeInTheDocument();
    });

    it("excludes non-hideable columns from the picker, includes the rest", async () => {
      render(<DataTable columns={wide} rows={rows} rowKey={(r) => r.id} testId="t" columnHiding={{ storageKey: "k" }} />);
      await userEvent.click(screen.getByRole("button", { name: /表示列/ }));
      expect(screen.queryByTestId("t-colvis-name")).not.toBeInTheDocument(); // hideable:false
      expect(screen.getByTestId("t-colvis-email")).toBeInTheDocument();
      expect(screen.getByTestId("t-colvis-phone")).toBeInTheDocument();
    });

    it("toggles a column on/off and persists the choice to localStorage", async () => {
      const { unmount } = render(
        <DataTable columns={wide} rows={rows} rowKey={(r) => r.id} testId="t" columnHiding={{ storageKey: "k" }} />,
      );
      await userEvent.click(screen.getByRole("button", { name: /表示列/ }));
      // turn a hidden column ON
      await userEvent.click(screen.getByTestId("t-colvis-phone"));
      expect(screen.getByRole("columnheader", { name: "電話" })).toBeInTheDocument();
      // turn a shown column OFF
      await userEvent.click(screen.getByTestId("t-colvis-email"));
      expect(screen.queryByRole("columnheader", { name: "メール" })).not.toBeInTheDocument();

      // persisted → a fresh mount with the same storageKey keeps the selection
      unmount();
      render(<DataTable columns={wide} rows={rows} rowKey={(r) => r.id} columnHiding={{ storageKey: "k" }} />);
      expect(screen.getByRole("columnheader", { name: "電話" })).toBeInTheDocument();
      expect(screen.queryByRole("columnheader", { name: "メール" })).not.toBeInTheDocument();
    });

    it("すべて表示 shows every hideable column", async () => {
      render(<DataTable columns={wide} rows={rows} rowKey={(r) => r.id} testId="t" columnHiding={{ storageKey: "k" }} />);
      await userEvent.click(screen.getByRole("button", { name: /表示列/ }));
      await userEvent.click(screen.getByTestId("t-colvis-show-all"));
      expect(screen.getByRole("columnheader", { name: "電話" })).toBeInTheDocument();
      expect(screen.getByRole("columnheader", { name: "メール" })).toBeInTheDocument();
    });

    it("既定に戻す clears overrides back to defaults", async () => {
      render(<DataTable columns={wide} rows={rows} rowKey={(r) => r.id} testId="t" columnHiding={{ storageKey: "k" }} />);
      await userEvent.click(screen.getByRole("button", { name: /表示列/ }));
      await userEvent.click(screen.getByTestId("t-colvis-phone")); // show the default-hidden col
      expect(screen.getByRole("columnheader", { name: "電話" })).toBeInTheDocument();
      await userEvent.click(screen.getByTestId("t-colvis-reset"));
      expect(screen.queryByRole("columnheader", { name: "電話" })).not.toBeInTheDocument();
      expect(window.localStorage.getItem("k")).toBeNull();
    });

    it("renders no picker toolbar when columnHiding is omitted", () => {
      render(<DataTable columns={wide} rows={rows} rowKey={(r) => r.id} />);
      // all columns visible (defaultHidden ignored) and no 表示列 trigger
      expect(screen.getByRole("columnheader", { name: "電話" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /表示列/ })).not.toBeInTheDocument();
    });
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
