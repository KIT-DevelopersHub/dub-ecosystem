// 面談申し込みフォームの定義/回答の検証 (フロントとサービスの共通 SoT)。
import { describe, it, expect } from "vitest";
import { hrForm } from "../src/index";

const base = () => hrForm.defaultInterviewForm();

describe("hrForm.validateFormDefinition", () => {
  it("accepts the default form", () => {
    expect(hrForm.validateFormDefinition(base())).toEqual([]);
  });

  it("requires lastName, firstName and email bindings, required, with a compatible type", () => {
    const f = base();
    const noEmail = { ...f, questions: f.questions.filter((q) => q.binding !== "email") };
    expect(hrForm.validateFormDefinition(noEmail)).toContainEqual({ field: "questions", reason: "missing_email" });

    const optionalName = { ...f, questions: f.questions.map((q) => (q.binding === "lastName" ? { ...q, required: false } : q)) };
    expect(hrForm.validateFormDefinition(optionalName)).toContainEqual({ field: "questions.0.required", reason: "required_binding" });

    const badType = { ...f, questions: f.questions.map((q) => (q.binding === "email" ? { ...q, type: "short_text" as const } : q)) };
    expect(hrForm.validateFormDefinition(badType).map((e) => e.field)).toContain(`questions.${f.questions.findIndex((q) => q.binding === "email")}.binding`);
  });

  it("rejects duplicate ids, empty labels, choice questions without options and duplicate bindings", () => {
    const f = base();
    const qs = [...f.questions];
    qs[7] = { ...qs[7]!, id: "last_name" };
    qs[8] = { ...qs[6]!, label: "  " };
    qs.push({ id: "pick", type: "dropdown", label: "選ぶ", description: null, required: false, options: [], binding: null });
    qs.push({ id: "dept2", type: "short_text", label: "学科2", description: null, required: false, options: [], binding: "department" });
    const fields = hrForm.validateFormDefinition({ ...f, questions: qs }).map((e) => e.field);
    expect(fields).toEqual(expect.arrayContaining(["questions.7.id", "questions.8.label", "questions.10.options", "questions.11.binding"]));
  });
});

describe("hrForm.validateAnswers", () => {
  const { questions } = base();

  it("normalizes answers, drops unknown ids and empties, lowercases email", () => {
    const { value, errors } = hrForm.validateAnswers(questions, {
      last_name: "  山田 ",
      first_name: "太郎",
      email: "Taro@Example.com",
      grade: "2年",
      interests: ["広報", "開発", "広報"],
      motivation: "",
      unknown: "x",
    });
    expect(errors).toEqual([]);
    expect(value).toEqual({ last_name: "山田", first_name: "太郎", email: "taro@example.com", grade: "2年", interests: ["開発", "広報"] });
  });

  it("reports required / invalid per question", () => {
    const { errors } = hrForm.validateAnswers(questions, {
      email: "not-an-email",
      grade: "9年",
      interests: ["宇宙"],
      preferred_date: "2026/11/01",
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        { field: "answers.last_name", reason: "required" },
        { field: "answers.first_name", reason: "required" },
        { field: "answers.email", reason: "invalid" },
        { field: "answers.grade", reason: "invalid" },
        { field: "answers.interests", reason: "invalid" },
        { field: "answers.preferred_date", reason: "invalid" },
      ]),
    );
  });

  it("caps bound answers at the applicant column length", () => {
    const { errors } = hrForm.validateAnswers(questions, { last_name: "あ".repeat(51), first_name: "太郎", email: "a@b.co" });
    expect(errors).toEqual([{ field: "answers.last_name", reason: "too_long" }]);
  });
});

describe("hrForm.applicantFieldsFromAnswers", () => {
  it("maps bound answers onto applicant columns only", () => {
    const { questions } = base();
    const fields = hrForm.applicantFieldsFromAnswers(questions, {
      last_name: "山田",
      first_name: "太郎",
      last_name_kana: "やまだ",
      first_name_kana: "たろう",
      email: "taro@example.com",
      department: "情報工学科",
      interests: ["開発"],
    });
    expect(fields).toEqual({
      name: "山田 太郎",
      nameKana: "やまだ たろう",
      email: "taro@example.com",
      department: "情報工学科",
      grade: null,
      motivation: null,
    });
  });
});

