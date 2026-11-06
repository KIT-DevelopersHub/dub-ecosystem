// スポンサーのメール連携: 送受信の通知 (live)・紐付け (link)・一括補完 (backfill) の経路と、
// 楽観ロックの競合 (手入力を上書きしない・当て直す)・権限・1 回あたりの呼び出し数を守る。
import { describe, expect, it } from "vitest";
import type { identity, sponsor } from "@dub/types";
import { call, createApp, fakeAuthz, makeDeps } from "./harness";
import type { MailContactsSource } from "../src/sponsor-mail-service";
import type { LeadAutoUpdate } from "../src/sponsor-mail-repo";

const LEADS = "/members/sponsor/leads";
const NOTIFY = "/members/internal/sponsor/mail-activity";

/** mail-gateway の集計の fake。呼ばれた回数と問い合わせを記録する。 */
function fakeMail(contacts: sponsor.MailContactSummary[]): MailContactsSource & { calls: sponsor.MailContactsQuery[] } {
  const calls: sponsor.MailContactsQuery[] = [];
  return {
    calls,
    async query(_ctx, q) {
      calls.push(q);
      const addrs = new Set(q.addresses);
      const doms = new Set(q.domains);
      return contacts.filter((c) => addrs.has(c.address) || doms.has(c.address.split("@")[1]!));
    },
  };
}

async function seed(app: ReturnType<typeof createApp>, leads: sponsor.CreateLeadRequest[]): Promise<sponsor.SponsorLead[]> {
  const res = await call(app, "POST", `${LEADS}/import`, { body: { leads } });
  expect(res.status).toBe(201);
  return res.json.leads;
}

const notify = (app: ReturnType<typeof createApp>, body: sponsor.MailActivityNotice) => call(app, "POST", NOTIFY, { body, internal: true, userId: null });

