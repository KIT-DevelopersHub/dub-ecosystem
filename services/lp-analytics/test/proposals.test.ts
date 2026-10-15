// LP 登壇者募集: LP管理 API (/lp/proposals*) + 公開 LP Worker 向け内部 API (/lp/internal/proposals*).
import { describe, it, expect } from "vitest";
import { DEFAULT_PROPOSAL_FIELDS, PER_CLIENT_DAILY_CAP } from "../src/proposals";
import type { LpProposal, LpProposalsPage, LpProposalsState } from "../src/types";
import { get, makeApp, send, type RepoKind } from "./harness";

const body = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const INTERNAL = { "x-dub-internal": "1" };

const VALID = {
  name: "北陸 太郎",
  email: "taro@example.com",
  title: "Workers で作る LP",
  abstract: "1 Worker に全版を同梱する話",
  answers: { format: "LT（5分）" },
};

async function setup(kind: RepoKind, opts: { publish?: boolean; cap?: number; level?: "view" | "edit" } = {}) {
  return makeApp(kind, opts.level ?? "edit", 5000, null, opts.publish === false ? [] : ["lp:publish"], {
    ...(opts.cap !== undefined ? { dailyProposalCap: opts.cap } : {}),
  });
}

async function open(app: Awaited<ReturnType<typeof setup>>["app"]) {
  const res = await app.fetch(send("POST", "/lp/proposals/enabled", { enabled: true }));
  expect(res.status).toBe(200);
}

const submit = (b: unknown) => send("POST", "/lp/internal/proposals/submit", b, INTERNAL);

