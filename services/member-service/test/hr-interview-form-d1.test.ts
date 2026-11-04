// 面談申し込みフォーム × 本物の SQLite: member の全 migration (0019 含む) を当てた DB に、D1 リポジトリ
// (名簿・人事・フォーム) を結んだアプリで「定義を保存 → 公開受付 → 応募者 + 回答」を通す。
// SQL の列名・バインド数・JSON 列・楽観ロックが migration と噛み合っていることを守る。
import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createDbClient } from "@dub/db";
import type { hrForm } from "@dub/types";
import { MEMBER_MIGRATIONS } from "../src/schema";
import { createD1MemberRepo } from "../src/d1-repo";
import { createD1HrRepo } from "../src/hr-repo";
import { createD1HrFormRepo } from "../src/hr-form-repo";
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

describe("面談申し込みフォーム (D1 / SQLite)", () => {
  it("saves the form, accepts a public submission and reads it back", async () => {
    const db = createDbClient(makeD1(), { namespace: "member" });
    const app = createApp(
      makeDeps({ repo: createD1MemberRepo(db) as never, hrRepo: createD1HrRepo(db), hrFormRepo: createD1HrFormRepo(db) }),
    );

    const cur = (await call(app, "GET", "/members/hr/interview-form")).json as hrForm.InterviewForm;
    expect(cur.version).toBe(0);
    const save = (expectedVersion: number, accepting: boolean) =>
      call(app, "PUT", "/members/hr/interview-form", {
        body: { title: cur.title, description: cur.description, questions: cur.questions, accepting, expectedVersion },
      });
    expect((await save(0, true)).json.version).toBe(1);
    expect((await save(0, true)).status).toBe(409);
    const v2 = await save(1, true);
    expect(v2.json).toMatchObject({ version: 2, accepting: true });
    expect((await call(app, "GET", "/members/hr/interview-form")).json.questions).toEqual(cur.questions);

    const sub = await call(app, "POST", "/members/internal/hr/interview-form", {
      internal: true,
      userId: null,
      body: { answers: { name: "佐藤 花", email: "hana@example.com", interests: ["開発"] } },
    });
    expect(sub.status).toBe(201);

    const applicants = (await call(app, "GET", "/members/hr/applicants")).json.applicants;
    expect(applicants).toHaveLength(1);
    expect(applicants[0]).toMatchObject({ name: "佐藤 花", email: "hana@example.com", stage: "scheduling" });

    const responses = (await call(app, "GET", `/members/hr/interview-form/responses?applicantId=${applicants[0].id}`)).json.responses;
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ applicantName: "佐藤 花", via: "public", answers: { interests: ["開発"] } });
    expect(responses[0].questions).toEqual(cur.questions);
  });
});
