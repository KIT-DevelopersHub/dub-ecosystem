// 人事: 面談結果の登録 — 予約で 面談確定 / 合格・不合格 / 二度押し / メール本文。
// api-gateway が呼ぶ INTERNAL の claim → link → complete を直接たたく (発行そのものは gateway 側のテスト)。
import { describe, it, expect } from "vitest";
import { hrResult } from "@dub/types";
import { call, createApp, makeDeps } from "./harness";
import type { HrMailRequest } from "../src/hr-interview-mail";
import type { AppDeps } from "../src/types";

type App = ReturnType<typeof createApp>;

const ANSWERS = {
  last_name: "山田",
  first_name: "太郎",
  last_name_kana: "やまだ",
  first_name_kana: "たろう",
  email: "taro@gmail.com",
  department: "情報工学科",
  grade: "2年",
  interests: ["開発"],
  motivation: "運営をやってみたい",
  preferred_date: "2026-11-20",
};

function setup(overrides: Partial<AppDeps> = {}) {
  const mails: { mail: HrMailRequest; key: string }[] = [];
  const deps = makeDeps({
    appBaseUrl: "https://app.example/",
    sendHrMail: async (_r, mail, key) => {
      mails.push({ mail, key });
    },
    ...overrides,
  });
  return { app: createApp(deps), deps, mails };
}

/** 申し込み → 枠 5 つ → 案内メールの URL で予約 = 面談確定。応募者 id を返す。 */
async function bookedApplicant(app: App, mails: { mail: HrMailRequest }[]): Promise<string> {
  await call(app, "POST", "/members/internal/hr/interview-form", { internal: true, userId: null, body: { answers: ANSWERS } });
  for (let d = 1; d <= 5; d++) {
    await call(app, "POST", "/members/hr/interviews/slots", {
      body: { slots: [{ startAt: `2026-09-0${d}T05:00:00.000Z`, durationMinutes: 30 }] },
    });
  }
  const token = decodeURIComponent(/#t=(\S+)/.exec(mails[0]!.mail.textBody)![1]!);
  const view = await call(app, "POST", "/members/internal/hr/interview-booking/view", { internal: true, userId: null, body: { token } });
  await call(app, "POST", "/members/internal/hr/interview-booking/book", { internal: true, userId: null, body: { token, slotId: view.json.slots[0].id } });
  const list = await call(app, "GET", "/members/hr/applicants");
  return list.json.applicants[0].id as string;
}

const base = (id: string) => `/members/internal/hr/applicants/${id}/interview-result`;
const claim = (app: App, id: string, body: hrResult.ClaimInterviewResultRequest) =>
  call(app, "POST", `${base(id)}/claim`, { internal: true, body });
const link = (app: App, id: string, body: hrResult.LinkInterviewResultRequest) =>
  call(app, "POST", `${base(id)}/link`, { internal: true, body });
const complete = (app: App, id: string) => call(app, "POST", `${base(id)}/complete`, { internal: true, body: {} });

describe("人事: 面談の予約で面談確定", () => {
  it("booking a slot moves the applicant to 面談確定 (interview_set)", async () => {
    const { app, mails } = setup();
    const id = await bookedApplicant(app, mails);
    const a = (await call(app, "GET", `/members/hr/applicants/${id}`)).json.applicant;
    expect(a.stage).toBe("interview_set");
  });
});

describe("人事: 面談結果 — 不合格", () => {
  it("records the result, moves to 不合格 and sends one polite mail without the reason by default", async () => {
    const { app, mails } = setup();
    const id = await bookedApplicant(app, mails);
    const before = mails.length;
    const c = await claim(app, id, { decision: "fail", reason: "今回は日程が合わない" });
    expect(c.status).toBe(200);
    expect(c.json.proceed).toBe(true);
    const done = await complete(app, id);
    expect(done.status).toBe(200);
    expect(done.json.result).toMatchObject({ decision: "fail", status: "done", reason: "今回は日程が合わない", includeReasonInMail: false });
    expect(done.json.result.mailSentAt).not.toBeNull();
    expect(done.json.applicant.stage).toBe("rejected");

    const sent = mails.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.mail.to).toBe("taro@gmail.com");
    expect(sent[0]!.mail.subject).toBe("【DevelopersHub】面談結果のご連絡");
    expect(sent[0]!.mail.textBody).toContain("山田 太郎 様");
    expect(sent[0]!.mail.textBody).toContain("ご期待に沿いかねる");
    expect(sent[0]!.mail.textBody).not.toContain("日程が合わない");
    expect(sent[0]!.key).toBe(`hr-interview-result:${done.json.result.id}`);
  });

  it("includes the reason only when asked", async () => {
    const { app, mails } = setup();
    const id = await bookedApplicant(app, mails);
    await claim(app, id, { decision: "fail", reason: "募集枠が埋まったため", includeReasonInMail: true });
    await complete(app, id);
    expect(mails.at(-1)!.mail.textBody).toContain("募集枠が埋まったため");
  });

  it("requires a reason and an eligible stage", async () => {
    const { app, mails } = setup();
    const id = await bookedApplicant(app, mails);
    expect((await claim(app, id, { decision: "fail", reason: "  " })).status).toBe(400);
    expect((await claim(app, id, { decision: "maybe" as never, reason: "x" })).status).toBe(400);
    const created = await call(app, "POST", "/members/hr/applicants", { body: { name: "未予約 花子", email: "h@example.com" } });
    const res = await claim(app, created.json.applicant.id, { decision: "fail", reason: "x" });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("HR_RESULT_NOT_ELIGIBLE");
  });
});

