import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Timeline } from "../src/components/Timeline";
import type { TimelineRow, TimelineDependency } from "../src/types";

const d = (iso: string) => Date.parse(iso);
const rows: TimelineRow[] = [
  { id: "a", label: "設計", startMs: d("2026-01-01T00:00:00Z"), endMs: d("2026-01-03T00:00:00Z"), progressPercent: 40 },
  { id: "b", label: "実装", startMs: d("2026-01-04T00:00:00Z"), endMs: d("2026-01-08T00:00:00Z"), progressPercent: 0 },
  { id: "c", label: "未定", startMs: null, endMs: null },
];
const deps: TimelineDependency[] = [{ id: "dep1", fromId: "a", toId: "b", violated: true }];

describe("Timeline", () => {
  it("renders one label row per datum and forwards testId", () => {
    render(<Timeline rows={rows} testId="tl" />);
    expect(screen.getByTestId("tl")).toBeInTheDocument();
    expect(screen.getByTestId("tl-row-a")).toHaveTextContent("設計");
    expect(screen.getByTestId("tl-row-c")).toHaveTextContent("未定");
  });

  it("draws a bar for dated rows but not for unscheduled rows", () => {
    render(<Timeline rows={rows} testId="tl" />);
    expect(screen.getByTestId("tl-bar-a")).toBeInTheDocument();
    expect(screen.getByTestId("tl-bar-b")).toBeInTheDocument();
    expect(screen.queryByTestId("tl-bar-c")).toBeNull();
  });

  it("marks a violated dependency segment", () => {
    render(<Timeline rows={rows} dependencies={deps} testId="tl" />);
    expect(screen.getByTestId("tl-dep-dep1")).toHaveAttribute("data-violated", "true");
  });

  it("shows the scale switcher only when onScaleChange is given and emits it", async () => {
    const onScaleChange = vi.fn();
    const { rerender } = render(<Timeline rows={rows} testId="tl" />);
    expect(screen.queryByTestId("tl-scale-month")).toBeNull();
    rerender(<Timeline rows={rows} scale="week" onScaleChange={onScaleChange} testId="tl" />);
    await userEvent.click(screen.getByTestId("tl-scale-month"));
    expect(onScaleChange).toHaveBeenCalledWith("month");
  });

  it("fires onRowClick from both the label and the bar", async () => {
    const onRowClick = vi.fn();
    render(<Timeline rows={rows} onRowClick={onRowClick} testId="tl" />);
    await userEvent.click(screen.getByTestId("tl-row-a"));
    await userEvent.click(screen.getByTestId("tl-bar-a"));
    expect(onRowClick).toHaveBeenNthCalledWith(1, "a");
    expect(onRowClick).toHaveBeenNthCalledWith(2, "a");
  });

  it("renders the truncated banner and the empty state", () => {
    const { rerender } = render(<Timeline rows={rows} truncated testId="tl" />);
    expect(screen.getByTestId("tl-truncated")).toBeInTheDocument();
    rerender(<Timeline rows={[{ id: "x", label: "x", startMs: null, endMs: null }]} emptyState="期間なし" testId="tl" />);
    expect(screen.getByText("期間なし")).toBeInTheDocument();
  });
});
