// LP スポンサー募集: LP管理 API (/lp/sponsor-inquiries*) + 公開 LP Worker 向け内部 API + 通知。
import { describe, it, expect } from "vitest";
import type { lpSponsor } from "@dub/types";
import { SPONSOR_PER_CLIENT_MAX, renderAckMail } from "../src/sponsor-inquiries";
import { get, makeApp, send, type RepoKind } from "./harness";

const body = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const INTERNAL = { "x-dub-internal": "1" };
const VALID = { companyName: "株式会社カナザワ", contactName: "金沢 花子", email: "hanako@example.com", message: "資料をください" };
const KEY = "a".repeat(32);

async function setup(kind: RepoKind, opts: { publish?: boolean; level?: "view" | "edit"; cap?: number } = {}) {
  const made = await makeApp(kind, opts.level ?? "edit", 5000, null, opts.publish === false ? [] : ["lp:publish"]);
  if (opts.cap !== undefined) made.deps.sponsor.dailyCap = opts.cap;
  return made;
}

const submit = (b: unknown) => send("POST", "/lp/internal/sponsor-inquiries/submit", b, INTERNAL);

async function open(app: Awaited<ReturnType<typeof setup>>["app"]) {
  expect((await app.fetch(send("POST", "/lp/sponsor-inquiries/enabled", { enabled: true }))).status).toBe(200);
}

