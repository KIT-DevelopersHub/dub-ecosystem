import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { task, team } from "@dub/types";
import { MockApiClient } from "../src/api/mock-client";
import * as api from "../src/api/endpoints";
import { toListTasksQuery, emptyFilter } from "../src/domain/task-query";
import { TeamViewSwitcher } from "../src/components/TeamViewSwitcher";

const TEAMS: team.Team[] = [
  { id: "team_ops", key: "ops", name: "運営", color: "#3358e8" },
  { id: "team_content", key: "content", name: "コンテンツ", color: "#27ae60" },
];

const mk = (id: string, teamId: string | null): task.Task => ({
  id, eventId: "evt_1", title: id, description: null, status: "todo",
  priority: "medium", assigneeId: null, teamId, dueAt: null, origin: "internal",
  archivedAt: null, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", version: 1,
});

describe("teams — canonical shared entity (feature B)", () => {
  it("GET /teams returns the seeded canonical teams", async () => {
    const c = new MockApiClient({ teams: TEAMS });
    const res = await api.listTeams(c);
    expect(res.items.map((t) => t.key)).toEqual(["ops", "content"]);
  });

  it("listTasks filters by teamId (feature C source)", async () => {
    const c = new MockApiClient({
      teams: TEAMS,
      tasks: [mk("t1", "team_ops"), mk("t2", "team_content"), mk("t3", "team_ops")],
    });
    const ops = await api.listTasks(c, { eventId: "evt_1", teamId: "team_ops" });
    expect(ops.items.map((t) => t.id).sort()).toEqual(["t1", "t3"]);
    const all = await api.listTasks(c, { eventId: "evt_1" });
    expect(all.items).toHaveLength(3);
  });

  it("create/update carry teamId; gantt rows expose it", async () => {
    const c = new MockApiClient({ teams: TEAMS });
    const created = await api.createTask(c, { eventId: "evt_1", title: "x", teamId: "team_ops" });
    expect(created.teamId).toBe("team_ops");
    const dto = await api.getGantt(c, "evt_1");
    expect(dto.rows.find((r) => r.taskId === created.id)?.teamId).toBe("team_ops");
    const updated = await api.updateTask(c, created.id, { version: created.version, teamId: "team_content" });
    expect(updated.teamId).toBe("team_content");
  });

  it("toListTasksQuery includes teamId only when set (AND with status)", () => {
    const base = emptyFilter("evt_1");
    expect(toListTasksQuery(base).teamId).toBeUndefined();
    const q = toListTasksQuery({ ...base, teamId: "team_ops", status: ["done"] });
    expect(q.teamId).toBe("team_ops");
    expect(q.status).toEqual(["done"]);
  });
});

describe("TeamViewSwitcher (feature C)", () => {
  it("renders 全体表示 + a chip per team and reports the selection", () => {
    const onChange = vi.fn();
    render(<TeamViewSwitcher teams={TEAMS} value={undefined} onChange={onChange} />);
    expect(screen.getByTestId("fe4-team-all")).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByTestId("fe4-team-team_ops"));
    expect(onChange).toHaveBeenCalledWith("team_ops");
  });

  it("全体表示 clears the team filter (undefined)", () => {
    const onChange = vi.fn();
    render(<TeamViewSwitcher teams={TEAMS} value="team_ops" onChange={onChange} />);
    expect(screen.getByTestId("fe4-team-team_ops")).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByTestId("fe4-team-all"));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });
});