describe("人事: 面談結果 — 合格", () => {
  it("links the issued account to a new roster row, moves to 採用 and mails the address + 参加届 + オンボーディング URLs", async () => {
    const { app, mails, deps } = setup();
    const id = await bookedApplicant(app, mails);
    const before = mails.length;
    expect((await claim(app, id, { decision: "pass", reason: "主体性がある" })).json.proceed).toBe(true);
    const linked = await link(app, id, { identityUserId: "usr_new", address: "taro.yamada@developershub.jp" });
    expect(linked.status).toBe(200);
    expect(linked.json.stage).toBe("hired");
    expect(linked.json.memberId).toBeTruthy();
    const person = await deps.repo.getPerson(linked.json.memberId);
    expect(person).toMatchObject({ identityUserId: "usr_new", status: "added", gmail: "taro@gmail.com", lastName: "山田", firstName: "太郎" });

    const done = await complete(app, id);
    expect(done.json.result).toMatchObject({
      decision: "pass",
      status: "done",
      issuedAddress: "taro.yamada@developershub.jp",
      issuedIdentityUserId: "usr_new",
      issuedMemberId: linked.json.memberId,
    });
    const sent = mails.slice(before);
    expect(sent).toHaveLength(1);
    const body = sent[0]!.mail.textBody;
    expect(sent[0]!.mail.subject).toBe("【DevelopersHub】面談結果のご連絡（合格）");
    expect(body).toContain("メールアドレス: taro.yamada@developershub.jp");
    expect(body).toContain("https://app.example/participate#prefill=");
    expect(body).toContain("https://app.example/onboarding");
    expect(body).toContain("アカウント発行のお知らせ");
    expect(body).not.toContain("主体性がある");
  });

  it("re-linking with the same account after a lost response does not create a second roster row", async () => {
    const { app, mails, deps } = setup();
    const id = await bookedApplicant(app, mails);
    await claim(app, id, { decision: "pass", reason: "ok" });
    const first = await link(app, id, { identityUserId: "usr_new", address: "a@developershub.jp" });
    const again = await link(app, id, { identityUserId: "usr_new", address: "a@developershub.jp" });
    expect(again.json.memberId).toBe(first.json.memberId);
    const rows = (await call(app, "GET", "/members/overview")).json;
    expect(JSON.stringify(rows).match(/usr_new/g)?.length).toBe(1);
    void deps;
  });

  it("will not complete a pass before the account is issued", async () => {
    const { app, mails } = setup();
    const id = await bookedApplicant(app, mails);
    await claim(app, id, { decision: "pass", reason: "ok" });
    expect((await complete(app, id)).status).toBe(409);
  });
});

describe("人事: 面談結果 — 二度押し・再試行", () => {
  it("a second claim while the first is running is 409, and after completion returns the result without doing anything", async () => {
    const { app, mails } = setup();
    const id = await bookedApplicant(app, mails);
    expect((await claim(app, id, { decision: "fail", reason: "x" })).json.proceed).toBe(true);
    const dup = await claim(app, id, { decision: "fail", reason: "x" });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe("HR_RESULT_IN_PROGRESS");
    await complete(app, id);
    const after = mails.length;
    const again = await claim(app, id, { decision: "pass", reason: "やっぱり" });
    expect(again.status).toBe(200);
    expect(again.json.proceed).toBe(false);
    expect(again.json.result.decision).toBe("fail");
    expect((await complete(app, id)).json.result.status).toBe("done");
    expect(mails.length).toBe(after);
  });

  it("a mail failure releases the lease so the next press resumes and sends exactly once", async () => {
    let down = true;
    const sent: string[] = [];
    const { app, mails } = setup({
      sendHrMail: async (_r, mail, key) => {
        if (down && mail.subject.includes("面談結果")) throw new Error("resend down");
        sent.push(key);
        if (!mail.subject.includes("面談結果")) mails.push({ mail, key });
      },
    });
    const id = await bookedApplicant(app, mails);
    await claim(app, id, { decision: "fail", reason: "x" });
    const failed = await complete(app, id);
    expect(failed.status).toBe(502);
    down = false;
    expect((await claim(app, id, { decision: "fail", reason: "x" })).json.proceed).toBe(true);
    expect((await complete(app, id)).json.result.status).toBe("done");
    expect(sent.filter((k) => k.startsWith("hr-interview-result:"))).toHaveLength(1);
  });
});

describe("hrResult.renderResultMail", () => {
  it("never carries a password and keeps the reason out unless given", () => {
    const pass = hrResult.renderResultMail({ decision: "pass", name: "A", reason: null, address: "a@developershub.jp", appUrl: "https://x/", participationUrl: "https://x/participate", onboardingUrl: "https://x/onboarding" });
    expect(pass.textBody).not.toMatch(/パスワード:/);
    expect(pass.textBody).not.toContain("【面談での評価】");
    const fail = hrResult.renderResultMail({ decision: "fail", name: "A", reason: "理由" });
    expect(fail.textBody).toContain("【検討内容について】");
  });
});
