// Deploy → Admin notification SQL builder: one idempotent audience='admin' row per SHA,
// applied against the real aggregated dub-core schema (notif_notifications incl. audience).
import { describe, it, expect } from "vitest";
import { migratedD1 } from "./d1";
import {
  buildDeployNotifyRow,
  buildDeployNotifySql,
  deployDedupKey,
} from "../src/adminNotify";

function rowFor(raw: ReturnType<typeof migratedD1> extends Promise<infer T> ? (T extends { raw: infer R } ? R : never) : never, sha: string) {
  return raw.prepare("SELECT * FROM notif_notifications WHERE dedup_key = ?").get(deployDedupKey(sha)) as
    | Record<string, unknown>
    | undefined;
}

describe("buildDeployNotifyRow", () => {
  it("produces an audience='admin' deploy row keyed by SHA", () => {
    const row = buildDeployNotifyRow({ sha: "abc123def456", title: "usage 刷新", prNumber: 200, services: "全Worker" });
    expect(row.audience).toBe("admin");
    expect(row.type).toBe("deploy.completed");
    expect(row.dedupKey).toBe("deploy:abc123def456");
    expect(row.title).toBe("デプロイ完了: usage 刷新 (#200)");
    expect(row.resourceId).toBe("abc123def456");
    expect(JSON.parse(row.metaJson)).toMatchObject({ sha: "abc123def456", prNumber: 200 });
  });

  it("falls back to a generic title when none is supplied", () => {
    const row = buildDeployNotifyRow({ sha: "deadbeef" });
    expect(row.title).toBe("デプロイ完了: 本番デプロイ");
  });
});

describe("buildDeployNotifySql — applied to dub-core", () => {
  it("inserts exactly one admin row; a re-run (same SHA) is idempotent", async () => {
    const { raw } = await migratedD1();
    const sql = buildDeployNotifySql({ sha: "sha_199", title: "全メトリクス取得の根治", prNumber: 199 });
    raw.exec(sql);
    raw.exec(sql); // re-run same deploy

    const cnt = raw.prepare("SELECT COUNT(*) AS c FROM notif_notifications WHERE dedup_key = ?").get("deploy:sha_199") as { c: number };
    expect(Number(cnt.c)).toBe(1);
    const row = rowFor(raw, "sha_199")!;
    expect(row.audience).toBe("admin");
    expect(row.type).toBe("deploy.completed");
    expect(String(row.title)).toContain("#199");
    // No inbox rows are written by CI — admins get them lazily on read (service side).
    const inbox = raw.prepare("SELECT COUNT(*) AS c FROM notif_inbox").get() as { c: number };
    expect(Number(inbox.c)).toBe(0);
  });

  it("escapes quotes in the title safely (no SQL breakage)", async () => {
    const { raw } = await migratedD1();
    raw.exec(buildDeployNotifySql({ sha: "sha_q", title: "fix mytasks: 'タスクを発行' を admin でも" }));
    const row = rowFor(raw, "sha_q")!;
    expect(String(row.title)).toContain("'タスクを発行'");
  });

  it("distinct SHAs produce distinct rows", async () => {
    const { raw } = await migratedD1();
    raw.exec(buildDeployNotifySql({ sha: "sha_a", title: "A" }));
    raw.exec(buildDeployNotifySql({ sha: "sha_b", title: "B" }));
    const cnt = raw.prepare("SELECT COUNT(*) AS c FROM notif_notifications WHERE audience = 'admin'").get() as { c: number };
    expect(Number(cnt.c)).toBe(2);
  });
});