describe("hrForm.upgradeQuestions (保存済みの旧フォーム)", () => {
  const legacy = (id: string, binding: string, extra: Partial<hrForm.FormQuestion> = {}) =>
    ({ id, type: "short_text", label: id, description: null, required: false, options: [], binding, ...extra }) as hrForm.FormQuestion;

  it("splits name / kana into two questions and keeps the rest in order", () => {
    const out = hrForm.upgradeQuestions([
      legacy("name", "name", { required: true }),
      legacy("name_kana", "nameKana"),
      legacy("mail", "email", { type: "email", required: true }),
    ]);
    expect(out.map((q) => [q.binding, q.required])).toEqual([
      ["lastName", true],
      ["firstName", true],
      ["lastNameKana", false],
      ["firstNameKana", false],
      ["email", true],
    ]);
    expect(hrForm.validateFormDefinition({ title: "t", questions: out })).toEqual([]);
  });

  it("replaces grade questions the participation form cannot represent, and keeps valid ones", () => {
    const old = legacy("g", "grade", { type: "single_choice", options: ["1年", "5年", "専攻科"] });
    expect(hrForm.upgradeQuestions([old])[0]).toMatchObject({ type: "dropdown", options: ["1年", "2年", "3年", "4年", "院生"] });
    const free = legacy("g", "grade");
    expect(hrForm.upgradeQuestions([free])[0]).toMatchObject({ type: "dropdown" });
    const ok = legacy("g", "grade", { type: "single_choice", options: ["1年", "2年"] });
    expect(hrForm.upgradeQuestions([ok])[0]).toBe(ok);
  });

  it("is idempotent on the default form", () => {
    const { questions } = base();
    expect(hrForm.upgradeQuestions(questions)).toEqual(questions);
  });

  it("rejects new forms whose grade options do not parse", () => {
    const f = base();
    const bad = { ...f, questions: f.questions.map((q) => (q.binding === "grade" ? { ...q, options: ["専攻科"] } : q)) };
    expect(hrForm.validateFormDefinition(bad)).toContainEqual({
      field: `questions.${f.questions.findIndex((q) => q.binding === "grade")}.options`,
      reason: "grade_options",
    });
  });
});

describe("hrForm.participationPrefill", () => {
  const applicant = { name: "山田 太郎", nameKana: "やまだ たろう", email: "taro@gmail.com", department: "情報工学科", grade: "3年" };
  const { questions } = base();
  const answers = { last_name: "山田", first_name: "太郎", last_name_kana: "やまだ", first_name_kana: "たろう" };

  it("maps the applicant and answers onto participation fields", () => {
    expect(hrForm.participationPrefill(applicant, { questions, answers })).toEqual({
      lastName: "山田",
      firstName: "太郎",
      lastNameKana: "やまだ",
      firstNameKana: "たろう",
      gmail: "taro@gmail.com",
      grade: "3",
      department: "情報工学科",
    });
  });

  it("keeps a multi-word split from the answers instead of guessing from spaces", () => {
    const a = { ...applicant, name: "de la Cruz Maria" };
    const r = { questions, answers: { ...answers, last_name: "de la Cruz", first_name: "Maria" } };
    expect(hrForm.participationPrefill(a, r)).toMatchObject({ lastName: "de la Cruz", firstName: "Maria" });
  });

  it("prefers the applicant row when HR corrected the name after the answer", () => {
    const fixed = { ...applicant, name: "山本 太郎" };
    expect(hrForm.participationPrefill(fixed, { questions, answers })).toMatchObject({ lastName: "山本", firstName: "太郎" });
  });

  it("falls back to splitting on spaces without a response, and routes a non-Gmail address to schoolEmail", () => {
    const prefill = hrForm.participationPrefill({ ...applicant, email: "c1234@st.kanazawa-it.ac.jp" }, null);
    expect(prefill).toMatchObject({ lastName: "山田", firstName: "太郎", lastNameKana: "やまだ", schoolEmail: "c1234@st.kanazawa-it.ac.jp" });
    expect(prefill).not.toHaveProperty("gmail");
  });

  it("omits what it cannot map", () => {
    expect(hrForm.participationPrefill({ name: "山田", nameKana: null, email: null, department: null, grade: "専攻科" }, null)).toEqual({ lastName: "山田" });
  });
});
