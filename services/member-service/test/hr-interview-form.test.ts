// 人事: 面談申し込みフォーム — 定義の編集 (楽観ロック・検証) / 公開受付 → 応募者 (面談日程調整中) /
// 同じメールの重複防止 / 代理入力 / 受付終了 / 回答一覧 / 権限。
import { describe, it, expect } from "vitest";
import { hrForm, type identity } from "@dub/types";
import { call, createApp, fakeAuthz, makeDeps } from "./harness";

type App = ReturnType<typeof createApp>;

const ANSWERS = {
  name: " 山田 太郎 ",
  name_kana: "やまだ たろう",
  email: "Taro@Example.com",
  department: "情報工学科",
  grade: "2年",
  interests: ["開発", "広報"],
  motivation: "ハッカソンの運営をやってみたい",
  preferred_date: "2026-11-20",
};

async function publicSubmit(app: App, answers: Record<string, unknown> = ANSWERS) {
  return call(app, "POST", "/members/internal/hr/interview-form", { internal: true, userId: null, body: { answers } });
}

async function saveForm(app: App, patch: Partial<hrForm.SaveInterviewFormRequest> = {}) {
  const cur = (await call(app, "GET", "/members/hr/interview-form")).json as hrForm.InterviewForm;
  return call(app, "PUT", "/members/hr/interview-form", {
    body: {
      title: cur.title,
      description: cur.description,
      questions: cur.questions,
      accepting: cur.accepting,
      expectedVersion: cur.version,
      ...patch,
    },
  });
}

describe("人事: 面談申し込みフォームの定義", () => {
  it("returns the default form (version 0) until saved, and the public read omits edit metadata", async () => {
    const app = createApp(makeDeps());
    const form = await call(app, "GET", "/members/hr/interview-form");
    expect(form.status).toBe(200);
    expect(form.json).toMatchObject({ version: 0, accepting: true, updatedBy: null, title: "面談申し込みフォーム" });
    expect(hrForm.validateFormDefinition(form.json)).toEqual([]);

    const pub = await call(app, "GET", "/members/internal/hr/interview-form", { internal: true, userId: null });
    expect(pub.status).toBe(200);
    expect(Object.keys(pub.json).sort()).toEqual(["accepting", "description", "questions", "title"]);
  });

  it("saves edits with optimistic locking and normalizes whitespace", async () => {
    const app = createApp(makeDeps());
    const cur = (await call(app, "GET", "/members/hr/interview-form")).json as hrForm.InterviewForm;
    const questions = [
      ...cur.questions,
      { id: "q_club", type: "dropdown", label: " 所属サークル ", description: "", required: false, options: [" なし ", "軽音"], binding: null },
    ];
    const saved = await saveForm(app, { title: "  面談に申し込む ", questions: questions as hrForm.FormQuestion[] });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ version: 1, title: "面談に申し込む", updatedBy: "user_caller" });
    expect(saved.json.questions.at(-1)).toEqual({
      id: "q_club", type: "dropdown", label: "所属サークル", description: null, required: false, options: ["なし", "軽音"], binding: null,
    });

    // 古い version (0) での保存は 409。
    const stale = await call(app, "PUT", "/members/hr/interview-form", {
      body: { title: "x", questions: cur.questions, accepting: true, expectedVersion: 0 },
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("HR_FORM_VERSION_CONFLICT");

    const again = await saveForm(app, { accepting: false });
    expect(again.json).toMatchObject({ version: 2, accepting: false });
  });

  it("rejects a form without the email question (氏名・メールは必須)", async () => {
    const app = createApp(makeDeps());
    const cur = (await call(app, "GET", "/members/hr/interview-form")).json as hrForm.InterviewForm;
    const res = await saveForm(app, { questions: cur.questions.filter((q) => q.binding !== "email") });
    expect(res.status).toBe(400);
  });
});

