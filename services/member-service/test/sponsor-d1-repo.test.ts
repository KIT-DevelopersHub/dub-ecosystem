// スポンサー D1 リポジトリ: INSERT の列とバインド数が揃い、書いた行がそのまま読み戻せること、
// UPDATE が楽観ロック (WHERE version = ?) で書くことを守る。
import { describe, expect, it } from "vitest";
import type { DbClient } from "@dub/db";
import { createD1SponsorRepo, type CardRow } from "../src/sponsor-repo";

const row: CardRow = {
  id: "card_1", orgId: "org_x", companyName: "株式会社A", personName: "山田 太郎", department: "営業部", title: "部長",
  email: "taro@a.example", phone: "03-0000-0000", note: "展示会で名刺交換", imageContentType: "image/jpeg", version: 2,
  createdBy: "usr_1", createdByName: "佐藤 花子", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z",
  archivedAt: null,
};

describe("createD1SponsorRepo", () => {
  it("round-trips a card through INSERT columns and SELECT mapping", async () => {
    let stored: Record<string, unknown> | null = null;
    const db = {
      namespace: "member",
      run: async (sql: string, ...binds: unknown[]) => {
        const cols = /\(([^)]*)\)\s*VALUES/s.exec(sql)![1]!.split(",").map((c) => c.trim());
        expect((sql.match(/\?/g) ?? []).length).toBe(cols.length);
        expect(binds).toHaveLength(cols.length);
        stored = Object.fromEntries(cols.map((c, i) => [c, binds[i]]));
        return { success: true, meta: { changes: 1, durationMs: 0 } };
      },
      first: async () => stored,
      all: async () => (stored ? [stored] : []),
      batch: async () => [],
    } as unknown as DbClient;
    const repo = createD1SponsorRepo(db);
    await repo.createCard(row);
    expect(await repo.getCard("card_1")).toEqual(row);
    expect(await repo.listCards("org_x")).toEqual([row]);
  });

  it("updates with one bind per placeholder and reports the version miss", async () => {
    let lastBinds: unknown[] = [];
    let changes = 1;
    const db = {
      namespace: "member",
      run: async (sql: string, ...binds: unknown[]) => {
        expect((sql.match(/\?/g) ?? []).length).toBe(binds.length);
        expect(sql).toMatch(/WHERE id = \? AND version = \?/);
        lastBinds = binds;
        return { success: true, meta: { changes, durationMs: 0 } };
      },
    } as unknown as DbClient;
    const repo = createD1SponsorRepo(db);
    expect(await repo.updateCard({ ...row, version: 3 }, 2)).toBe(true);
    expect(lastBinds.slice(-2)).toEqual(["card_1", 2]);
    changes = 0;
    expect(await repo.updateCard({ ...row, version: 3 }, 2)).toBe(false);
  });
});
