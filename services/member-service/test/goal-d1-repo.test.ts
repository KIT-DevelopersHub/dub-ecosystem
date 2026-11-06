// 目標管理 D1 リポジトリ: 実 SQLite + 実 migration で、保存の往復と月の数え方 (日本時間の月境界) を守る。
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { DbClient } from "@dub/db";
import { createD1GoalRepo, type GoalRow } from "../src/goal-repo";
import { MEMBER_MIGRATIONS } from "../src/schema";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type Bind = string | number | null;

function open() {
  const raw = new DatabaseSync(":memory:");
  for (const m of MEMBER_MIGRATIONS) raw.exec(m.up);
  const db = {
    namespace: "member",
    first: async (sql: string, ...b: Bind[]) => raw.prepare(sql).get(...b) ?? null,
    all: async (sql: string, ...b: Bind[]) => raw.prepare(sql).all(...b),
    run: async (sql: string, ...b: Bind[]) => {
      const r = raw.prepare(sql).run(...b);
      return { success: true, meta: { changes: Number(r.changes), durationMs: 0 } };
    },
  } as unknown as DbClient;
  return { raw, repo: createD1GoalRepo(db) };
}

const row: GoalRow = {
  orgId: "org_x", teamId: "team_1", month: "2026-11", title: "目標",
  kpis: [{ name: "完了数", metric: "tasks_done", target: 10, manualActual: 0 }],
  version: 1, updatedBy: "usr_1", updatedByName: "佐藤", updatedAt: "2026-11-01T00:00:00.000Z",
};

describe("createD1GoalRepo", () => {
  it("round-trips a goal and enforces create-once + optimistic lock", async () => {
    const { repo } = open();
    expect(await repo.save(row, 0)).toBe(true);
    expect(await repo.save(row, 0)).toBe(false);
    expect(await repo.get("org_x", "team_1", "2026-11")).toEqual(row);
    expect(await repo.list("org_x", "2026-11")).toEqual([row]);
    expect(await repo.list("org_x", "2026-12")).toEqual([]);
    expect(await repo.save({ ...row, version: 3, title: "変更" }, 2)).toBe(false);
    expect(await repo.save({ ...row, version: 2, title: "変更" }, 1)).toBe(true);
    expect((await repo.get("org_x", "team_1", "2026-11"))?.title).toBe("変更");
    await repo.remove("org_x", "team_1", "2026-11");
    expect(await repo.get("org_x", "team_1", "2026-11")).toBeNull();
  });

  it("counts each source by JST month, leaving out archived rows and repeated hires", async () => {
    const { raw, repo } = open();
    const applicant = (id: string, createdAt: string, interviewAt: string | null, archivedAt: string | null = null) =>
      raw.prepare(
        `INSERT INTO member_hr_applicants (id, org_id, name, interview_at, stage, version, archived_at, created_by, created_at, updated_at)
         VALUES (?, 'org_x', '応募者', ?, 'scheduling', 1, ?, 'usr', ?, ?)`,
      ).run(id, interviewAt, archivedAt, createdAt, createdAt);
    // 11/1 00:30 JST = 10/31 15:30 UTC は 11 月。11/30 23:00 UTC = 12/1 JST は 12 月。
    applicant("a1", "2026-10-31T15:30:00.000Z", "2026-11-10T01:00:00.000Z");
    applicant("a2", "2026-11-30T23:00:00.000Z", null);
    applicant("a3", "2026-11-05T00:00:00.000Z", "2026-11-11T01:00:00.000Z", "2026-11-06T00:00:00.000Z");
    const hired = (id: string, applicantId: string, at: string) =>
      raw.prepare(
        `INSERT INTO member_hr_events (id, applicant_id, kind, to_stage, actor_id, created_at) VALUES (?, ?, 'stage', 'hired', 'usr', ?)`,
      ).run(id, applicantId, at);
    hired("e1", "a1", "2026-11-02T00:00:00.000Z");
    hired("e2", "a1", "2026-11-03T00:00:00.000Z");
    hired("e3", "a3", "2026-11-03T00:00:00.000Z");
    raw.prepare(
      `INSERT INTO member_sponsor_cards (id, org_id, version, created_by, created_at, updated_at) VALUES ('c1', 'org_x', 1, 'usr', ?, ?)`,
    ).run("2026-11-02T00:00:00.000Z", "2026-11-02T00:00:00.000Z");

    expect(await repo.countMonth("org_x", "2026-11")).toEqual({
      hr_applicants: 1, hr_interviews: 1, hr_hired: 1, sponsor_cards: 1, participations: 0,
    });
    expect((await repo.countMonth("org_x", "2026-12")).hr_applicants).toBe(1);
    expect((await repo.countMonth("org_y", "2026-11")).hr_applicants).toBe(0);
  });
});
