import { describe, it, expect, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { identity, task, gantt } from "@dub/types";
import { App } from "../src/App";
import { MockApiClient } from "../src/api/mock-client";

// jsdom has no PointerEvent (drops clientX); polyfill it + stub pointer-capture.
beforeAll(() => {
  if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent === "undefined") {
    class P extends MouseEvent {
      pointerId: number;
      constructor(t: string, p: PointerEventInit = {}) { super(t, p); this.pointerId = p.pointerId ?? 1; }
    }
    (globalThis as { PointerEvent?: unknown }).PointerEvent = P;
  }
  (Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
  (Element.prototype as unknown as { releasePointerCapture: () => void }).releasePointerCapture = () => {};
});

const EVENT = "evt_p";
const PERMS: identity.PermissionKey[] = ["task:read", "task:write", "task:delete"];
const ORIGIN = "2026-08-10T00:00:00.000Z";
const DAY = 86_400_000;
const PXD = 34; // day-zoom px per day
const mk = (id: string): task.Task => ({
  id, eventId: EVENT, title: id, description: null, status: "todo", priority: "medium",
  assigneeId: null, dueAt: "2026-08-14T00:00:00.000Z", origin: "internal", archivedAt: null,
  createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", version: 1,
});

// Regression: a PARENT bar drag shifts the whole subtree. Two moves must produce
// two independent undo steps — one Ctrl-Z reverses exactly one move. The bug: the
// undo command recomputed `staleSnapshot + delta`, so undoing the 2nd move landed
// on the origin (jumped two steps) and a 2nd undo went below the origin.
describe("Parent bar drag undo is 1 step per drag (subtree shift)", () => {
  it("each Ctrl-Z reverses exactly one parent move — never overshoots", async () => {
    const client = new MockApiClient({
      tasks: [mk("p"), mk("c")],
      rowDates: {
        p: { startsAt: ORIGIN, endsAt: "2026-08-12T00:00:00.000Z" },
        c: { startsAt: ORIGIN, endsAt: "2026-08-12T00:00:00.000Z" },
      },
      hierarchy: { c: { parentTaskId: "p", depth: 1 } },
    });
    const coordOf = async (taskId: string): Promise<number> => {
      const dto = await client.request<gantt.GanttChartDTO>({ method: "GET", path: "/api/v1/gantt", query: { eventId: EVENT } });
      const row = dto.rows.find((r) => r.taskId === taskId)!;
      return (Date.parse(row.startsAt!) - Date.parse(ORIGIN)) / DAY;
    };

    render(<App client={client} eventId={EVENT} permissions={PERMS} />);
    await screen.findByTestId("fe4-gantt-row-p");
    fireEvent.click(screen.getByTestId("fe4-gantt-zoom-day"));
    const scroll = screen.getByTestId("fe4-gantt-scroll");
    const drag = (days: number) => {
      const bar = screen.getByTestId("fe4-gantt-bar-p"); // collapsed parent => subtree shift
      const dx = days * PXD;
      fireEvent.pointerDown(bar, { clientX: 100, pointerId: 1 });
      fireEvent.pointerMove(scroll, { clientX: 100 + dx, pointerId: 1 });
      fireEvent.pointerUp(scroll, { clientX: 100 + dx, pointerId: 1 });
    };

    expect(await coordOf("c")).toBe(0); // origin

    drag(1); // 0 -> 1
    await waitFor(async () => expect(await coordOf("c")).toBe(1));
    drag(1); // 1 -> 2
    await waitFor(async () => expect(await coordOf("c")).toBe(2));

    // one undo -> coord 1 for BOTH parent and child (not the origin)
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(async () => expect(await coordOf("c")).toBe(1));
    expect(await coordOf("p")).toBe(1);

    // second undo -> origin
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(async () => expect(await coordOf("c")).toBe(0));
    expect(await coordOf("p")).toBe(0);

    // redo re-applies one step
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(async () => expect(await coordOf("c")).toBe(1));
  });
});
