// スポンサー: 名刺 CRUD + 楽観ロック + 検証 + 写真 (PUT/GET・形式/サイズ・置き場なし) + 登録者名の名簿引き + 権限。
import { describe, it, expect } from "vitest";
import { sponsor, type identity } from "@dub/types";
import { call, createApp, fakeAuthz, makeDeps, FakeImageStore } from "./harness";
import { InMemorySponsorRepo } from "../src/sponsor-repo";

type App = ReturnType<typeof createApp>;

async function newCard(app: App, body: Record<string, unknown> = {}): Promise<{ id: string; version: number }> {
  const res = await call(app, "POST", "/members/sponsor/cards", { body: { companyName: "株式会社テスト", ...body } });
  expect(res.status).toBe(201);
  return { id: res.json.id, version: res.json.version };
}

async function putImage(
  app: App,
  id: string,
  bytes: Uint8Array,
  contentType = "image/jpeg",
  userId = "user_caller",
): Promise<{ status: number; json: any }> {
  const res = await app.request(`http://svc/members/sponsor/cards/${id}/image`, {
    method: "PUT",
    headers: { "x-dub-request-id": "req_test", "x-dub-user-id": userId, "content-type": contentType },
    body: bytes,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

function clock(): () => string {
  let t = Date.parse("2026-11-01T00:00:00.000Z");
  return () => new Date((t += 1000)).toISOString();
}

describe("スポンサー: 名刺", () => {
  it("creates a card (trimmed, blanks -> null) and lists newest-updated first", async () => {
    const app = createApp(makeDeps({ now: clock() }));
    const created = await call(app, "POST", "/members/sponsor/cards", {
      body: { companyName: "  株式会社A ", personName: "山田 太郎", email: " taro@a.example ", phone: "", note: "  " },
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      companyName: "株式会社A", personName: "山田 太郎", email: "taro@a.example", phone: null, note: null,
      department: null, title: null, hasImage: false, version: 1, createdBy: "user_caller", createdByName: null,
    });
    const b = await newCard(app, { companyName: "株式会社B" });
    // A を更新すると先頭に来る (updatedAt 降順)。
    await call(app, "PATCH", `/members/sponsor/cards/${created.json.id}`, { body: { title: "部長", expectedVersion: 1 } });

    const list = await call(app, "GET", "/members/sponsor/cards");
    expect(list.status).toBe(200);
    expect(list.json.cards.map((c: { id: string }) => c.id)).toEqual([created.json.id, b.id]);
    expect(list.json.cards[0]).not.toHaveProperty("orgId");
    expect(list.json.cards[0]).not.toHaveProperty("archivedAt");
  });

  it("allows a photo-only card (every text field empty)", async () => {
    const app = createApp(makeDeps());
    const res = await call(app, "POST", "/members/sponsor/cards", { body: {} });
    expect(res.status).toBe(201);
    expect(sponsor.cardDisplayName(res.json)).toBe("名刺（未入力）");
  });

  it("stamps createdByName from the caller's linked roster row", async () => {
    const app = createApp(makeDeps());
    const m = await call(app, "POST", "/members/people", { body: { name: "佐藤 花子", status: "added", teamIds: [] } });
    await call(app, "POST", `/members/people/${m.json.id}/identity-link`, {
      body: { identityUserId: "usr_sato", version: m.json.version },
    });
    const res = await call(app, "POST", "/members/sponsor/cards", { userId: "usr_sato", body: { personName: "x" } });
    expect(res.json).toMatchObject({ createdBy: "usr_sato", createdByName: "佐藤 花子" });
  });

  it("validates lengths, email shape and types (400)", async () => {
    const app = createApp(makeDeps());
    const post = (body: unknown) => call(app, "POST", "/members/sponsor/cards", { body });
    expect((await post({ companyName: "x".repeat(sponsor.CARD_FIELD_MAX + 1) })).status).toBe(400);
    expect((await post({ companyName: "x".repeat(sponsor.CARD_FIELD_MAX) })).status).toBe(201);
    expect((await post({ note: "x".repeat(sponsor.CARD_NOTE_MAX + 1) })).status).toBe(400);
    expect((await post({ note: "x".repeat(sponsor.CARD_NOTE_MAX) })).status).toBe(201);
    expect((await post({ email: "not-an-email" })).status).toBe(400);
    expect((await post({ email: "a b@c" })).status).toBe(400);
    expect((await post({ phone: 123 })).status).toBe(400);
  });

  it("gets one card, 404 for unknown", async () => {
    const app = createApp(makeDeps());
    const c = await newCard(app);
    expect((await call(app, "GET", `/members/sponsor/cards/${c.id}`)).json.id).toBe(c.id);
    const missing = await call(app, "GET", "/members/sponsor/cards/card_nope");
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe("SPONSOR_CARD_NOT_FOUND");
  });

  it("updates only the sent fields with optimistic locking (409 on stale version)", async () => {
    const app = createApp(makeDeps());
    const c = await newCard(app, { personName: "山田", email: "y@example.com" });
    const ok = await call(app, "PATCH", `/members/sponsor/cards/${c.id}`, {
      body: { department: "営業部", email: null, expectedVersion: 1 },
    });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ companyName: "株式会社テスト", personName: "山田", department: "営業部", email: null, version: 2 });
    const stale = await call(app, "PATCH", `/members/sponsor/cards/${c.id}`, { body: { title: "x", expectedVersion: 1 } });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("SPONSOR_VERSION_CONFLICT");
    expect((await call(app, "PATCH", `/members/sponsor/cards/${c.id}`, { body: { title: "x" } })).status).toBe(400);
  });

  it("deletes softly (204): gone from list / get / patch, and the photo is removed best-effort", async () => {
    const images = new FakeImageStore();
    const app = createApp(makeDeps({ sponsorImages: images }));
    const c = await newCard(app);
    const keep = await newCard(app, { companyName: "残る" });
    expect((await putImage(app, c.id, new Uint8Array([1, 2, 3]))).status).toBe(200);
    expect(images.objects.has(`sponsor/cards/${c.id}`)).toBe(true);

    const del = await app.request(`http://svc/members/sponsor/cards/${c.id}`, {
      method: "DELETE",
      headers: { "x-dub-request-id": "req_test", "x-dub-user-id": "user_caller" },
    });
    expect(del.status).toBe(204);
    expect(images.objects.has(`sponsor/cards/${c.id}`)).toBe(false);
    const list = await call(app, "GET", "/members/sponsor/cards");
    expect(list.json.cards.map((x: { id: string }) => x.id)).toEqual([keep.id]);
    expect((await call(app, "GET", `/members/sponsor/cards/${c.id}`)).status).toBe(404);
    expect((await call(app, "PATCH", `/members/sponsor/cards/${c.id}`, { body: { title: "x", expectedVersion: 3 } })).status).toBe(404);
    expect((await call(app, "DELETE", `/members/sponsor/cards/${c.id}`)).status).toBe(404);
  });

  it("delete still succeeds when the photo delete fails", async () => {
    const images = new FakeImageStore();
    const app = createApp(makeDeps({ sponsorImages: images }));
    const c = await newCard(app);
    await putImage(app, c.id, new Uint8Array([1]));
    images.failDelete = true;
    expect((await call(app, "DELETE", `/members/sponsor/cards/${c.id}`)).status).toBe(204);
    expect((await call(app, "GET", "/members/sponsor/cards")).json.cards).toEqual([]);
  });
});

describe("スポンサー: 名刺の写真", () => {
  it("stores the photo (hasImage, version+1), serves it back, and overwrites on retake", async () => {
    const app = createApp(makeDeps());
    const c = await newCard(app);
    const put = await putImage(app, c.id, new Uint8Array([0xff, 0xd8, 0xff, 0x01]));
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ id: c.id, hasImage: true, version: 2 });

    const got = await app.request(`http://svc/members/sponsor/cards/${c.id}/image`, {
      headers: { "x-dub-request-id": "req_test", "x-dub-user-id": "user_caller" },
    });
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/jpeg");
    expect(got.headers.get("cache-control")).toBe("private, max-age=300");
    expect([...new Uint8Array(await got.arrayBuffer())]).toEqual([0xff, 0xd8, 0xff, 0x01]);

    const retake = await putImage(app, c.id, new Uint8Array([9, 9]), "image/png; charset=binary");
    expect(retake.json).toMatchObject({ hasImage: true, version: 3 });
    const again = await app.request(`http://svc/members/sponsor/cards/${c.id}/image`, {
      headers: { "x-dub-request-id": "req_test", "x-dub-user-id": "user_caller" },
    });
    expect(again.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await again.arrayBuffer())]).toEqual([9, 9]);
  });

  it("404 when the card has no photo or does not exist", async () => {
    const app = createApp(makeDeps());
    const c = await newCard(app);
    const none = await call(app, "GET", `/members/sponsor/cards/${c.id}/image`);
    expect(none.status).toBe(404);
    expect(none.json.error.code).toBe("SPONSOR_IMAGE_NOT_FOUND");
    expect((await putImage(app, "card_nope", new Uint8Array([1]))).status).toBe(404);
  });

  it("415 for an unsupported type, 413 over the size limit, 400 for an empty body", async () => {
    const images = new FakeImageStore();
    const app = createApp(makeDeps({ sponsorImages: images }));
    const c = await newCard(app);
    const gif = await putImage(app, c.id, new Uint8Array([1]), "image/gif");
    expect(gif.status).toBe(415);
    expect(gif.json.error.code).toBe("SPONSOR_IMAGE_UNSUPPORTED_TYPE");
    expect((await putImage(app, c.id, new Uint8Array([1]), "application/json")).status).toBe(415);
    const big = await putImage(app, c.id, new Uint8Array(sponsor.CARD_IMAGE_MAX_BYTES + 1));
    expect(big.status).toBe(413);
    expect(big.json.error.code).toBe("SPONSOR_IMAGE_TOO_LARGE");
    expect((await putImage(app, c.id, new Uint8Array(0))).status).toBe(400);
    expect(images.objects.size).toBe(0);
    expect((await putImage(app, c.id, new Uint8Array(sponsor.CARD_IMAGE_MAX_BYTES))).status).toBe(200);
  });

  it("503 on the photo routes only, when the R2 binding is absent", async () => {
    const deps = makeDeps();
    delete deps.sponsorImages;
    const app = createApp(deps);
    const c = await newCard(app);
    const put = await putImage(app, c.id, new Uint8Array([1]));
    expect(put.status).toBe(503);
    expect(put.json.error.code).toBe("SPONSOR_FILES_UNAVAILABLE");
    expect((await call(app, "GET", `/members/sponsor/cards/${c.id}/image`)).status).toBe(503);
    expect((await call(app, "GET", "/members/sponsor/cards")).status).toBe(200);
    expect((await call(app, "DELETE", `/members/sponsor/cards/${c.id}`)).status).toBe(204);
  });
});

describe("スポンサー: 権限 (表)", () => {
  const app = (keys: identity.PermissionKey[]) =>
    createApp(makeDeps({ authz: fakeAuthz(new Set(keys)), sponsorRepo: new InMemorySponsorRepo() }));

  it("閲覧 + sponsor:read can read but not write", async () => {
    const a = app(["app:sponsor:view", "sponsor:read"]);
    expect((await call(a, "GET", "/members/sponsor/cards")).status).toBe(200);
    expect((await call(a, "POST", "/members/sponsor/cards", { body: {} })).status).toBe(403);
  });

  it("detail keys alone (app 無効) reach nothing", async () => {
    const a = app(["sponsor:read", "sponsor:write", "sponsor:admin"]);
    expect((await call(a, "GET", "/members/sponsor/cards")).status).toBe(403);
  });

  it("編集 + sponsor:write can create but not delete (sponsor:admin)", async () => {
    const a = app(["app:sponsor:view", "app:sponsor:edit", "sponsor:read", "sponsor:write"]);
    const c = await call(a, "POST", "/members/sponsor/cards", { body: {} });
    expect(c.status).toBe(201);
    expect((await call(a, "DELETE", `/members/sponsor/cards/${c.json.id}`)).status).toBe(403);
  });
});
