import { describe, it, expect, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { identity, task, gantt } from "@dub/types";
import { App } from "../src/App";
import { MockApiClient } from "../src/api/mock-client";

// jsdom ships no PointerEvent, so fireEvent.pointer* drops clientX — drags then
// read NaN and never register movement. Polyfill it off MouseEvent + stub capture.
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

const EVENT = "evt_undo_drag";
const PERMS: identity.PermissionKey[] = ["task:read", "task:write", "task:delete"];
const START0 = "2026-08-10T00:00:00.000Z";
const END0 = "2026-08-14T00:00:00.000Z";
const DAY = 86_400_000;
const PX_PER_DAY_DAY = 34; // GanttView "day" granularity

const mk = (id: string, title: string): task.Task => ({
  id, eventId: EVENT, title, description: null, status: "todo",
  priority: "medium", assigneeId: null, dueAt: END0, origin: "internal",
  archivedAt: null, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", version: 1,
});

describe("Gantt bar drag undo is 1 step per drag (座標0→1→2, Ctrl-Z→1, Ctrl-Z→0)", () => {
  it("each Ctrl-Z reverses exactly one drag — never overshoots to the origin", async () => {
    const client = new MockApiClient({
      tasks: [mk("t1", "会場予約")],
      rowDates: { t1: { startsAt: START0, endsAt: END0 } },
    });

    const readStart = async (): Promise<number> => {
      const dto = await client.request<gantt.GanttChartDTO>({
        method: "GET", path: "/api/v1/gantt", query: { eventId: EVENT },
      });
      const row = dto.rows.find((r) => r.taskId === "t1")!;
      return Date.parse(row.startsAt!);
    };

    render(<App client={client} eventId={EVENT} permissions={PERMS} />);
    await screen.findByTestId("fe4-gantt-row-t1");
    // switch to day zoom so 1 day == 34px (deterministic whole-day drags)
    fireEvent.click(screen.getByTestId("fe4-gantt-zoom-day"));

    const scroll = screen.getByTestId("fe4-gantt-scroll");
    const drag = (dxDays: number) => {
      const bar = screen.getByTestId("fe4-gantt-bar-t1");
      const dx = dxDays * PX_PER_DAY_DAY;
      fireEvent.pointerDown(bar, { clientX: 100, pointerId: 1 });
      fireEvent.pointerMove(scroll, { clientX: 100 + dx, pointerId: 1 });
      fireEvent.pointerUp(scroll, { clientX: 100 + dx, pointerId: 1 });
    };

    const base = await readStart();
    expect(base).toBe(Date.parse(START0)); // coord 0

    drag(1); // 0 -> 1
    await waitFor(async () => expect(await readStart()).toBe(base + DAY));

    drag(1); // 1 -> 2
    await waitFor(async () => expect(await readStart()).toBe(base + 2 * DAY));

    // one undo must land on coord 1 (NOT coord 0)
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(async () => expect(await readStart()).toBe(base + DAY));

    // a second undo lands on coord 0
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(async () => expect(await readStart()).toBe(base));
  });
});
