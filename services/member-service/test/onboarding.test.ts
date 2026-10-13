// オンボーディング案内: 管理 CRUD + 並び替え + 公開用 internal 読み取り。
import { describe, it, expect } from "vitest";
import type { identity } from "@dub/types";
import { policy } from "@dub/types";
import { call, createApp, fakeAuthz, makeDeps } from "./harness";

const viewOnly = (): Set<identity.PermissionKey> =>
  new Set<identity.PermissionKey>(policy.keysForAppLevel("participation", "view"));

async function seed(app: ReturnType<typeof createApp>, titles: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const title of titles) {
    const res = await call(app, "POST", "/members/onboarding", { body: { title } });
    expect(res.status).toBe(201);
    ids.push(res.json.id);
  }
  return ids;
}

describe("onboarding items", () => {
  it("creates items in append order and lists them", async () => {
    const app = createApp(makeDeps());
    const created = await call(app, "POST", "/members/onboarding", {
      body: { title: "  Discord に参加  ", description: "招待リンクから", url: "https://discord.gg/abc" },
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ title: "Discord に参加", description: "招待リンクから", url: "https://discord.gg/abc" });
    await seed(app, ["参加届を出す"]);

    const list = await call(app, "GET", "/members/onboarding");
    expect(list.status).toBe(200);
    expect(list.json.items.map((i: { title: string }) => i.title)).toEqual(["Discord に参加", "参加届を出す"]);
  });

  it("rejects a missing title and non-http urls (no javascript: on the public page)", async () => {
    const app = createApp(makeDeps());
    expect((await call(app, "POST", "/members/onboarding", { body: { title: " " } })).status).toBe(400);
    for (const url of ["javascript:alert(1)", "data:text/html,x", "not a url"]) {
      const res = await call(app, "POST", "/members/onboarding", { body: { title: "x", url } });
      expect(res.status, url).toBe(400);
      expect(JSON.stringify(res.json.error)).toContain("url");
    }
  });

  it("partially updates and clears fields with null / empty string", async () => {
    const app = createApp(makeDeps());
    const [id] = await seed(app, ["Slack"]);
    const set = await call(app, "PATCH", `/members/onboarding/${id}`, {
      body: { description: "説明", url: "https://example.com" },
    });
    expect(set.json).toMatchObject({ title: "Slack", description: "説明", url: "https://example.com" });
    const cleared = await call(app, "PATCH", `/members/onboarding/${id}`, { body: { description: "", url: null } });
    expect(cleared.json).toMatchObject({ title: "Slack", description: null, url: null });
    expect((await call(app, "PATCH", "/members/onboarding/onb_missing", { body: { title: "x" } })).status).toBe(404);
  });

  it("deletes an item", async () => {
    const app = createApp(makeDeps());
    const [a, b] = await seed(app, ["A", "B"]);
    expect((await call(app, "DELETE", `/members/onboarding/${a}`)).status).toBe(200);
    const list = await call(app, "GET", "/members/onboarding");
    expect(list.json.items.map((i: { id: string }) => i.id)).toEqual([b]);
    expect((await call(app, "DELETE", `/members/onboarding/${a}`)).status).toBe(404);
  });

  it("reorders with a full permutation and rejects stale or partial ones", async () => {
    const app = createApp(makeDeps());
    const [a, b, c] = await seed(app, ["A", "B", "C"]);
    const res = await call(app, "POST", "/members/onboarding/reorder", { body: { ids: [c, a, b] } });
    expect(res.status).toBe(200);
    expect(res.json.items.map((i: { title: string }) => i.title)).toEqual(["C", "A", "B"]);

    for (const ids of [[a, b], [a, a, b], [a, b, "onb_x"], "nope"]) {
      expect((await call(app, "POST", "/members/onboarding/reorder", { body: { ids } })).status).toBe(400);
    }
    // a new item after a reorder still lands at the end
    await seed(app, ["D"]);
    const list = await call(app, "GET", "/members/onboarding");
    expect(list.json.items.map((i: { title: string }) => i.title)).toEqual(["C", "A", "B", "D"]);
  });

  it("serves the same list on the internal (public page) route without a user", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    await seed(app, ["A"]);
    const res = await call(app, "GET", "/members/internal/onboarding", { userId: null, internal: true });
    expect(res.status).toBe(200);
    expect(res.json.items.map((i: { title: string }) => i.title)).toEqual(["A"]);
    // never from outside without the s2s marker
    expect((await call(app, "GET", "/members/internal/onboarding", { userId: null })).status).toBe(403);
  });

  it("参加届 閲覧 can read the list but not change it", async () => {
    const deps = makeDeps();
    await seed(createApp(deps), ["A"]);
    const app = createApp({ ...deps, authz: fakeAuthz(viewOnly()) });
    expect((await call(app, "GET", "/members/onboarding")).status).toBe(200);
    expect((await call(app, "POST", "/members/onboarding", { body: { title: "x" } })).status).toBe(403);
  });
});

