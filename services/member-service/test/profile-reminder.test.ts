// 情報が足りない本人への催促: 未入力の判定・送れない条件・失敗を隠さないこと。
import { describe, expect, it, vi } from "vitest";
import { member, type identity } from "@dub/types";
import { call, createApp, fakeAuthz, makeDeps } from "./harness";
import { buildProfileReminder, PROFILE_REMINDER_TYPE } from "../src/profileReminder";

const FULL = {
  lastName: "山田", firstName: "太郎",
  lastNameKana: "やまだ", firstNameKana: "たろう",
  lastNameRomaji: "Yamada", firstNameRomaji: "Taro",
  schoolEmail: "t@school.ac.jp", gmail: "t@gmail.com", phone: "090-1234-5678",
  grade: "3", department: "情報", rosterNumber: "3EP2-26", studentNumber: "1400980",
};

async function seed(app: ReturnType<typeof createApp>, fields: object, identityUserId: string | null): Promise<string> {
  const created = await call(app, "POST", "/members/people", { body: { status: "added", ...fields } });
  expect(created.status).toBe(201);
  if (identityUserId) {
    const linked = await call(app, "POST", `/members/people/${created.json.id}/identity-link`, {
      body: { identityUserId, version: created.json.version },
    });
    expect(linked.status).toBe(200);
  }
  return created.json.id;
}

describe("POST /members/people/:id/profile-reminder", () => {
  it("未入力の項目を本人へ通知する", async () => {
    const send = vi.fn().mockResolvedValue({ deduplicated: false });
    const app = createApp(makeDeps({ sendProfileReminder: send }));
    const { gmail: _gmail, phone: _phone, ...partial } = FULL;
    const id = await seed(app, partial, "user_x");
    const res = await call(app, "POST", `/members/people/${id}/profile-reminder`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ deduplicated: false, missing: ["gmail", "phone"] });
    expect(send.mock.calls[0]![1]).toMatchObject({ memberId: id, identityUserId: "user_x", missing: ["gmail", "phone"] });
  });

  it("アカウント未紐付け・未入力なしは送らない", async () => {
    const send = vi.fn();
    const app = createApp(makeDeps({ sendProfileReminder: send }));
    const unlinked = await seed(app, { lastName: "未", firstName: "紐付" }, null);
    const complete = await seed(app, FULL, "user_y");
    expect((await call(app, "POST", `/members/people/${unlinked}/profile-reminder`)).status).toBe(400);
    expect((await call(app, "POST", `/members/people/${complete}/profile-reminder`)).status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("辞退者には送らない", async () => {
    const send = vi.fn();
    const app = createApp(makeDeps({ sendProfileReminder: send }));
    const id = await seed(app, { lastName: "辞", firstName: "退", status: "declined" }, "user_d");
    expect((await call(app, "POST", `/members/people/${id}/profile-reminder`)).status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("1 日の区切りは日本時間", async () => {
    const send = vi.fn().mockResolvedValue({ deduplicated: false });
    const app = createApp(makeDeps({ sendProfileReminder: send, now: () => "2026-11-06T15:30:00.000Z" }));
    const id = await seed(app, { lastName: "時", firstName: "間" }, "user_t");
    await call(app, "POST", `/members/people/${id}/profile-reminder`);
    expect(send.mock.calls[0]![1].today).toBe("2026-11-07");
  });

  it("通知の失敗を成功として返さない", async () => {
    const app = createApp(makeDeps({ sendProfileReminder: vi.fn().mockRejectedValue(new Error("down")) }));
    const id = await seed(app, { lastName: "失", firstName: "敗" }, "user_z");
    expect((await call(app, "POST", `/members/people/${id}/profile-reminder`)).status).toBeGreaterThanOrEqual(500);
  });

  it("members の編集権限が無ければ 403", async () => {
    const deps = makeDeps({ sendProfileReminder: vi.fn() });
    const admin = createApp(deps);
    const id = await seed(admin, { lastName: "権", firstName: "限" }, "user_w");
    const viewer = createApp({ ...deps, authz: fakeAuthz(new Set<identity.PermissionKey>(["app:members:view"])) });
    expect((await call(viewer, "POST", `/members/people/${id}/profile-reminder`)).status).toBe(403);
  });
});

describe("buildProfileReminder", () => {
  it("本人宛・1 日 1 回の dedupKey・項目名入りの本文にする", () => {
    const req = buildProfileReminder({ memberId: "m1", identityUserId: "u1", missing: ["gmail"], today: "2026-11-06" });
    expect(req.type).toBe(PROFILE_REMINDER_TYPE);
    expect(req.recipientIds).toEqual(["u1"]);
    expect(req.dedupKey).toBe(`${PROFILE_REMINDER_TYPE}:m1:2026-11-06`);
    expect(req.body).toContain(member.PERSON_PROFILE_LABEL.gmail);
  });
});

describe("missingProfileKeys", () => {
  it("空白だけの値も未入力、任意項目は対象外", () => {
    expect(member.missingProfileKeys({ ...FULL, gmail: "  " } as Partial<member.PersonProfile>)).toEqual(["gmail"]);
  });
  it("姓名に分かれていない行は表示名があれば姓・名を未入力にしない", () => {
    const { lastName: _l, firstName: _f, ...rest } = FULL;
    expect(member.missingProfileKeys({ ...rest, name: "山田 太郎" } as Partial<member.PersonProfile>)).toEqual([]);
    expect(member.missingProfileKeys(rest as Partial<member.PersonProfile>)).toEqual(["lastName", "firstName"]);
  });
});
