// 面談申し込みフォームの定義/回答の検証 (フロントとサービスの共通 SoT)。
import { describe, it, expect } from "vitest";
import { hrForm } from "../src/index";

const base = () => hrForm.defaultInterviewForm();

describe("hrForm.validateFormDefinition", () => {
  it("accepts the default form", () => {
    expect(hrForm.validateFormDefinition(base())).toEqual([]);
  });

  it("requires name and email bindings, required, with a compatible type", () => {
    const f = base();
    const noEmail = { ...f, questions: f.questions.filter((q) => q.binding !== "email") };
    expect(hrForm.validateFormDefinition(noEmail)).toContainEqual({ field: "questions", reason: "missing_email" });

    const optionalName = { ...f, questions: f.questions.map((q) => (q.binding === "name" ? { ...q, required: false } : q)) };
    expect(hrForm.validateFormDefinition(optionalName)).toContainEqual({ field: "questions.0.required", reason: "required_binding" });

    const badType = { ...f, questions: f.questions.map((q) => (q.binding === "email" ? { ...q, type: "short_text" as const } : q)) };
    expect(hrForm.validateFormDefinition(badType).map((e) => e.field)).toContain("questions.2.binding");
  });

  it("rejects duplicate ids, empty labels, choice questions without options and duplicate bindings", () => {
    const f = base();
    const qs = [...f.questions];
    qs[5] = { ...qs[5]!, id: "name" };
    qs[6] = { ...qs[6]!, label: "  " };
    qs.push({ id: "pick", type: "dropdown", label: "選ぶ", description: null, required: false, options: [], binding: null });
    qs.push({ id: "dept2", type: "short_text", label: "学科2", description: null, required: false, options: [], binding: "department" });
    const fields = hrForm.validateFormDefinition({ ...f, questions: qs }).map((e) => e.field);
    expect(fields).toEqual(expect.arrayContaining(["questions.5.id", "questions.6.label", "questions.8.options", "questions.9.binding"]));
  });
});

describe("hrForm.validateAnswers", () => {
  const { questions } = base();

  it("normalizes answers, drops unknown ids and empties, lowercases email", () => {
    const { value, errors } = hrForm.validateAnswers(questions, {
      name: "  山田 太郎 ",
      email: "Taro@Example.com",
      grade: "2年",
      interests: ["広報", "開発", "広報"],
      motivation: "",
      unknown: "x",
    });
    expect(errors).toEqual([]);
    expect(value).toEqual({ name: "山田 太郎", email: "taro@example.com", grade: "2年", interests: ["開発", "広報"] });
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
        { field: "answers.name", reason: "required" },
        { field: "answers.email", reason: "invalid" },
        { field: "answers.grade", reason: "invalid" },
        { field: "answers.interests", reason: "invalid" },
        { field: "answers.preferred_date", reason: "invalid" },
      ]),
    );
  });

  it("caps bound answers at the applicant column length", () => {
    const { errors } = hrForm.validateAnswers(questions, { name: "あ".repeat(101), email: "a@b.co" });
    expect(errors).toEqual([{ field: "answers.name", reason: "too_long" }]);
  });
});

describe("hrForm.applicantFieldsFromAnswers", () => {
  it("maps bound answers onto applicant columns only", () => {
    const { questions } = base();
    const fields = hrForm.applicantFieldsFromAnswers(questions, {
      name: "山田 太郎",
      email: "taro@example.com",
      department: "情報工学科",
      interests: ["開発"],
    });
    expect(fields).toEqual({
      name: "山田 太郎",
      nameKana: null,
      email: "taro@example.com",
      department: "情報工学科",
      grade: null,
      motivation: null,
    });
  });
});
