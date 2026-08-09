import { describe, it, expect } from "vitest";
import type { DbClient, DbRunResult } from "@dub/db";
import { isDubError } from "@dub/errors";
import { createViewRepo, validatePutBody } from "../src/views";

// Minimal in-memory DbClient fake for gantt_view_states (first / run only).
function fakeDb(): DbClient {
  const store = new Map<string, { state: string; updated_at: string }>();
  const key = (u: string, e: string) => `${u}|${e}`;
  const ok: DbRunResult = { success: true, meta: { changes: 1, durationMs: 0 } };
  return {
    namespace: "gantt",
    async first<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T | null> {
      if (/SELECT/i.test(sql)) {
        const row = store.get(key(binds[0] as string, binds[1] as string));
        return (row ?? null) as T | null;
      }
      return null;
    },
    async all<T = Record<string, unknown>>(): Promise<T[]> {
      return [];
    },
    async run(sql: string, ...binds: unknown[]): Promise<DbRunResult> {
      if (/INSERT/i.test(sql)) {
        store.set(key(binds[0] as string, binds[1] as string), { state: binds[2] as string, updated_at: binds[3] as string });
      } else if (/DELETE/i.test(sql)) {
        for (const k of [...store.keys()]) if (k.endsWith(`|${binds[0] as string}`)) store.delete(k);
      }
      return ok;
    },
    async batch(): Promise<DbRunResult[]> {
      return [];
    },
    raw() {
      throw new Error("not implemented");
    },
  };
}

describe("validatePutBody", () => {
  it("accepts a valid body", () => {
    expect(validatePutBody({ zoom: "month", collapsedTaskIds: ["task_a"] })).toEqual({ zoom: "month", collapsedTaskIds: ["task_a"] });
  });
  it("rejects an invalid zoom (400)", () => {
    try {
      validatePutBody({ zoom: "year", collapsedTaskIds: [] });
      expect.unreachable();
    } catch (e) {
      expect(isDubError(e) && e.status).toBe(400);
    }
  });
  it("rejects non-string collapsedTaskIds (400)", () => {
    try {
      validatePutBody({ zoom: "week", collapsedTaskIds: [1, 2] });
      expect.unreachable();
    } catch (e) {
      expect(isDubError(e) && e.status).toBe(400);
    }
  });
});

describe("createViewRepo", () => {
  it("returns a default state when unsaved (zoom=week, collapsed=[])", async () => {
    const repo = createViewRepo(fakeDb());
    expect(await repo.get("user_a", "event_1")).toEqual({ eventId: "event_1", zoom: "week", collapsedTaskIds: [] });
  });

  it("round-trips PUT -> GET for the owner", async () => {
    const repo = createViewRepo(fakeDb());
    const saved = await repo.put("user_a", "event_1", { zoom: "day", collapsedTaskIds: ["task_a", "task_b"] });
    expect(saved).toEqual({ eventId: "event_1", zoom: "day", collapsedTaskIds: ["task_a", "task_b"] });
    expect(await repo.get("user_a", "event_1")).toEqual(saved);
  });

  it("isolates state per user (another user still sees default)", async () => {
    const repo = createViewRepo(fakeDb());
    await repo.put("user_a", "event_1", { zoom: "day", collapsedTaskIds: [] });
    expect((await repo.get("user_b", "event_1")).zoom).toBe("week");
  });

  it("deleteByEvent reaps all users' rows for that event", async () => {
    const db = fakeDb();
    const repo = createViewRepo(db);
    await repo.put("user_a", "event_1", { zoom: "day", collapsedTaskIds: [] });
    await repo.put("user_b", "event_1", { zoom: "month", collapsedTaskIds: [] });
    await repo.deleteByEvent("event_1");
    expect((await repo.get("user_a", "event_1")).zoom).toBe("week");
    expect((await repo.get("user_b", "event_1")).zoom).toBe("week");
  });
});
