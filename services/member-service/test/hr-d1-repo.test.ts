// 人事 D1 リポジトリ: INSERT の列とバインド数が揃い、書いた行がそのまま読み戻せることを守る。
import { describe, expect, it } from "vitest";
import type { DbClient } from "@dub/db";
import { createD1HrRepo, type ApplicantRow } from "../src/hr-repo";

const row: ApplicantRow = {
  id: "app_1", orgId: "org_x", name: "山本 花", nameKana: "やまもと はな", email: "h@example.com",
  department: "情報工学科", grade: "2年", desiredTeamId: "team_dev", source: "紹介", motivation: "やりたい",
  stage: "interview", memberId: null, participationId: "part_1", version: 3, archivedAt: null,
  createdBy: "usr_1", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z",
};

describe("createD1HrRepo", () => {
  it("round-trips an applicant through INSERT columns and SELECT mapping", async () => {
    let stored: Record<string, unknown> | null = null;
    const db = {
      namespace: "member",
      run: async (sql: string, ...binds: unknown[]) => {
        const cols = /\(([^)]*)\)\s*VALUES/s.exec(sql)![1]!.split(",").map((c) => c.trim());
        expect((sql.match(/\?/g) ?? []).length).toBe(cols.length);
        expect(binds).toHaveLength(cols.length);
        stored = Object.fromEntries(cols.map((c, i) => [c, binds[i]]));
        return { success: true, meta: { changes: 1, durationMs: 0 } };
      },
      first: async () => stored,
      all: async () => (stored ? [stored] : []),
      batch: async () => [],
    } as unknown as DbClient;
    const repo = createD1HrRepo(db);
    await repo.createApplicant(row);
    expect(await repo.getApplicant("app_1")).toEqual(row);
    expect(await repo.listApplicants("org_x")).toEqual([row]);
  });
});