describe.each<RepoKind>(["memory", "d1"])("proposals (%s)", (kind) => {
  it("starts closed with the default fields and the public URL", async () => {
    const { app } = await setup(kind);
    const s = await body<LpProposalsState>(await app.fetch(get("/lp/proposals")));
    expect(s.enabled).toBe(false);
    expect(s.publicUrl).toBe("https://hokuriku-it-conf.com/proposals");
    expect(s.fields).toEqual(DEFAULT_PROPOSAL_FIELDS);
    expect(s.totals).toEqual({ total: 0, accepted: 0, rejected: 0 });

    const pub = await body<{ enabled: boolean }>(await app.fetch(get("/lp/internal/proposals", INTERNAL)));
    expect(pub.enabled).toBe(false);
  });

  it("opening needs lp:publish; enabling keeps the default fields", async () => {
    const denied = await setup(kind, { publish: false });
    expect((await denied.app.fetch(send("POST", "/lp/proposals/enabled", { enabled: true }))).status).toBe(403);

    const { app } = await setup(kind);
    await open(app);
    const s = await body<LpProposalsState>(await app.fetch(get("/lp/proposals")));
    expect(s.enabled).toBe(true);
    expect(s.fields).toEqual(DEFAULT_PROPOSAL_FIELDS);
    expect(s.updatedBy).toBe("usr_admin");
  });

  it("rejects submissions while closed (404)", async () => {
    const { app } = await setup(kind);
    expect((await app.fetch(submit(VALID))).status).toBe(404);
  });

  it("accepts a valid submission and lists it newest first with answers", async () => {
    const { app, clock } = await setup(kind);
    await open(app);
    expect((await app.fetch(submit(VALID))).status).toBe(201);
    clock.set("2026-10-07T04:00:00.000Z");
    const res = await app.fetch(submit({ ...VALID, title: "二本目", answers: { format: "セッション（30分）", bio: "LT 好き" } }));
    expect(res.status).toBe(201);

    const page = await body<LpProposalsPage>(await app.fetch(get("/lp/proposals/submissions")));
    expect(page.items.map((p) => p.title)).toEqual(["二本目", "Workers で作る LP"]);
    expect(page.items[0]!.status).toBe("submitted");
    expect(page.items[0]!.answers).toContainEqual({ fieldId: "bio", label: "自己紹介", value: "LT 好き" });
    expect(page.nextCursor).toBeNull();

    const s = await body<LpProposalsState>(await app.fetch(get("/lp/proposals")));
    expect(s.totals.total).toBe(2);
  });

  it("validates fixed fields and the configured fields", async () => {
    const { app } = await setup(kind);
    await open(app);
    const res = await app.fetch(submit({ name: "", email: "nope", title: "x".repeat(101), abstract: "", answers: { format: "基調講演" } }));
    expect(res.status).toBe(400);
    const fields = ((await res.json()) as { error: { details: { field: string; reason: string }[] } }).error.details;
    expect(fields).toEqual(
      expect.arrayContaining([
        { field: "name", reason: "required" },
        { field: "email", reason: "invalid" },
        { field: "title", reason: "too_long" },
        { field: "abstract", reason: "required" },
        { field: "answers.format", reason: "invalid" },
      ]),
    );
  });

  it("saves custom fields (edit) and refuses the fixed ids", async () => {
    const { app } = await setup(kind);
    const bad = await app.fetch(
      send("POST", "/lp/proposals/fields", { fields: [{ id: "title", label: "題", type: "text", required: false }] }),
    );
    expect(bad.status).toBe(400);
    const ok = await app.fetch(
      send("POST", "/lp/proposals/fields", { fields: [{ id: "slides", label: "資料 URL", type: "text", required: true }] }),
    );
    expect(ok.status).toBe(200);
    expect((await body<LpProposalsState>(ok)).fields).toEqual([
      { id: "slides", label: "資料 URL", type: "text", required: true, options: [] },
    ]);
    await open(app);
    // 既定の「発表形式」はもう要求されず、新しい必須項目が効く。
    expect((await app.fetch(submit({ ...VALID, answers: {} }))).status).toBe(400);
    expect((await app.fetch(submit({ ...VALID, answers: { slides: "https://example.com" } }))).status).toBe(201);
  });

  it("sets the review status and counts it", async () => {
    const { app } = await setup(kind);
    await open(app);
    const { id } = await body<{ id: string }>(await app.fetch(submit(VALID)));
    const res = await app.fetch(send("PATCH", `/lp/proposals/submissions/${id}`, { status: "accepted" }));
    expect(res.status).toBe(200);
    const p = await body<LpProposal>(res);
    expect(p.status).toBe("accepted");
    expect(p.reviewedBy).toBe("usr_admin");
    expect((await body<LpProposalsState>(await app.fetch(get("/lp/proposals")))).totals).toEqual({
      total: 1,
      accepted: 1,
      rejected: 0,
    });
    expect((await app.fetch(send("PATCH", `/lp/proposals/submissions/${id}`, { status: "maybe" }))).status).toBe(400);
    expect((await app.fetch(send("PATCH", "/lp/proposals/submissions/lpp_missing", { status: "rejected" }))).status).toBe(404);
  });

  it("keeps submissions (personal data) away from view-only users", async () => {
    const { app } = await setup(kind, { level: "view" });
    expect((await app.fetch(get("/lp/proposals"))).status).toBe(200);
    expect((await app.fetch(get("/lp/proposals/submissions"))).status).toBe(403);
    expect((await app.fetch(send("PATCH", "/lp/proposals/submissions/x", { status: "accepted" }))).status).toBe(403);
    expect((await app.fetch(send("POST", "/lp/proposals/fields", { fields: [] }))).status).toBe(403);
  });

  it("caps submissions per JST day (429)", async () => {
    const { app } = await setup(kind, { cap: 1 });
    await open(app);
    expect((await app.fetch(submit(VALID))).status).toBe(201);
    expect((await app.fetch(submit(VALID))).status).toBe(429);
  });

  it("caps one sender (clientKey) per JST day without exposing the key", async () => {
    const { app } = await setup(kind);
    await open(app);
    const a = "a".repeat(32);
    for (let i = 0; i < PER_CLIENT_DAILY_CAP; i++) expect((await app.fetch(submit({ ...VALID, clientKey: a }))).status).toBe(201);
    expect((await app.fetch(submit({ ...VALID, clientKey: a }))).status).toBe(429);
    expect((await app.fetch(submit({ ...VALID, clientKey: "b".repeat(32) }))).status).toBe(201);
    const page = await body<LpProposalsPage>(await app.fetch(get("/lp/proposals/submissions")));
    expect(page.items[0]).not.toHaveProperty("clientKey");
  });

  it("clears the reviewer when a proposal goes back to 未対応", async () => {
    const { app } = await setup(kind);
    await open(app);
    const { id } = await body<{ id: string }>(await app.fetch(submit(VALID)));
    await app.fetch(send("PATCH", `/lp/proposals/submissions/${id}`, { status: "accepted" }));
    const back = await body<LpProposal>(await app.fetch(send("PATCH", `/lp/proposals/submissions/${id}`, { status: "submitted" })));
    expect(back.reviewedBy).toBeNull();
  });

  it("pages with a cursor", async () => {
    const { app, clock } = await setup(kind);
    await open(app);
    for (let i = 0; i < 3; i++) {
      clock.set(`2026-10-07T0${3 + i}:00:00.000Z`);
      await app.fetch(submit({ ...VALID, title: `t${i}` }));
    }
    const p1 = await body<LpProposalsPage>(await app.fetch(get("/lp/proposals/submissions?limit=2")));
    expect(p1.items.map((p) => p.title)).toEqual(["t2", "t1"]);
    const p2 = await body<LpProposalsPage>(
      await app.fetch(get(`/lp/proposals/submissions?limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}`)),
    );
    expect(p2.items.map((p) => p.title)).toEqual(["t0"]);
    expect(p2.nextCursor).toBeNull();
  });

  it("hides the internal routes from external callers", async () => {
    const { app } = await setup(kind);
    expect((await app.fetch(get("/lp/internal/proposals"))).status).toBe(404);
  });
});
