import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { gantt } from "@dub/types";
import { GanttView } from "../src/components/GanttView";
import { ROW_HEIGHT } from "../src/domain/timeline-axis";

// jsdom ships no PointerEvent (drops clientX) and no pointer-capture — mirror the
// polyfill the other gantt drag tests use.
beforeAll(() => {
  if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent === "undefined") {
    class PointerEventPolyfill extends MouseEvent {
      pointerId: number;
      constructor(type: string, params: PointerEventInit = {}) {
        super(type, params);
        this.pointerId = params.pointerId ?? 1;
      }
    }
    (globalThis as { PointerEvent?: unknown }).PointerEvent = PointerEventPolyfill;
  }
  (Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
  (Element.prototype as unknown as { releasePointerCapture: () => void }).releasePointerCapture = () => {};
});

// three flat, dated, top-level rows → bars on rows 0,1,2 (y = index*ROW_HEIGHT).
const flatDto: gantt.GanttChartDTO = {
  eventId: "evt_1",
  rows: [
    { taskId: "A", title: "タスクA", startsAt: "2026-08-05T00:00:00Z", endsAt: "2026-08-09T00:00:00Z", progressPercent: 0, assigneeId: null, depth: 0, hasChildren: false },
    { taskId: "B", title: "タスクB", startsAt: "2026-08-10T00:00:00Z", endsAt: "2026-08-14T00:00:00Z", progressPercent: 0, assigneeId: null, depth: 0, hasChildren: false },
    { taskId: "C", title: "タスクC", startsAt: "2026-08-18T00:00:00Z", endsAt: "2026-08-22T00:00:00Z", progressPercent: 0, assigneeId: null, depth: 0, hasChildren: false },
  ],
  dependencies: [],
};

// Marquee across rows 0 and 1 (full width, vertical band 0..2*ROW-1) → selects A,B not C.
// The move/up listeners live on window; dispatch on the body so the (bubbling) pointer
// events reach them WITH clientX (testing-library sets it; a raw PointerEvent doesn't).
function marqueeRows0And1() {
  const body = screen.getByTestId("fe4-gantt-body");
  const far = { clientX: 100000, clientY: 2 * ROW_HEIGHT - 1 };
  fireEvent.pointerDown(body, { clientX: 2, clientY: 2, button: 0 });
  fireEvent.pointerMove(body, far);
  fireEvent.pointerUp(body, far);
}

describe("marquee multi-select", () => {
  it("selecting a range highlights the touched bars and shows the count", () => {
    render(<GanttView dto={flatDto} zoom="day" canWrite onBulkDelete={vi.fn()} />);
    marqueeRows0And1();
    expect(screen.getByTestId("fe4-gantt-selection-count").textContent).toBe("2 件選択中");
  });

  it("Backspace opens a confirm dialog, and confirming bulk-deletes the selection", () => {
    const onBulkDelete = vi.fn();
    render(<GanttView dto={flatDto} zoom="day" canWrite onBulkDelete={onBulkDelete} />);
    marqueeRows0And1();
    fireEvent.keyDown(window, { key: "Backspace" });
    const dialog = screen.getByTestId("fe4-gantt-bulk-delete-confirm");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText(/2件のタスクを削除しますか/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "削除" }));
    expect(onBulkDelete).toHaveBeenCalledTimes(1);
    expect(onBulkDelete.mock.calls[0]![0]).toEqual(expect.arrayContaining(["A", "B"]));
  });

  it("ArrowRight / ArrowLeft shift the whole selection by ±1 day", () => {
    const onBulkShiftDays = vi.fn();
    render(<GanttView dto={flatDto} zoom="day" canWrite onBulkShiftDays={onBulkShiftDays} />);
    marqueeRows0And1();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onBulkShiftDays).toHaveBeenLastCalledWith(expect.arrayContaining(["A", "B"]), 1);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(onBulkShiftDays).toHaveBeenLastCalledWith(expect.arrayContaining(["A", "B"]), -1);
  });

  it("ArrowUp / ArrowDown reorder the selection only in 手動 mode", () => {
    const onBulkMoveVertical = vi.fn();
    const { rerender } = render(
      <GanttView dto={flatDto} zoom="day" canWrite sortMode="manual" onBulkMoveVertical={onBulkMoveVertical} />,
    );
    marqueeRows0And1();
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(onBulkMoveVertical).toHaveBeenLastCalledWith(expect.arrayContaining(["A", "B"]), -1);

    // switch to an automatic sort → vertical reorder is suppressed
    onBulkMoveVertical.mockClear();
    rerender(
      <GanttView dto={flatDto} zoom="day" canWrite sortMode="priority" onBulkMoveVertical={onBulkMoveVertical} />,
    );
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(onBulkMoveVertical).not.toHaveBeenCalled();
  });

  it("Escape clears the selection", () => {
    render(<GanttView dto={flatDto} zoom="day" canWrite onBulkDelete={vi.fn()} />);
    marqueeRows0And1();
    expect(screen.queryByTestId("fe4-gantt-selection-count")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("fe4-gantt-selection-count")).toBeNull();
  });

  it("does not hijack keys while typing in a field", () => {
    const onBulkShiftDays = vi.fn();
    render(<GanttView dto={flatDto} zoom="day" canWrite onBulkShiftDays={onBulkShiftDays} />);
    marqueeRows0And1();
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(onBulkShiftDays).not.toHaveBeenCalled();
    input.remove();
  });
});
