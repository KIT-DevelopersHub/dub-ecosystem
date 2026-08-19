// 参加届 (participation) HTTP surface (B案): submit は 参加届 を記録するだけで名簿へは
// 反映しない (reviewState="pending")。名簿への反映は管理者が /resolve で確定する
// (link=既存の招待中を昇格・結合 / create=新規作成 / skip=対象外)。突合候補は
// /candidates (招待中・検討中を氏名/メール一致で提示)。Drives the real Hono app over
// the in-memory repo.
import { describe, it, expect } from "vitest";
import { createApp, makeDeps, fakeAuthz, call } from "./harness";
import { normalizeName } from "../src/domain";
import type { identity } from "@dub/types";

// Every submit needs the two required emails; spread this into each body.
const EMAILS = { schoolEmail: "taro@school.ac.jp", gmail: "taro@gmail.com" };

describe("member-service 参加届 (participation)", () => {
  it("submit is open to any authenticated user but 401 without a user", async () => {
    const app = createApp(makeDeps());
    const anon = await call(app, "POST", "/members/participation", {
      userId: null,
      body: { name: "田中一郎", ...EMAILS },
    });
    expect(anon.status).toBe(401);
  });

  it("admin list requires identity:read", async () => {
    const app = createApp(makeDeps({ authz: fakeAuthz(new Set<identity.PermissionKey>()) }));
    const res = await call(app, "GET", "/members/participation");
    expect(res.status).toBe(403);
  });

  it("submit records the 参加届 as pending and does NOT reflect onto the roster", async () => {
    const app = createApp(makeDeps());
    const t = await call(app, "POST", "/members/teams", { body: { name: "開発" } });
    const teamId = t.json.id as string;

    const res = await call(app, "POST", "/members/participation", {
      body: {
        name: "新規太郎",
        nameKana: "シンキタロウ",
        grade: "2",
        department: "情報工学科",
        schoolEmail: "shinki@school.ac.jp",
        gmail: "shinki@gmail.com",
        desiredTeamId: teamId,
        desiredActivity: "dev",
        note: "よろしく",
      },
    });
    expect(res.status).toBe(201);
    // 未処理: 名簿には未反映 (member echo は null)。
    expect(res.json.participation.reviewState).toBe("pending");
    expect(res.json.participation.memberId).toBeNull();
    expect(res.json.member).toBeNull();
    // both addresses retained on the participation
    expect(res.json.participation.schoolEmail).toBe("shinki@school.ac.jp");
    expect(res.json.participation.gmail).toBe("shinki@gmail.com");
    expect(res.json.participation.desiredActivity).toBe("dev");

    // roster overview は空のまま (自動追加しない)
    const ov = await call(app, "GET", "/members/overview");
    expect(ov.json.members).toHaveLength(0);
  });

  it("composes 姓/名 into name + nameKana + nameRomaji, retains the split fields and phone", async () => {
    const app = createApp(makeDeps());
    const res = await call(app, "POST", "/members/participation", {
      body: {
        lastName: "山田",
        firstName: "太郎",
        lastNameKana: "やまだ",
        firstNameKana: "たろう",
        lastNameRomaji: "Yamada",
        firstNameRomaji: "Taro",
        phone: "090-1234-5678",
        ...EMAILS,
      },
    });
    expect(res.status).toBe(201);
    // legacy composed fields kept in sync ("姓 名") for backward-compatible readers
    expect(res.json.participation.name).toBe("山田 太郎");
    expect(res.json.participation.nameKana).toBe("やまだ たろう");
    // ローマ字 also composed "Last First" for the alphabet email 発行 candidate
    expect(res.json.participation.nameRomaji).toBe("Yamada Taro");
    // structured split fields + phone are retained on the 参加届
    expect(res.json.participation.lastName).toBe("山田");
    expect(res.json.participation.firstName).toBe("太郎");
    expect(res.json.participation.lastNameKana).toBe("やまだ");
    expect(res.json.participation.firstNameKana).toBe("たろう");
    expect(res.json.participation.lastNameRomaji).toBe("Yamada");
    expect(res.json.participation.firstNameRomaji).toBe("Taro");
    expect(res.json.participation.phone).toBe("090-1234-5678");
  });

  it("rejects a non-alphabet ローマ字 (英字のみ)", async () => {
    const app = createApp(makeDeps());
    const res = await call(app, "POST", "/members/participation", {
      body: { lastName: "山田", firstName: "太郎", lastNameRomaji: "やまだ", ...EMAILS },
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects a malformed phone number", async () => {
    const app = createApp(makeDeps());
    const res = await call(app, "POST", "/members/participation", {
      body: { lastName: "山田", firstName: "太郎", phone: "not-a-phone", ...EMAILS },
    });
    expect(res.status).toBe(400);
  });

  it("resolve create -> makes a new 追加済 member from the submission, retaining both emails", async () => {
    const app = createApp(makeDeps());
    const t = await call(app, "POST", "/members/teams", { body: { name: "開発" } });
    const teamId = t.json.id as string;
    const sub = await call(app, "POST", "/members/participation", {
      body: { name: "新規太郎", schoolEmail: "shinki@school.ac.jp", gmail: "shinki@gmail.com", desiredTeamId: teamId },
    });
    const pid = sub.json.participation.id as string;

    const res = await call(app, "POST", `/members/participation/${pid}/resolve`, { body: { action: "create" } });
    expect(res.status).toBe(200);
    expect(res.json.participation.reviewState).toBe("added");
    expect(res.json.participation.matchKind).toBe("created_new");
    expect(res.json.member.status).toBe("added");
    expect(res.json.member.teamIds).toEqual([teamId]);
    expect(res.json.member.schoolEmail).toBe("shinki@school.ac.jp");
    expect(res.json.member.gmail).toBe("shinki@gmail.com");
    expect(res.json.member.contact).toBe("shinki@school.ac.jp");

    const ov = await call(app, "GET", "/members/overview");
    expect(ov.json.members).toHaveLength(1);
    expect(ov.json.members[0].name).toBe("新規太郎");
  });

  it("candidates lists an 招待中 name match; resolve link promotes it, merges team, fills emails, no duplicate", async () => {
    const app = createApp(makeDeps());
    const t = await call(app, "POST", "/members/teams", { body: { name: "会場" } });
    const teamId = t.json.id as string;

    // pre-existing invited member with an existing contact, no emails yet
    const invited = await call(app, "POST", "/members/people", {
      body: { name: "山田 花子", status: "invited", teamIds: [], contact: "existing@example.com" },
    });
    const memberId = invited.json.id as string;
    const version = invited.json.version as number;

    // submit with a whitespace-variant name (表記ゆれ) + the two emails
    const sub = await call(app, "POST", "/members/participation", {
      body: { name: "山田花子", desiredTeamId: teamId, schoolEmail: "hanako@school.ac.jp", gmail: "hanako@gmail.com" },
    });
    const pid = sub.json.participation.id as string;
    expect(sub.json.participation.reviewState).toBe("pending");

    // candidates surfaces the invited member (name-normalized match)
    const cands = await call(app, "GET", `/members/participation/${pid}/candidates`);
    expect(cands.status).toBe(200);
    expect(cands.json.candidates).toHaveLength(1);
    expect(cands.json.candidates[0].memberId).toBe(memberId);
    expect(cands.json.candidates[0].matchedBy).toContain("name");

    // resolve link -> promote + merge (optimistic lock via version)
    const res = await call(app, "POST", `/members/participation/${pid}/resolve`, {
      body: { action: "link", memberId, expectedVersion: version },
    });
    expect(res.status).toBe(200);
    expect(res.json.participation.matchKind).toBe("linked_existing");
    expect(res.json.participation.reviewState).toBe("added");
    expect(res.json.member.id).toBe(memberId);
    expect(res.json.member.status).toBe("added"); // promoted
    expect(res.json.member.teamIds).toEqual([teamId]); // desired team merged in
    expect(res.json.member.contact).toBe("existing@example.com"); // NOT overwritten
    expect(res.json.member.schoolEmail).toBe("hanako@school.ac.jp"); // filled from submission
    expect(res.json.member.gmail).toBe("hanako@gmail.com");

    // no duplicate member created (only the promoted one)
    const ov = await call(app, "GET", "/members/overview");
    expect(ov.json.members).toHaveLength(1);
  });

  it("candidates excludes 追加済 members (only 招待中/検討中 are join targets)", async () => {
    const app = createApp(makeDeps());
    await call(app, "POST", "/members/people", { body: { name: "既存 太郎", status: "added", teamIds: [] } });
    const sub = await call(app, "POST", "/members/participation", { body: { name: "既存太郎", ...EMAILS } });
    const pid = sub.json.participation.id as string;
    const cands = await call(app, "GET", `/members/participation/${pid}/candidates`);
    expect(cands.json.candidates).toHaveLength(0);
  });

  it("resolve skip -> marks the 参加届 対象外, no roster write", async () => {
    const app = createApp(makeDeps());
    const sub = await call(app, "POST", "/members/participation", { body: { name: "見送太郎", ...EMAILS } });
    const pid = sub.json.participation.id as string;
    const res = await call(app, "POST", `/members/participation/${pid}/resolve`, { body: { action: "skip" } });
    expect(res.status).toBe(200);
    expect(res.json.participation.reviewState).toBe("skipped");
    expect(res.json.member).toBeNull();
    const ov = await call(app, "GET", "/members/overview");
    expect(ov.json.members).toHaveLength(0);
  });

  it("resolve requires identity:admin", async () => {
    const app = createApp(makeDeps({ authz: fakeAuthz(new Set<identity.PermissionKey>(["identity:read"])) }));
    const res = await call(app, "POST", "/members/participation/part_x/resolve", { body: { action: "create" } });
    expect(res.status).toBe(403);
  });

  it("resolve 404s for an unknown participation id", async () => {
    const app = createApp(makeDeps());
    const res = await call(app, "POST", "/members/participation/part_missing/resolve", { body: { action: "create" } });
    expect(res.status).toBe(404);
  });

  it("resubmission is idempotent: dedupes the 参加届 and preserves its review state", async () => {
    const app = createApp(makeDeps());
    const first = await call(app, "POST", "/members/participation", { body: { name: "重複太郎", ...EMAILS } });
    expect(first.json.participation.reviewState).toBe("pending");
    const second = await call(app, "POST", "/members/participation", {
      body: { name: "重複　太郎", note: "再提出", ...EMAILS },
    });
    expect(second.status).toBe(201);
    expect(second.json.participation.reviewState).toBe("pending");

    const list = await call(app, "GET", "/members/participation");
    expect(list.json.participations).toHaveLength(1); // deduped by normalized name
    const ov = await call(app, "GET", "/members/overview");
    expect(ov.json.members).toHaveLength(0); // still not reflected
  });

  it("rejects empty name, missing/invalid emails, invalid grade/activity, and unknown desiredTeamId", async () => {
    const app = createApp(makeDeps());
    // empty name
    expect((await call(app, "POST", "/members/participation", { body: { name: "  ", ...EMAILS } })).status).toBe(400);
    // both emails required
    expect((await call(app, "POST", "/members/participation", { body: { name: "A" } })).status).toBe(400);
    expect((await call(app, "POST", "/members/participation", { body: { name: "A", schoolEmail: "s@x.jp" } })).status).toBe(400);
    // email format
    expect(
      (await call(app, "POST", "/members/participation", { body: { name: "A", schoolEmail: "not-an-email", gmail: "g@x.com" } })).status,
    ).toBe(400);
    expect(
      (await call(app, "POST", "/members/participation", { body: { name: "A", schoolEmail: "s@x.jp", gmail: "bad" } })).status,
    ).toBe(400);
    // invalid grade / activity / unknown team
    expect((await call(app, "POST", "/members/participation", { body: { name: "A", grade: "5", ...EMAILS } })).status).toBe(400);
    expect((await call(app, "POST", "/members/participation", { body: { name: "A", desiredActivity: "x", ...EMAILS } })).status).toBe(400);
    expect(
      (await call(app, "POST", "/members/participation", { body: { name: "A", desiredTeamId: "team_missing", ...EMAILS } })).status,
    ).toBe(404);
  });

  describe("public internal route (POST /members/internal/participation)", () => {
    it("404s without the x-dub-internal marker (never exposed externally)", async () => {
      const app = createApp(makeDeps());
      const res = await call(app, "POST", "/members/internal/participation", { body: { name: "外部太郎", ...EMAILS } });
      expect(res.status).toBe(404);
    });

    it("accepts an unauthenticated s2s submission (system actor), records it pending without reflecting", async () => {
      const app = createApp(makeDeps());
      // no x-dub-user-id (unauthenticated participant), but a genuine internal call
      const res = await call(app, "POST", "/members/internal/participation", {
        userId: null,
        internal: true,
        body: { name: "公開花子", schoolEmail: "koukai@school.ac.jp", gmail: "koukai@gmail.com", desiredActivity: "event" },
      });
      expect(res.status).toBe(201);
      expect(res.json.participation.reviewState).toBe("pending");
      expect(res.json.member).toBeNull();
      expect(res.json.participation.submittedBy).toBe("system:public-participation");

      const ov = await call(app, "GET", "/members/overview");
      expect(ov.json.members).toHaveLength(0);
    });

    it("still validates: missing emails -> 400 even on the internal route", async () => {
      const app = createApp(makeDeps());
      const res = await call(app, "POST", "/members/internal/participation", {
        internal: true,
        body: { name: "無メール" },
      });
      expect(res.status).toBe(400);
    });
  });

  it("normalizeName folds width and whitespace variants", () => {
    expect(normalizeName("山田 太郎")).toBe(normalizeName("山田　太郎"));
    expect(normalizeName("Ｙａｍａｄａ")).toBe(normalizeName("yamada"));
    expect(normalizeName("  A B ")).toBe("ab");
  });
});