describe("人事: 面談申し込みフォームの回答", () => {
  it("a public submission registers an applicant in 面談日程調整中 and ties the answers to them", async () => {
    const app = createApp(makeDeps());
    const res = await publicSubmit(app);
    expect(res.status).toBe(201);
    expect(res.json.accepted).toBe(true);

    const list = await call(app, "GET", "/members/hr/applicants");
    expect(list.json.applicants).toHaveLength(1);
    const a = list.json.applicants[0];
    expect(a).toMatchObject({
      name: "山田 太郎",
      nameKana: "やまだ たろう",
      email: "taro@example.com",
      department: "情報工学科",
      grade: "2年",
      motivation: "ハッカソンの運営をやってみたい",
      source: hrForm.SOURCE_PUBLIC,
      stage: "scheduling",
      createdBy: "system:public-hr-interview-form",
    });

    // 既存フローにそのまま乗る: 面談確定へ動かせる。
    const moved = await call(app, "POST", `/members/hr/applicants/${a.id}/stage`, { body: { stage: "interview_set", expectedVersion: a.version } });
    expect(moved.status).toBe(200);

    const responses = await call(app, "GET", `/members/hr/interview-form/responses?applicantId=${a.id}`);
    expect(responses.status).toBe(200);
    expect(responses.json.responses).toHaveLength(1);
    expect(responses.json.responses[0]).toMatchObject({
      applicantId: a.id,
      applicantName: "山田 太郎",
      via: "public",
      answers: { interests: ["開発", "広報"], preferred_date: "2026-11-20" },
    });
    expect(responses.json.responses[0].questions.length).toBeGreaterThan(0);
  });

  it("validates answers with field errors", async () => {
    const app = createApp(makeDeps());
    const res = await publicSubmit(app, { name: "", email: "nope", grade: "9年" });
    expect(res.status).toBe(400);
    const fields = res.json.error.details.map((f: { field: string }) => f.field);
    expect(fields).toEqual(expect.arrayContaining(["answers.name", "answers.email", "answers.grade"]));
    expect((await call(app, "GET", "/members/hr/applicants")).json.applicants).toHaveLength(0);
  });

  it("does not create a duplicate for the same email while still before a decision", async () => {
    const app = createApp(makeDeps());
    await publicSubmit(app);
    const second = await publicSubmit(app, { ...ANSWERS, email: "taro@example.com", motivation: "追記です" });
    expect(second.status).toBe(201);
    const list = await call(app, "GET", "/members/hr/applicants");
    expect(list.json.applicants).toHaveLength(1);
    expect(list.json.applicants[0].latestNote).toBe("面談申し込みフォームに再度回答がありました");
    const responses = await call(app, "GET", "/members/hr/interview-form/responses");
    expect(responses.json.responses).toHaveLength(2);

    // 不採用になった人がもう一度申し込んだら新しい応募者として入る。
    const a = list.json.applicants[0];
    await call(app, "POST", `/members/hr/applicants/${a.id}/stage`, { body: { stage: "rejected", expectedVersion: a.version } });
    await publicSubmit(app);
    expect((await call(app, "GET", "/members/hr/applicants")).json.applicants).toHaveLength(2);
  });

  it("closes public submissions when accepting=false, but staff can still enter on someone's behalf", async () => {
    const app = createApp(makeDeps());
    await saveForm(app, { accepting: false });
    const closed = await publicSubmit(app);
    expect(closed.status).toBe(409);
    expect(closed.json.error.code).toBe("HR_FORM_CLOSED");

    const staff = await call(app, "POST", "/members/hr/interview-form/responses", { userId: "user_hr", body: { answers: ANSWERS } });
    expect(staff.status).toBe(201);
    expect(staff.json).toMatchObject({ deduped: false, response: { via: "staff", submittedBy: "user_hr" } });
    const detail = await call(app, "GET", `/members/hr/applicants/${staff.json.applicantId}`);
    expect(detail.json.applicant).toMatchObject({ source: hrForm.SOURCE_STAFF, stage: "scheduling", createdBy: "user_hr" });
  });

  it("keeps answers readable after the form is edited (questions are snapshotted)", async () => {
    const app = createApp(makeDeps());
    await publicSubmit(app);
    const cur = (await call(app, "GET", "/members/hr/interview-form")).json as hrForm.InterviewForm;
    await saveForm(app, { questions: cur.questions.filter((q) => q.id !== "interests") });
    const responses = await call(app, "GET", "/members/hr/interview-form/responses");
    const r = responses.json.responses[0];
    expect(r.questions.map((q: { id: string }) => q.id)).toContain("interests");
    expect(r.answers.interests).toEqual(["開発", "広報"]);
  });

  it("keeps the answers of a deleted applicant (no name) and lets the same email apply again", async () => {
    const app = createApp(makeDeps());
    await publicSubmit(app);
    const firstId = (await call(app, "GET", "/members/hr/applicants")).json.applicants[0].id as string;
    expect((await call(app, "DELETE", `/members/hr/applicants/${firstId}`)).status).toBe(200);
    const responses = await call(app, "GET", "/members/hr/interview-form/responses");
    expect(responses.json.responses).toHaveLength(1);
    expect(responses.json.responses[0]).toMatchObject({ applicantId: firstId, applicantName: null });

    await publicSubmit(app);
    const list = (await call(app, "GET", "/members/hr/applicants")).json.applicants;
    expect(list).toHaveLength(1);
    expect(list[0].id).not.toBe(firstId);
  });
});

describe("人事: 面談申し込みフォームの権限", () => {
  const viewer: identity.PermissionKey[] = ["app:hr:view", "hr:read"];

  it("a viewer can read the form and responses but not edit or enter on behalf", async () => {
    const app = createApp(makeDeps({ authz: fakeAuthz(new Set(viewer)) }));
    expect((await call(app, "GET", "/members/hr/interview-form")).status).toBe(200);
    expect((await call(app, "GET", "/members/hr/interview-form/responses")).status).toBe(200);
    expect((await saveForm(app)).status).toBe(403);
    expect((await call(app, "POST", "/members/hr/interview-form/responses", { body: { answers: ANSWERS } })).status).toBe(403);
  });

  it("the internal (public) routes require the s2s marker", async () => {
    const app = createApp(makeDeps());
    expect((await call(app, "GET", "/members/internal/hr/interview-form", { userId: null })).status).toBe(403);
    expect((await call(app, "POST", "/members/internal/hr/interview-form", { userId: null, body: { answers: ANSWERS } })).status).toBe(403);
  });
});
