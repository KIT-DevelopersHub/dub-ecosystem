/// <reference lib="dom" />
// Read-state debouncer (design §2-5). When the timeline bottom is visible, send
// POST /read after a 2s debounce; never send while the tab is inactive; never
// send a stale (older) lastReadMessageId. Scheduler + visibility are injectable
// so the logic is unit-testable without real timers or a DOM.
import type { common } from "@dub/types";

export const READ_DEBOUNCE_MS = 2000;

export interface ReadTrackerDeps {
  send: (lastReadMessageId: common.MessageId) => void;
  isVisible: () => boolean;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (handle: number) => void;
  debounceMs?: number;
}

export class ReadTracker {
  private readonly deps: Required<ReadTrackerDeps>;
  private timer: number | null = null;
  private pendingId: common.MessageId | null = null;
  private sentId: common.MessageId | null = null;

  constructor(deps: ReadTrackerDeps) {
    this.deps = { debounceMs: READ_DEBOUNCE_MS, ...deps };
  }

  /** Call when the bottom of the timeline is visible showing `lastMessageId`. */
  observeBottom(lastMessageId: common.MessageId): void {
    // ULID ascending: ignore ids not newer than what we've already sent/queued.
    if (this.sentId !== null && lastMessageId <= this.sentId) return;
    if (this.pendingId !== null && lastMessageId <= this.pendingId) return;
    this.pendingId = lastMessageId;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = this.deps.setTimer(() => this.flush(), this.deps.debounceMs);
  }

  private flush(): void {
    this.timer = null;
    const id = this.pendingId;
    if (id === null) return;
    if (!this.deps.isVisible()) return; // hidden tab: hold until re-observed
    this.pendingId = null;
    this.sentId = id;
    this.deps.send(id);
  }

  dispose(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }
}
