import { describe, it, expect } from "vitest";
import { classifyIntent, deriveTaskTitle } from "./intent.ts";

describe("classifyIntent", () => {
  it("treats a work request as a task (the reported case)", () => {
    expect(classifyIntent("俺の自己紹介ページ作ってほしい").kind).toBe("task");
  });

  it.each([
    "ログイン画面を作って",
    "バグを直して",
    "この関数をリファクタして",
    "READMEを書いてほしい",
    "使用量ダッシュボードを実装してください",
    "名簿にロール絞り込みを追加して",
    "build a landing page",
    "fix the login bug",
  ])("classifies %s as task", (line) => {
    expect(classifyIntent(line).kind).toBe("task");
  });

  it.each([
    "こんにちは",
    "ありがとう！",
    "了解",
    "なるほど",
    "thanks",
    "Reactって何？",
    "この関数の意味は？",
    "なぜこれが動くの？",
  ])("classifies %s as chat", (line) => {
    expect(classifyIntent(line).kind).toBe("chat");
  });

  it("asks (ambiguous) when there is no clear signal", () => {
    expect(classifyIntent("自己紹介ページ").kind).toBe("ambiguous");
    expect(classifyIntent("認証まわりの設計方針").kind).toBe("ambiguous");
  });

  it("empty input is chat", () => {
    expect(classifyIntent("   ").kind).toBe("chat");
  });

  it("a work verb wins even with a trailing question mark", () => {
    expect(classifyIntent("自己紹介ページ作ってくれる？").kind).toBe("task");
  });
});

describe("deriveTaskTitle", () => {
  it("strips a polite request suffix", () => {
    expect(deriveTaskTitle("俺の自己紹介ページ作ってほしい")).toBe("俺の自己紹介ページ作って");
  });

  it("truncates long input", () => {
    const long = "あ".repeat(80);
    expect(deriveTaskTitle(long).length).toBeLessThanOrEqual(48);
    expect(deriveTaskTitle(long).endsWith("…")).toBe(true);
  });
});
