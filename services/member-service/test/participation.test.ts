// 参加届 (participation) HTTP surface: submit self-registers/promotes onto the roster,
// admin lists submissions. Drives the real Hono app over the in-memory repo.
import { describe, it, expect } from "vitest";
import { createApp, makeDeps, fakeAuthz, call } from "./harness";
import { normalizeName } from "../src/domain";
import type { identity } from "@dub/types";

describe("member-service 参加届 (participation)", () => {
  it("submit is open to any authenticated user but 401 without a user", async () => {
    const app = createApp(makeDeps());
    const anon = await call(app, "POST", "/members/participation", { userId: null, body: { name: "田中一郎" } });
    expect(anon.status).toBe(401);
  });

  it("admin list requires identity:read", async () => {
    const app = createApp(makeDeps({ authz: fakeAuthz(new Set<identity.PermissionKey>()) }));
    const res = await call(app, "GET", "/members/participation");
    expect(res.status).toBe(403);
  });

  it("no roster match -> creates a new 追加済 member from the submission", async () => {
    const app = createApp(makeDeps());
    const t = await call(app, "POST", "/members/teams", { body: { name: "開発" } });
    const teamId = t.json.id as string;

    const res = await call(app, "POST", "/members/participation", {
      body: {
        name: "新規太郎",
        nameKana: "シンキタロウ",
        grade: "2",
        department: "情報工学科",
        contact: "shinki@example.com",
        desiredTeamId: teamId,
        desiredActivity: "dev",
        note: "よろしく",
      },
    });
    expect(res.status).toBe(201);
    expect(res.json.matchKind).toBe("created_new");
    expect(res.json.member.status).toBe("added");
    expect(res.json.member.teamIds).toEqual([teamId]);
    expect(res.json.member.contact).toBe("shinki@example.com");
    expect(res.json.participation.desiredActivity).toBe("dev");

    // reflected on the roster overview
    const ov = await call(app, "GET", "/members/overview");
    expect(ov.json.members).toHaveLength(1);
    expect(ov.json.members[0].name).toBe("新規太郎");
  });

  it("name match promotes an 招待中 member to 追加済 and merges the desired team (non-destructive contact)", async () => {
    const app = createApp(makeDeps());
    const t = await call(app, "POST", "/members/teams", { body: { name: "会場" } });
    const teamId = t.json.id as string;

    // pre-existing invited member with an existing contact
    const invited = await call(app, "POST", "/members/people", {
      body: { name: "山田 花子", status: "invited", teamIds: [], contact: "existing@example.com" },
    });
    const memberId = invited.json.id as string;
    expect(invited.json.status).toBe("invited");

    // submit with a whitespace-variant name (表記ゆれ) + a new contact
    const res = await call(app, "POST", "/members/participation", {
      body: { name: "山田花子", desiredTeamId: teamId, contact: "new@example.com" },
    });
    expect(res.status).toBe(201);
    expect(res.json.matchKind).toBe("linked_existing");
    expect(res.json.member.id).toBe(memberId);
    expect(res.json.member.status).toBe("added"); // promoted
    expect(res.json.member.teamIds).toEqual([teamId]); // desired team merged in
    expect(res.json.member.contact).toBe("existing@example.com"); // NOT overwritten

    // no duplicate member created
    const ov = await call(app, "GET", "/members/overview");
    expect(ov.json.members).toHaveLength(1);
  });

  it("resubmission is idempotent: dedupes the 参加届 and does not duplicate the member", async () => {
    const app = createApp(makeDeps());
    const first = await call(app, "POST", "/members/participation", { body: { name: "重複太郎", contact: "a@x.com" } });
    expect(first.json.matchKind).toBe("created_new");
    const second = await call(app, "POST", "/members/participation", { body: { name: "重複　太郎", note: "再提出" } });
    expect(second.status).toBe(201);
    expect(second.json.matchKind).toBe("linked_existing"); // now the member exists

    const list = await call(app, "GET", "/members/participation");
    expect(list.json.participations).toHaveLength(1); // deduped by normalized name
    const ov = await call(app, "GET", "/members/overview");
    expect(ov.json.members).toHaveLength(1);
  });

  it("rejects an empty name, invalid grade/activity, and unknown desiredTeamId", async () => {
    const app = createApp(makeDeps());
    expect((await call(app, "POST", "/members/participation", { body: { name: "  " } })).status).toBe(400);
    expect((await call(app, "POST", "/members/participation", { body: { name: "A", grade: "5" } })).status).toBe(400);
    expect((await call(app, "POST", "/members/participation", { body: { name: "A", desiredActivity: "x" } })).status).toBe(400);
    expect(
      (await call(app, "POST", "/members/participation", { body: { name: "A", desiredTeamId: "team_missing" } })).status,
    ).toBe(404);
  });

  it("normalizeName folds width and whitespace variants", () => {
    expect(normalizeName("山田 太郎")).toBe(normalizeName("山田　太郎"));
    expect(normalizeName("Ｙａｍａｄａ")).toBe(normalizeName("yamada"));
    expect(normalizeName("  A B ")).toBe("ab");
  });
});
