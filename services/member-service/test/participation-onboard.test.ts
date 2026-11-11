// 参加届からのアカウント発行 (api-gateway onboard-account) が呼ぶ s2s の 2 本:
//   GET  /members/internal/participation/:id/onboard-target  対象の確認
//   POST /members/internal/participation/:id/onboard-link    再確認してから紐付け
// 対象 = 参加届に紐付いた追加済の名簿行で、まだアカウントの無い人だけ。
import { describe, it, expect } from "vitest";
import { createApp, makeDeps, call } from "./harness";

const EMAILS = { schoolEmail: "taro@school.ac.jp", gmail: "taro@gmail.com" };

async function addedParticipation(app: ReturnType<typeof createApp>): Promise<{ pid: string; memberId: string }> {
  const sub = await call(app, "POST", "/members/participation", { body: { lastName: "山田", firstName: "太郎", ...EMAILS } });
  const pid = sub.json.participation.id as string;
  const res = await call(app, "POST", `/members/participation/${pid}/resolve`, { body: { action: "create" } });
  return { pid, memberId: res.json.member.id as string };
}

const target = (app: ReturnType<typeof createApp>, pid: string) =>
  call(app, "GET", `/members/internal/participation/${pid}/onboard-target`, { internal: true });
const link = (app: ReturnType<typeof createApp>, pid: string, identityUserId: string) =>
  call(app, "POST", `/members/internal/participation/${pid}/onboard-link`, { internal: true, body: { identityUserId } });

describe("participation onboard (internal)", () => {
  it("target returns the participation and its unlinked member", async () => {
    const app = createApp(makeDeps());
    const { pid, memberId } = await addedParticipation(app);
    const res = await target(app, pid);
    expect(res.status).toBe(200);
    expect(res.json.participation.id).toBe(pid);
    expect(res.json.member).toMatchObject({ id: memberId, identityUserId: null, gmail: "taro@gmail.com" });
  });

  it("refuses a participation that is not added to the roster yet", async () => {
    const app = createApp(makeDeps());
    const sub = await call(app, "POST", "/members/participation", { body: { lastName: "山田", firstName: "太郎", ...EMAILS } });
    const res = await target(app, sub.json.participation.id);
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("MEMBER_ONBOARD_NOT_ADDED");
  });

  it("links once, is idempotent for the same account, and refuses a member that already has an account", async () => {
    const app = createApp(makeDeps());
    const { pid, memberId } = await addedParticipation(app);
    const first = await link(app, pid, "usr_new");
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ id: memberId, identityUserId: "usr_new" });
    // 再試行 (同じアカウント) は成功扱い
    expect((await link(app, pid, "usr_new")).status).toBe(200);
    // 既にアカウントがある人: 対象外・張り替え不可
    const t = await target(app, pid);
    expect(t.status).toBe(409);
    expect(t.json.error.code).toBe("MEMBER_ONBOARD_ALREADY_HAS_ACCOUNT");
    const other = await link(app, pid, "usr_other");
    expect(other.status).toBe(409);
    expect(other.json.error.code).toBe("MEMBER_ONBOARD_ALREADY_HAS_ACCOUNT");
  });

  it("is INTERNAL only (403 without the marker)", async () => {
    const app = createApp(makeDeps());
    const { pid } = await addedParticipation(app);
    expect((await call(app, "GET", `/members/internal/participation/${pid}/onboard-target`)).status).toBe(403);
    expect((await call(app, "POST", `/members/internal/participation/${pid}/onboard-link`, { body: { identityUserId: "x" } })).status).toBe(403);
  });
});
