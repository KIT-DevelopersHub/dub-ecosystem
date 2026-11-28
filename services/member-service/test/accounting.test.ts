// 会計: 発行者情報の保存 (検査・正規化・楽観ロック) と、領収書が読む内部口。D1 は実 SQLite + 実 migration で往復する。
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { DbClient } from "@dub/db";
import { createD1AccountingRepo, type IssuerRow, type PrivacyPolicyRow } from "../src/accounting-repo";
import { MEMBER_MIGRATIONS } from "../src/schema";
import { call, createApp, makeDeps } from "./harness";

const NOW = () => "2026-11-26T00:00:00.000Z";
const BASE = {
  name: "一般社団法人 Developers Hub",
  officeName: "北陸ITカンファレンス 事務局",
  postalCode: "９２０１２３４",
  address: "石川県金沢市〇〇町 1-2-3",
  phone: "",
  email: "info@developershub.jp",
  url: "https://developershub.jp",
  invoiceRegistrationNo: "t 7000-0120-50002",
  taxRatePercent: 10,
};

describe("会計 発行者情報", () => {
  it("starts empty, saves normalized values, and serves them to the internal reader", async () => {
    const app = createApp(makeDeps({ now: NOW }));
    expect((await call(app, "GET", "/members/accounting/issuer")).json).toEqual({ issuer: null });

    const saved = await call(app, "PUT", "/members/accounting/issuer", { body: { ...BASE, expectedVersion: 0 } });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({
      postalCode: "920-1234",
      invoiceRegistrationNo: "T7000012050002",
      phone: null,
      version: 1,
      updatedBy: "user_caller",
      updatedAt: NOW(),
      warnings: [],
    });
    const { warnings: _w, ...savedIssuer } = saved.json;

    const got = await call(app, "GET", "/members/accounting/issuer");
    expect(got.json.issuer).toEqual(savedIssuer);
    const internal = await call(app, "GET", "/members/internal/accounting/issuer", { internal: true, userId: null });
    expect(internal.status).toBe(200);
    expect(internal.json.issuer).toEqual(savedIssuer);
  });

  it("rejects a malformed registration number / postal code / rate with field errors", async () => {
    const app = createApp(makeDeps({ now: NOW }));
    const bad = await call(app, "PUT", "/members/accounting/issuer", {
      body: { ...BASE, invoiceRegistrationNo: "T123", postalCode: "92-1", taxRatePercent: 5, name: " ", expectedVersion: 0 },
    });
    expect(bad.status).toBe(400);
    const fields = (bad.json.error.details as { field: string; reason: string }[]).map((d) => `${d.field}:${d.reason}`).sort();
    expect(fields).toEqual(["invoiceRegistrationNo:invalid", "name:required", "postalCode:invalid", "taxRatePercent:invalid"]);
    expect((await call(app, "GET", "/members/accounting/issuer")).json.issuer).toBeNull();
  });

  it("saves a number whose check digit does not match, with a check_digit warning (個人事業者の番号を止めない)", async () => {
    const app = createApp(makeDeps({ now: NOW }));
    const res = await call(app, "PUT", "/members/accounting/issuer", { body: { ...BASE, invoiceRegistrationNo: "T1234567890123", expectedVersion: 0 } });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ invoiceRegistrationNo: "T1234567890123", version: 1, warnings: ["check_digit"] });
    expect((await call(app, "GET", "/members/accounting/issuer")).json.issuer).toMatchObject({ invoiceRegistrationNo: "T1234567890123", version: 1 });
  });

  it("requires expectedVersion and loses the optimistic lock to a newer save", async () => {
    const app = createApp(makeDeps({ now: NOW }));
    expect((await call(app, "PUT", "/members/accounting/issuer", { body: BASE })).status).toBe(400);
    expect((await call(app, "PUT", "/members/accounting/issuer", { body: { ...BASE, expectedVersion: 0 } })).status).toBe(200);
    const stale = await call(app, "PUT", "/members/accounting/issuer", { body: { ...BASE, expectedVersion: 0 } });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("ACCOUNTING_VERSION_CONFLICT");
    const next = await call(app, "PUT", "/members/accounting/issuer", { body: { ...BASE, taxRatePercent: 8, expectedVersion: 1 } });
    expect(next.json).toMatchObject({ version: 2, taxRatePercent: 8 });
  });

  it("the internal reader is not reachable from outside", async () => {
    const app = createApp(makeDeps({ now: NOW }));
    expect((await call(app, "GET", "/members/internal/accounting/issuer")).status).toBe(403);
  });
});

describe("createD1AccountingRepo", () => {
  it("round-trips a row with create-once + optimistic lock", async () => {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    type Bind = string | number | null;
    const raw = new DatabaseSync(":memory:");
    for (const m of MEMBER_MIGRATIONS) raw.exec(m.up);
    const db = {
      namespace: "member",
      first: async (sql: string, ...b: Bind[]) => raw.prepare(sql).get(...b) ?? null,
      all: async (sql: string, ...b: Bind[]) => raw.prepare(sql).all(...b),
      run: async (sql: string, ...b: Bind[]) => {
        const r = raw.prepare(sql).run(...b);
        return { success: true, meta: { changes: Number(r.changes), durationMs: 0 } };
      },
    } as unknown as DbClient;
    const repo = createD1AccountingRepo(db);
    const row: IssuerRow = {
      orgId: "org_x", name: "法人", officeName: null, postalCode: "920-0000", address: null, phone: null,
      email: null, url: null, invoiceRegistrationNo: "T7000012050002", taxRatePercent: 10,
      version: 1, updatedBy: "usr_1" as IssuerRow["updatedBy"], updatedByName: "佐藤", updatedAt: NOW(),
    };
    expect(await repo.getIssuer("org_x")).toBeNull();
    expect(await repo.saveIssuer(row, 0)).toBe(true);
    expect(await repo.saveIssuer(row, 0)).toBe(false);
    expect(await repo.getIssuer("org_x")).toEqual(row);
    expect(await repo.saveIssuer({ ...row, version: 3, name: "変更" }, 2)).toBe(false);
    const next = { ...row, version: 2, name: "変更", officeName: "事務局" };
    expect(await repo.saveIssuer(next, 1)).toBe(true);
    expect(await repo.getIssuer("org_x")).toEqual(next);
  });
});

