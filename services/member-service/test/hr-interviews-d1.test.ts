// 面談の日程調整 × 本物の SQLite: 全 migration を当てた DB で、申し込み → 候補が揃ってメール → 予約 → 取り消しを通す。
// SQL の列名・バインド数と、同時押しを 1 人に絞る部分 UNIQUE が migration と噛み合っていることを守る。
import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createDbClient } from "@dub/db";
import { MEMBER_MIGRATIONS } from "../src/schema";
import { createD1MemberRepo } from "../src/d1-repo";
import { createD1HrRepo } from "../src/hr-repo";
import { createD1HrFormRepo } from "../src/hr-form-repo";
import { createD1HrInterviewRepo } from "../src/hr-interview-repo";
import { call, createApp, makeDeps } from "./harness";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

function makeD1(): D1Database {
  const raw = new DatabaseSync(":memory:");
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
  email: "taro@example.com", department: "情報工学科", grade: "2年", interests: ["開発"], motivation: "興味があります", preferred_date: "2026-11-20",
};

function setup() {
  const db = createDbClient(makeD1(), { namespace: "member" });
  const mails: string[] = [];
  const hrInterviewRepo = createD1HrInterviewRepo(db);
  const app = createApp(
    makeDeps({
      repo: createD1MemberRepo(db) as never,
      hrRepo: createD1HrRepo(db),
      hrFormRepo: createD1HrFormRepo(db),
      hrInterviewRepo,
      appBaseUrl: "https://app.example",
      sendHrMail: async (_r, m) => {
        mails.push(m.textBody);
      },
    }),
  );
  const apply = (email: string) =>
    call(app, "POST", "/members/internal/hr/interview-form", { internal: true, userId: null, body: { answers: { ...ANSWERS, email } } });
  const slot = (day: number) =>
    call(app, "POST", "/members/hr/interviews/slots", { body: { slots: [{ startAt: `2026-09-0${day}T05:00:00.000Z`, durationMinutes: 45 }] } });
  const book = (token: string, slotId: string) =>
    call(app, "POST", "/members/internal/hr/interview-booking/book", { internal: true, userId: null, body: { token, slotId } });
  const tokenOf = (body: string) => decodeURIComponent(/#t=(\S+)/.exec(body)![1]!);
  return { app, mails, apply, slot, book, tokenOf, hrInterviewRepo };
}

describe("面談の日程調整 (D1 / SQLite)", () => {
  it("holds, releases, books, refuses a second booking, and releases the slot", async () => {
    const { app, mails, apply, slot, book, tokenOf } = setup();
    await apply("taro@example.com");
    await apply("hanako@example.com");
    expect((await call(app, "PUT", "/members/hr/interviews/settings", { body: { minOpenSlots: 2 } })).status).toBe(200);
    expect((await call(app, "PUT", "/members/hr/interviews/settings", { body: { minOpenSlots: 3 } })).json.settings.minOpenSlots).toBe(3);
    await slot(1);
    await slot(2);
    expect(mails).toHaveLength(0);
    expect((await slot(1)).json.slots).toHaveLength(2); // 自分の枠と重なるので増えない
    await slot(3);
    expect(mails).toHaveLength(2);

    const [taro, hanako] = mails.map(tokenOf) as [string, string];
    const view = await call(app, "POST", "/members/internal/hr/interview-booking/view", { internal: true, userId: null, body: { token: taro } });
    const [a, b] = view.json.slots;
    expect((await book(taro, a.id)).status).toBe(200);
    expect((await book(hanako, a.id)).json.error.code).toBe("HR_SLOT_TAKEN");

    const over = (await call(app, "GET", "/members/hr/interviews")).json;
    expect(over).toMatchObject({ openSlotCount: 2, heldCount: 0 });
    expect(over.slots[0]).toMatchObject({ applicantName: "山田 太郎", interviewerName: "担当者" });
    expect(over.invites.map((i: { status: string }) => i.status).sort()).toEqual(["booked", "sent"]);

    expect((await call(app, "DELETE", `/members/hr/interviews/slots/${a.id}`)).status).toBe(409);
    expect((await call(app, "POST", `/members/hr/interviews/slots/${a.id}/release`)).status).toBe(200);
    expect((await call(app, "DELETE", `/members/hr/interviews/slots/${b.id}`)).status).toBe(200);
    const left = (await call(app, "POST", "/members/hr/interviews/slots/delete", { body: { ids: [a.id] } })).json.slots;
    expect(left).toHaveLength(1);
  });

  it("adds a whole dragged week in one batch", async () => {
    const { app } = setup();
    const slots = Array.from({ length: 168 }, (_, i) => ({
      startAt: new Date(Date.parse("2026-09-01T00:00:00.000Z") + i * 30 * 60_000).toISOString(),
      durationMinutes: 30,
    }));
    const res = await call(app, "POST", "/members/hr/interviews/slots", { body: { slots } });
    expect(res.status).toBe(201);
    expect(res.json.slots).toHaveLength(168);
    const ids = res.json.slots.map((s: { id: string }) => s.id);
    expect((await call(app, "POST", "/members/hr/interviews/slots/delete", { body: { ids } })).json.slots).toHaveLength(0);
  });

  it("the partial UNIQUE stops one applicant from holding two slots, even past the service's stage check", async () => {
    const { app, apply, slot, hrInterviewRepo } = setup();
    await apply("taro@example.com");
    await slot(1);
    await slot(2);
    const { slots, invites } = (await call(app, "GET", "/members/hr/interviews")).json;
    const applicantId = invites[0].applicantId;
    expect(await hrInterviewRepo.bookSlot(slots[0].id, applicantId, "2026-08-12T00:00:00.000Z")).toBe(true);
    expect(await hrInterviewRepo.bookSlot(slots[1].id, applicantId, "2026-08-12T00:00:00.000Z")).toBe(false);
  });
});
