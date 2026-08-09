// TaskRepository — Room-as-read-cache + single-source = MO3 (§2-2). Task write is
// one online PATCH with optimistic locking: apply optimistically, commit on 200,
// rollback + refetch on 409 (§6 / theme3 D4). Observable so a ViewModel/Compose
// state can react. The Kotlin port keeps the same Flow<List<Task>> boundary.
import { AppErrorException, isAppErrorException, type AppError } from "./errors";
import type { MobileBffClient } from "./bff-client";
import type { TaskSummary, TaskStatus, Task } from "./contract";

export type TaskUpdateResult =
  | { ok: true; task: Task }
  | { ok: false; conflict: true; serverVersion: number | null } // rolled back + refetched
  | { ok: false; conflict: false; error: AppError }; // rolled back

type Listener = (tasks: TaskSummary[]) => void;

function toSummary(t: Task): TaskSummary {
  return { id: t.id, title: t.title, status: t.status, assigneeId: t.assigneeId };
}

export class TaskRepository {
  private cache = new Map<string, TaskSummary>();
  private listeners = new Set<Listener>();

  constructor(private readonly client: MobileBffClient) {}

  /** Current cached snapshot (insertion order). */
  observe(): TaskSummary[] {
    return [...this.cache.values()];
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const snapshot = this.observe();
    for (const l of this.listeners) l(snapshot);
  }

  /** Replace cache from the server list (pull-to-refresh / TTL revalidate). */
  async refreshMyTasks(): Promise<void> {
    const page = await this.client.getMyTasks();
    this.cache = new Map(page.items.map((t) => [t.id, t]));
    this.emit();
  }

  /** Test/seed hook to prime the read cache. */
  seed(tasks: TaskSummary[]): void {
    this.cache = new Map(tasks.map((t) => [t.id, t]));
    this.emit();
  }

  /**
   * Optimistic status change. baseVersion is the version the user saw.
   * Success -> commit; 409 -> rollback then refetch latest; other -> rollback.
   */
  async updateStatus(id: string, status: TaskStatus, baseVersion: number): Promise<TaskUpdateResult> {
    const previous = this.cache.get(id);
    if (!previous) {
      return { ok: false, conflict: false, error: { kind: "Server", code: "NOT_IN_CACHE", requestId: null } };
    }

    // 1. optimistic apply
    this.cache.set(id, { ...previous, status });
    this.emit();

    try {
      // 2. single online PATCH
      const updated = await this.client.updateTaskStatus(id, status, baseVersion);
      // 3a. commit authoritative server state
      this.cache.set(id, toSummary(updated));
      this.emit();
      return { ok: true, task: updated };
    } catch (err) {
      const appError = isAppErrorException(err) ? err.appError : ({ kind: "Server", code: "UNKNOWN", requestId: null } as AppError);

      // 3b. rollback optimistic UI first
      this.cache.set(id, previous);
      this.emit();

      if (appError.kind === "Conflict") {
        // refetch latest so the user re-decides against fresh state
        try {
          const fresh = await this.client.getTask(id);
          this.cache.set(id, toSummary(fresh));
          this.emit();
        } catch {
          // keep the rolled-back value if refetch also fails (offline etc.)
        }
        return { ok: false, conflict: true, serverVersion: appError.serverVersion };
      }
      return { ok: false, conflict: false, error: appError };
    }
  }
}

export { AppErrorException };
