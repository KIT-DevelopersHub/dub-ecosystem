// 公開版切り替え: GET/POST /lp/publish (LP管理) + GET /lp/internal/publish (public LP Worker).
import { describe, it, expect } from "vitest";
import { lp } from "@dub/types";
import { get, makeApp, send, type RepoKind } from "./harness";

const body = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const publisher = (kind: RepoKind) => makeApp(kind, "edit", 5000, null, ["lp:publish"]);
const INTERNAL = { "x-dub-internal": "1" };

describe.each<RepoKind>(["memory", "d1"])("lp publish (%s repo)", (kind) => {
  it("GET /lp/publish answers the default version before anyone switched", async () => {
    const { app } = await makeApp(kind, "view");
    const res = await app.fetch(get("/lp/publish"));
    expect(res.status).toBe(200);
    const s = await body<lp.LpPublishState>(res);
    expect(s).toMatchObject({ site: "hokuriku-it-conf.com", versionId: "v3.4", versions: [...lp.LP_PUBLISHABLE_VERSION_IDS] });
    // memory has no row (null); D1 carries the 0002 seed row
    if (kind === "memory") expect(s).toMatchObject({ updatedAt: null, updatedBy: null });
    else expect(s).toMatchObject({ updatedAt: "2026-10-12T00:00:00.000Z", updatedBy: null });
  });

  it("lp:publish holder switches the version; GET + internal read reflect it", async () => {
    const { app } = await publisher(kind);
    const res = await app.fetch(send("POST", "/lp/publish", { versionId: "v3.2" }));
    expect(res.status).toBe(200);
    expect(await body<lp.LpPublishState>(res)).toMatchObject({
      versionId: "v3.2",
      updatedBy: "usr_admin",
      updatedAt: "2026-10-07T03:00:00.000Z",
    });
    expect((await body<lp.LpPublishState>(await app.fetch(get("/lp/publish")))).versionId).toBe("v3.2");
    const internal = await app.fetch(get("/lp/internal/publish", INTERNAL));
    expect(internal.status).toBe(200);
    expect(await internal.json()).toEqual({ versionId: "v3.2" });
  });

  it('normalizes "3.1" to "v3.1"; unknown version → 400', async () => {
    const { app } = await publisher(kind);
    const ok = await app.fetch(send("POST", "/lp/publish", { versionId: " 3.1 " }));
    expect((await body<lp.LpPublishState>(ok)).versionId).toBe("v3.1");
    for (const versionId of ["v9.9", "", 3.1, null]) {
      expect((await app.fetch(send("POST", "/lp/publish", { versionId }))).status).toBe(400);
    }
    expect((await body<lp.LpPublishState>(await app.fetch(get("/lp/publish")))).versionId).toBe("v3.1");
  });
});

describe("publish gate", () => {
  it("LP管理 編集 without lp:publish → 403 (never 401); 閲覧 + lp:publish → 403", async () => {
    const edit = await makeApp("memory", "edit");
    expect((await edit.app.fetch(send("POST", "/lp/publish", { versionId: "v3.1" }))).status).toBe(403);
    const viewOnly = await makeApp("memory", "view", 5000, null, ["lp:publish"]);
    expect((await viewOnly.app.fetch(send("POST", "/lp/publish", { versionId: "v3.1" }))).status).toBe(403);
    // nothing changed
    expect((await body<lp.LpPublishState>(await edit.app.fetch(get("/lp/publish")))).versionId).toBe("v3.4");
  });

  it("無効 cannot read the publish state", async () => {
    const none = await makeApp("memory", "none");
    expect((await none.app.fetch(get("/lp/publish"))).status).toBe(403);
  });

  it("GET /lp/internal/publish is s2s only (404 without x-dub-internal) and needs no user", async () => {
    const { app } = await makeApp("memory");
    expect((await app.fetch(get("/lp/internal/publish", {}))).status).toBe(404);
    const res = await app.fetch(get("/lp/internal/publish", INTERNAL));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ versionId: lp.LP_DEFAULT_PUBLISHED_VERSION });
  });
});

describe("publishable list matches the public LP bundle", () => {
  it("LP_PUBLISHABLE_VERSION_IDS == apps/lp-conference-next/versions.json ids", async () => {
    const { readFileSync } = await import("node:fs");
    const manifest = JSON.parse(
      readFileSync(new URL("../../../apps/lp-conference-next/versions.json", import.meta.url), "utf8"),
    ) as { default: string; versions: { id: string }[] };
    expect([...lp.LP_PUBLISHABLE_VERSION_IDS].sort()).toEqual(manifest.versions.map((v) => v.id).sort());
    expect(manifest.default).toBe(lp.LP_DEFAULT_PUBLISHED_VERSION);
  });
});
