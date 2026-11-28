import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import type { common, gantt, task } from "@dub/types";
import { renderWithProviders as render } from "./helpers-providers";
import { GanttView } from "../src/components/GanttView";
import {
  GANTT_EXPORT_HEADERS,
  buildGanttTable,
  ganttCsvFileName,
  toGanttCsv,
} from "../src/domain/gantt-export";
import { childProgressByParent } from "../src/domain/child-progress";
import { rollupRowDates } from "../src/domain/timeline-axis";

const id = (s: string) => s as common.TaskId;
const row = (taskId: string, extra: Partial<gantt.GanttRow> = {}): gantt.GanttRow => ({
  taskId: id(taskId),
  title: taskId,
  startsAt: null,
  endsAt: null,
  progressPercent: 0,
  assigneeId: null,
  ...extra,
});

const rows: gantt.GanttRow[] = [
  row("p", { title: "設計", hasChildren: true, depth: 0, teamId: "team_a" as common.TeamId }),
  row("c1", { title: "画面, 仕様", parentTaskId: id("p"), depth: 1, startsAt: "2026-08-05T00:00:00Z", endsAt: "2026-08-09T00:00:00Z", teamId: "team_a" as common.TeamId }),
  row("c2", { title: '=SUM(A1) "x"', parentTaskId: id("p"), depth: 1, startsAt: "2026-08-10T00:00:00Z", endsAt: "2026-08-12T00:00:00Z" }),
];
const status = new Map<common.TaskId, task.TaskStatus>([[id("c1"), "done"], [id("c2"), "in_progress"]]);

describe("buildGanttTable", () => {
  it("maps every row (incl. collapsed children) to the export columns", () => {
    const rolled = rollupRowDates(rows);
    const progress = childProgressByParent(rows, status);
    const t = buildGanttTable(rolled, {
      numberById: new Map([[id("p"), "AA-1"], [id("c1"), "AA-1-1"]]),
      statusById: new Map([...status, [id("p"), "done"]]),
      childProgressById: progress,
      assigneeNameById: new Map([[id("c1"), "山田"]]),
      teamNameById: new Map([["team_a", "広報"]]),
    });
    expect(t.headers).toEqual(GANTT_EXPORT_HEADERS);
    expect(t.rows).toEqual([
      ["AA-1", "設計", "", "広報", "", "2026-08-05", "2026-08-12", "完了", "50"],
      ["AA-1-1", "画面, 仕様", "設計", "広報", "山田", "2026-08-05", "2026-08-09", "完了", "100"],
      ["", '=SUM(A1) "x"', "設計", "", "", "2026-08-10", "2026-08-12", "進行中", "0"],
    ]);
  });

  it("blank cells when the context is missing", () => {
    const t = buildGanttTable([row("x")]);
    expect(t.rows).toEqual([["", "x", "", "", "", "", "", "", "0"]]);
  });
});

describe("toGanttCsv", () => {
  it("UTF-8 BOM, CRLF, quoting and formula neutralizing", () => {
    const csv = toGanttCsv({ headers: ["a", "b"], rows: [["画面, 仕様", '=SUM(A1) "x"'], ["+81 90", "-x"]] });
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe('a,b\r\n"画面, 仕様","\'=SUM(A1) ""x"""\r\n+81 90,\'-x\r\n');
  });

  it("file name carries the date", () => {
    expect(ganttCsvFileName(new Date(2026, 10, 6))).toBe("ガント_20261106.csv");
  });
});

describe("CSV書き出しボタン (#871)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("downloads a CSV blob built from the loaded rows", async () => {
    const blobs: Blob[] = [];
    const g = globalThis as unknown as { URL: { createObjectURL?: unknown; revokeObjectURL?: unknown } };
    g.URL.createObjectURL = vi.fn((b: Blob) => {
      blobs.push(b);
      return "blob:x";
    });
    g.URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const dto: gantt.GanttChartDTO = { eventId: "evt_1" as common.EventId, rows, dependencies: [] };
    render(<GanttView dto={dto} zoom="week" statusById={status} />);
    fireEvent.click(screen.getByTestId("fe4-gantt-export-csv"));
    expect(click).toHaveBeenCalledTimes(1);
    expect(blobs).toHaveLength(1);
    const text = await new Promise<string>((res) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.readAsText(blobs[0]!);
    });
    // collapsed children are still exported
    expect(text).toContain("画面, 仕様");
    expect(text.split("\r\n")[0]).toContain("タスク番号,タスク名,親タスク");
  });

  it("hidden when there are no rows", () => {
    render(<GanttView dto={{ eventId: "evt_1" as common.EventId, rows: [], dependencies: [] }} zoom="week" />);
    expect(screen.queryByTestId("fe4-gantt-export-csv")).toBeNull();
  });
});
