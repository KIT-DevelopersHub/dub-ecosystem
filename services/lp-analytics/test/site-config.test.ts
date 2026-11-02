// 公開設定: GET /lp/site-config・PUT draft・POST draft/reset・POST publish（LP管理）+ GET /lp/internal/site-config（LP Worker）。
import { describe, it, expect } from "vitest";
import { createDbClient } from "@dub/db";
import { lp } from "@dub/types";
import type { D1Database } from "@cloudflare/workers-types";
import { memoryD1 } from "../../../infra/d1/src/node-d1";
import { applyAll } from "../../../infra/d1/src/apply";
import { createD1LpRepo } from "../src/d1-repo";
import { get, makeApp, send, type RepoKind } from "./harness";

const body = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const publisher = (kind: RepoKind) => makeApp(kind, "edit", 5000, null, ["lp:publish"]);
const INTERNAL = { "x-dub-internal": "1" };
const OTHER = { "x-dub-user-id": "usr_other", "x-dub-request-id": "req_2" };

const DEFAULT_RELEASE: lp.LpRelease = {
  versionId: lp.LP_DEFAULT_PUBLISHED_VERSION,
  ticketsEnabled: false,
  ticketsCtaEnabled: false,
  proposalsEnabled: false,
};
const bannerOff: lp.LpLayout = {
  schema: 1,
  sections: {
    header: { variant: "a", visible: true, options: { banner: false } },
    program: { variant: "a", visible: false, options: {} },
  },
};
const config = (over: Partial<lp.LpRelease> = {}, layout: lp.LpLayout = bannerOff): lp.LpSiteConfig => ({
  layout,
  release: { ...DEFAULT_RELEASE, ...over },
});

