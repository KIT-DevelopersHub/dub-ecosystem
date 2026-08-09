// HomeViewModel (S2) — the MVI/UDF reference (§2-2 MviViewModel<S,E>, §7 unit
// target: initial load / refresh / error / empty / cached-on-error). Framework-
// agnostic; the Compose ViewModel adapts this state machine to a StateFlow.
import type { AppError } from "./errors";
import { isAppErrorException } from "./errors";
import type { MobileBffClient } from "./bff-client";
import type { MobileHomeResponse } from "./contract";

export type HomeUiState =
  | { status: "loading" }
  | { status: "content"; home: MobileHomeResponse; isEmpty: boolean }
  | { status: "error"; error: AppError; cached: MobileHomeResponse | null }; // stale-while-error banner

export type HomeEvent = { type: "load" } | { type: "refresh" };

function isEmptyHome(h: MobileHomeResponse): boolean {
  return h.upcomingEvents.length === 0 && h.myTasks.length === 0 && h.unreadCount === 0;
}

export class HomeViewModel {
  private state: HomeUiState = { status: "loading" };
  private lastGood: MobileHomeResponse | null = null;
  private listeners = new Set<(s: HomeUiState) => void>();

  constructor(private readonly client: MobileBffClient) {}

  get uiState(): HomeUiState {
    return this.state;
  }

  subscribe(listener: (s: HomeUiState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onEvent(event: HomeEvent): Promise<void> {
    switch (event.type) {
      case "load":
      case "refresh":
        return this.fetch();
    }
  }

  private setState(s: HomeUiState): void {
    this.state = s;
    for (const l of this.listeners) l(s);
  }

  private async fetch(): Promise<void> {
    if (this.state.status !== "content") this.setState({ status: "loading" });
    try {
      const home = await this.client.getHome();
      this.lastGood = home;
      this.setState({ status: "content", home, isEmpty: isEmptyHome(home) });
    } catch (err) {
      const error: AppError = isAppErrorException(err)
        ? err.appError
        : { kind: "Server", code: "UNKNOWN", requestId: null };
      // keep last-good visible behind the banner (offline -> cached view, §6)
      this.setState({ status: "error", error, cached: this.lastGood });
    }
  }
}
