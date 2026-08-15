// 参加届 (participation) HTTP surface: submit self-registers/promotes onto the roster,
// carrying the two required emails (学校 + Gmail) onto both the submission and the
// resolved 運営メンバー; admin lists submissions; and the public internal route accepts
// unauthenticated (s2s) submissions with a system actor. Drives the real Hono app over
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

  it("no roster match -> creates a new 追加済 member, retaining both emails", async () => {
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
    expect(res.json.matchKind).toBe("created_new");
    expect(res.json.member.status).toBe("added");
    expect(res.json.member.teamIds).toEqual([teamId]);
    // both addresses retained on the participation + the roster member
    expect(res.json.participation.schoolEmail).toBe("shinki@school.ac.jp");
    expect(res.json.participation.gmail).toBe("shinki@gmail.com");
    expect(res.json.member.schoolEmail).toBe("shinki@school.ac.jp");
    expect(res.json.member.gmail).toBe("shinki@gmail.com");
    // contact defaults to the school address when none was supplied
    expect(res.json.member.contact).toBe("shinki@school.ac.jp");
    expect(res.json.participation.desiredActivity).toBe("dev");

    // reflected on the roster overview
    const ov = await call(app, "GET", "/members/overview");
    expect(ov.json.members).toHaveLength(1);
    expect(ov.json.members[0].name).toBe("新規太郎");
    expect(ov.json.members[0].gmail).toBe("shinki@gmail.com");
  });

  it("name match promotes an 招待中 member to 追加済, merges the team, fills emails non-destructively", async () => {
    const app = createApp(makeDeps());
    const t = await call(app, "POST", "/members/teams", { body: { name: "会場" } });
    const teamId = t.json.id as string;

    // pre-existing invited member with an existing contact
    const invited = await call(app, "POST", "/members/people", {
      body: { name: "山田 花子", status: "invited", teamIds: [], contact: "existing@example.com" },
    });
    const memberId = invited.json.id as string;
    expect(invited.json.status).toBe("invited");

    // submit with a whitespace-variant name (表記ゆれ) + the two emails
    const res = await call(app, "POST", "/members/participation", {
      body: { name: "山田花子", desiredTeamId: teamId, schoolEmail: "hanako@school.ac.jp", gmail: "hanako@gmail.com" },
    });
    expect(res.status).toBe(201);
    expect(res.json.matchKind).toBe("linked_existing");
    expect(res.json.member.id).toBe(memberId);
    expect(res.json.member.status).toBe("added"); // promoted
    expect(res.json.member.teamIds).toEqual([teamId]); // desired team merged in
    expect(res.json.member.contact).toBe("existing@example.com"); // NOT overwritten
    // emails were empty on the invited member -> filled from the submission
    expect(res.json.member.schoolEmail).toBe("hanako@school.ac.jp");
    expect(res.json.member.gmail).toBe("hanako@gmail.com");

    // no duplicate member created
    const ov = await call(app, "GET", "/members/overview");
    expect(ov.json.members).toHaveLength(1);
  });

  it("resubmission is idempotent: dedupes the 参加届 and does not duplicate the member", async () => {
    const app = createApp(makeDeps());
    const first = await call(app, "POST", "/members/participation", { body: { name: "重複太郎", ...EMAILS } });
    expect(first.json.matchKind).toBe("created_new");
    const second = await call(app, "POST", "/members/participation", {
      body: { name: "重複　太郎", note: "再提出", ...EMAILS },
    });
    expect(second.status).toBe(201);
    expect(second.json.matchKind).toBe("linked_existing"); // now the member exists

    const list = await call(app, "GET", "/members/participation");
    expect(list.json.participations).toHaveLength(1); // deduped by normalized name
    const ov = await call(app, "GET", "/members/overview");
    expect(ov.json.members).toHaveLength(1);
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

    it("accepts an unauthenticated s2s submission (system actor) and reflects onto the roster", async () => {
      const app = createApp(makeDeps());
      // no x-dub-user-id (unauthenticated participant), but a genuine internal call
      const res = await call(app, "POST", "/members/internal/participation", {
        userId: null,
        internal: true,
        body: { name: "公開花子", schoolEmail: "koukai@school.ac.jp", gmail: "koukai@gmail.com", desiredActivity: "event" },
      });
      expect(res.status).toBe(201);
      expect(res.json.matchKind).toBe("created_new");
      expect(res.json.member.schoolEmail).toBe("koukai@school.ac.jp");
      expect(res.json.member.gmail).toBe("koukai@gmail.com");
      expect(res.json.participation.submittedBy).toBe("system:public-participation");

      const ov = await call(app, "GET", "/members/overview");
      expect(ov.json.members).toHaveLength(1);
      expect(ov.json.members[0].name).toBe("公開花子");
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
