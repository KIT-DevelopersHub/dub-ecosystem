// 会計: 発行者情報の保存 (検査・正規化・楽観ロック) と、領収書が読む内部口。D1 は実 SQLite + 実 migration で往復する。
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { DbClient } from "@dub/db";
import { createD1AccountingRepo, type IssuerRow } from "../src/accounting-repo";
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
