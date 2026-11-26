import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { task, identity } from "@dub/types";
import { App } from "../src/App";
import { MockApiClient } from "../src/api/mock-client";
import { makeCanEditBar, makeCanEditTask } from "../src/domain/permissions";

// #881: without task:edit_all a member edits only tasks assigned to them (or their team) or
// created by them; the rest render read-only (no drag/resize handles, disabled detail fields, a short hint).

const EVENT = "evt_test";
const ME = "usr_me";
const MEMBER: identity.PermissionKey[] = ["task:read", "task:write"];
const LEAD: identity.PermissionKey[] = ["task:read", "task:write", "task:delete", "task:edit_all"];

const mk = (id: string, over: Partial<task.Task> = {}): task.Task => ({
  id,
  eventId: EVENT,
  title: id,
  description: null,
  status: "todo",
  priority: "medium",
  assigneeId: null,
  createdBy: "usr_other",
  teamId: null,
  dueAt: "2026-08-20T00:00:00Z",
  origin: "internal",
  archivedAt: null,
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
  version: 1,
  ...over,
});

const TASKS = [mk("mine", { assigneeId: ME }), mk("made", { createdBy: ME }), mk("theirs", { assigneeId: "usr_bob" })];

describe("makeCanEditTask / makeCanEditBar", () => {
  it("assignee and creator edit; others need task:edit_all", () => {
    const can = makeCanEditTask(TASKS, ME, MEMBER);
    expect(can("mine")).toBe(true);
    expect(can("made")).toBe(true);
    expect(can("theirs")).toBe(false);
    expect(can("task_tmp_x")).toBe(true);
    expect(can("unknown")).toBe(false);
    expect(makeCanEditTask(TASKS, ME, LEAD)("theirs")).toBe(true);
    expect(makeCanEditTask(TASKS, ME, null)("mine")).toBe(false);
    expect(makeCanEditTask(TASKS, ME, ["task:read"])("mine")).toBe(false);
  });

  it("a member of the task's team edits it; a non-member does not", () => {
    const teamTasks = [mk("ops", { teamId: "team_ops" }), mk("pr", { teamId: "team_pr" })];
    const can = makeCanEditTask(teamTasks, ME, MEMBER, ["team_ops"]);
    expect(can("ops")).toBe(true);
    expect(can("pr")).toBe(false);
    expect(makeCanEditTask(teamTasks, ME, MEMBER)("ops")).toBe(false);
  });

  it("a parent bar needs its whole subtree editable", () => {
    const can = makeCanEditTask(TASKS, ME, MEMBER);
    const rows = [
      { taskId: "mine", parentTaskId: null },
      { taskId: "theirs", parentTaskId: "mine" },
      { taskId: "made", parentTaskId: null },
    ];
    const bar = makeCanEditBar(can, rows);
    expect(bar("mine")).toBe(false); // child "theirs" is not mine
    expect(bar("made")).toBe(true);
  });
});

describe("gantt read-only rendering for tasks I may not edit", () => {
  const renderAs = (perms: identity.PermissionKey[]) =>
    render(<App client={new MockApiClient({ tasks: TASKS, currentUserId: ME })} eventId={EVENT} permissions={perms} currentUserId={ME} />);

  it("member: my bar has resize handles, another's bar has none and is marked read-only", async () => {
    renderAs(MEMBER);
    const theirs = await screen.findByTestId("fe4-gantt-bar-theirs");
    expect(theirs.getAttribute("data-readonly")).toBe("true");
    expect(theirs.getAttribute("title")).toContain("作成者だけが編集できます");
    expect(screen.queryByTestId("fe4-gantt-bar-theirs-rz-l")).toBeNull();
    expect(screen.queryByTestId("fe4-gantt-bar-theirs-rz-r")).toBeNull();
    expect(screen.getByTestId("fe4-gantt-bar-mine").getAttribute("data-readonly")).toBeNull();
    expect(screen.getByTestId("fe4-gantt-bar-mine-rz-r")).toBeTruthy();
    expect(screen.getByTestId("fe4-gantt-bar-made-rz-r")).toBeTruthy();
  });

  it("member: another's task opens read-only with a hint; my task is editable", async () => {
    renderAs(MEMBER);
    fireEvent.pointerDown(await screen.findByTestId("fe4-gantt-bar-theirs"));
    let panel = await screen.findByTestId("fe4-detail-panel");
    expect(within(panel).getByTestId("fe4-detail-readonly-hint")).toBeTruthy();
    expect((within(panel).getByTestId("fe4-detail-title") as HTMLInputElement).disabled).toBe(true);

    fireEvent.click(within(panel).getAllByRole("button", { name: /閉じる/ })[0]!);
    fireEvent.pointerDown(await screen.findByTestId("fe4-gantt-bar-mine"));
    fireEvent.pointerUp(await screen.findByTestId("fe4-gantt-bar-mine"));
    panel = await screen.findByTestId("fe4-detail-panel");
    expect(within(panel).queryByTestId("fe4-detail-readonly-hint")).toBeNull();
    expect((within(panel).getByTestId("fe4-detail-title") as HTMLInputElement).disabled).toBe(false);
  });

  it("member: a bar of my team's task (myTeamIds from mention-teams) is editable", async () => {
    class TeamClient extends MockApiClient {
      override async request<T>(req: Parameters<MockApiClient["request"]>[0]): Promise<T> {
        if (req.path === "/api/v1/members/me/mention-teams") return { teams: [], myTeamIds: ["team_ops"] } as T;
        return super.request<T>(req);
      }
    }
    const OPS = "usr_ops_member"; // own user id: App's QueryClient is module-level, keyed per user
    const tasks = [...TASKS, mk("ops", { assigneeId: "usr_bob", teamId: "team_ops" })];
    render(<App client={new TeamClient({ tasks, currentUserId: OPS })} eventId={EVENT} permissions={MEMBER} currentUserId={OPS} />);
    await screen.findByTestId("fe4-gantt-bar-ops-rz-r");
    expect(screen.getByTestId("fe4-gantt-bar-ops").getAttribute("data-readonly")).toBeNull();
    expect(screen.getByTestId("fe4-gantt-bar-theirs").getAttribute("data-readonly")).toBe("true");
  });

  it("task:edit_all holder: every bar is editable", async () => {
    renderAs(LEAD);
    const theirs = await screen.findByTestId("fe4-gantt-bar-theirs");
    expect(theirs.getAttribute("data-readonly")).toBeNull();
    expect(screen.getByTestId("fe4-gantt-bar-theirs-rz-r")).toBeTruthy();
  });
});
