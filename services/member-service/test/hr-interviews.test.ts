// 人事: 面談の日程調整 — 枠の登録 / 候補が揃うまでメール保留 / 公開の日程選択 / 予約の取り消し / 権限。
import { describe, it, expect } from "vitest";
import { hrInterview, type identity } from "@dub/types";
import { call, createApp, fakeAuthz, makeDeps } from "./harness";
import type { HrMailRequest } from "../src/hr-interview-mail";
import type { AppDeps } from "../src/types";

type App = ReturnType<typeof createApp>;

const ANSWERS = {
  last_name: "山田",
  first_name: "太郎",
  last_name_kana: "やまだ",
  first_name_kana: "たろう",
  email: "taro@example.com",
  department: "情報工学科",
  grade: "2年",
  interests: ["開発"],
  motivation: "運営をやってみたい",
  preferred_date: "2026-11-20",
};

function setup(overrides: Partial<AppDeps> = {}) {
  const mails: { mail: HrMailRequest; key: string }[] = [];
  const notifies: { title: string; recipientIds: string[] }[] = [];
  const deps = makeDeps({
    appBaseUrl: "https://app.example/",
    sendHrMail: async (_r, mail, key) => {
      mails.push({ mail, key });
    },
    notifyInterviewer: async (_r, req) => {
      notifies.push({ title: req.title, recipientIds: req.recipientIds });
    },
    ...overrides,
  });
  return { app: createApp(deps), deps, mails, notifies };
}

const apply = (app: App, email = "taro@example.com") =>
  call(app, "POST", "/members/internal/hr/interview-form", { internal: true, userId: null, body: { answers: { ...ANSWERS, email } } });

const addSlot = (app: App, day: number, userId = "user_caller") =>
  call(app, "POST", "/members/hr/interviews/slots", {
    userId,
    body: { slots: [{ startAt: `2026-09-${String(day).padStart(2, "0")}T05:00:00.000Z`, durationMinutes: 30 }] },
  });

const overview = async (app: App): Promise<hrInterview.InterviewOverview> => (await call(app, "GET", "/members/hr/interviews")).json;

