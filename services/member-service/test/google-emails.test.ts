// 名簿の Gmail 逆引き API。drive-share-service が カレンダー > ミーティング の招待先を決めるときに
// s2s で呼ぶ (名簿の Gmail、無ければ Dub のログインメールにフォールバック)。
import { describe, it, expect } from "vitest";
import { createApp, makeDeps, call } from "./harness";

async function seed(app: ReturnType<typeof createApp>) {
  const add = async (name: string, gmail: string | null, identityUserId: string | null) => {
    const m = await call(app, "POST", "/members/people", { body: { name, status: "added", ...(gmail ? { gmail } : {}) } });
    if (identityUserId) {
      await call(app, "POST", `/members/people/${m.json.id}/identity-link`, { body: { identityUserId, version: m.json.version } });
    }
  };
  await add("高岡", "Kota@Gmail.com", "usr_kota");
  await add("黒川", null, "usr_kurokawa");
  await add("未リンク", "nolink@gmail.com", null);
}

describe("POST /members/internal/google-emails", () => {
  it("returns the linked rows' gmail (lowercased; null when absent) for the asked ids only", async () => {
    const app = createApp(makeDeps());
    await seed(app);
    const res = await call(app, "POST", "/members/internal/google-emails", {
      internal: true,
      body: { userIds: ["usr_kota", "usr_kurokawa", "usr_unknown"] },
    });
    expect(res.status).toBe(200);
    expect(res.json.items).toEqual([
      { userId: "usr_kota", gmail: "kota@gmail.com", name: "高岡" },
      { userId: "usr_kurokawa", gmail: null, name: "黒川" },
    ]);
  });

  it("an empty or malformed body yields no items", async () => {
    const app = createApp(makeDeps());
    await seed(app);
    expect((await call(app, "POST", "/members/internal/google-emails", { internal: true, body: {} })).json.items).toEqual([]);
    expect((await call(app, "POST", "/members/internal/google-emails", { internal: true, body: { userIds: "usr_kota" } })).json.items).toEqual([]);
  });

  it("is service-to-service only — an external caller gets 403 internal_only", async () => {
    const res = await call(createApp(makeDeps()), "POST", "/members/internal/google-emails", { body: { userIds: ["usr_kota"] } });
    expect(res.status).toBe(403);
    expect(res.json.error.details.reason).toBe("internal_only");
  });
});
