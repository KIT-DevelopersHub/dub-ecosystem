// GanttViewModel (S11) — the MVI/UDF state machine for the per-event gantt view,
// modeled 1:1 on home-view-model.ts (§2-2 MviViewModel<S,E>, §7 unit target:
// initial load / refresh / error / empty / view-pref edit). Framework-agnostic;
// the Compose ViewModel adapts this to a StateFlow. The chart (rows + FS deps) is
// a read model over task/event owned by gantt-service; zoom + collapsed rows are a
// per-user view pref that is applied optimistically and best-effort persisted.
import type { gantt } from "@dub/types";
import type { AppError } from "./errors";
import { isAppErrorException } from "./errors";
import type { MobileBffClient } from "./bff-client";

/** Client-local view prefs (mirror of gantt.GanttViewState minus eventId). */
export interface GanttView {
  zoom: gantt.GanttZoom;
  collapsedTaskIds: string[];
}

export type GanttUiState =
  | { status: "loading" }
  | { status: "content"; chart: gantt.GanttChartDTO; view: GanttView; isEmpty: boolean }
  | { status: "error"; error: AppError; cached: gantt.GanttChartDTO | null }; // stale-while-error banner

export type GanttEvent =
  | { type: "load" }
  | { type: "refresh" }
  | { type: "setZoom"; zoom: gantt.GanttZoom }
  | { type: "toggleCollapse"; taskId: string };

const DEFAULT_VIEW: GanttView = { zoom: "week", collapsedTaskIds: [] };

function isEmptyChart(c: gantt.GanttChartDTO): boolean {
  return c.rows.length === 0;
}

export class GanttViewModel {
  private state: GanttUiState = { status: "loading" };
  private lastGood: gantt.GanttChartDTO | null = null;
  private view: GanttView = DEFAULT_VIEW;
  private listeners = new Set<(s: GanttUiState) => void>();

  constructor(
    private readonly client: MobileBffClient,
    private readonly eventId: string,
  ) {}

  get uiState(): GanttUiState {
    return this.state;
  }

  subscribe(listener: (s: GanttUiState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onEvent(event: GanttEvent): Promise<void> {
    switch (event.type) {
      case "load":
      case "refresh":
        return this.fetch();
      case "setZoom":
        return this.applyView({ ...this.view, zoom: event.zoom });
      case "toggleCollapse":
        return this.applyView({ ...this.view, collapsedTaskIds: toggle(this.view.collapsedTaskIds, event.taskId) });
    }
  }

  private setState(s: GanttUiState): void {
    this.state = s;
    for (const l of this.listeners) l(s);
  }

  private async fetch(): Promise<void> {
    if (this.state.status !== "content") this.setState({ status: "loading" });
    try {
      // chart + persisted view prefs load together; a missing/failed view pref
      // must not blank the chart, so the view read degrades to the last-known view.
      const [chart, view] = await Promise.all([
        this.client.getGantt(this.eventId),
        this.client.getGanttView(this.eventId).catch(() => null),
      ]);
      this.lastGood = chart;
      if (view) this.view = { zoom: view.zoom, collapsedTaskIds: [...view.collapsedTaskIds] };
      this.setState({ status: "content", chart, view: this.view, isEmpty: isEmptyChart(chart) });
    } catch (err) {
      const error: AppError = isAppErrorException(err)
        ? err.appError
        : { kind: "Server", code: "UNKNOWN", requestId: null };
      // keep last-good chart visible behind the banner (offline -> cached view, §6)
      this.setState({ status: "error", error, cached: this.lastGood });
    }
  }

  /** Optimistically apply a view pref (zoom/collapse) and best-effort persist it. */
  private async applyView(next: GanttView): Promise<void> {
    this.view = next;
    if (this.state.status === "content") {
      this.setState({ ...this.state, view: next });
    }
    try {
      // View prefs are non-critical: a failed save is swallowed (local view stays).
      await this.client.saveGanttView(this.eventId, {
        zoom: next.zoom,
        collapsedTaskIds: next.collapsedTaskIds,
      });
    } catch {
      // keep the optimistic local view; prefs re-sync on next successful load.
    }
  }
}

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}
