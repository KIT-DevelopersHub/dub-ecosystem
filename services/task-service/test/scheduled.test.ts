import { describe, it, expect } from "vitest";
import { runDueSoonScan } from "../src/scheduled";
import { makeHarness } from "./helpers";

const NOW = Date.parse("2026-08-09T12:00:00Z");

async function seed(h: ReturnType<typeof makeHarness>, id: string, dueAt: string | null, status = "todo"): Promise<void> {
  await h.repo.insert({
    id,
    eventId: "evt_1",
    title: "T",
    description: null,
    status: status as never,
    priority: "medium",
    assigneeId: "usr_bob",
    dueAt,
    origin: "internal",
    createdBy: "usr_alice",
    now: "2026-08-09T00:00:00Z",
  });
}

describe("cron due-soon scan", () => {
  it("emits task.due_soon once per task within 24h (dedup on re-scan), actorId=null", async () => {
    const h = makeHarness();
    await seed(h, "task_soon", "2026-08-09T18:00:00Z"); // in 6h -> within window
    await seed(h, "task_far", "2026-08-20T00:00:00Z"); // far future -> excluded
    await seed(h, "task_done", "2026-08-09T18:00:00Z", "done"); // done -> excluded
    await seed(h, "task_none", null); // no due -> excluded

    const n = await runDueSoonScan(h.deps, NOW);
    expect(n).toBe(1);
    const emitted = h.events.byName("task.due_soon");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload).toEqual({ taskId: "task_soon", eventId: "evt_1", dueAt: "2026-08-09T18:00:00Z" });
    expect(emitted[0]!.actorId).toBeNull();

    // second scan: already notified -> nothing new.
    const n2 = await runDueSoonScan(h.deps, NOW);
    expect(n2).toBe(0);
    expect(h.events.byName("task.due_soon")).toHaveLength(1);
  });
});
