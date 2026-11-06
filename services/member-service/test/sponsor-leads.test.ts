// スポンサー営業進捗: CRUD + 楽観ロック + 検証 + 取り込み (全件検証・重複スキップ) + 権限 + D1 の列/バインド。
import { describe, it, expect } from "vitest";
import type { DbClient } from "@dub/db";
import type { identity } from "@dub/types";
import { call, createApp, fakeAuthz, makeDeps } from "./harness";
import { createD1SponsorLeadRepo, type LeadRow } from "../src/sponsor-lead-repo";

const BASE = "/members/sponsor/leads";

describe("スポンサー: 営業進捗", () => {
  it("creates with defaults, trims, and hides internal columns", async () => {
    const app = createApp(makeDeps());
    const res = await call(app, "POST", BASE, { body: { companyName: "  株式会社A ", owner: " 吉田 ", note: "  " } });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ companyName: "株式会社A", owner: "吉田", note: null, status: "未接触", version: 1, expectedAmount: null });
    const list = await call(app, "GET", BASE);
    expect(list.json.leads).toHaveLength(1);
    expect(list.json.leads[0]).not.toHaveProperty("orgId");
    expect(list.json.leads[0]).not.toHaveProperty("archivedAt");
  });

  it.each([
    [{ companyName: "  " }, "companyName"],
    [{ companyName: "A", status: "商談中" }, "status"],
    [{ companyName: "A", plan: "Diamond" }, "plan"],
    [{ companyName: "A", priority: "Z" }, "priority"],
    [{ companyName: "A", firstContactOn: "2026/11/01" }, "firstContactOn"],
    [{ companyName: "A", nextActionOn: "2026-02-31" }, "nextActionOn"],
    [{ companyName: "A", expectedAmount: -1 }, "expectedAmount"],
    [{ companyName: "A", expectedAmount: "300000" }, "expectedAmount"],
    [{ companyName: "A", owner: "x".repeat(201) }, "owner"],
  ])("rejects %j", async (body, field) => {
    const res = await call(createApp(makeDeps()), "POST", BASE, { body });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toContain(field);
  });

  it("updates only the sent fields, clears with null, and 409s on a stale version", async () => {
    const app = createApp(makeDeps());
    const { json: lead } = await call(app, "POST", BASE, { body: { companyName: "A", owner: "吉田", expectedAmount: 300000 } });
    const res = await call(app, "PATCH", `${BASE}/${lead.id}`, { body: { status: "提案済", owner: null, expectedVersion: 1 } });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "提案済", owner: null, expectedAmount: 300000, version: 2 });
    const stale = await call(app, "PATCH", `${BASE}/${lead.id}`, { body: { status: "内諾", expectedVersion: 1 } });
    expect(stale.status).toBe(409);
    const cleared = await call(app, "PATCH", `${BASE}/${lead.id}`, { body: { status: null, expectedVersion: 2 } });
    expect(cleared.status).toBe(400);
  });

  it("soft-deletes: gone from the list and 404 afterwards", async () => {
    const app = createApp(makeDeps());
    const { json: lead } = await call(app, "POST", BASE, { body: { companyName: "A" } });
    expect((await call(app, "DELETE", `${BASE}/${lead.id}`)).status).toBe(204);
    expect((await call(app, "GET", BASE)).json.leads).toEqual([]);
    expect((await call(app, "GET", `${BASE}/${lead.id}`)).status).toBe(404);
  });

  it("imports, skipping companies already registered or repeated (表記ゆれも同じ企業)", async () => {
    const app = createApp(makeDeps());
    await call(app, "POST", BASE, { body: { companyName: "株式会社北陸テック" } });
    const res = await call(app, "POST", `${BASE}/import`, {
      body: { leads: [{ companyName: "（株）北陸テック" }, { companyName: "金沢クラウド", status: "内諾" }, { companyName: "金沢クラウド株式会社" }] },
    });
    expect(res.status).toBe(201);
    expect(res.json.skipped).toBe(2);
    expect(res.json.leads.map((l: { companyName: string }) => l.companyName)).toEqual(["金沢クラウド"]);
    // 貼り直しても増えない。
    const again = await call(app, "POST", `${BASE}/import`, { body: { leads: [{ companyName: "金沢クラウド" }] } });
    expect(again.json).toMatchObject({ leads: [], skipped: 1 });
    expect((await call(app, "GET", BASE)).json.leads).toHaveLength(2);
  });

  it("imports nothing when any row is invalid, and rejects empty / oversized batches", async () => {
    const app = createApp(makeDeps());
    const bad = await call(app, "POST", `${BASE}/import`, { body: { leads: [{ companyName: "A" }, { companyName: "B", status: "?" }] } });
    expect(bad.status).toBe(400);
    expect((await call(app, "GET", BASE)).json.leads).toEqual([]);
    expect((await call(app, "POST", `${BASE}/import`, { body: { leads: [] } })).status).toBe(400);
    const tooMany = Array.from({ length: 501 }, (_, i) => ({ companyName: `社${i}` }));
    expect((await call(app, "POST", `${BASE}/import`, { body: { leads: tooMany } })).status).toBe(400);
  });

  it("gates by the sponsor keys: view can only read, write cannot delete", async () => {
    const VIEW = ["app:sponsor:view", "sponsor:read"] as identity.PermissionKey[];
    const WRITE = [...VIEW, "app:sponsor:edit", "sponsor:write"] as identity.PermissionKey[];
    const seeded = makeDeps();
    const admin = createApp(seeded);
    const { json: lead } = await call(admin, "POST", BASE, { body: { companyName: "A" } });

    const viewer = createApp({ ...seeded, authz: fakeAuthz(new Set(VIEW)) });
    expect((await call(viewer, "GET", BASE)).status).toBe(200);
    expect((await call(viewer, "POST", BASE, { body: { companyName: "B" } })).status).toBe(403);
    expect((await call(viewer, "POST", `${BASE}/import`, { body: { leads: [{ companyName: "B" }] } })).status).toBe(403);
    expect((await call(viewer, "PATCH", `${BASE}/${lead.id}`, { body: { expectedVersion: 1 } })).status).toBe(403);

    const writer = createApp({ ...seeded, authz: fakeAuthz(new Set(WRITE)) });
    expect((await call(writer, "PATCH", `${BASE}/${lead.id}`, { body: { status: "初回連絡", expectedVersion: 1 } })).status).toBe(200);
    expect((await call(writer, "DELETE", `${BASE}/${lead.id}`)).status).toBe(403);
  });
});

