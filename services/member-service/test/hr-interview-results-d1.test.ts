// 面談結果 × 本物の SQLite: 全 migration を当てた DB で、予約 → 合格 (claim → link → complete) と二度押しを通す。
// SQL の列名・バインド数と、applicant_id UNIQUE・占有 (lease_until) が migration と噛み合っていることを守る。
import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createDbClient } from "@dub/db";
import { MEMBER_MIGRATIONS } from "../src/schema";
import { createD1MemberRepo } from "../src/d1-repo";
import { createD1HrRepo } from "../src/hr-repo";
import { createD1HrFormRepo } from "../src/hr-form-repo";
import { createD1HrInterviewRepo } from "../src/hr-interview-repo";
import { createD1HrResultRepo } from "../src/hr-result-repo";
import { call, createApp, makeDeps } from "./harness";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

function makeD1(raw = new DatabaseSync(":memory:")): D1Database {
  for (const m of MEMBER_MIGRATIONS) raw.exec(m.up);
  const norm = (v: unknown) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);
  return {
    prepare(sql: string) {
      const stmt = raw.prepare(sql);
      let args: unknown[] = [];
      const api = {
        bind(...b: unknown[]) {
          args = b.map(norm);
          return api;
        },
        first: async () => stmt.get(...(args as never[])) ?? null,
        all: async () => ({ results: stmt.all(...(args as never[])), success: true, meta: {} }),
        run: async () => {
          const r = stmt.run(...(args as never[]));
          return { success: true, meta: { changes: Number(r.changes), duration: 0 } };
        },
      };
      return api;
    },
    batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => Promise.all(stmts.map((s) => s.run())),
  } as unknown as D1Database;
}

const ANSWERS = {
  last_name: "山田", first_name: "太郎", last_name_kana: "やまだ", first_name_kana: "たろう",
  email: "taro@gmail.com", department: "情報工学科", grade: "2年", interests: ["開発"], motivation: "興味があります", preferred_date: "2026-11-20",
};

function setup() {
  const raw = new DatabaseSync(":memory:");
  const db = createDbClient(makeD1(raw), { namespace: "member" });
  const mails: string[] = [];
  const app = createApp(
    makeDeps({
      repo: createD1MemberRepo(db) as never,
      hrRepo: createD1HrRepo(db),
      hrFormRepo: createD1HrFormRepo(db),
      hrInterviewRepo: createD1HrInterviewRepo(db),
      hrResultRepo: createD1HrResultRepo(db),
      appBaseUrl: "https://app.example",
      sendHrMail: async (_r, m) => {
        mails.push(m.textBody);
      },
    }),
  );
  return { app, mails, raw };
}

describe("面談結果 × D1", () => {
  it("pass: claim → link → complete persists one result row, and a second claim does nothing", async () => {
    const { app, mails, raw } = setup();
    await call(app, "POST", "/members/internal/hr/interview-form", { internal: true, userId: null, body: { answers: ANSWERS } });
    for (let d = 1; d <= 5; d++) {
      await call(app, "POST", "/members/hr/interviews/slots", { body: { slots: [{ startAt: `2026-09-0${d}T05:00:00.000Z`, durationMinutes: 30 }] } });
    }
    const token = decodeURIComponent(/#t=(\S+)/.exec(mails[0]!)![1]!);
    const view = await call(app, "POST", "/members/internal/hr/interview-booking/view", { internal: true, userId: null, body: { token } });
    await call(app, "POST", "/members/internal/hr/interview-booking/book", { internal: true, userId: null, body: { token, slotId: view.json.slots[0].id } });
    const id = (await call(app, "GET", "/members/hr/applicants")).json.applicants[0].id as string;
    const base = `/members/internal/hr/applicants/${id}/interview-result`;

    expect((await call(app, "POST", `${base}/claim`, { internal: true, body: { decision: "pass", reason: "良い" } })).json.proceed).toBe(true);
    expect((await call(app, "POST", `${base}/claim`, { internal: true, body: { decision: "pass", reason: "良い" } })).status).toBe(409);
    const linked = await call(app, "POST", `${base}/link`, { internal: true, body: { identityUserId: "usr_x", address: "taro.yamada@developershub.jp" } });
    expect(linked.json.stage).toBe("hired");
    const done = await call(app, "POST", `${base}/complete`, { internal: true, body: {} });
    expect(done.json.result).toMatchObject({ status: "done", issuedAddress: "taro.yamada@developershub.jp", issuedIdentityUserId: "usr_x" });
    expect(mails.at(-1)).toContain("https://app.example/onboarding");
    expect((await call(app, "POST", `${base}/claim`, { internal: true, body: { decision: "fail", reason: "x" } })).json.proceed).toBe(false);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM member_hr_interview_results").get()).toEqual({ n: 1 });
  });

  it("the backfill migration moves booked-but-scheduling applicants to 面談確定 and is idempotent", () => {
    const raw = new DatabaseSync(":memory:");
    const all = MEMBER_MIGRATIONS;
    const upTo = all.findIndex((m) => m.id === "0027_hr_booked_interview_set");
    for (const m of all.slice(0, upTo)) raw.exec(m.up);
    const ins = raw.prepare(
      `INSERT INTO member_hr_applicants (id, org_id, name, stage, version, created_by, created_at, updated_at) VALUES (?, 'org', ?, 'scheduling', 1, 'u', 't', 't')`,
    );
    ins.run("app_booked", "予約済み");
    ins.run("app_open", "未予約");
    raw.exec(`INSERT INTO member_hr_interview_slots (id, org_id, start_at, end_at, interviewer_id, interviewer_name, applicant_id, booked_at, created_at)
              VALUES ('s1', 'org', '2026-09-01T05:00:00Z', '2026-09-01T05:30:00Z', 'u', '担当', 'app_booked', 't', 't')`);
    raw.exec(all[upTo]!.up);
    raw.exec(all[upTo]!.up);
    const rows = raw.prepare("SELECT id, stage, version FROM member_hr_applicants ORDER BY id").all();
    expect(rows).toEqual([
      { id: "app_booked", stage: "interview_set", version: 2 },
      { id: "app_open", stage: "scheduling", version: 1 },
    ]);
  });
});