describe("スポンサー: メールからの自動更新 (live)", () => {
  it("a sent mail to the contact moves 未接触 → 初回連絡 with the JST date, and records which mail did it", async () => {
    const app = createApp(makeDeps());
    const [a] = await seed(app, [{ companyName: "株式会社A", contactEmail: "yamada@a.example.jp／sato@a.example.jp（CC）" }]);
    // 2026-11-04 23:30 JST = 14:30Z
    const res = await notify(app, { direction: "sent", at: "2026-11-04T14:30:00.000Z", counterparts: ["Sato@A.example.jp", "archive@developershub.jp"], mailbox: "suzuki@developershub.jp" });
    expect(res.json).toEqual({ updated: 1 });
    const lead = (await call(app, "GET", `${LEADS}/${a!.id}`)).json;
    expect(lead).toMatchObject({ status: "初回連絡", firstContactOn: "2026-11-04", lastContactOn: "2026-11-04", version: 2 });
    const act = (await call(app, "GET", `${LEADS}/${a!.id}/activity`)).json.activity;
    expect(act).toHaveLength(1);
    expect(act[0]).toMatchObject({ source: "live", direction: "sent", counterpart: "sato@a.example.jp", matchedBy: "email", mailbox: "suzuki@developershub.jp" });
    expect(act[0].changes.map((c: sponsor.LeadFieldChange) => c.field)).toEqual(["status", "firstContactOn", "lastContactOn"]);
  });

  it("a reply moves 初回連絡 → 返信あり; a domain match counts; nothing for free mail, ambiguity or 見送り status", async () => {
    const app = createApp(makeDeps());
    const [a, b, c, d] = await seed(app, [
      { companyName: "A", contactEmail: "yamada@a.example.jp", status: "初回連絡", firstContactOn: "2026-10-01" },
      { companyName: "B", contactEmail: "x@shared.example.jp" },
      { companyName: "C", contactEmail: "y@shared.example.jp" },
      { companyName: "D", contactEmail: "z@d.example.jp", status: "見送り" },
    ]);
    expect((await notify(app, { direction: "received", at: "2026-11-02T01:00:00Z", counterparts: ["boss@a.example.jp"], mailbox: null })).json).toEqual({ updated: 1 });
    expect((await call(app, "GET", `${LEADS}/${a!.id}`)).json).toMatchObject({ status: "返信あり", firstContactOn: "2026-10-01", lastContactOn: "2026-11-02" });
    // 同じドメインが 2 社 → 更新しない。
    expect((await notify(app, { direction: "sent", at: "2026-11-02T01:00:00Z", counterparts: ["new@shared.example.jp"], mailbox: null })).json).toEqual({ updated: 0 });
    expect((await call(app, "GET", `${LEADS}/${b!.id}`)).json.version).toBe(1);
    expect((await call(app, "GET", `${LEADS}/${c!.id}`)).json.version).toBe(1);
    expect((await notify(app, { direction: "sent", at: "2026-11-02T01:00:00Z", counterparts: ["someone@gmail.com"], mailbox: null })).json).toEqual({ updated: 0 });
    // 見送りは日付だけ入り、ステータスはそのまま。
    await notify(app, { direction: "sent", at: "2026-11-02T01:00:00Z", counterparts: ["z@d.example.jp"], mailbox: null });
    expect((await call(app, "GET", `${LEADS}/${d!.id}`)).json).toMatchObject({ status: "見送り", firstContactOn: "2026-11-02" });
  });

  it("is internal-only and validates the notice", async () => {
    const app = createApp(makeDeps());
    const external = await call(app, "POST", NOTIFY, { body: { direction: "sent", at: "2026-11-02T01:00:00Z", counterparts: [] } });
    expect(external.status).toBe(403);
    expect((await notify(app, { direction: "bogus" as never, at: "x", counterparts: [], mailbox: null })).status).toBe(400);
  });

  it("does not clobber a concurrent manual edit: re-reads and re-applies on a version conflict", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const [a] = await seed(app, [{ companyName: "A", contactEmail: "yamada@a.example.jp" }]);
    // 自動更新の保存の直前に、別の人が手で営業担当と次回アクションを保存した。
    const realApply = deps.sponsorMailRepo.applyAutoUpdates.bind(deps.sponsorMailRepo);
    let raced = false;
    deps.sponsorMailRepo.applyAutoUpdates = async (updates: readonly LeadAutoUpdate[]) => {
      if (!raced) {
        raced = true;
        const cur = (await deps.sponsorLeadRepo.getLead(a!.id))!;
        await deps.sponsorLeadRepo.updateLead({ ...cur, owner: "前田", nextAction: "電話する", version: cur.version + 1 }, cur.version);
      }
      return realApply(updates);
    };
    expect((await notify(app, { direction: "sent", at: "2026-11-03T01:00:00Z", counterparts: ["yamada@a.example.jp"], mailbox: null })).json).toEqual({ updated: 1 });
    const lead = (await call(app, "GET", `${LEADS}/${a!.id}`)).json;
    expect(lead).toMatchObject({ owner: "前田", nextAction: "電話する", status: "初回連絡", firstContactOn: "2026-11-03", version: 3 });
    expect((await call(app, "GET", `${LEADS}/${a!.id}/activity`)).json.activity).toHaveLength(1);
  });

  it("gives up after 3 conflicts without writing a partial activity", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const [a] = await seed(app, [{ companyName: "A", contactEmail: "yamada@a.example.jp" }]);
    let attempts = 0;
    deps.sponsorMailRepo.applyAutoUpdates = async (updates) => {
      attempts++;
      return updates.map(() => false);
    };
    expect((await notify(app, { direction: "sent", at: "2026-11-03T01:00:00Z", counterparts: ["yamada@a.example.jp"], mailbox: null })).json).toEqual({ updated: 0 });
    expect(attempts).toBe(3);
    expect((await call(app, "GET", `${LEADS}/${a!.id}/activity`)).json.activity).toEqual([]);
  });
});