describe("会計 プライバシーポリシー", () => {
  const BODY = "## 1. 取得する情報\r\n\r\n- 氏名\r\n  ";

  it("starts empty, saves versions with history, and serves only body + date to the LP", async () => {
    const app = createApp(makeDeps({ now: NOW }));
    expect((await call(app, "GET", "/members/accounting/privacy-policy")).json).toEqual({ policy: null, history: [] });
    expect((await call(app, "GET", "/members/internal/accounting/privacy-policy", { internal: true, userId: null })).json).toEqual({ policy: null });

    const first = await call(app, "PUT", "/members/accounting/privacy-policy", { body: { body: BODY, expectedVersion: 0 } });
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ body: "## 1. 取得する情報\n\n- 氏名", version: 1, updatedBy: "user_caller", updatedByName: null, updatedAt: NOW() });
    const second = await call(app, "PUT", "/members/accounting/privacy-policy", { body: { body: "改定", expectedVersion: 1 } });
    expect(second.json).toMatchObject({ body: "改定", version: 2 });

    const got = await call(app, "GET", "/members/accounting/privacy-policy");
    expect(got.json.policy).toEqual(second.json);
    expect(got.json.history.map((h: { version: number }) => h.version)).toEqual([2, 1]);
    expect(Object.keys(got.json.history[0]).sort()).toEqual(["updatedAt", "updatedByName", "version"]);

    const pub = await call(app, "GET", "/members/internal/accounting/privacy-policy", { internal: true, userId: null });
    expect(pub.json).toEqual({ policy: { body: "改定", updatedAt: NOW() } });
  });

  it("rejects an empty / too long body and a stale version", async () => {
    const app = createApp(makeDeps({ now: NOW }));
    const empty = await call(app, "PUT", "/members/accounting/privacy-policy", { body: { body: "  \n ", expectedVersion: 0 } });
    expect(empty.status).toBe(400);
    expect(empty.json.error.details).toEqual([{ field: "body", reason: "required" }]);
    const long = await call(app, "PUT", "/members/accounting/privacy-policy", { body: { body: "あ".repeat(20_001), expectedVersion: 0 } });
    expect(long.json.error.details).toEqual([{ field: "body", reason: "too_long" }]);
    expect((await call(app, "PUT", "/members/accounting/privacy-policy", { body: { body: "x" } })).status).toBe(400);
    expect((await call(app, "PUT", "/members/accounting/privacy-policy", { body: { body: "x", expectedVersion: 0 } })).status).toBe(200);
    const stale = await call(app, "PUT", "/members/accounting/privacy-policy", { body: { body: "y", expectedVersion: 0 } });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("ACCOUNTING_PRIVACY_POLICY_VERSION_CONFLICT");
  });

  it("the internal reader is not reachable from outside", async () => {
    const app = createApp(makeDeps({ now: NOW }));
    expect((await call(app, "GET", "/members/internal/accounting/privacy-policy")).status).toBe(403);
  });
});

describe("createD1AccountingRepo privacy policy", () => {
  it("appends versions only on top of the expected latest one", async () => {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    type Bind = string | number | null;
    const raw = new DatabaseSync(":memory:");
    for (const m of MEMBER_MIGRATIONS) raw.exec(m.up);
    const db = {
      namespace: "member",
      first: async (sql: string, ...b: Bind[]) => raw.prepare(sql).get(...b) ?? null,
      all: async (sql: string, ...b: Bind[]) => raw.prepare(sql).all(...b),
      run: async (sql: string, ...b: Bind[]) => {
        const r = raw.prepare(sql).run(...b);
        return { success: true, meta: { changes: Number(r.changes), durationMs: 0 } };
      },
    } as unknown as DbClient;
    const repo = createD1AccountingRepo(db);
    const v1: PrivacyPolicyRow = { orgId: "org_x", body: "初版", version: 1, updatedBy: "usr_1" as PrivacyPolicyRow["updatedBy"], updatedByName: "佐藤", updatedAt: NOW() };
    expect(await repo.getPrivacyPolicy("org_x")).toBeNull();
    expect(await repo.addPrivacyPolicy({ ...v1, version: 2 }, 1)).toBe(false);
    expect(await repo.addPrivacyPolicy(v1, 0)).toBe(true);
    expect(await repo.addPrivacyPolicy({ ...v1, body: "別" }, 0)).toBe(false);
    const v2 = { ...v1, version: 2, body: "改定", updatedByName: null };
    expect(await repo.addPrivacyPolicy(v2, 1)).toBe(true);
    expect(await repo.getPrivacyPolicy("org_x")).toEqual(v2);
    expect(await repo.getPrivacyPolicy("org_other")).toBeNull();
    expect(await repo.listPrivacyPolicyHistory("org_x", 1)).toEqual([{ version: 2, updatedByName: null, updatedAt: NOW() }]);
    expect((await repo.listPrivacyPolicyHistory("org_x", 20)).map((h) => h.version)).toEqual([2, 1]);
  });
});
