// スポンサーのメール連携の D1 リポジトリを実 SQLite (node:sqlite・実 migration) で確かめる:
// 営業先の UPDATE (楽観ロック) と履歴の INSERT が同じ batch で、UPDATE が当たった時だけ履歴が入ること。
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createDbClient } from "@dub/db";
import { createD1SponsorLeadRepo, type LeadRow } from "../src/sponsor-lead-repo";
import { createD1SponsorMailRepo, type ActivityRow } from "../src/sponsor-mail-repo";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

const migration = (id: string) => readFileSync(new URL(`../../../infra/d1/migrations/member/${id}.sql`, import.meta.url), "utf8");

/** D1 の使う範囲だけの adapter。batch は本物と同じく 1 トランザクション。 */
function makeD1(): D1Database {
  const raw = new DatabaseSync(":memory:");
  raw.exec(migration("0021_sponsor_leads"));
  raw.exec(migration("0024_sponsor_mail_sync"));
  const prepare = (sql: string) => {
    const stmt = raw.prepare(sql);
    let args: unknown[] = [];
    const api = {
      bind(...b: unknown[]) {
        args = b.map((v) => (v === undefined ? null : v));
        return api;
      },
      first: () => stmt.get(...(args as never[])) ?? null,
      all: () => ({ results: stmt.all(...(args as never[])), success: true, meta: {} }),
      run: () => {
        const r = stmt.run(...(args as never[]));
        return { success: true, meta: { changes: Number(r.changes), duration: 0 } };
      },
    };
    return api;
  };
  return {
    prepare,
    batch(stmts: { run: () => unknown }[]) {
      raw.exec("BEGIN");
      try {
        const out = stmts.map((s) => s.run());
        raw.exec("COMMIT");
        return out;
      } catch (err) {
        raw.exec("ROLLBACK");
        throw err;
      }
    },
  } as unknown as D1Database;
}

const lead = (id: string, f: Partial<LeadRow> = {}): LeadRow => ({
  id, orgId: "org_x", companyName: `企業${id}`, industry: null, owner: null, contactName: null, contactRole: null, contactEmail: null, source: null,
  contactType: null, evidence: null, priority: null, plan: null, status: "未接触", firstContactOn: null, lastContactOn: null, proposedOn: null, agreedOn: null,
  nextAction: null, nextActionOn: null, expectedAmount: null, confidence: null, budgetPeriod: null, decisionPeriod: null, note: null, version: 1,
  createdBy: "usr_1", createdByName: null, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", archivedAt: null, ...f,
});

const activity = (id: string, leadId: string): ActivityRow => ({
  id, orgId: "org_x", leadId, source: "live", direction: "sent", mailAt: "2026-11-05T01:00:00.000Z", counterpart: "a@x.example.jp",
  matchedBy: "contact", mailbox: "suzuki@developershub.jp",
  changes: [{ field: "status", from: "未接触", to: "初回連絡" }], createdAt: "2026-11-05T01:00:01.000Z",
});

describe("createD1SponsorMailRepo (real SQLite)", () => {
  it("writes the lead and its activity together, and nothing for a version conflict", async () => {
    const db = createDbClient(makeD1(), { namespace: "member" });
    const leads = createD1SponsorLeadRepo(db);
    const mail = createD1SponsorMailRepo(db);
    await leads.createLeads([lead("l1"), lead("l2", { version: 4 }), lead("l3")]);

    const ok = await mail.applyAutoUpdates([
      { next: lead("l1", { status: "初回連絡", firstContactOn: "2026-11-05", version: 2 }), expectedVersion: 1, activity: activity("a1", "l1") },
      // 誰かが先に保存した (今の version は 4) → 更新も履歴も入らない。
      { next: lead("l2", { status: "初回連絡", version: 2 }), expectedVersion: 1, activity: activity("a2", "l2") },
      { next: lead("l3", { lastContactOn: "2026-11-05", version: 2 }), expectedVersion: 1, activity: activity("a3", "l3") },
    ]);
    expect(ok).toEqual([true, false, true]);
    expect((await leads.getLead("l1"))?.status).toBe("初回連絡");
    expect((await leads.getLead("l2"))?.status).toBe("未接触");
    expect((await mail.listActivity("org_x", "l1")).map((a) => a.id)).toEqual(["a1"]);
    expect(await mail.listActivity("org_x", "l2")).toEqual([]);
    expect((await mail.listActivity("org_x", "l3"))[0]).toMatchObject({ id: "a3", changes: [{ field: "status", from: "未接触", to: "初回連絡" }] });
  });
});