describe("スポンサー: メールアドレスの紐付け", () => {
  it("links an address, fills an empty contact email, and applies existing mail at once", async () => {
    const mail = fakeMail([
      { address: "ceo@newco.example.jp", direction: "sent", firstAt: "2026-10-10T03:00:00Z", lastAt: "2026-10-20T03:00:00Z", count: 2 },
      { address: "ceo@newco.example.jp", direction: "received", firstAt: "2026-10-21T03:00:00Z", lastAt: "2026-10-21T03:00:00Z", count: 1 },
    ]);
    const app = createApp(makeDeps({ mailContacts: mail }));
    const [lead] = await seed(app, [{ companyName: "NewCo" }]);
    const res = await call(app, "POST", `${LEADS}/${lead!.id}/mail-links`, { body: { address: " CEO@newco.example.jp ", threadId: "thr_1" } });
    expect(res.status).toBe(201);
    expect(res.json.link).toMatchObject({ leadId: lead!.id, address: "ceo@newco.example.jp", threadId: "thr_1" });
    expect(res.json.lead).toMatchObject({ contactEmail: "ceo@newco.example.jp", status: "返信あり", firstContactOn: "2026-10-10", lastContactOn: "2026-10-21" });
    expect(mail.calls).toEqual([{ addresses: ["ceo@newco.example.jp"], domains: [] }]);
    expect((await call(app, "GET", "/members/sponsor/mail-links")).json.links).toHaveLength(1);
    expect((await call(app, "GET", `${LEADS}/${lead!.id}/activity`)).json.activity[0]).toMatchObject({ source: "link", matchedBy: "link" });
    // 以後このアドレスとのメールはこの営業先 (担当者メールを書き換えても)。
    await call(app, "PATCH", `${LEADS}/${lead!.id}`, { body: { contactEmail: null, expectedVersion: res.json.lead.version } });
    expect((await notify(app, { direction: "received", at: "2026-11-01T03:00:00Z", counterparts: ["ceo@newco.example.jp"], mailbox: null })).json).toEqual({ updated: 1 });
  });

  it("re-linking an address moves it; unlink; rejects our own domain and non-editors", async () => {
    const app = createApp(makeDeps());
    const [a, b] = await seed(app, [{ companyName: "A" }, { companyName: "B", contactEmail: "keep@b.example.jp" }]);
    await call(app, "POST", `${LEADS}/${a!.id}/mail-links`, { body: { address: "x@x.example.jp" } });
    const moved = await call(app, "POST", `${LEADS}/${b!.id}/mail-links`, { body: { address: "x@x.example.jp" } });
    // 担当者メールが入っている営業先は書き換えない (メール集計が無くても紐付けは保存される)。
    expect(moved.json.lead.contactEmail).toBe("keep@b.example.jp");
    const links = (await call(app, "GET", "/members/sponsor/mail-links")).json.links;
    expect(links).toHaveLength(1);
    expect(links[0].leadId).toBe(b!.id);
    expect((await call(app, "DELETE", `/members/sponsor/mail-links/${links[0].id}`)).status).toBe(204);
    expect((await call(app, "DELETE", `/members/sponsor/mail-links/${links[0].id}`)).status).toBe(404);
    expect((await call(app, "POST", `${LEADS}/${a!.id}/mail-links`, { body: { address: "suzuki@developershub.jp" } })).status).toBe(400);
    expect((await call(app, "POST", `${LEADS}/${a!.id}/mail-links`, { body: { address: "a@x.jp, b@y.jp" } })).status).toBe(400);
    const viewer = createApp(makeDeps({ authz: fakeAuthz(new Set<identity.PermissionKey>(["app:sponsor:view", "sponsor:read"])) }));
    expect((await call(viewer, "POST", `${LEADS}/${a!.id}/mail-links`, { body: { address: "x@x.example.jp" } })).status).toBe(403);
  });
});

