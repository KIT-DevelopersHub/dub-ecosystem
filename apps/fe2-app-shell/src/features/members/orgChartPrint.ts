// 組織図の印刷: 1 枚の A4 横に収まる最大の倍率へ揃える。
//
// ブラウザ任せだと横幅に合わせて縮むだけで余白が残るので、印刷の直前に組織図の実寸を測り、
// 用紙の印字範囲いっぱいになる zoom を --org-print-zoom で渡す（CSS は members.module.css）。
// ボタンだけでなく Cmd+P でも効くよう beforeprint で計算する。
import { useEffect, type RefObject } from "react";

/** A4 横 (96dpi) から余白 8mm を引いた印字範囲。ORG_CHART_PAGE_CSS と揃える。 */
const PRINT_AREA = { width: 1062, height: 733 };
const MAX_ZOOM = 2;
const ZOOM_VAR = "--org-print-zoom";
export const ORG_CHART_PAGE_CSS = "@media print { @page { size: A4 landscape; margin: 8mm; } }";

export function fitZoom(size: { width: number; height: number }): number {
  if (size.width <= 0 || size.height <= 0) return 1;
  return Math.min(MAX_ZOOM, PRINT_AREA.width / size.width, PRINT_AREA.height / size.height);
}

export function useFitChartToPrintedPage(chart: RefObject<HTMLElement>): void {
  useEffect(() => {
    const onBeforePrint = (): void => {
      const el = chart.current;
      if (!el) return;
      // 画面の横スクロール枠の外まで含めた、組織図本来の大きさを測る。
      const prevWidth = el.style.width;
      el.style.width = "max-content";
      const size = { width: el.offsetWidth, height: el.offsetHeight };
      el.style.width = prevWidth;
      // 端数の切り上げで 2 ページ目へあふれないよう、わずかに小さくする。
      el.style.setProperty(ZOOM_VAR, String(fitZoom(size) * 0.99));
    };
    const onAfterPrint = (): void => {
      chart.current?.style.removeProperty(ZOOM_VAR);
    };
    window.addEventListener("beforeprint", onBeforePrint);
    window.addEventListener("afterprint", onAfterPrint);
    return () => {
      window.removeEventListener("beforeprint", onBeforePrint);
      window.removeEventListener("afterprint", onAfterPrint);
    };
  }, [chart]);
}
