import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { GanttSkeleton } from "../src/components/GanttSkeleton";
import { HEADER_H, ROW_HEIGHT, DEFAULT_LEFT_W } from "../src/domain/timeline-axis";

// The skeleton must reproduce GanttView's structural chrome using the SAME shared
// layout constants, so the loaded chart swaps in with no reflow (症状: スケルトンがずれる).
describe("GanttSkeleton", () => {
  it("announces the loading state once (role=status) for screen readers", () => {
    render(<GanttSkeleton />);
    const region = screen.getByRole("status", { name: "ガントチャートを読み込み中" });
    expect(region).toBeTruthy();
    expect(region.getAttribute("data-testid")).toBe("fe4-gantt-skeleton");
  });

  it("draws the requested number of placeholder rows and keeps the left column header", () => {
    const { container } = render(<GanttSkeleton rows={5} />);
    // the sticky left task-name header is always mounted, at the shared header height
    const leftHead = container.querySelector('[class*="tlLeftHead"]') as HTMLElement | null;
    expect(leftHead).not.toBeNull();
    expect(leftHead!.style.height).toBe(`${HEADER_H}px`);
    expect(screen.getByText("タスク")).toBeTruthy();
    // body row lines: exactly one per requested row, each ROW_HEIGHT tall
    const rowLines = container.querySelectorAll('[class*="tlRowLine"]');
    expect(rowLines.length).toBe(5);
    expect((rowLines[0] as HTMLElement).style.height).toBe(`${ROW_HEIGHT}px`);
  });

  it("sizes the left column to the shared default width", () => {
    const { container } = render(<GanttSkeleton />);
    const left = container.querySelector('[class*="tlLeft"]') as HTMLElement | null;
    expect(left).not.toBeNull();
    expect(left!.style.width).toBe(`${DEFAULT_LEFT_W}px`);
  });
});
