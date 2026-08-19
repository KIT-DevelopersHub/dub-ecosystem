// PR18: the 送る・受け取る status badge (「タスクをお願いした / 受け負った」) shows on BOTH
// マイタスク rows and ガント rows, with the wording DERIVED from the role (never stored).
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { task, type gantt, type common } from "@dub/types";
import { CrossTeamRoleBadge } from "../src/components/CrossTeamRoleBadge";
import { GanttView } from "../src/components/GanttView";
import { MyTaskList } from "../src/components/MyTaskList";

describe("CrossTeamRoleBadge", () => {
  it("derives the label from the role (single source: TASK_CROSS_ROLE_STATUS_LABEL)", () => {
    render(<CrossTeamRoleBadge role="requested" />);
    expect(screen.getByText(task.TASK_CROSS_ROLE_STATUS_LABEL.requested)).toBeInTheDocument();
    expect(screen.getByText("タスクをお願いした")).toBeInTheDocument();
  });
  it("renders 受け負った for the accepted role", () => {
    render(<CrossTeamRoleBadge role="accepted" />);
    expect(screen.getByText("タスクを受け負った")).toBeInTheDocument();
  });
});

describe("ガント: crossTeamRole projects a badge (no arrow)", () => {
  const row = (over: Partial<gantt.GanttRow> & { taskId: string; title: string }): gantt.GanttRow => ({
    startsAt: "2026-08-12T00:00:00Z",
    endsAt: "2026-08-18T00:00:00Z",
    progressPercent: 0,
    assigneeId: null,
    depth: 0,
    ...over,
  });

  it("shows お願いした / 受け負った on rows that carry a crossTeamRole", () => {
    const dto: gantt.GanttChartDTO = {
      eventId: "evt_1",
      rows: [
        row({ taskId: "req", title: "会計→スポンサーへ依頼", crossTeamRole: "requested" }),
        row({ taskId: "acc", title: "スポンサーが受けた作業", crossTeamRole: "accepted" }),
        row({ taskId: "plain", title: "自チームの通常タスク" }),
      ],
      dependencies: [],
      crossLinks: [
        { id: "txl_1", requestId: "treq_1", requesterTaskId: "req", requesteeTaskId: "acc", eventId: "evt_1", createdAt: "2026-08-12T00:00:00Z" },
      ],
    };
    render(<GanttView dto={dto} zoom="week" />);
    expect(screen.getAllByText("タスクをお願いした").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("タスクを受け負った").length).toBeGreaterThanOrEqual(1);
  });
});

describe("マイタスク: roleByTask projects the same badge", () => {
  const mkTask = (id: string, title: string): task.Task => ({
    id: id as common.TaskId,
    eventId: "evt_1" as common.EventId,
    title,
    description: null,
    status: "todo",
    priority: "medium",
    assigneeId: null,
    teamId: null,
    createdBy: "usr_me" as common.UserId,
    parentTaskId: null,
    wbs: null,
    startAt: null,
    dueAt: null,
    origin: "internal",
    archivedAt: null,
    createdAt: "2026-08-20T00:00:00Z",
    updatedAt: "2026-08-20T00:00:00Z",
    version: 1,
  });

  it("renders the badge on the row whose id is in roleByTask", () => {
    const roleByTask = new Map<common.TaskId, task.TaskCrossRole>([["t_req" as common.TaskId, "requested"]]);
    render(
      <MyTaskList
        tasks={[mkTask("t_req", "お願いしたタスク"), mkTask("t_plain", "普通のタスク")]}
        users={new Map()}
        teamNames={new Map()}
        onSelect={() => {}}
        roleByTask={roleByTask}
        visibleCount={25}
        onShowMore={() => {}}
      />,
    );
    expect(screen.getByTestId("fe4-mytask-role-t_req")).toHaveTextContent("タスクをお願いした");
    expect(screen.queryByTestId("fe4-mytask-role-t_plain")).toBeNull();
  });
});