describe.each<RepoKind>(["memory", "d1"])("lp site-config (%s repo)", (kind) => {
  it("GET answers defaults + the existing release tables before anything was saved", async () => {
    const { app } = await makeApp(kind, "view");
    const res = await app.fetch(get("/lp/site-config"));
    expect(res.status).toBe(200);
    const s = await body<lp.LpSiteConfigState>(res);
    const expected = { layout: lp.defaultLayout(), release: DEFAULT_RELEASE };
    expect(s).toEqual({
      site: lp.LP_PUBLISH_SITE,
      draft: expected,
      published: expected,
      revision: 0,
      draftUpdatedAt: null,
      draftUpdatedBy: null,
      publishedAt: null,
      publishedBy: null,
    });
  });

  it("published.release follows the existing endpoints (they stay the source of truth)", async () => {
    const { app } = await publisher(kind);
    await app.fetch(send("POST", "/lp/publish", { versionId: "v3.2" }));
    await app.fetch(send("POST", "/lp/tickets/enabled", { enabled: true }));
    await app.fetch(send("POST", "/lp/proposals/enabled", { enabled: true }));
    const s = await body<lp.LpSiteConfigState>(await app.fetch(get("/lp/site-config")));
    expect(s.published.release).toEqual({ versionId: "v3.2", ticketsEnabled: true, ticketsCtaEnabled: false, proposalsEnabled: true });
    // never-saved draft mirrors production
    expect(s.draft).toEqual(s.published);
  });

  it("PUT draft saves, bumps revision and leaves production untouched", async () => {
    const { app } = await makeApp(kind, "edit");
    const res = await app.fetch(send("PUT", "/lp/site-config/draft", { config: config({ versionId: "v3.5" }), revision: 0 }));
    expect(res.status).toBe(200);
    const s = await body<lp.LpSiteConfigState>(res);
    expect(s.revision).toBe(1);
    expect(s.draft).toEqual(config({ versionId: "v3.5" }));
    expect(s).toMatchObject({ draftUpdatedBy: "usr_admin", draftUpdatedAt: "2026-10-07T03:00:00.000Z", publishedAt: null });
    expect(s.published).toEqual({ layout: lp.defaultLayout(), release: DEFAULT_RELEASE });
    // the old publish endpoint still answers the untouched live version
    expect((await body<lp.LpPublishState>(await app.fetch(get("/lp/publish")))).versionId).toBe(lp.LP_DEFAULT_PUBLISHED_VERSION);
  });

  it("stale revision → 409 and nothing changes (optimistic lock)", async () => {
    const { app } = await makeApp(kind, "edit");
    expect((await app.fetch(send("PUT", "/lp/site-config/draft", { config: config(), revision: 0 }))).status).toBe(200);
    const late = await app.fetch(send("PUT", "/lp/site-config/draft", { config: config({ proposalsEnabled: true }), revision: 0 }, OTHER));
    expect(late.status).toBe(409);
    const s = await body<lp.LpSiteConfigState>(await app.fetch(get("/lp/site-config")));
    expect(s.revision).toBe(1);
    expect(s.draft.release.proposalsEnabled).toBe(false);
    expect(s.draftUpdatedBy).toBe("usr_admin");
    // a revision from the future also conflicts (no row is created out of thin air)
    expect((await app.fetch(send("PUT", "/lp/site-config/draft", { config: config(), revision: 7 }))).status).toBe(409);
  });

  it("first write with a non-zero revision on an empty site → 409", async () => {
    const { app } = await makeApp(kind, "edit");
    expect((await app.fetch(send("PUT", "/lp/site-config/draft", { config: config(), revision: 1 }))).status).toBe(409);
    expect((await body<lp.LpSiteConfigState>(await app.fetch(get("/lp/site-config")))).revision).toBe(0);
  });

  it("invalid section / variant / option / release / revision → 400", async () => {
    const { app } = await publisher(kind);
    const bad: unknown[] = [
      { config: config({}, { schema: 1, sections: { hero9: {} } } as unknown as lp.LpLayout), revision: 0 },
      { config: config({}, { schema: 1, sections: { program: { variant: "z", visible: true, options: {} } } }), revision: 0 },
      { config: config({}, { schema: 1, sections: { header: { variant: "a", visible: true, options: { glow: true } } } }), revision: 0 },
      { config: config({}, { schema: 1, sections: { header: { variant: "a", visible: false, options: {} } } }), revision: 0 },
      { config: config({ versionId: "v9.9" }), revision: 0 },
      { config: config(), revision: -1 },
      { config: config() },
      { revision: 0 },
    ];
    for (const b of bad) {
      expect((await app.fetch(send("PUT", "/lp/site-config/draft", b))).status).toBe(400);
      expect((await app.fetch(send("POST", "/lp/site-config/publish", b))).status).toBe(400);
    }
    const res = await app.fetch(
      send("PUT", "/lp/site-config/draft", {
        config: config({}, { schema: 1, sections: { program: { variant: "b", visible: true, options: {} } } }),
        revision: 0,
      }),
    );
    expect(await body<{ error: { details: unknown } }>(res)).toMatchObject({
      error: { details: [{ field: "config.layout.sections.program.variant", reason: "unknown_variant" }] },
    });
    expect((await body<lp.LpSiteConfigState>(await app.fetch(get("/lp/site-config")))).revision).toBe(0);
  });

  it("publish writes layout + release (version / tickets / proposals) and one history row", async () => {
    const { app, repo } = await publisher(kind);
    const next = config({ versionId: "v3.5", ticketsEnabled: true, ticketsCtaEnabled: true, proposalsEnabled: true });
    const res = await app.fetch(send("POST", "/lp/site-config/publish", { config: next, revision: 0 }));
    expect(res.status).toBe(200);
    const s = await body<lp.LpSiteConfigState>(res);
    expect(s.published).toEqual(next);
    expect(s).toMatchObject({ revision: 1, publishedBy: "usr_admin", publishedAt: "2026-10-07T03:00:00.000Z" });
    // a never-saved draft follows production
    expect(s.draft).toEqual(next);

    // existing tables / endpoints reflect it
    expect((await body<lp.LpPublishState>(await app.fetch(get("/lp/publish")))).versionId).toBe("v3.5");
    expect(await body(await app.fetch(get("/lp/internal/publish", INTERNAL)))).toEqual({ versionId: "v3.5" });
    expect(await body(await app.fetch(get("/lp/tickets")))).toMatchObject({ enabled: true, ctaEnabled: true });
    expect(await body(await app.fetch(get("/lp/proposals")))).toMatchObject({ enabled: true });

    const history = await repo.listSiteConfigHistory(lp.LP_PUBLISH_SITE, 10);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ id: "lph_00000000", publishedBy: "usr_admin", publishedAt: "2026-10-07T03:00:00.000Z" });
    expect(JSON.parse(history[0]!.configJson)).toEqual(next);
  });

  it("publish only rewrites the release rows whose value changed (who/when of the rest is kept)", async () => {
    const { app, clock } = await publisher(kind);
    await app.fetch(send("POST", "/lp/tickets/enabled", { enabled: true }));
    clock.set("2026-10-08T00:00:00.000Z");
    const res = await app.fetch(
      send("POST", "/lp/site-config/publish", { config: config({ ticketsEnabled: true, proposalsEnabled: true }), revision: 0 }, OTHER),
    );
    expect(res.status).toBe(200);
    expect(await body(await app.fetch(get("/lp/tickets")))).toMatchObject({
      enabled: true,
      updatedBy: "usr_admin",
      updatedAt: "2026-10-07T03:00:00.000Z",
    });
    expect(await body(await app.fetch(get("/lp/proposals")))).toMatchObject({ enabled: true, updatedBy: "usr_other" });
  });

  it("stale publish → 409 and writes nothing (no layout, no release, no history)", async () => {
    const { app, repo } = await publisher(kind);
    expect((await app.fetch(send("PUT", "/lp/site-config/draft", { config: config(), revision: 0 }))).status).toBe(200);
    const stale = await app.fetch(
      send("POST", "/lp/site-config/publish", { config: config({ versionId: "v3.5", ticketsEnabled: true, proposalsEnabled: true }), revision: 0 }),
    );
    expect(stale.status).toBe(409);
    const s = await body<lp.LpSiteConfigState>(await app.fetch(get("/lp/site-config")));
    expect(s.revision).toBe(1);
    expect(s.published).toEqual({ layout: lp.defaultLayout(), release: DEFAULT_RELEASE });
    expect(s.publishedAt).toBeNull();
    expect(await repo.listSiteConfigHistory(lp.LP_PUBLISH_SITE, 10)).toEqual([]);
  });

  it("reset copies production into the draft; optional revision is checked", async () => {
    const { app } = await publisher(kind);
    await app.fetch(send("POST", "/lp/site-config/publish", { config: config({ versionId: "v3.3" }), revision: 0 }));
    await app.fetch(send("PUT", "/lp/site-config/draft", { config: config({ versionId: "v3.5" }, lp.defaultLayout()), revision: 1 }));
    expect((await app.fetch(send("POST", "/lp/site-config/draft/reset", { revision: 1 }))).status).toBe(409);
    const res = await app.fetch(new Request("https://lp/lp/site-config/draft/reset", {
      method: "POST",
      headers: { "x-dub-user-id": "usr_admin" },
    }));
    expect(res.status).toBe(200);
    const s = await body<lp.LpSiteConfigState>(res);
    expect(s.draft).toEqual(s.published);
    expect(s.draft).toEqual(config({ versionId: "v3.3" }));
    expect(s.revision).toBe(3);
    expect((await app.fetch(send("POST", "/lp/site-config/draft/reset", { revision: 3 }))).status).toBe(200);
    expect((await app.fetch(send("POST", "/lp/site-config/draft/reset", { revision: "x" }))).status).toBe(400);
  });

  it("GET /lp/internal/site-config returns { published, draft } layouts", async () => {
    const { app } = await publisher(kind);
    const empty = await app.fetch(get("/lp/internal/site-config", INTERNAL));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ published: lp.defaultLayout(), draft: lp.defaultLayout() });

    await app.fetch(send("POST", "/lp/site-config/publish", { config: config(), revision: 0 }));
    const draftLayout: lp.LpLayout = { schema: 1, sections: { about: { variant: "a", visible: false, options: {} } } };
    await app.fetch(send("PUT", "/lp/site-config/draft", { config: config({}, draftLayout), revision: 1 }));
    expect(await body(await app.fetch(get("/lp/internal/site-config", INTERNAL)))).toEqual({ published: bannerOff, draft: draftLayout });
  });
});

