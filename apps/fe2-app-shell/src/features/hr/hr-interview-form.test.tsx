// 人事 > 面談申し込みフォームのテスト。
//   (1) demo transport (REAL api-client 経由): 既定フォーム + seed 回答・公開送信で応募者が 面談日程調整中 に入る・
//       同じメールは二重登録しない・定義の楽観ロック
//   (2) 公開ページ: 質問の描画・必須チェック (送らない)・送信でサンクス・受付終了
//   (3) 編集: 氏名/メールは消せない・質問の追加と形式変更 (選択肢)・空の質問文は保存しない・保存は expectedVersion 付き
//   (4) 代理入力: 送った瞬間に応募者の表へ仮の行 (楽観的)
//   (5) 応募者の詳細ドロワーに回答が出る
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import { hrForm, type hr, type identity } from "@dub/types";
import { describe, expect, it, vi } from "vitest";
import { editorPermissions, FakeAuthProvider, viewerPermissions } from "../../auth/test-support.tsx";
import { createApiClient, type ApiClient } from "../../lib/api-client.tsx";
import { createDemoFetch } from "../../lib/demo-seed.tsx";
import { createHrApi } from "./hrApi.tsx";
import { HrApiProvider } from "./HrProvider.tsx";
import { createInterviewFormApi, InterviewFormApiProvider, type InterviewFormApi } from "./interviewFormApi.tsx";
import { PublicInterviewFormPage } from "./PublicInterviewFormPage.tsx";
import { HrInterviewFormScreen } from "./HrInterviewFormScreen.tsx";
import { HR_LIST_KEY } from "./hrHooks.ts";
import { ApplicantDrawer } from "./HrShared.tsx";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), useRouter: () => null }));

const EDITOR = editorPermissions("hr", ["hr:read", "hr:write", "hr:admin"]);
const VIEWER = viewerPermissions("hr", ["hr:read"]);

function demoClient(): ApiClient {
  return createApiClient({ baseUrl: "https://demo.local", fetchImpl: createDemoFetch() });
}

function renderWith(
  node: JSX.Element,
  formApi: InterviewFormApi,
  opts: { permissions?: readonly identity.PermissionKey[]; client?: QueryClient; hrClient?: ApiClient } = {},
): QueryClient {
  const client = opts.client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const hrApi = createHrApi(opts.hrClient ?? demoClient());
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <FakeAuthProvider permissions={opts.permissions ?? EDITOR}>
          <HrApiProvider value={hrApi}>
            <InterviewFormApiProvider value={formApi}>{node}</InterviewFormApiProvider>
          </HrApiProvider>
        </FakeAuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return client;
}

const baseForm = (over: Partial<hrForm.InterviewForm> = {}): hrForm.InterviewForm => ({
  ...hrForm.defaultInterviewForm(),
  version: 3,
  updatedBy: "usr_demo",
  updatedAt: "2026-11-01T00:00:00Z",
  ...over,
});

function fakeFormApi(overrides: Partial<InterviewFormApi> = {}): InterviewFormApi {
  const form = baseForm();
  return {
    get: () => Promise.resolve(form),
    save: (body) => Promise.resolve({ ...form, ...body, version: body.expectedVersion + 1 }),
    responses: () => Promise.resolve({ responses: [] }),
    submitOnBehalf: () => Promise.reject(new Error("unused")),
    getPublic: () => Promise.resolve({ title: form.title, description: form.description, questions: form.questions, accepting: true }),
    submitPublic: () => Promise.resolve({ accepted: true }),
    ...overrides,
  };
}

describe("demo transport (面談申し込みフォーム)", () => {
  it("seeds the default form and two responses tied to applicants in 面談日程調整中", async () => {
    const api = demoClient();
    const formApi = createInterviewFormApi(api);
    const form = await formApi.get();
    expect(hrForm.validateFormDefinition(form)).toEqual([]);
    const { responses } = await formApi.responses();
    expect(responses.map((r) => r.via).sort()).toEqual(["public", "staff"]);
    const applicants = (await createHrApi(api).list()).applicants;
    for (const r of responses) {
      expect(applicants.find((a) => a.id === r.applicantId)).toMatchObject({ stage: "scheduling", name: r.applicantName });
    }
  });

  it("a public submission adds an applicant; the same email again does not duplicate", async () => {
    const api = demoClient();
    const formApi = createInterviewFormApi(api);
    const before = (await createHrApi(api).list()).applicants.length;
    await formApi.submitPublic({ answers: { name: "新井 陽", email: "you@example.com" } });
    await formApi.submitPublic({ answers: { name: "新井 陽", email: "YOU@example.com" } });
    const after = (await createHrApi(api).list()).applicants;
    expect(after.length).toBe(before + 1);
    expect(after.find((a) => a.email === "you@example.com")).toMatchObject({ stage: "scheduling", source: hrForm.SOURCE_PUBLIC });
    await expect(formApi.submitPublic({ answers: { name: "", email: "x" } })).rejects.toMatchObject({ status: 400 });
    const form = await formApi.get();
    await expect(formApi.save({ ...form, expectedVersion: form.version - 1 })).rejects.toMatchObject({ status: 409 });
  });
});