describe("createD1SponsorLeadRepo", () => {
  const row: LeadRow = {
    id: "lead_1", orgId: "org_x", companyName: "株式会社A", industry: "IT・SaaS", owner: "吉田", contactName: "山田", contactRole: "部長",
    contactEmail: "a@example.jp／b@example.jp（CC）", source: "紹介", contactType: "個人と直接", evidence: "議事録", priority: "S", plan: "Gold",
    status: "社内検討", firstContactOn: "2026-10-01", lastContactOn: "2026-10-02", nextAction: "資料送付", nextActionOn: "2026-11-01",
    expectedAmount: 300000, confidence: "高", budgetPeriod: "2026年度", decisionPeriod: "12月", note: "メモ", version: 2,
    createdBy: "usr_1", createdByName: "佐藤", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z", archivedAt: null,
  };

  it("round-trips every column through the batched INSERT and SELECT mapping", async () => {
    let stored: Record<string, unknown> | null = null;
    const db = {
      namespace: "member",
      batch: async (stmts: { sql: string; binds: unknown[] }[]) => {
        const { sql, binds } = stmts[0]!;
        const cols = /\(([^)]*)\)\s*VALUES/s.exec(sql)![1]!.split(",").map((c) => c.trim());
        expect((sql.match(/\?/g) ?? []).length).toBe(cols.length);
        expect(binds).toHaveLength(cols.length);
        stored = Object.fromEntries(cols.map((c, i) => [c, binds[i]]));
        return [];
      },
      first: async () => stored,
      all: async () => (stored ? [stored] : []),
    } as unknown as DbClient;
    const repo = createD1SponsorLeadRepo(db);
    await repo.createLeads([row]);
    expect(await repo.getLead("lead_1")).toEqual(row);
    expect(await repo.listLeads("org_x")).toEqual([row]);
  });

  it("updates under the optimistic lock with one bind per placeholder", async () => {
    let binds: unknown[] = [];
    let changes = 1;
    const db = {
      namespace: "member",
      run: async (sql: string, ...b: unknown[]) => {
        expect((sql.match(/\?/g) ?? []).length).toBe(b.length);
        expect(sql).toMatch(/WHERE id = \? AND version = \?/);
        binds = b;
        return { success: true, meta: { changes, durationMs: 0 } };
      },
    } as unknown as DbClient;
    const repo = createD1SponsorLeadRepo(db);
    expect(await repo.updateLead(row, 1)).toBe(true);
    expect(binds.slice(-2)).toEqual(["lead_1", 1]);
    changes = 0;
    expect(await repo.updateLead(row, 1)).toBe(false);
  });
});
