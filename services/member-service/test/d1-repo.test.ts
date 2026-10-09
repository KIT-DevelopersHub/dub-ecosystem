// 運営名簿と参加届の人物項目 (PersonProfile) が DB の書き込み・読み込みで欠けないことを守る。
// 項目を型に足したのに SQL を直し忘れると、ここが落ちる。
import { describe, expect, it } from "vitest";
import { member } from "@dub/types";
import type { DbClient } from "@dub/db";
import { PERSON_PROFILE_COLUMN, createD1MemberRepo } from "../src/d1-repo";
import type { ParticipationRow, PersonRow } from "../src/types";

/** 項目ごとに見分けのつく値 (学年・希望活動は選択肢の値)。 */
function sentinelProfile(): member.PersonProfile {
  const p = member.emptyPersonProfile() as unknown as Record<string, unknown>;
  for (const k of member.PERSON_PROFILE_KEYS) p[k] = `v_${k}`;
  p.grade = "3";
  p.desiredActivity = "dev";
  return p as unknown as member.PersonProfile;
}

function recordingDb(firstRow: Record<string, unknown> | null = null) {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const result = { success: true, meta: { changes: 1, durationMs: 0 } };
  const db = {
    namespace: "member",
    first: async (sql: string, ...binds: unknown[]) => (calls.push({ sql, binds }), firstRow),
    all: async (sql: string, ...binds: unknown[]) => (calls.push({ sql, binds }), firstRow ? [firstRow] : []),
    run: async (sql: string, ...binds: unknown[]) => (calls.push({ sql, binds }), result),
    batch: async () => [result],
  } as unknown as DbClient;
  return { db, calls };
}

const base = { id: "x", orgId: "o", name: "n", version: 1, createdAt: "t", updatedAt: "t" };
const person = (): PersonRow => ({
  ...base, ...sentinelProfile(), roleTitle: null, status: "added", identityUserId: null, leaderId: null,
  contact: null, sortOrder: 1, archivedAt: null, createdBy: "u",
});
const participation = (): ParticipationRow => ({
  ...base, ...sentinelProfile(), schoolEmail: "v_schoolEmail", gmail: "v_gmail", memberId: null, normalizedName: "n",
  nameKana: null, nameRomaji: null, contact: null, desiredTeamId: null, status: "submitted", matchKind: "created_new",
  reviewState: "pending", submittedBy: "u", submittedAt: "t",
});

function expectAllProfileWritten(call: { sql: string; binds: unknown[] }, p: member.PersonProfile) {
  for (const k of member.PERSON_PROFILE_KEYS) {
    expect(call.sql, `${k} column`).toContain(PERSON_PROFILE_COLUMN[k]);
    expect(call.binds, `${k} value`).toContain(p[k]);
  }
}

describe("d1-repo: PersonProfile の全項目を保存・読み込みする", () => {
  it("member_people の INSERT / UPDATE", async () => {
    const { db, calls } = recordingDb();
    const repo = createD1MemberRepo(db);
    await repo.createPerson(person(), []);
    expectAllProfileWritten(calls.find((c) => c.sql.includes("INSERT INTO member_people"))!, person());
    await repo.updatePerson(person(), 1);
    expectAllProfileWritten(calls.find((c) => c.sql.includes("UPDATE member_people"))!, person());
  });

  it("member_participations の UPSERT (更新側も全列)", async () => {
    const { db, calls } = recordingDb();
    await createD1MemberRepo(db).upsertParticipation(participation());
    const call = calls.find((c) => c.sql.includes("INSERT INTO member_participations"))!;
    expectAllProfileWritten(call, participation());
    const onConflict = call.sql.slice(call.sql.indexOf("ON CONFLICT"));
    for (const k of member.PERSON_PROFILE_KEYS) expect(onConflict, k).toContain(`${PERSON_PROFILE_COLUMN[k]} = excluded.`);
  });

  it("読み込みで全項目が行に戻る", async () => {
    const p = sentinelProfile();
    const dbRow: Record<string, unknown> = {
      id: "x", org_id: "o", name: "n", normalized_name: "n", status: "added", version: 1, sort_order: 1,
      created_at: "t", updated_at: "t", created_by: "u", submitted_by: "u", submitted_at: "t", match_kind: "created_new",
    };
    for (const k of member.PERSON_PROFILE_KEYS) dbRow[PERSON_PROFILE_COLUMN[k]] = p[k];
    const repo = createD1MemberRepo(recordingDb(dbRow).db);
    const got = await repo.getPerson("x");
    const gotPart = await repo.getParticipation("x");
    for (const k of member.PERSON_PROFILE_KEYS) {
      expect(got?.[k], `person ${k}`).toBe(p[k]);
      expect(gotPart?.[k], `participation ${k}`).toBe(p[k]);
    }
  });
});