describe("site-config gate", () => {
  it("publish needs lp:publish: 編集 → 403, 閲覧 + lp:publish → 403; nothing written", async () => {
    const edit = await makeApp("memory", "edit");
    expect((await edit.app.fetch(send("POST", "/lp/site-config/publish", { config: config({ versionId: "v3.5" }), revision: 0 }))).status).toBe(403);
    const viewOnly = await makeApp("memory", "view", 5000, null, ["lp:publish"]);
    expect((await viewOnly.app.fetch(send("POST", "/lp/site-config/publish", { config: config(), revision: 0 }))).status).toBe(403);
    expect((await edit.app.fetch(get("/lp/publish"))).status).toBe(200);
    expect((await body<lp.LpSiteConfigState>(await edit.app.fetch(get("/lp/site-config")))).revision).toBe(0);
  });

  it("draft writes need 編集; 閲覧 can read; 無効 cannot", async () => {
    const view = await makeApp("memory", "view");
    expect((await view.app.fetch(get("/lp/site-config"))).status).toBe(200);
    expect((await view.app.fetch(send("PUT", "/lp/site-config/draft", { config: config(), revision: 0 }))).status).toBe(403);
    expect((await view.app.fetch(send("POST", "/lp/site-config/draft/reset", {}))).status).toBe(403);
    const none = await makeApp("memory", "none");
    expect((await none.app.fetch(get("/lp/site-config"))).status).toBe(403);
  });

  it("GET /lp/internal/site-config is s2s only (404 without x-dub-internal) and needs no user", async () => {
    const { app } = await makeApp("memory");
    expect((await app.fetch(get("/lp/internal/site-config", {}))).status).toBe(404);
    expect((await app.fetch(get("/lp/internal/site-config", INTERNAL))).status).toBe(200);
  });

  it("internal read tolerates stored values the registry no longer knows (falls back to defaults)", async () => {
    const { app, repo } = await makeApp("memory");
    await repo.saveSiteConfigDraft(
      lp.LP_PUBLISH_SITE,
      JSON.stringify({ layout: { schema: 1, sections: { program: { variant: "retired", visible: false, options: {} }, gone: {} } } }),
      null,
      "usr_admin",
      "2026-10-07T03:00:00.000Z",
    );
    expect(await body(await app.fetch(get("/lp/internal/site-config", INTERNAL)))).toEqual({
      published: lp.defaultLayout(),
      draft: { schema: 1, sections: { program: { variant: "a", visible: false, options: {} } } },
    });
    // the draft release was missing → the published release is shown
    expect((await body<lp.LpSiteConfigState>(await app.fetch(get("/lp/site-config")))).draft.release).toEqual(DEFAULT_RELEASE);
  });
});

