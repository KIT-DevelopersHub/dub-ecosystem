import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useVirtualRows } from "../src/components/useVirtualRows";

/** A detached div with a controllable clientHeight/scrollTop (jsdom computes 0). */
function makeScrollEl(clientHeight: number): HTMLDivElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight });
  let top = 0;
  Object.defineProperty(el, "scrollTop", { configurable: true, get: () => top, set: (v: number) => (top = v) });
  return el;
}

describe("useVirtualRows", () => {
  it("windows a long list to only the rows in view (+ overscan)", () => {
    const el = makeScrollEl(500); // viewport shows 10 rows at 50px
    const { result } = renderHook(() =>
      useVirtualRows({ count: 1000, estimateRowHeight: 50, overscan: 5, getScrollElement: () => el }),
    );
    expect(result.current.active).toBe(true);
    expect(result.current.startIndex).toBe(0);
    // 10 visible + 5 overscan → last index ~15 (well under the full 1000).
    expect(result.current.endIndex).toBeLessThanOrEqual(16);
    expect(result.current.endIndex).toBeGreaterThanOrEqual(10);
    expect(result.current.totalSize).toBe(50_000);
    expect(result.current.paddingTop).toBe(0);
    expect(result.current.paddingBottom).toBeGreaterThan(40_000);
  });

  it("bounds the mounted window well below the full count at a 50-row roster (DOM stays有界)", () => {
    const el = makeScrollEl(400); // viewport shows ~8 rows at 50px
    const { result } = renderHook(() =>
      useVirtualRows({ count: 50, estimateRowHeight: 50, overscan: 8, getScrollElement: () => el }),
    );
    expect(result.current.active).toBe(true);
    // 8 visible + 8 overscan → far fewer than all 50 rows mount → DOM count is bounded.
    const mounted = result.current.endIndex - result.current.startIndex + 1;
    expect(mounted).toBeLessThan(25);
    expect(result.current.paddingBottom).toBeGreaterThan(0); // spacer stands in for un-mounted rows
  });

  it("shifts the window and grows paddingTop after a scroll", () => {
    const el = makeScrollEl(500);
    const { result } = renderHook(() =>
      useVirtualRows({ count: 1000, estimateRowHeight: 50, overscan: 5, getScrollElement: () => el }),
    );
    act(() => {
      el.scrollTop = 5000; // scroll down 100 rows
      el.dispatchEvent(new Event("scroll"));
    });
    expect(result.current.startIndex).toBeGreaterThan(90);
    expect(result.current.paddingTop).toBeGreaterThan(4000);
  });

  it("falls back to rendering every row when the viewport can't be measured", () => {
    const el = makeScrollEl(0); // unmeasurable (jsdom / no layout)
    const { result } = renderHook(() =>
      useVirtualRows({ count: 1000, estimateRowHeight: 50, getScrollElement: () => el }),
    );
    expect(result.current.active).toBe(false);
    expect(result.current.startIndex).toBe(0);
    expect(result.current.endIndex).toBe(999);
    expect(result.current.paddingTop).toBe(0);
    expect(result.current.paddingBottom).toBe(0);
  });

  it("is inert when disabled", () => {
    const el = makeScrollEl(500);
    const { result } = renderHook(() =>
      useVirtualRows({ count: 1000, estimateRowHeight: 50, enabled: false, getScrollElement: () => el }),
    );
    expect(result.current.active).toBe(false);
    expect(result.current.endIndex).toBe(999);
  });

  it("uses measured row heights (variable-height rows) over the estimate", () => {
    const el = makeScrollEl(500);
    const { result } = renderHook(() =>
      useVirtualRows({ count: 100, estimateRowHeight: 50, getScrollElement: () => el }),
    );
    const before = result.current.totalSize; // 100 * 50
    const row = document.createElement("tr");
    row.getBoundingClientRect = () => ({ height: 90, width: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
    act(() => result.current.measureElement(0, row));
    // one row grew from 50→90 → total grows by 40.
    expect(result.current.totalSize).toBe(before + 40);
  });
});
