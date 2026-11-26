import { describe, it, expect, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import type { common, gantt } from "@dub/types";
import { renderWithProviders as render } from "./helpers-providers";
import { GanttView } from "../src/components/GanttView";
import {
  allExpanded,
  collapseAll,
  expandAll,
  loadOpenParents,
  parentIdsOf,
  saveOpenParents,
} from "../src/domain/gantt-expand";

const EVENT = "evt_expand" as common.EventId;
const id = (s: string) => s as common.TaskId;

const row = (taskId: string, extra: Partial<gantt.GanttRow> = {}): gantt.GanttRow => ({
  taskId: id(taskId),
  title: taskId,
  startsAt: "2026-08-05T00:00:00Z",
  endsAt: "2026-08-09T00:00:00Z",
  progressPercent: 0,
  assigneeId: null,
  ...extra,
});

// p > c (> g), q > d, leaf l
const dto: gantt.GanttChartDTO = {
  eventId: EVENT,
  rows: [
    row("p", { hasChildren: true, depth: 0 }),
    row("c", { parentTaskId: id("p"), depth: 1, hasChildren: true }),
    row("g", { parentTaskId: id("c"), depth: 2 }),
    row("q", { hasChildren: true, depth: 0 }),
    row("d", { parentTaskId: id("q"), depth: 1 }),
    row("l", { depth: 0 }),
  ],
  dependencies: [],
};

describe("gantt-expand domain", () => {
  beforeEach(() => globalThis.localStorage?.clear());

  it("parentIdsOf lists only rows with children", () => {
    expect(parentIdsOf(dto.rows)).toEqual(["p", "c", "q"]);
  });

  it("expandAll / collapseAll touch only the given parents", () => {
    const parents = [id("p"), id("q")];
    const hidden = id("x"); // a parent filtered out of the current view
    const opened = expandAll(parents, new Set([hidden]));
    expect([...opened].sort()).toEqual(["p", "q", "x"]);
    expect(allExpanded(parents, opened)).toBe(true);
    const closed = collapseAll(parents, opened);
    expect([...closed]).toEqual(["x"]);
    expect(allExpanded(parents, closed)).toBe(false);
  });

  it("allExpanded is false when there are no parents", () => {
    expect(allExpanded([], new Set())).toBe(false);
  });

  it("persists per event and tolerates garbage", () => {
    saveOpenParents(EVENT, new Set([id("p")]));
    expect([...loadOpenParents(EVENT)]).toEqual(["p"]);
    expect(loadOpenParents("evt_other" as common.EventId).size).toBe(0);
    globalThis.localStorage.setItem(`fe4:gantt-open-parents:${EVENT}`, "{bad");
    expect(loadOpenParents(EVENT).size).toBe(0);
    globalThis.localStorage.setItem(`fe4:gantt-open-parents:${EVENT}`, JSON.stringify({ a: 1 }));
    expect(loadOpenParents(EVENT).size).toBe(0);
  });
});

describe("すべて展開 / すべて折りたたむ (#872)", () => {
  beforeEach(() => globalThis.localStorage?.clear());

  it("one control toggles every parent at any depth", () => {
    render(<GanttView dto={dto} zoom="week" />);
    const btn = screen.getByTestId("fe4-gantt-toggle-all");
    expect(btn).toHaveTextContent("すべて展開");
    expect(screen.queryByTestId("fe4-gantt-row-g")).toBeNull();
    fireEvent.click(btn);
    expect(screen.getByTestId("fe4-gantt-row-g")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-gantt-row-d")).toBeInTheDocument();
    expect(btn).toHaveTextContent("すべて折りたたむ");
    fireEvent.click(btn);
    expect(screen.queryByTestId("fe4-gantt-row-c")).toBeNull();
    expect(screen.queryByTestId("fe4-gantt-row-d")).toBeNull();
    expect(btn).toHaveTextContent("すべて展開");
  });

  it("label follows manual toggles", () => {
    render(<GanttView dto={dto} zoom="week" />);
    fireEvent.click(screen.getByTestId("fe4-gantt-toggle-p"));
    fireEvent.click(screen.getByTestId("fe4-gantt-toggle-c"));
    expect(screen.getByTestId("fe4-gantt-toggle-all")).toHaveTextContent("すべて展開");
    fireEvent.click(screen.getByTestId("fe4-gantt-toggle-q"));
    expect(screen.getByTestId("fe4-gantt-toggle-all")).toHaveTextContent("すべて折りたたむ");
  });

  it("hidden when the gantt has no parent rows", () => {
    render(<GanttView dto={{ ...dto, rows: [row("l")] }} zoom="week" />);
    expect(screen.queryByTestId("fe4-gantt-toggle-all")).toBeNull();
  });

  it("with openStateKey the open state is remembered across remounts", () => {
    const { unmount } = render(<GanttView dto={dto} zoom="week" openStateKey={EVENT} />);
    fireEvent.click(screen.getByTestId("fe4-gantt-toggle-all"));
    unmount();
    render(<GanttView dto={dto} zoom="week" openStateKey={EVENT} />);
    expect(screen.getByTestId("fe4-gantt-row-g")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-gantt-toggle-all")).toHaveTextContent("すべて折りたたむ");
  });

  it("without openStateKey nothing is persisted", () => {
    render(<GanttView dto={dto} zoom="week" />);
    fireEvent.click(screen.getByTestId("fe4-gantt-toggle-all"));
    expect(loadOpenParents(EVENT).size).toBe(0);
  });
});
