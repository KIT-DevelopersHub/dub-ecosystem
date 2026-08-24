// Locks in the real LMB-derived demo seed: the 41 conference sections flow into
// the gantt DTO with real teams, dependency lines, and a critical governance spine.
import { describe, expect, it } from "vitest";
import { createDevClient, DEMO_EVENT_ID } from "../src/dev-seed";
import * as api from "../src/api/endpoints";
import { rollupRowDates } from "../src/domain/timeline-axis";
import type { gantt, task, member } from "@dub/types";

async function getDto(): Promise<gantt.GanttChartDTO> {
  // Route through the real endpoint wrapper so this fixture can never re-encode a
  // hand-written query key (the old `?event=`); the wire key comes from @dub/types.
  return api.getGantt(createDevClient(), DEMO_EVENT_ID);
}

describe("dev-seed (real LMB conference data)", () => {
  it("exposes the 8 official conference teams with colours + 2-letter ID codes", async () => {
    const client = createDevClient();
    const res = await client.request<member.ListTeamsResponse>({ method: "GET", path: "/api/v1/teams" });
    const names = res.teams.map((t) => t.name).sort();
    expect(names).toEqual(
      ["統括", "法務会計", "会場", "当日進行", "スポンサー", "集客広報", "デザイン", "法人メンバー"].sort(),
    );
    expect(res.teams.every((t) => typeof t.color === "string")).toBe(true);
    // Every team carries its contractual 2-letter task-ID prefix code.
    expect(res.teams.every((t) => typeof t.code === "string" && /^[A-Z]{2}$/.test(t.code!))).toBe(true);
  });

  it("renders the 41 work-packages + 128 WBS leaves as a two-level tree, each with a bar", async () => {
    const dto = await getDto();
    const parents = dto.rows.filter((r) => (r.depth ?? 0) === 0);
    const leaves = dto.rows.filter((r) => (r.depth ?? 0) === 1);
    expect(parents).toHaveLength(41); // LMB's 41 section work-packages
    expect(leaves).toHaveLength(128); // 129 config leaves − the 3.3 self-leaf
    expect(dto.rows).toHaveLength(169);
    // A row WITH children (work-package) carries null own dates — its span is derived from
    // children (mirrors gantt-service dto.toRow). Every row WITHOUT children (leaves +
    // childless top-level work-packages like 3.3) carries real dates. The client rolls the
    // parent span up so every row still shows a bar.
    const withChildren = dto.rows.filter((r) => r.hasChildren);
    const withoutChildren = dto.rows.filter((r) => !r.hasChildren);
    expect(withChildren.every((r) => r.startsAt === null && r.endsAt === null)).toBe(true);
    expect(withoutChildren.every((r) => r.startsAt !== null && r.endsAt !== null)).toBe(true);
    expect(rollupRowDates(dto.rows).every((r) => r.startsAt !== null && r.endsAt !== null)).toBe(true);
    expect(dto.rows.every((r) => r.teamId !== null)).toBe(true);
    // every leaf points at a real parent row that advertises children
    const byId = new Map(dto.rows.map((r) => [r.taskId, r]));
    expect(leaves.every((l) => byId.get(l.parentTaskId!)?.hasChildren === true)).toBe(true);
  });

  it("hangs the WBS leaves under their work-package parent (togglable drill-down)", async () => {
    const dto = await getDto();
    const sponsor = dto.rows.find((r) => r.taskId === "task_4_1"); // スポンサー: 打診・契約
    expect(sponsor?.hasChildren).toBe(true);
    const leaf = dto.rows.find((r) => r.taskId === "task_4_1_1");
    expect(leaf?.parentTaskId).toBe("task_4_1");
    expect(leaf?.depth).toBe(1);
    expect(leaf?.wbs).toBe("4.1.1");
    // the 開発 work-package (3.3) has no distinct leaves ⇒ no toggle
    expect(dto.rows.find((r) => r.taskId === "task_3_3")?.hasChildren).toBe(false);
  });

  it("keeps the two real in-repo dates for WBS 3.4 (2026-08-16 → 2026-09-15) via child rollup", async () => {
    const dto = await getDto();
    // 3.4 is a work-package (has leaves), so its OWN dates are null in the read model; the
    // seed slices its children to span exactly the two real dates, so the rolled-up parent
    // bar still reads [2026-08-16, 2026-09-15] — the same result the client renders.
    const raw = dto.rows.find((r) => r.taskId === "task_3_4");
    expect(raw?.hasChildren).toBe(true);
    expect(raw?.startsAt).toBeNull();
    const row = rollupRowDates(dto.rows).find((r) => r.taskId === "task_3_4");
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
    const res = await client.request<task.ListTasksResponse>({ method: "GET", path: "/api/v1/tasks", query: { eventId: DEMO_EVENT_ID, limit: 200 } });
    expect(res.items.length).toBe(169); // 41 work-packages + 128 WBS leaves
    const kickoff = res.items.find((t) => t.id === "task_3_1");
    expect(kickoff?.assigneeId).toBe("usr_takaoka"); // 本部 owner = 高岡 己太朗
    expect(kickoff?.status).toBe("done");
  });
});