describe("スポンサー: 既存メールからの一括補完", () => {
  const EDITOR = new Set<identity.PermissionKey>(["app:sponsor:view", "app:sponsor:edit", "sponsor:read", "sponsor:write"]);

  it("dry-run proposes per-lead diffs without writing, then apply writes the same changes", async () => {
    const mail = fakeMail([
      { address: "a@a.example.jp", direction: "sent", firstAt: "2026-09-01T00:00:00Z", lastAt: "2026-10-01T00:00:00Z", count: 4 },
      { address: "other@a.example.jp", direction: "received", firstAt: "2026-10-02T00:00:00Z", lastAt: "2026-10-05T00:00:00Z", count: 2 },
      { address: "b@b.example.jp", direction: "sent", firstAt: "2026-10-01T00:00:00Z", lastAt: "2026-10-01T00:00:00Z", count: 1 },
    ]);
    const app = createApp(makeDeps({ mailContacts: mail }));
    const [a, b] = await seed(app, [
      { companyName: "A", contactEmail: "a@a.example.jp", status: "提案済" },
      { companyName: "B", contactEmail: "b@b.example.jp", firstContactOn: "2026-09-15", lastContactOn: "2026-10-03", status: "返信あり" },
      { companyName: "C" },
    ]);
    const dry = await call(app, "POST", `${LEADS}/mail-backfill`, { body: { dryRun: true } });
    expect(dry.status).toBe(200);
    expect(dry.json).toMatchObject({ dryRun: true, offset: 0, total: 3, nextOffset: null });
    // B は既に早い初回連絡日・遅い最終接触日を持つので変化なし → 提案に出ない。
    expect(dry.json.proposals).toHaveLength(1);
    expect(dry.json.proposals[0]).toMatchObject({
      leadId: a!.id,
      matchedBy: "email",
      changes: [
        { field: "firstContactOn", from: null, to: "2026-09-01" },
        { field: "lastContactOn", from: null, to: "2026-10-05" },
      ],
    });
    expect(dry.json.proposals[0]).not.toHaveProperty("applied");
    expect((await call(app, "GET", `${LEADS}/${a!.id}`)).json.version).toBe(1);

    const run = await call(app, "POST", `${LEADS}/mail-backfill`, { body: { dryRun: false } });
    expect(run.json.proposals).toEqual([expect.objectContaining({ leadId: a!.id, applied: true })]);
    expect((await call(app, "GET", `${LEADS}/${a!.id}`)).json).toMatchObject({ status: "提案済", firstContactOn: "2026-09-01", lastContactOn: "2026-10-05", version: 2 });
    expect((await call(app, "GET", `${LEADS}/${b!.id}`)).json.version).toBe(1);
    // 2 回目は何も変わらない (冪等)。
    expect((await call(app, "POST", `${LEADS}/mail-backfill`, { body: { dryRun: false } })).json.proposals).toEqual([]);
  });

  it("pages by lead id, asks mail-gateway once per page, and only for that page's addresses", async () => {
    const mail = fakeMail([]);
    const app = createApp(makeDeps({ mailContacts: mail }));
    await seed(app, Array.from({ length: 5 }, (_, i) => ({ companyName: `企業${i}`, contactEmail: `c${i}@co${i}.example.jp` })));
    const first = await call(app, "POST", `${LEADS}/mail-backfill`, { body: { dryRun: true, offset: 0, limit: 2 } });
    expect(first.json).toMatchObject({ total: 5, nextOffset: 2, limit: 2 });
    expect(mail.calls).toHaveLength(1);
    expect(mail.calls[0]!.addresses).toHaveLength(2);
    const last = await call(app, "POST", `${LEADS}/mail-backfill`, { body: { dryRun: true, offset: 4, limit: 2 } });
    expect(last.json.nextOffset).toBeNull();
    expect(mail.calls).toHaveLength(2);
  });

  it("skips the mail query for a page with no addresses, and rejects bad paging / missing binding / non-admins", async () => {
    const mail = fakeMail([]);
    const app = createApp(makeDeps({ mailContacts: mail }));
    await seed(app, [{ companyName: "連絡先なし" }]);
    expect((await call(app, "POST", `${LEADS}/mail-backfill`, { body: { dryRun: true } })).json.proposals).toEqual([]);
    expect(mail.calls).toHaveLength(0);
    for (const body of [{}, { dryRun: true, limit: 101 }, { dryRun: true, limit: 0 }, { dryRun: true, offset: -1 }]) {
      expect((await call(app, "POST", `${LEADS}/mail-backfill`, { body })).status).toBe(400);
    }
    expect((await call(createApp(makeDeps()), "POST", `${LEADS}/mail-backfill`, { body: { dryRun: true } })).status).toBe(503);
    const editor = createApp(makeDeps({ mailContacts: mail, authz: fakeAuthz(EDITOR) }));
    expect((await call(editor, "POST", `${LEADS}/mail-backfill`, { body: { dryRun: true } })).status).toBe(403);
  });
});
