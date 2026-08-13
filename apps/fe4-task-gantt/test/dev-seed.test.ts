// Locks in the real LMB-derived demo seed: the 41 conference sections flow into
// the gantt DTO with real teams, dependency lines, and a critical governance spine.
import { describe, expect, it } from "vitest";
import { createDevClient, DEMO_EVENT_ID } from "../src/dev-seed";
import type { gantt, task, team } from "@dub/types";

async function getDto(): Promise<gantt.GanttChartDTO> {
  const client = createDevClient();
  return client.request<gantt.GanttChartDTO>({ method: "GET", path: "/api/v1/gantt", query: { event: DEMO_EVENT_ID } });
}

describe("dev-seed (real LMB conference data)", () => {
  it("exposes the 7 real conference teams with colours", async () => {
    const client = createDevClient();
    const res = await client.request<team.ListTeamsResponse>({ method: "GET", path: "/api/v1/teams" });
    const names = res.items.map((t) => t.name).sort();
    expect(names).toEqual(["会場", "会計", "全体進行", "集客告知", "スポンサー", "開発", "本部"].sort());
    expect(res.items.every((t) => typeof t.color === "string")).toBe(true);
  });

  it("renders all 41 section work-packages as gantt rows, each with a bar", async () => {
    const dto = await getDto();
    expect(dto.rows).toHaveLength(41);
    expect(dto.rows.every((r) => r.startsAt !== null && r.endsAt !== null)).toBe(true);
    expect(dto.rows.every((r) => r.teamId !== null)).toBe(true);
  });

  it("keeps the two real in-repo dates for WBS 3.4 (2026-08-16 → 2026-09-15)", async () => {
    const dto = await getDto();
    const row = dto.rows.find((r) => r.taskId === "task_3_4");
    expect(row?.startsAt).toBe("2026-08-16T00:00:00.000Z");
    expect(row?.endsAt).toBe("2026-09-15T00:00:00.000Z");
  });

  it("wires the real phase-spine dependencies + critical path", async () => {
    const dto = await getDto();
    const edge = (from: string, to: string) => dto.dependencies.some((d) => d.fromTaskId === from && d.toTaskId === to);
    expect(edge("task_1_1", "task_3_1")).toBe(true); // F1→F3
    expect(edge("task_6_1", "task_7_3")).toBe(true); // F6→F7 本番
    expect(dto.criticalTaskIds).toContain("task_7_3");
    expect(dto.criticalTaskIds).toContain("task_1_1");
  });

  it("lists tasks under the conference event with real assignee owners", async () => {
    const client = createDevClient();
    const res = await client.request<task.ListTasksResponse>({ method: "GET", path: "/api/v1/tasks", query: { eventId: DEMO_EVENT_ID, limit: 100 } });
    expect(res.items.length).toBe(41);
    const kickoff = res.items.find((t) => t.id === "task_3_1");
    expect(kickoff?.assigneeId).toBe("usr_takaoka"); // 本部 owner = 高岡 己太朗
    expect(kickoff?.status).toBe("done");
  });
});