describe("publish atomicity (real D1 SQL, transactional batch like Cloudflare D1)", () => {
  /** node-d1's batch runs statements one by one; wrap it in a transaction the way D1 does. */
  async function transactionalD1() {
    const { db, raw } = memoryD1();
    await applyAll(db);
    const tx = Object.assign(Object.create(db) as D1Database, {
      batch(stmts: Parameters<D1Database["batch"]>[0]) {
        raw.exec("BEGIN");
        try {
          const out = (db.batch as unknown as (s: typeof stmts) => unknown)(stmts);
          raw.exec("COMMIT");
          return out;
        } catch (e) {
          raw.exec("ROLLBACK");
          throw e;
        }
      },
    });
    let batches = 0;
    let runs = 0;
    const client = createDbClient(tx, { namespace: "lp" });
    const counted = {
      ...client,
      batch: (s: Parameters<typeof client.batch>[0]) => (batches++, client.batch(s)),
      run: (sql: string, ...b: unknown[]) => (runs++, client.run(sql, ...b)),
    };
    return { raw, repo: createD1LpRepo(counted), counts: () => ({ batches, runs }) };
  }

  it("all publish writes go through exactly one batch (no separate run)", async () => {
    const { repo, counts } = await transactionalD1();
    const { app } = await makeApp("d1", "edit", 5000, null, ["lp:publish"], { repo });
    const res = await app.fetch(send("POST", "/lp/site-config/publish", { config: config({ versionId: "v3.5", ticketsEnabled: true }), revision: 0 }));
    expect(res.status).toBe(200);
    expect(counts()).toEqual({ batches: 1, runs: 0 });
  });

  it("a failure in the last statement rolls back layout, version, tickets and history", async () => {
    const { raw, repo } = await transactionalD1();
    raw.exec(`CREATE TRIGGER lp_test_fail_ins BEFORE INSERT ON lp_proposal_settings BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    const { app } = await makeApp("d1", "edit", 5000, null, ["lp:publish"], { repo });
    const res = await app.fetch(
      send("POST", "/lp/site-config/publish", { config: config({ versionId: "v3.5", ticketsEnabled: true, proposalsEnabled: true }), revision: 0 }),
    );
    expect(res.status).toBe(500);
    raw.exec("DROP TRIGGER lp_test_fail_ins");
    const s = await body<lp.LpSiteConfigState>(await app.fetch(get("/lp/site-config")));
    expect(s.revision).toBe(0);
    expect(s.published).toEqual({ layout: lp.defaultLayout(), release: DEFAULT_RELEASE });
    expect(await repo.listSiteConfigHistory(lp.LP_PUBLISH_SITE, 10)).toEqual([]);
  });
});