const tokenOf = (mail: HrMailRequest): string => decodeURIComponent(/#t=(\S+)/.exec(mail.textBody)![1]!);

const view = (app: App, token: string) => call(app, "POST", "/members/internal/hr/interview-booking/view", { internal: true, userId: null, body: { token } });
const book = (app: App, token: string, slotId: string) =>
  call(app, "POST", "/members/internal/hr/interview-booking/book", { internal: true, userId: null, body: { token, slotId } });

async function withSlots(app: App, n: number): Promise<void> {
  for (let d = 1; d <= n; d++) expect((await addSlot(app, d)).status).toBe(201);
}

describe("人事: 面談メールの保留", () => {
  it("holds the invite while slots are short, then sends once when the count reaches the setting", async () => {
    const { app, mails } = setup();
    await apply(app);
    await withSlots(app, 4);
    expect(mails).toHaveLength(0);
    expect(await overview(app)).toMatchObject({ openSlotCount: 4, heldCount: 1, settings: { minOpenSlots: 5 } });

    await addSlot(app, 5);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.mail.to).toBe("taro@example.com");
    expect(mails[0]!.mail.textBody).toContain("https://app.example/interview-book#t=");
    expect((await overview(app)).heldCount).toBe(0);

    await addSlot(app, 6);
    expect(mails).toHaveLength(1);
  });

  it("sends immediately when enough slots exist, and a repeat submission does not mail again", async () => {
    const { app, mails } = setup();
    await withSlots(app, 5);
    await apply(app);
    await apply(app);
    expect(mails).toHaveLength(1);
  });

  it("lowering the setting releases held invites; out-of-range values are rejected", async () => {
    const { app, mails } = setup();
    await apply(app);
    await withSlots(app, 2);
    expect((await call(app, "PUT", "/members/hr/interviews/settings", { body: { minOpenSlots: 0 } })).status).toBe(400);
    expect((await call(app, "PUT", "/members/hr/interviews/settings", { body: { minOpenSlots: 2 } })).status).toBe(200);
    expect(mails).toHaveLength(1);
  });

  it("counts same-time slots from two interviewers as one candidate", async () => {
    const { app, mails } = setup();
    await apply(app);
    await call(app, "PUT", "/members/hr/interviews/settings", { body: { minOpenSlots: 2 } });
    await addSlot(app, 1, "user_a");
    await addSlot(app, 1, "user_b");
    expect((await overview(app)).openSlotCount).toBe(1);
    expect(mails).toHaveLength(0);
  });

  it("rejects the whole request when any item is malformed or in the past", async () => {
    const { app } = setup();
    const post = (slots: unknown) => call(app, "POST", "/members/hr/interviews/slots", { body: { slots } });
    expect((await post([{ startAt: "2026-09-01T05:00:00.000Z", durationMinutes: 30 }, { startAt: "2026-01-01T00:00:00.000Z", durationMinutes: 30 }])).json.error.details).toEqual([
      { field: "slots[1].startAt", reason: "in_the_past" },
    ]);
    expect((await post([])).status).toBe(400);
    expect((await post(Array.from({ length: 201 }, () => ({ startAt: "2026-09-01T05:00:00.000Z", durationMinutes: 30 })))).status).toBe(400);
    expect((await overview(app)).slots).toHaveLength(0);
  });

  it("adds a dragged range at once, skipping cells that overlap the same interviewer's slots", async () => {
    const { app } = setup();
    const cells = (from: number, n: number, minutes = 30) =>
      Array.from({ length: n }, (_, i) => ({ startAt: new Date(Date.parse("2026-09-01T00:00:00.000Z") + (from + i) * minutes * 60_000).toISOString(), durationMinutes: minutes }));
    await call(app, "POST", "/members/hr/interviews/slots", { body: { slots: cells(2, 1, 60) } }); // 02:00-03:00
    const res = await call(app, "POST", "/members/hr/interviews/slots", { body: { slots: [...cells(0, 8), ...cells(0, 2)] } });
    expect(res.status).toBe(201);
    // 00:00-04:00 の 8 コマのうち 02:00-03:00 と重なる 2 コマを飛ばし、重複分も 1 回だけ
    expect(res.json.slots).toHaveLength(7);
    // 別の担当者は同じ時間に入れられる
    expect((await call(app, "POST", "/members/hr/interviews/slots", { userId: "user_b", body: { slots: cells(0, 2) } })).json.slots).toHaveLength(9);
  });

  it("removes several open slots at once but keeps a booked one", async () => {
    const { app, mails } = setup();
    await withSlots(app, 5);
    await apply(app);
    const token = tokenOf(mails[0]!.mail);
    const ids = (await overview(app)).slots.map((s) => s.id);
    await book(app, token, ids[0]!);
    const res = await call(app, "POST", "/members/hr/interviews/slots/delete", { body: { ids: [...ids, "nope"] } });
    expect(res.status).toBe(200);
    expect(res.json.slots.map((s: { id: string }) => s.id)).toEqual([ids[0]]);
    expect((await call(app, "POST", "/members/hr/interviews/slots/delete", { body: { ids: [] } })).status).toBe(400);
  });

  it("keeps the submission and the held invite when the mail fails, and retries on the next trigger", async () => {
    let down = true;
    const mails: string[] = [];
    const { app } = setup({
      sendHrMail: async (_r, _m, key) => {
        if (down) throw new Error("mail down");
        mails.push(key);
      },
    });
    await withSlots(app, 5);
    expect((await apply(app)).status).toBe(201);
    expect(await overview(app)).toMatchObject({ heldCount: 1 });
    expect((await overview(app)).invites[0]!.lastError).toBe("send_failed");
    down = false;
    await addSlot(app, 6);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatch(/:1$/);
    expect((await overview(app)).invites[0]).toMatchObject({ status: "sent", lastError: null });
  });

  it("does not mail an applicant who withdrew while held", async () => {
    const { app, mails, deps } = setup();
    await apply(app);
    const a = (await deps.hrRepo.listApplicants(deps.orgId))[0]!;
    await call(app, "POST", `/members/hr/applicants/${a.id}/stage`, { body: { stage: "withdrawn", expectedVersion: a.version } });
    await withSlots(app, 5);
    expect(mails).toHaveLength(0);
    expect((await overview(app)).invites).toHaveLength(0);
  });

  it("stops at the daily cap and leaves the rest held", async () => {
    const { app, mails } = setup();
    for (let i = 0; i < 31; i++) await apply(app, `u${i}@example.com`);
    await withSlots(app, 5);
    expect(mails).toHaveLength(10);
    await addSlot(app, 6);
    await addSlot(app, 7);
    expect(mails).toHaveLength(30);
    await addSlot(app, 8);
    expect(mails).toHaveLength(30);
    expect((await overview(app)).heldCount).toBe(1);
  });

  it("skips an applicant without an address instead of blocking the queue", async () => {
    const { app, mails, deps } = setup();
    await apply(app);
    await apply(app, "hanako@example.com");
    const taro = (await deps.hrRepo.listApplicants(deps.orgId)).find((a) => a.email === "taro@example.com")!;
    await deps.hrRepo.updateApplicant({ ...taro, email: null, version: taro.version + 1 }, taro.version);
    await withSlots(app, 5);
    expect(mails.map((m) => m.mail.to)).toEqual(["hanako@example.com"]);
    expect((await overview(app)).heldCount).toBe(1);
  });

  it("does not put form input into the invite body, so the form cannot deliver arbitrary text", async () => {
    const { app, mails } = setup();
    await withSlots(app, 5);
    await apply(app);
    expect(mails[0]!.mail.textBody).not.toContain("山田");
  });

  it("runs mail after the response when deferring, and an invite failure reaches the submitter", async () => {
    const deferred: Promise<void>[] = [];
    const { app, mails, deps } = setup({ defer: (w) => void deferred.push(w) });
    await withSlots(app, 5);
    expect((await apply(app)).status).toBe(201);
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
    expect(mails).toHaveLength(1);

    deps.hrInterviewRepo.addInvite = async () => {
      throw new Error("d1 down");
    };
    expect((await apply(app, "other@example.com")).status).toBe(500);
  });

  it("「今すぐ送る」 ignores the slot count and surfaces a send failure", async () => {
    let down = true;
    const mails: string[] = [];
    const { app } = setup({
      sendHrMail: async (_r, _m, key) => {
        if (down) throw new Error("x");
        mails.push(key);
      },
    });
    await apply(app);
    const id = (await overview(app)).invites[0]!.id;
    expect((await call(app, "POST", `/members/hr/interviews/invites/${id}/send`)).status).toBe(502);
    down = false;
    expect((await call(app, "POST", `/members/hr/interviews/invites/${id}/send`)).status).toBe(200);
    expect((await call(app, "POST", `/members/hr/interviews/invites/${id}/send`)).status).toBe(200);
    expect(new Set(mails).size).toBe(2); // 再送は別の送信
  });
});

