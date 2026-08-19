// 参加届 → 管理者(admin) 通知: submit が通ると notifyParticipationSubmitted が
// 呼ばれること、通知が失敗しても提出は成功する(best-effort)こと、通知ペイロードが
// 管理者ロールへ in_app で飛ぶことを検証する。
import { describe, it, expect, vi } from "vitest";
import { createApp, makeDeps, call } from "./harness";
import { buildParticipationNotify, PARTICIPATION_NOTIFY_ROLE_IDS, PARTICIPATION_NOTIFY_TYPE } from "../src/participationNotify";
import type { member } from "@dub/types";

const EMAILS = { schoolEmail: "taro@school.ac.jp", gmail: "taro@gmail.com" };

describe("参加届 → 管理者通知の発火", () => {
  it("submit が成功すると notifyParticipationSubmitted が participation 付きで1回呼ばれる", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const app = createApp(makeDeps({ notifyParticipationSubmitted: notify }));
    const res = await call(app, "POST", "/members/participation", {
      body: { name: "通知太郎", ...EMAILS },
    });
    expect(res.status).toBe(201);
    expect(notify).toHaveBeenCalledTimes(1);
    const firstCall = notify.mock.calls[0]!;
    expect(firstCall[0]).toMatchObject({ requestId: "req_test", userId: "user_caller" });
    expect(firstCall[1].name).toBe("通知太郎");
    expect(firstCall[1].id).toBe(res.json.participation.id);
  });

  it("public (unauthenticated s2s) 提出でも管理者通知が飛ぶ", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const app = createApp(makeDeps({ notifyParticipationSubmitted: notify }));
    const res = await call(app, "POST", "/members/internal/participation", {
      userId: null,
      internal: true,
      body: { name: "公募花子", ...EMAILS },
    });
    expect(res.status).toBe(201);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("通知が throw しても提出は 201 で成功する (best-effort)", async () => {
    const notify = vi.fn().mockRejectedValue(new Error("notification-service down"));
    const app = createApp(makeDeps({ notifyParticipationSubmitted: notify }));
    const res = await call(app, "POST", "/members/participation", {
      body: { name: "堅牢次郎", ...EMAILS },
    });
    expect(res.status).toBe(201);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("notifier 未設定(binding 無し)でも提出は成功する", async () => {
    const app = createApp(makeDeps()); // no notifyParticipationSubmitted
    const res = await call(app, "POST", "/members/participation", {
      body: { name: "無通知三郎", ...EMAILS },
    });
    expect(res.status).toBe(201);
  });
});

describe("buildParticipationNotify のペイロード", () => {
  const p = {
    id: "part_000001",
    name: "山田 太郎",
    grade: "2",
    department: "情報工学科",
    desiredActivity: "dev",
    schoolEmail: "yamada@school.ac.jp",
    gmail: "yamada@gmail.com",
    phone: "090-1234-5678",
  } as unknown as member.Participation;

  it("管理者ロールへ in_app・admin向けの通知を作る", () => {
    const req = buildParticipationNotify(p);
    expect(req.type).toBe(PARTICIPATION_NOTIFY_TYPE);
    expect(req.recipientRoles).toEqual([...PARTICIPATION_NOTIFY_ROLE_IDS]);
    expect(req.recipientIds).toEqual([]);
    expect(req.channels).toEqual(["in_app"]);
    expect(req.title).toContain("山田 太郎");
    expect(req.resourceType).toBe("participation");
    expect(req.resourceId).toBe("part_000001");
    expect(req.dedupKey).toBe("participation:part_000001");
    expect(req.body).toContain("yamada@school.ac.jp");
    expect(req.body).toContain("yamada@gmail.com");
  });
});