describe("onboarding meetings", () => {
  async function team(app: ReturnType<typeof createApp>, name: string, key: string): Promise<string> {
    const res = await call(app, "POST", "/members/teams", { body: { name, key } });
    expect(res.status).toBe(201);
    return res.json.id;
  }

  it("saves the 全体 and per-team meetings, lists teams, and clears with an empty schedule", async () => {
    const app = createApp(makeDeps());
    const pr = await team(app, "広報チーム", "pr");
    const dev = await team(app, "開発チーム", "dev");

    const all = await call(app, "PUT", "/members/onboarding/meetings", {
      body: { teamId: null, schedule: " 10/20(火) 19:00〜 ", url: "https://meet.google.com/abc-defg-hij" },
    });
    expect(all.status).toBe(200);
    await call(app, "PUT", "/members/onboarding/meetings", { body: { teamId: dev, schedule: "毎週水曜 20:00〜" } });
    // overwrite, not append
    await call(app, "PUT", "/members/onboarding/meetings", { body: { teamId: dev, schedule: "毎週木曜 20:00〜", url: null } });

    const guide = await call(app, "GET", "/members/onboarding");
    expect(guide.json.teams.map((t: { name: string }) => t.name)).toEqual(["広報チーム", "開発チーム"]);
    expect(guide.json.meetings).toEqual([
      expect.objectContaining({ teamId: null, schedule: "10/20(火) 19:00〜", url: "https://meet.google.com/abc-defg-hij" }),
      expect.objectContaining({ teamId: dev, schedule: "毎週木曜 20:00〜", url: null }),
    ]);

    const cleared = await call(app, "PUT", "/members/onboarding/meetings", { body: { teamId: dev, schedule: "" } });
    expect(cleared.json.meetings.map((m: { teamId: string | null }) => m.teamId)).toEqual([null]);
    expect(pr).toBeTruthy();
  });

  it("rejects unknown teams, non-http links and a link without a schedule", async () => {
    const app = createApp(makeDeps());
    expect((await call(app, "PUT", "/members/onboarding/meetings", { body: { teamId: "team_x", schedule: "x" } })).status).toBe(404);
    expect(
      (await call(app, "PUT", "/members/onboarding/meetings", { body: { teamId: null, schedule: "x", url: "javascript:alert(1)" } })).status,
    ).toBe(400);
    expect(
      (await call(app, "PUT", "/members/onboarding/meetings", { body: { teamId: null, schedule: "", url: "https://x.example" } })).status,
    ).toBe(400);
  });

  it("drops a deleted team's meeting and serves the guide on the internal route", async () => {
    const app = createApp(makeDeps());
    const dev = await team(app, "開発チーム", "dev");
    await call(app, "PUT", "/members/onboarding/meetings", { body: { teamId: dev, schedule: "毎週水曜" } });
    expect((await call(app, "DELETE", `/members/teams/${dev}`)).status).toBeLessThan(300);
    const res = await call(app, "GET", "/members/internal/onboarding", { userId: null, internal: true });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ items: [], teams: [], meetings: [] });
  });

  it("参加届 閲覧 cannot change meetings", async () => {
    const deps = makeDeps();
    const app = createApp({ ...deps, authz: fakeAuthz(viewOnly()) });
    expect((await call(app, "PUT", "/members/onboarding/meetings", { body: { teamId: null, schedule: "x" } })).status).toBe(403);
  });
});
