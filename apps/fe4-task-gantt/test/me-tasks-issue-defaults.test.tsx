import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import type { common, event, identity, member, team } from "@dub/types";
import { ApiClientProvider } from "../src/api/client-context";
import { MockApiClient } from "../src/api/mock-client";
import { getGantt } from "../src/api/endpoints";
import { MeTasksRoute, TaskRouteProvider } from "../src/routes/taskRoutes";
import { setCurrentEventId } from "../src/domain/current-event";

// 「タスクを発行」 modal defaults + ガント parity (this task):
//   1. 対象イベントの初期値 = the globally-selected event (グローバルなイベント選択状態).
//   2. 依頼先(担当者) = a dropdown over the 運営メンバー roster.
//   3. 優先度 initial value = 未設定.
//   4. A task issued from マイタスク shows up in the ガント for its event, with the
//      same 対象イベント / 担当 (and the priority carried on the shared task record).

const ME = "usr_me" as common.UserId;
const EVT = "evt_conf" as common.EventId;

const EVENTS: event.EventSummary[] = [
  { id: EVT, title: "北陸ITカンファレンス2026", phase: "planning", startsAt: null },
];

const ROSTER: identity.UserSummary[] = [
  { id: "usr_me" as common.UserId, displayName: "自分 太郎", avatarUrl: null },
  { id: "usr_hanako" as common.UserId, displayName: "花子 運営", avatarUrl: null },
  { id: "usr_kume" as common.UserId, displayName: "久米", avatarUrl: null },
];

function renderRoute(client: MockApiClient): ReactElement {
  return render(
    <ApiClientProvider client={client}>
      <TaskRouteProvider value={{ currentUserId: ME, permissions: ["task:read", "task:write"] }}>
        <MeTasksRoute />
      </TaskRouteProvider>
    </ApiClientProvider>,
  ) as unknown as ReactElement;
}

const TEAMS: team.Team[] = [
  { id: "team_hq" as common.TeamId, key: "hq", name: "統括チーム" },
  { id: "team_dev" as common.TeamId, key: "dev", name: "開発チーム" },
];

// A 名簿 where the current user (usr_me) belongs to 開発チーム — the 「タスクを発行」 team
// default should resolve to it (via member.identityUserId === current user).
function member_(id: string, identityUserId: string | null, teamIds: string[]): member.Member {
  return {
    id, orgId: "org_demo" as common.OrgId, name: id, roleTitle: null, status: "added", teamIds,
    department: null, grade: null, identityUserId, contact: null, note: null, sortOrder: 0, version: 1,
    createdAt: "t" as common.ISODateTime, updatedAt: "t" as common.ISODateTime,
  };
}
const MEMBERS: member.Member[] = [
  member_("m_me", ME, ["team_dev"]),
  member_("m_other", "usr_hanako", ["team_hq"]),
];

function newClient(): MockApiClient {
  return new MockApiClient({ events: EVENTS, users: ROSTER, currentUserId: ME });
}

function newClientWithTeams(): MockApiClient {
  return new MockApiClient({ events: EVENTS, users: ROSTER, teams: TEAMS, members: MEMBERS, currentUserId: ME });
}

