import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { identity, task } from "@dub/types";
import type { RequestInput } from "../src/contracts/spa-shell";
import { ApiError } from "../src/contracts/spa-shell";
import { App } from "../src/App";

const upstreamDown = () =>
  new ApiError(503, { error: { code: "UPSTREAM_UNAVAILABLE", message: "gantt refetch failed", retryable: true } });
import { MockApiClient } from "../src/api/mock-client";

beforeEach(() => localStorage.clear());

const EVENT = "evt_rm";
const PERMS: identity.PermissionKey[] = ["task:read", "task:write", "task:delete"];
const mk = (id: string, title: string): task.Task => ({
  id, eventId: EVENT, title, description: null, status: "todo",
  priority: "medium", assigneeId: null, dueAt: "2026-08-20T00:00:00Z", origin: "internal",
  archivedAt: null, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", version: 1,
});

// Seed t1 -> t2 (t2 depends on t1). The real gantt-service edge id is `${to}->${from}`
// (services/gantt-service/src/dto.ts) — mirror that so the DOM test-id matches prod.
function seedArgs() {
  return {
    tasks: [mk("t1", "会場予約"), mk("t2", "登壇者調整")],
    dependencies: [{ id: "t2->t1", fromTaskId: "t1", toTaskId: "t2", type: "FS" as const, lagDays: 0 }],
  };
}

/** MockApiClient that fails the post-write `refetchFresh` (GET /gantt with
 *  `Cache-Control: no-cache`) once a dependency write has been persisted — reproducing a
 *  READ path that stays unavailable AFTER the write already succeeded. The initial gantt
 *  load (no such header), the reconcile task-list read, and every mutation call still
 *  succeed. The failure PERSISTS so the fix's correctness cannot hide behind a lucky
 *  background retry: the removal must hold from the optimistic write alone. */
class FlakyRefetchClient extends MockApiClient {
  private putSeen = false;
  override async request<T, TBody = unknown>(req: RequestInput<TBody>): Promise<T> {
    const isDepsPut = req.method === "PUT" && /\/tasks\/[^/]+\/dependencies$/.test(req.path);
    const isFreshGantt =
      req.method === "GET" && req.path === "/api/v1/gantt" && req.headers?.["Cache-Control"] === "no-cache";
    if (isFreshGantt && this.putSeen) {
      throw upstreamDown();
    }
    const res = await super.request<T, TBody>(req);
    if (isDepsPut) this.putSeen = true;
    return res;
  }
}

/** Count rendered dependency arrows by test-id prefix — robust to the edge-id format. */
const arrowCount = (root: HTMLElement) => root.querySelectorAll('[data-testid^="fe4-gantt-dep-"]').length;

async function removePredecessorAndSave() {
  fireEvent.click(await screen.findByTestId("fe4-gantt-row-t2"));
  const panel = await screen.findByTestId("fe4-detail-panel");
  fireEvent.click(await within(panel).findByLabelText("会場予約 を外す"));
  fireEvent.click(within(panel).getByTestId("fe4-detail-save"));
  return panel;
}

describe("先行タスクを外す（削除）", () => {
  it("removes cleanly on the happy path — no error, arrow gone, persisted", async () => {
    const client = new MockApiClient(seedArgs());
    const { container } = render(<App client={client} eventId={EVENT} permissions={PERMS} />);
    await screen.findByTestId("fe4-gantt-row-t2");
    await waitFor(() => expect(arrowCount(container)).toBe(1));

    await removePredecessorAndSave();

    await waitFor(() => expect(arrowCount(container)).toBe(0));
    expect(screen.queryByTestId("fe4-error-banner")).toBeNull();
    expect(screen.queryByTestId("toast-error")).toBeNull();
    expect(await screen.findByTestId("toast-success")).toBeInTheDocument();

    const gd = (await client.request({ method: "GET", path: "/api/v1/gantt", query: { eventId: EVENT } })) as {
      dependencies: unknown[];
    };
    expect(gd.dependencies).toHaveLength(0);
  });

  // Regression for the reported bug: "外すとエラーが出るが、少し時間を置くと外れている".
  // A transient failure of the POST-WRITE refetch must NOT roll the removal back nor
  // raise an error — the write already succeeded on the server.
  it("does not show an error or roll back when the post-write refetch transiently fails", async () => {
    const client = new FlakyRefetchClient(seedArgs());
    const { container } = render(<App client={client} eventId={EVENT} permissions={PERMS} />);
    await screen.findByTestId("fe4-gantt-row-t2");
    await waitFor(() => expect(arrowCount(container)).toBe(1));

    await removePredecessorAndSave();

    // No error surfaced despite the refetch throwing…
    await waitFor(() => {
      expect(screen.queryByTestId("fe4-error-banner")).toBeNull();
      expect(screen.queryByTestId("toast-error")).toBeNull();
    });
    // …the removal stays applied (never rolled back to a re-appearing arrow)…
    await waitFor(() => expect(arrowCount(container)).toBe(0));
    // …and stays gone after the background reconcile settles (no flicker back).
    await new Promise((r) => setTimeout(r, 30));
    expect(arrowCount(container)).toBe(0);
    expect(screen.queryByTestId("fe4-error-banner")).toBeNull();
    // server truly has the dependency removed (the write was committed)
    const gd = (await client.request({ method: "GET", path: "/api/v1/gantt", query: { eventId: EVENT } })) as {
      dependencies: unknown[];
    };
    expect(gd.dependencies).toHaveLength(0);
  });
});
