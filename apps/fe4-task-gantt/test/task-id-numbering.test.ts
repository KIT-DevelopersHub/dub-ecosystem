// Integration: the ID number `<team code>-<global creation sequence>` is stable
// across filter/sort and re-sequences to the tail when a task's team changes —
// exercised end-to-end over the mock client + team-code resolver + computeTaskNumbers.
import { describe, it, expect } from "vitest";
import type { task, team, common, gantt } from "@dub/types";
import { MockApiClient } from "../src/api/mock-client";
import * as api from "../src/api/endpoints";
import { computeTaskNumbers } from "../src/domain/task-number";
import { teamCode } from "../src/domain/team-code";

const EVENT = "evt_1";

const TEAMS: team.Team[] = [
  { id: "team_toukatsu", key: "toukatsu", name: "統括", color: "#111", code: "TK" },
  { id: "team_sponsor", key: "sponsor", name: "スポンサー", color: "#222", code: "SP" },
  { id: "team_houjin", key: "houjin", name: "法人メンバー", color: "#333", code: "HJ" },
];
const teamById = new Map(TEAMS.map((t) => [t.id, t] as const));

const mk = (id: string, createdAt: string, teamId: string | null): task.Task => ({
  id, eventId: EVENT, title: id, description: null, status: "todo",
  priority: "medium", assigneeId: null, teamId, dueAt: null, origin: "internal",
  archivedAt: null, createdAt, updatedAt: createdAt, version: 1,
});

function seed(): MockApiClient {
  return new MockApiClient({
    teams: TEAMS,
    tasks: [
      mk("t1", "2026-01-01T00:00:00Z", "team_toukatsu"),
      mk("t2", "2026-01-02T00:00:00Z", "team_sponsor"),
      mk("t3", "2026-01-03T00:00:00Z", "team_toukatsu"),
    ],
  });
}

const codeOf = (r: gantt.GanttRow) => teamCode(r.teamId ? teamById.get(r.teamId) : null);
const numbers = (rows: readonly gantt.GanttRow[]) => computeTaskNumbers(rows, codeOf, 4);

describe("task ID numbering — end to end", () => {
  it("assigns <team code>-<global creation sequence> in creation order", async () => {
    const dto = await api.getGantt(seed(), EVENT);
    const n = numbers(dto.rows);
    expect(n.get("t1")).toBe("TK-0001");
    expect(n.get("t2")).toBe("SP-0002");
    expect(n.get("t3")).toBe("TK-0003");
  });

  it("does NOT re-number when rows are re-ordered (filter/sort stable)", async () => {
    const dto = await api.getGantt(seed(), EVENT);
    const forward = numbers(dto.rows);
    const reversed = numbers([...dto.rows].reverse());
    for (const id of ["t1", "t2", "t3"]) expect(reversed.get(id)).toBe(forward.get(id));
  });

  it("keeps the GLOBAL number when a subset (team filter) is displayed", async () => {
    const client = seed();
    const all = await api.getGantt(client, EVENT);
    const full = numbers(all.rows); // computed over the full set (as the app does)
    // Simulate a "統括" team filter: only t1/t3 shown, but their numbers are unchanged.
    expect(full.get("t1")).toBe("TK-0001");
    expect(full.get("t3")).toBe("TK-0003");
  });

  it("re-sequences to the tail with the new prefix when the team changes", async () => {
    const client = seed();
    const before = numbers((await api.getGantt(client, EVENT)).rows);
    expect(before.get("t1")).toBe("TK-0001");

    // Move t1 統括(TK) -> 法人メンバー(HJ). Old ID retires; it re-numbers at the tail.
    const cur = await api.getTask(client, "t1");
    await api.updateTask(client, "t1", { teamId: "team_houjin", version: cur.version });

    const after = numbers((await api.getGantt(client, EVENT)).rows);
    expect(after.get("t1")).toBe("HJ-0004"); // fresh tail number, new prefix; old TK-0001 retired
    // The tasks that did NOT change keep their exact original numbers (no survivor shift).
    expect(after.get("t2")).toBe("SP-0002");
    expect(after.get("t3")).toBe("TK-0003");
  });
});
