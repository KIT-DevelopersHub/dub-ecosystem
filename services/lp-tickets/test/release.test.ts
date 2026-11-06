// 公開設定の release（lp-analytics → SVC_LP_TICKETS）。旧 publishSiteConfig の「値が変わる時だけ書く」を守る。
import { describe, it, expect } from "vitest";
import { get, makeApp, send, type RepoKind } from "./harness";

const body = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const S2S = { "x-dub-internal": "1", "x-dub-user-id": "usr_admin" };
const OTHER = { "x-dub-internal": "1", "x-dub-user-id": "usr_other" };
const PATH = "/lp/internal/tickets/release";

describe.each<RepoKind>(["memory", "d1"])("lp tickets release (%s repo)", (kind) => {
  it("defaults to off, and writes both flags", async () => {
    const { app } = await makeApp(kind);
    expect(await body(await app.fetch(get(PATH, S2S)))).toEqual({ ticketsEnabled: false, ticketsCtaEnabled: false });
    const res = await app.fetch(send("POST", PATH, { ticketsEnabled: true, ticketsCtaEnabled: true }, S2S));
    expect(await body(res)).toEqual({ ticketsEnabled: true, ticketsCtaEnabled: true });
    expect(await body(await app.fetch(get("/lp/tickets")))).toMatchObject({ enabled: true, ctaEnabled: true, updatedBy: "usr_admin" });
  });

  it("the same values keep who/when of the last real change", async () => {
    const { app, clock } = await makeApp(kind);
    await app.fetch(send("POST", PATH, { ticketsEnabled: true, ticketsCtaEnabled: false }, S2S));
    clock.set("2026-10-08T00:00:00.000Z");
    await app.fetch(send("POST", PATH, { ticketsEnabled: true, ticketsCtaEnabled: false }, OTHER));
    expect(await body(await app.fetch(get("/lp/tickets")))).toMatchObject({
      updatedBy: "usr_admin",
      updatedAt: "2026-10-07T03:00:00.000Z",
    });
  });

  it("rejects a bad body, a missing actor and any caller without the marker", async () => {
    const { app } = await makeApp(kind);
    expect((await app.fetch(send("POST", PATH, { ticketsEnabled: "yes" }, S2S))).status).toBe(400);
    expect((await app.fetch(send("POST", PATH, { ticketsEnabled: true, ticketsCtaEnabled: true }, { "x-dub-internal": "1" }))).status).toBe(401);
    expect((await app.fetch(send("POST", PATH, { ticketsEnabled: true, ticketsCtaEnabled: true }))).status).toBe(403);
    expect((await app.fetch(get(PATH))).status).toBe(403);
  });
});