describe.each<RepoKind>(["memory", "d1"])("sponsor inquiries (%s)", (kind) => {
  it("starts closed; the public page is /sponsors; env default mail is shown", async () => {
    const { app } = await setup(kind);
    const s = await body<lpSponsor.LpSponsorInquiriesState>(await app.fetch(get("/lp/sponsor-inquiries")));
    expect(s).toMatchObject({
      enabled: false,
      publicUrl: "https://hokuriku-it-conf.com/sponsors",
      notifyEmail: null,
      defaultNotifyEmail: "sponsor@example.com",
      totals: { total: 0, open: 0 },
    });
    expect(await body(await app.fetch(get("/lp/internal/sponsor-inquiries", INTERNAL)))).toEqual({ enabled: false });
    expect((await app.fetch(submit(VALID))).status).toBe(404);
  });

  it("publishing and the notify target need lp:publish", async () => {
    const { app } = await setup(kind, { publish: false });
    expect((await app.fetch(send("POST", "/lp/sponsor-inquiries/enabled", { enabled: true }))).status).toBe(403);
    expect((await app.fetch(send("POST", "/lp/sponsor-inquiries/notify", { notifyEmail: null }))).status).toBe(403);
  });

  it("viewers cannot read the list (personal data)", async () => {
    const { app } = await setup(kind, { level: "view", publish: false });
    expect((await app.fetch(get("/lp/sponsor-inquiries"))).status).toBe(200);
    expect((await app.fetch(get("/lp/sponsor-inquiries/items"))).status).toBe(403);
  });

  it("validates the team email; empty clears it", async () => {
    const { app } = await setup(kind);
    expect((await app.fetch(send("POST", "/lp/sponsor-inquiries/notify", { notifyEmail: "x" }))).status).toBe(400);
    const s = await body<lpSponsor.LpSponsorInquiriesState>(
      await app.fetch(send("POST", "/lp/sponsor-inquiries/notify", { notifyEmail: "team@example.com" })),
    );
    expect(s).toMatchObject({ notifyEmail: "team@example.com" });
    expect(s).not.toHaveProperty("notifyChannelId");
    const cleared = await body<lpSponsor.LpSponsorInquiriesState>(
      await app.fetch(send("POST", "/lp/sponsor-inquiries/notify", { notifyEmail: "" })),
    );
    expect(cleared).toMatchObject({ notifyEmail: null });
  });

  it("accepts an inquiry: saves it, notifies app:sponsor:edit holders in Dub, mails the team and acknowledges the requester", async () => {
    const { app, sponsorNotifier } = await setup(kind);
    await open(app);
    await app.fetch(send("POST", "/lp/sponsor-inquiries/notify", { notifyEmail: "team@example.com" }));
    const res = await app.fetch(submit({ ...VALID, clientKey: KEY }));
    expect(res.status).toBe(201);
    const { id } = await body<{ id: string }>(res);

    expect(sponsorNotifier.notifies).toHaveLength(1);
    const n = sponsorNotifier.notifies[0]!;
    expect(n).toMatchObject({
      type: "lp.sponsor_inquiry",
      recipientIds: [],
      recipientPermissions: ["app:sponsor:edit"],
      title: "スポンサーの資料請求が届きました",
      dedupKey: `lp.sponsor_inquiry:${id}`,
      resourceType: "lp_sponsor_inquiry",
      resourceId: id,
    });
    expect(n.body).toContain("会社名: 株式会社カナザワ");
    expect(n.body).toContain("担当者名: 金沢 花子");
    expect(n.body).toContain("メールアドレス: hanako@example.com");
    expect(n.body).toContain("ひとこと: 資料をください");
    const team = sponsorNotifier.mails.find((m) => m.to === "team@example.com")!;
    expect(team.subject).toContain("株式会社カナザワ");
    const ack = sponsorNotifier.mails.find((m) => m.to === "hanako@example.com")!;
    expect(ack).toMatchObject(renderAckMail("hanako@example.com"));
    // 依頼者へのメールに入力文字列は入れない（踏み台対策）。
    expect(ack.textBody).not.toContain("カナザワ");
    expect(ack.textBody).not.toContain("資料をください");

    const page = await body<lpSponsor.LpSponsorInquiriesPage>(await app.fetch(get("/lp/sponsor-inquiries/items")));
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ ...VALID, status: "new", notifiedVia: "both" });
    expect(page.items[0]).not.toHaveProperty("clientKey");
  });

  it("only the email is required; falls back to the env team address", async () => {
    const { app, sponsorNotifier } = await setup(kind);
    await open(app);
    expect((await app.fetch(submit({ email: "" }))).status).toBe(400);
    expect((await app.fetch(submit({ email: "not-mail" }))).status).toBe(400);
    expect((await app.fetch(submit({ email: "a@example.com" }))).status).toBe(201);
    expect(sponsorNotifier.notifies[0]!.body).toContain("会社名: （未記入）");
    expect(sponsorNotifier.mails.map((m) => m.to).sort()).toEqual(["a@example.com", "sponsor@example.com"]);
    const page = await body<lpSponsor.LpSponsorInquiriesPage>(await app.fetch(get("/lp/sponsor-inquiries/items")));
    expect(page.items[0]).toMatchObject({ companyName: "", contactName: "", message: "", notifiedVia: "both" });
  });

  it("records app / mail separately and cuts a long message in the Dub notification", async () => {
    const { app, sponsorNotifier } = await setup(kind);
    await open(app);
    sponsorNotifier.fail = { app: false, mail: true };
    expect((await app.fetch(submit({ ...VALID, message: "あ".repeat(500) }))).status).toBe(201);
    expect(sponsorNotifier.notifies[0]!.body).toContain(`ひとこと: ${"あ".repeat(200)}…`);
    sponsorNotifier.fail = { app: true, mail: false };
    expect((await app.fetch(submit(VALID))).status).toBe(201);
    const page = await body<lpSponsor.LpSponsorInquiriesPage>(await app.fetch(get("/lp/sponsor-inquiries/items")));
    expect(page.items.map((i) => i.notifiedVia).sort()).toEqual(["app", "mail"]);
  });

  it("keeps the inquiry when nothing could be delivered (notifiedVia none)", async () => {
    const { app, sponsorNotifier } = await setup(kind);
    await open(app);
    sponsorNotifier.fail = { app: true, mail: true };
    expect((await app.fetch(submit(VALID))).status).toBe(201);
    const page = await body<lpSponsor.LpSponsorInquiriesPage>(await app.fetch(get("/lp/sponsor-inquiries/items")));
    expect(page.items[0]!.notifiedVia).toBe("none");
  });

  it("caps one sender at 10 per hour, then lets them in again", async () => {
    const { app, clock } = await setup(kind);
    await open(app);
    for (let i = 0; i < SPONSOR_PER_CLIENT_MAX; i++) expect((await app.fetch(submit({ ...VALID, clientKey: KEY }))).status).toBe(201);
    expect((await app.fetch(submit({ ...VALID, clientKey: KEY }))).status).toBe(429);
    // 別の送信元は通る。
    expect((await app.fetch(submit({ ...VALID, clientKey: "b".repeat(32) }))).status).toBe(201);
    clock.set("2026-10-07T04:00:01.000Z");
    expect((await app.fetch(submit({ ...VALID, clientKey: KEY }))).status).toBe(201);
  });

  it("has a daily ceiling across all senders", async () => {
    const { app } = await setup(kind, { cap: 2 });
    await open(app);
    expect((await app.fetch(submit(VALID))).status).toBe(201);
    expect((await app.fetch(submit(VALID))).status).toBe(201);
    expect((await app.fetch(submit(VALID))).status).toBe(429);
  });

  it("tracks status from LP管理 and counts open ones", async () => {
    const { app } = await setup(kind);
    await open(app);
    const { id } = await body<{ id: string }>(await app.fetch(submit(VALID)));
    expect((await app.fetch(send("PATCH", `/lp/sponsor-inquiries/items/${id}`, { status: "bogus" }))).status).toBe(400);
    expect((await app.fetch(send("PATCH", "/lp/sponsor-inquiries/items/nope", { status: "sent" }))).status).toBe(404);
    const saved = await body<lpSponsor.LpSponsorInquiry>(
      await app.fetch(send("PATCH", `/lp/sponsor-inquiries/items/${id}`, { status: "sent" })),
    );
    expect(saved).toMatchObject({ status: "sent", updatedBy: "usr_admin" });
    const s = await body<lpSponsor.LpSponsorInquiriesState>(await app.fetch(get("/lp/sponsor-inquiries")));
    expect(s.totals).toEqual({ total: 1, open: 0 });
  });

  it("pages newest first", async () => {
    const { app, clock } = await setup(kind);
    await open(app);
    for (let i = 0; i < 3; i++) {
      clock.set(`2026-10-07T03:0${i}:00.000Z`);
      await app.fetch(submit({ email: `p${i}@example.com` }));
    }
    const p1 = await body<lpSponsor.LpSponsorInquiriesPage>(await app.fetch(get("/lp/sponsor-inquiries/items?limit=2")));
    expect(p1.items.map((x) => x.email)).toEqual(["p2@example.com", "p1@example.com"]);
    const p2 = await body<lpSponsor.LpSponsorInquiriesPage>(
      await app.fetch(get(`/lp/sponsor-inquiries/items?limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}`)),
    );
    expect(p2.items.map((x) => x.email)).toEqual(["p0@example.com"]);
    expect(p2.nextCursor).toBeNull();
  });
});
