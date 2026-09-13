// The Home dashboard's customizable widget grid — a real cell grid (react-grid-
// layout), not a sortable list. Each widget occupies (w x h) cells; dragging a
// widget by its grab handle over another's cells pushes the other DOWN the
// column (react-grid-layout's own vertical compaction/collision handling), and
// the arrangement persists across reloads via useUiStore's homeGrid slice.
//
// Scope: this canvas holds the dashboard's "panel" widgets (usage/task charts,
// the live BFF side panels, and any FE3-7 contributed homeWidget) — the KPI
// strip and the app launchpad stay outside it as fixed, structural sections
// (they are stat tiles / navigation, not independently placeable panels).
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import RGL from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { Icon, SegmentedControl } from "@dub/ui";
import { useUiStore } from "../../../store/uiStore.tsx";
import {
  HOME_GRID_MARGIN,
  HOME_GRID_ROW_HEIGHT,
  colsForWidth,
  layoutFor,
  sizeOf,
  WIDGET_SIZES,
  type GridWidgetMeta,
  type WidgetSize,
} from "./homeGrid.ts";

const SIZE_LABEL: Record<WidgetSize, string> = { small: "小", medium: "中", large: "大" };

// jsdom (unit tests) never performs real layout — clientWidth/contentRect are
// always 0 there. Falling back to a fixed desktop width in that case (rather
// than waiting forever for a real measurement that will never come) is what
// keeps this component testable with @testing-library/react and no browser.
const FALLBACK_WIDTH = 1280;

export function HomeWidgetGrid({
  catalog,
  nodes,
}: {
  /** Widget catalog, in default/fallback order. */
  catalog: GridWidgetMeta[];
  /** Rendered node per widget id. A widget whose node is `null`/`undefined` (e.g.
   *  "最近開いた" before any visit) is dropped from the grid entirely for this
   *  render — it reappears (freshly packed, never overlapping) once it renders again. */
  nodes: Record<string, ReactNode>;
}): JSX.Element | null {
  const positions = useUiStore((s) => s.homeGrid.positions);
  const sizes = useUiStore((s) => s.homeGrid.sizes);
  const setHomeGridPositions = useUiStore((s) => s.setHomeGridPositions);
  const setHomeWidgetSize = useUiStore((s) => s.setHomeWidgetSize);
  const resetHomeGrid = useUiStore((s) => s.resetHomeGrid);
  // Normal mode (default) is a static display — no drag handle, no size
  // control, react-grid-layout dragging disabled. Editing (move/resize/reset)
  // is only possible after switching into edit mode via the toolbar toggle.
  const editMode = useUiStore((s) => s.homeGridEditMode);
  const setHomeGridEditMode = useUiStore((s) => s.setHomeGridEditMode);

  // A SINGLE width measurement drives both `cols` (our narrow/wide breakpoint)
  // and the pixel `width` react-grid-layout uses to compute column geometry.
  // Two independent observers (one for `cols`, react-grid-layout's own
  // WidthProvider HOC for `width`) can transiently disagree for one frame right
  // after mount — WidthProvider defaults to width=1280 until ITS OWN
  // ResizeObserver first fires, which can race against a `cols` value already
  // updated from the real container width, producing a genuinely overlapping
  // layout for that one frame (caught by a real-mouse E2E reading pixel rects
  // immediately after mount). Measuring synchronously in useLayoutEffect (before
  // paint) and feeding the SAME number into both `cols` and `width` removes the
  // race at its root instead of papering over it with a delay.
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setWidth(el.clientWidth || FALLBACK_WIDTH);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      setWidth((entries[0]?.contentRect.width || el.clientWidth) || FALLBACK_WIDTH);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cols = colsForWidth(width);
  const present = useMemo(() => catalog.filter((w) => nodes[w.id] != null), [catalog, nodes]);
  const presentKey = present.map((w) => w.id).join(",");
  const layout = useMemo(
    () => layoutFor(present, { positions, sizes }, cols),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- presentKey is the stable identity of `present`
    [presentKey, positions, sizes, cols],
  );

  if (present.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className={`fe2-widget-grid-wrap${editMode ? " fe2-widget-grid-wrap--editing" : ""}`}
      data-testid="fe2-home-widget-grid"
    >
      <div className="fe2-widget-grid-toolbar-row">
        {editMode ? (
          <button
            type="button"
            className="fe2-widget-grid-reset"
            data-testid="fe2-home-widget-grid-reset"
            onClick={() => resetHomeGrid()}
          >
            配置をリセット
          </button>
        ) : null}
        <button
          type="button"
          className="fe2-widget-grid-edit-toggle"
          data-testid="fe2-home-widget-grid-edit-toggle"
          aria-pressed={editMode}
          onClick={() => setHomeGridEditMode(!editMode)}
        >
          {editMode ? "完了" : "編集"}
        </button>
      </div>
      {width > 0 ? (
        <RGL
          className="fe2-widget-grid"
          layout={layout}
          cols={cols}
          width={width}
          rowHeight={HOME_GRID_ROW_HEIGHT}
          margin={HOME_GRID_MARGIN}
          compactType="vertical"
          preventCollision={false}
          allowOverlap={false}
          isResizable={false}
          // Normal mode: fully static (no drag at all) — the whole point of the
          // toggle is that a viewer who is just LOOKING at the dashboard can
          // never accidentally move a widget.
          isDraggable={editMode}
          draggableHandle=".fe2-widget-grab"
          onLayoutChange={(next) => {
            if (!editMode) return; // ignore RGL's own mount-time layout echo while static
            setHomeGridPositions(next.map((it) => ({ id: it.i, x: it.x, y: it.y })));
          }}
        >
          {present.map((w) => {
            const size = sizeOf(present, sizes, w.id);
            return (
              <div key={w.id} data-testid={`fe2-widget-grid-item-${w.id}`} className="fe2-widget-grid-item">
                {editMode ? (
                  <div className="fe2-widget-grid-chrome">
                    <span
                      className="fe2-widget-grab"
                      data-testid={`fe2-widget-grab-${w.id}`}
                      role="button"
                      tabIndex={-1}
                      aria-label={`${w.label}をドラッグして移動`}
                      title="ドラッグして移動"
                    >
                      <Icon name="drag" />
                    </span>
                    <SegmentedControl<WidgetSize>
                      className="fe2-widget-grid-size"
                      size="sm"
                      value={size}
                      onChange={(next) => setHomeWidgetSize(w.id, next)}
                      aria-label={`${w.label}のサイズ`}
                      testId={`fe2-widget-size-${w.id}`}
                      options={WIDGET_SIZES.map((s) => ({
                        value: s,
                        label: SIZE_LABEL[s],
                        testId: `fe2-widget-size-${w.id}-${s}`,
                      }))}
                    />
                  </div>
                ) : null}
                <div className="fe2-widget-grid-body">{nodes[w.id]}</div>
              </div>
            );
          })}
        </RGL>
      ) : null}
    </div>
  );
}
