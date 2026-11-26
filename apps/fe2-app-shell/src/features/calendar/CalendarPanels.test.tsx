// #883: the detail popover must stay inside the viewport — a long 予定 scrolls inside it
// instead of running off-screen under the header / demo banner.
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Floating } from "./CalendarPanels.tsx";

const VW = 1280;
const VH = 720;
let contentHeight = 1500;

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: VW });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: VH });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => contentHeight });
});
afterEach(() => {
  delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  contentHeight = 1500;
});

function box(): { top: number; left: number; maxHeight: number } {
  const el = screen.getByTestId("float");
  return { top: parseFloat(el.style.top), left: parseFloat(el.style.left), maxHeight: parseFloat(el.style.maxHeight) };
}

describe("Floating (#883)", () => {
  it("a panel taller than the viewport is capped to it (8px top, 48px clear of the bottom bar)", () => {
    render(
      <Floating anchor={{ left: 900, top: 400, right: 1000, bottom: 440 }} width={448} onClose={() => undefined} label="x" testId="float">
        <div>long</div>
      </Floating>,
    );
    const b = box();
    expect(b.maxHeight).toBe(VH - 8 - 48);
    expect(b.top).toBeGreaterThanOrEqual(8);
    expect(b.top + Math.min(contentHeight, b.maxHeight)).toBeLessThanOrEqual(VH - 48);
    expect(screen.getByTestId("float")).toHaveStyle({ visibility: "visible" });
  });

  it("a short panel sits at its anchor, and re-places itself when the window shrinks", () => {
    contentHeight = 240;
    render(
      <Floating anchor={{ left: 300, top: 400, right: 400, bottom: 440 }} width={448} onClose={() => undefined} label="x" testId="float">
        <div>short</div>
      </Floating>,
    );
    expect(box()).toMatchObject({ top: 400, left: 408 });
    act(() => {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 500 });
      window.dispatchEvent(new Event("resize"));
    });
    const b = box();
    expect(b.maxHeight).toBe(500 - 8 - 48);
    expect(b.top + 240).toBeLessThanOrEqual(500 - 48);
  });
});