describe("人事: 公開の日程選択", () => {
  async function ready() {
    const s = setup();
    await withSlots(s.app, 5);
    await apply(s.app);
    return { ...s, token: tokenOf(s.mails[0]!.mail) };
  }

  it("shows open slots without the interviewer, books one, and moves the applicant to 面談確定", async () => {
    const { app, deps, mails, notifies, token } = await ready();
    const v = await view(app, token);
    expect(v.json).toMatchObject({ state: "open", applicantName: "山田 太郎", booked: null });
    expect(v.json.slots).toHaveLength(5);
    expect(Object.keys(v.json.slots[0]).sort()).toEqual(["endAt", "id", "startAt"]);

    const slot = v.json.slots[1];
    const res = await book(app, token, slot.id);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ state: "booked", booked: { id: slot.id } });

    const a = (await deps.hrRepo.listApplicants(deps.orgId))[0]!;
    expect(a).toMatchObject({ stage: "interview_set", interviewAt: slot.startAt });
    expect(mails.at(-1)!.mail.subject).toContain("確定");
    expect(mails.at(-1)!.mail.textBody).toContain("9月2日(水) 14:00〜14:30");
    expect(notifies).toEqual([{ title: "面談の予約: 山田 太郎", recipientIds: ["user_caller"] }]);
    expect((await overview(app)).openSlotCount).toBe(4);
  });

  it("does not let two applicants take one slot, nor one applicant take two", async () => {
    const { app, mails, token } = await ready();
    await apply(app, "hanako@example.com");
    const other = tokenOf(mails[1]!.mail);
    const slots = (await view(app, token)).json.slots;
    expect((await book(app, token, slots[0].id)).status).toBe(200);
    expect((await book(app, other, slots[0].id)).json.error.code).toBe("HR_SLOT_TAKEN");
    expect((await book(app, token, slots[1].id)).json.error.code).toBe("HR_BOOKING_CLOSED");
  });

  it("an unknown token is 404, and a withdrawn applicant's link is closed", async () => {
    const { app, deps, token } = await ready();
    expect((await view(app, "nope")).status).toBe(404);
    const a = (await deps.hrRepo.listApplicants(deps.orgId))[0]!;
    await call(app, "POST", `/members/hr/applicants/${a.id}/stage`, { body: { stage: "withdrawn", expectedVersion: a.version } });
    expect((await view(app, token)).json).toMatchObject({ state: "closed", slots: [] });
  });

  it("a booked slot cannot be deleted; releasing it reopens the slot and the same URL", async () => {
    const { app, deps, token } = await ready();
    const slotId = (await view(app, token)).json.slots[0].id;
    await book(app, token, slotId);
    expect((await call(app, "DELETE", `/members/hr/interviews/slots/${slotId}`)).json.error.code).toBe("HR_SLOT_BOOKED");

    expect((await call(app, "POST", `/members/hr/interviews/slots/${slotId}/release`)).status).toBe(200);
    expect((await deps.hrRepo.listApplicants(deps.orgId))[0]).toMatchObject({ stage: "scheduling", interviewAt: null });
    expect((await view(app, token)).json.state).toBe("open");
    expect((await book(app, token, slotId)).status).toBe(200);
    expect((await call(app, "DELETE", `/members/hr/interviews/slots/${slotId}`)).status).toBe(409);
  });

  it("does not overwrite a withdrawal that lands while booking retries", async () => {
    const { app, deps, token } = await ready();
    const slotId = (await view(app, token)).json.slots[0].id;
    const original = deps.hrRepo.updateApplicant.bind(deps.hrRepo);
    deps.hrRepo.updateApplicant = async (next, expected) => {
      deps.hrRepo.updateApplicant = original;
      await original({ ...next, stage: "withdrawn" }, expected);
      return false; // 人事の変更に負けた
    };
    expect((await book(app, token, slotId)).json.error.code).toBe("HR_BOOKING_CLOSED");
    expect((await deps.hrRepo.listApplicants(deps.orgId))[0]!.stage).toBe("withdrawn");
    expect((await deps.hrInterviewRepo.getSlot(slotId))!.applicantId).toBeNull();
  });

  it("keeps the booking when only the history write fails", async () => {
    const { app, deps, token } = await ready();
    const slotId = (await view(app, token)).json.slots[0].id;
    deps.hrRepo.addEvent = async () => {
      throw new Error("d1 down");
    };
    expect((await book(app, token, slotId)).status).toBe(200);
    expect((await deps.hrInterviewRepo.getSlot(slotId))!.applicantId).not.toBeNull();
  });

  it("gives the slot back when the applicant cannot be moved", async () => {
    const { app, deps, token } = await ready();
    const slotId = (await view(app, token)).json.slots[0].id;
    deps.hrRepo.updateApplicant = async () => false;
    expect((await book(app, token, slotId)).status).toBe(409);
    expect((await deps.hrInterviewRepo.getSlot(slotId))!.applicantId).toBeNull();
  });
});

describe("人事: 面談タブの権限", () => {
  const hrKeys = (extra: identity.PermissionKey[]) => new Set<identity.PermissionKey>(["app:hr:view", ...extra]);

  it("a viewer reads but cannot write; the public routes are s2s only", async () => {
    const app = createApp(makeDeps({ authz: fakeAuthz(hrKeys(["hr:read"])) }));
    expect((await call(app, "GET", "/members/hr/interviews")).status).toBe(200);
    expect((await addSlot(app, 1)).status).toBe(403);
    expect((await call(app, "POST", "/members/internal/hr/interview-booking/view", { body: { token: "x" } })).status).toBe(403);
  });

  it("the overview never carries a booking token", async () => {
    const { app } = setup();
    await apply(app);
    expect(JSON.stringify(await overview(app))).not.toContain("token");
  });
});