describe("マイタスク「タスクを発行」 — defaults + ガント parity", () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
  });

  it("seeds 対象イベント from the globally-selected event and lists roster members as 依頼先", async () => {
    setCurrentEventId(EVT); // header/global selection
    const client = newClient();
    renderRoute(client);

    fireEvent.click(await screen.findByTestId("fe4-mytasks-create-open"));

    // 1. 対象イベント初期値 = the selected event.
    const eventSelect = (await screen.findByTestId("fe4-mytask-create-event")) as HTMLSelectElement;
    await waitFor(() => expect(eventSelect.value).toBe(EVT));

    // 2. 依頼先 dropdown offers the 運営メンバー roster.
    const assignee = screen.getByTestId("fe4-mytask-create-assignee") as HTMLSelectElement;
    await waitFor(() => expect(assignee).toHaveTextContent("花子 運営"));
    expect(assignee).toHaveTextContent("久米");

    // 3. 優先度 initial value = 未設定 (blank sentinel).
    const priority = screen.getByTestId("fe4-mytask-create-priority") as HTMLSelectElement;
    expect(priority.value).toBe("");
    expect(priority).toHaveTextContent("未設定");
  });

  it("seeds チーム to the team the logged-in user belongs to (③)", async () => {
    setCurrentEventId(EVT);
    const client = newClientWithTeams();
    renderRoute(client);

    fireEvent.click(await screen.findByTestId("fe4-mytasks-create-open"));

    // チーム初期値 = 開発チーム (usr_me's team via member.identityUserId), resolved async
    // from /members/overview after the modal opens.
    const teamSelect = (await screen.findByTestId("fe4-mytask-create-team")) as HTMLSelectElement;
    await waitFor(() => expect(teamSelect.value).toBe("team_dev"));
  });

  it("leaves チーム 未割当 when the user is on no team", async () => {
    setCurrentEventId(EVT);
    // roster/overview without a membership for usr_me → no default.
    const client = new MockApiClient({ events: EVENTS, users: ROSTER, teams: TEAMS, members: [member_("m_other", "usr_hanako", ["team_hq"])], currentUserId: ME });
    renderRoute(client);
    fireEvent.click(await screen.findByTestId("fe4-mytasks-create-open"));
    const teamSelect = (await screen.findByTestId("fe4-mytask-create-team")) as HTMLSelectElement;
    // it stays 未割当 (blank) — assert it never flips to a team.
    await waitFor(() => expect((screen.getByTestId("fe4-mytask-create-event") as HTMLSelectElement).value).toBe(EVT));
    expect(teamSelect.value).toBe("");
  });

  it("starts unlinked when no event is globally selected", async () => {
    const client = newClient(); // localStorage cleared → no current event
    renderRoute(client);
    fireEvent.click(await screen.findByTestId("fe4-mytasks-create-open"));
    const eventSelect = (await screen.findByTestId("fe4-mytask-create-event")) as HTMLSelectElement;
    expect(eventSelect.value).toBe(""); // 紐付けない
  });

  it("issues a task with event+assignee+priority — it appears in the ガント for that event", async () => {
    setCurrentEventId(EVT);
    const client = newClient();
    renderRoute(client);

    fireEvent.click(await screen.findByTestId("fe4-mytasks-create-open"));
    await waitFor(() =>
      expect((screen.getByTestId("fe4-mytask-create-event") as HTMLSelectElement).value).toBe(EVT),
    );

    fireEvent.change(screen.getByTestId("fe4-mytask-create-title"), {
      target: { value: "登壇者へ最終案内メールを送る" },
    });
    fireEvent.change(screen.getByTestId("fe4-mytask-create-assignee"), { target: { value: "usr_hanako" } });
    fireEvent.change(screen.getByTestId("fe4-mytask-create-priority"), { target: { value: "high" } });
    fireEvent.click(screen.getByTestId("fe4-mytask-create-submit"));

    // POST carried the selected event / assignee / priority.
    await waitFor(() => {
      const created = client.calls.find((c) => c.path === "/api/v1/tasks" && c.method === "POST");
      expect(created).toBeTruthy();
      const body = created?.body as { eventId?: string; assigneeId?: string; priority?: string };
      expect(body.eventId).toBe(EVT);
      expect(body.assigneeId).toBe("usr_hanako");
      expect(body.priority).toBe("high");
    });

    // ガント parity: the same task shows in the event's gantt with the same assignee.
    const dto = await getGantt(client, EVT);
    const row = dto.rows.find((r) => r.title === "登壇者へ最終案内メールを送る");
    expect(row).toBeTruthy();
    expect(row?.assigneeId).toBe("usr_hanako");
  });

  it("未設定 priority is omitted on POST (server defaults medium) and the task still lands in the ガント", async () => {
    setCurrentEventId(EVT);
    const client = newClient();
    renderRoute(client);

    fireEvent.click(await screen.findByTestId("fe4-mytasks-create-open"));
    await waitFor(() =>
      expect((screen.getByTestId("fe4-mytask-create-event") as HTMLSelectElement).value).toBe(EVT),
    );
    fireEvent.change(screen.getByTestId("fe4-mytask-create-title"), { target: { value: "会場の下見をする" } });
    // leave 優先度 at 未設定; leave 依頼先 未割当.
    fireEvent.click(screen.getByTestId("fe4-mytask-create-submit"));

    await waitFor(() => {
      const created = client.calls.find((c) => c.path === "/api/v1/tasks" && c.method === "POST");
      expect(created).toBeTruthy();
      const body = created?.body as { priority?: string };
      expect(body.priority).toBeUndefined(); // omitted ⇒ server applies "medium"
    });

    const dto = await getGantt(client, EVT);
    expect(dto.rows.some((r) => r.title === "会場の下見をする")).toBe(true);
  });
});