describe("公開ページ", () => {
  it("validates required answers client-side, then submits and thanks", async () => {
    // PublicInterviewFormPage は渡された api-client から自前の provider を作る (シェルの外) ので demo transport で通す。
    renderWith(<PublicInterviewFormPage api={demoClient()} />, fakeFormApi());
    expect(await screen.findByText("面談申し込みフォーム")).toBeTruthy();
    fireEvent.click(screen.getByTestId("interview-form-public-submit"));
    expect(await screen.findAllByText("入力してください")).toHaveLength(2); // 氏名 + メール
    fireEvent.change(screen.getByTestId("interview-form-public-q-name"), { target: { value: "山田 太郎" } });
    fireEvent.change(screen.getByTestId("interview-form-public-q-email"), { target: { value: "taro@example.com" } });
    fireEvent.click(screen.getByTestId("interview-form-public-q-interests-1"));
    fireEvent.click(screen.getByTestId("interview-form-public-submit"));
    expect(await screen.findByTestId("interview-form-public-thanks")).toBeTruthy();
  });
});

describe("フォームの編集", () => {
  it("locks name/email, adds a dropdown question and saves with expectedVersion", async () => {
    const save = vi.fn((body: hrForm.SaveInterviewFormRequest) => Promise.resolve({ ...baseForm(), ...body, version: 4 }));
    renderWith(<HrInterviewFormScreen />, fakeFormApi({ save }));
    await screen.findByTestId("fe2-hr-form-editor");
    expect(screen.queryByTestId("fe2-hr-form-q-name-delete")).toBeNull();
    expect((screen.getByTestId("fe2-hr-form-q-email-type") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByTestId("fe2-hr-form-q-interests-delete")).toBeTruthy();

    fireEvent.click(screen.getByTestId("fe2-hr-form-add-question"));
    const cards = screen.getAllByTestId(/^fe2-hr-form-q-q_[a-z0-9]+$/);
    const added = cards[cards.length - 1]!;
    const id = added.getAttribute("data-testid")!.replace("fe2-hr-form-q-", "");

    // 空の質問文では保存しない。
    fireEvent.click(screen.getByTestId("fe2-hr-form-save"));
    expect(await screen.findByTestId("fe2-hr-form-errors")).toBeTruthy();
    expect(save).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId(`fe2-hr-form-q-${id}-label`), { target: { value: "所属サークル" } });
    fireEvent.change(screen.getByTestId(`fe2-hr-form-q-${id}-type`), { target: { value: "dropdown" } });
    expect(within(added).getByTestId(`fe2-hr-form-q-${id}-options`)).toBeTruthy();
    fireEvent.change(screen.getByTestId(`fe2-hr-form-q-${id}-opt-0`), { target: { value: "軽音" } });
    fireEvent.click(screen.getByTestId("fe2-hr-form-save"));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const body = save.mock.calls[0]![0];
    expect(body.expectedVersion).toBe(3);
    expect(body.questions.at(-1)).toMatchObject({ label: "所属サークル", type: "dropdown", options: ["軽音"] });
  });

  it("a viewer sees the editor but every control is disabled", async () => {
    renderWith(<HrInterviewFormScreen />, fakeFormApi(), { permissions: VIEWER });
    await screen.findByTestId("fe2-hr-form-editor");
    expect((screen.getByTestId("fe2-hr-form-title") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("fe2-hr-form-add-question") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("fe2-hr-form-enter") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("代理入力", () => {
  it("adds a pending row to the applicants list immediately (optimistic)", async () => {
    let resolve!: (v: hrForm.StaffSubmitInterviewFormResponse) => void;
    const submitOnBehalf = vi.fn(() => new Promise<hrForm.StaffSubmitInterviewFormResponse>((r) => (resolve = r)));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData<hr.ListApplicantsResponse>(HR_LIST_KEY, { applicants: [] });
    renderWith(<HrInterviewFormScreen />, fakeFormApi({ submitOnBehalf }), { client });
    await screen.findByTestId("fe2-hr-form-editor");
    fireEvent.click(screen.getByTestId("fe2-hr-form-enter"));
    fireEvent.change(await screen.findByTestId("fe2-hr-form-enter-q-name"), { target: { value: "電話 一郎" } });
    fireEvent.change(screen.getByTestId("fe2-hr-form-enter-q-email"), { target: { value: "ichiro@example.com" } });
    fireEvent.click(screen.getByTestId("fe2-hr-form-enter-submit"));
    await waitFor(() => expect(submitOnBehalf).toHaveBeenCalledTimes(1));
    const list = client.getQueryData<hr.ListApplicantsResponse>(HR_LIST_KEY)!;
    expect(list.applicants[0]).toMatchObject({ name: "電話 一郎", email: "ichiro@example.com", stage: "scheduling" });
    resolve({
      applicantId: "app_x",
      deduped: false,
      response: { id: "hfr_x", applicantId: "app_x", answers: {}, questions: [], via: "staff", submittedBy: "usr", createdAt: "2026-11-04T00:00:00Z" },
    });
  });
});

describe("応募者の詳細", () => {
  it("shows the interview-form answers of the applicant", async () => {
    const api = demoClient();
    const formApi = createInterviewFormApi(api);
    const { responses } = await formApi.responses();
    const publicOne = responses.find((r) => r.via === "public")!;
    renderWith(<ApplicantDrawer applicantId={publicOne.applicantId} onClose={() => undefined} onRequestJoin={() => undefined} />, formApi, {
      hrClient: api,
    });
    const answers = await screen.findByTestId("fe2-hr-detail-answers");
    expect(within(answers).getByText("興味のある活動")).toBeTruthy();
    expect(within(answers).getByText("イベント運営、広報")).toBeTruthy();
  });
});
