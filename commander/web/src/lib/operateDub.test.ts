import { describe, it, expect } from "vitest";
import type { ChatMessage } from "./commanderApi.ts";
import {
  buildAnswerPrompt,
  buildPlannerPrompt,
  buildTranscript,
  describeCatalog,
  OPERATE_PLANNER_ARGS,
  OPERATE_PLANNER_CWD,
  parsePlannerReply,
  RESULT_PREFIX,
} from "./operateDub.ts";
import { FAKE_CATALOG } from "../test/operateFakes.ts";

const msg = (role: ChatMessage["role"], text: string, i = 0): ChatMessage => ({
  id: `m${i}`,
  seq: i,
  sessionId: "s1",
  role,
  text,
  tools: [],
  status: "done",
  createdAt: "2026-10-10T00:00:00.000Z",
});

describe("planner run isolation", () => {
  it("gives the planner no tools and keeps it out of the repo", () => {
    expect(OPERATE_PLANNER_ARGS).toEqual(["--tools", "", "--strict-mcp-config"]);
    expect(OPERATE_PLANNER_CWD).not.toMatch(/dub-ecosystem/);
  });
});

describe("buildPlannerPrompt", () => {
  it("carries the rules, the catalog, the whole session (incl. results) and the request", () => {
    const history = [
      msg("user", "北陸ITカンファレンス2027 を探して", 1),
      msg("assistant", `${RESULT_PREFIX.preview}イベントを1件見つけました（id ev1）`, 2),
      msg("assistant", `${RESULT_PREFIX.execution}一部できませんでした`, 3),
    ];
    const p = buildPlannerPrompt({ catalog: FAKE_CATALOG, history, request: "失敗した分だけやり直して" });
    expect(p).toMatch(/返答は必ず日本語/);
    expect(p).toMatch(/<EVENT_ID> のような仮の値は禁止/);
    expect(p).toContain("- events.update [書き込み・リスク中・取り消し可] PATCH /events/:id");
    expect(p).toContain("[ユーザー]\n北陸ITカンファレンス2027 を探して");
    expect(p).toContain("[システム]\n【確認結果】イベントを1件見つけました（id ev1）");
    expect(p).toContain("[システム]\n【実行結果】一部できませんでした");
    expect(p.trim().endsWith("# 今回の依頼\n失敗した分だけやり直して")).toBe(true);
  });

  it("asks for prose, not a plan, when answering from read results", () => {
    expect(buildAnswerPrompt({ catalog: FAKE_CATALOG, history: [] })).toMatch(/計画や JSON は書かないこと/);
  });

  it("labels the risk tier and reversibility of mutations only", () => {
    const d = describeCatalog(FAKE_CATALOG);
    expect(d).toContain("- events.list [読み取り] GET /events");
    expect(d).toContain("[削除・リスク高・取り消し可]");
    expect(d).toContain("- events.get [読み取り] GET /events/:id — イベント1件の詳細を取得する / version を含む");
  });
});

describe("buildTranscript", () => {
  it("keeps the newest messages when over budget and skips streaming ones", () => {
    const big = "あ".repeat(2900);
    const history = Array.from({ length: 30 }, (_, i) => msg(i % 2 ? "assistant" : "user", `${i}:${big}`, i));
    history.push({ ...msg("assistant", "途中", 99), status: "streaming" });
    const tr = buildTranscript(history);
    expect(tr).toContain("29:");
    expect(tr).not.toContain("[ユーザー]\n0:");
    expect(tr).not.toContain("途中");
    expect(buildTranscript([])).toBe("（まだありません）");
  });
});

describe("parsePlannerReply", () => {
  it("treats prose as an answer", () => {
    expect(parsePlannerReply("こんにちは。イベントの編集ができます。")).toEqual({ kind: "answer", text: "こんにちは。イベントの編集ができます。" });
  });

  it("parses a plan and keeps the Japanese intro", () => {
    const r = parsePlannerReply('概要を差し替えます。\n```json\n{"type":"plan","summary":"1件更新","steps":[{"id":"a","op":"events.list"}]}\n```');
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    expect(r.intro).toBe("概要を差し替えます。");
    expect(r.plan.summary).toBe("1件更新");
    expect(r.plan.steps).toHaveLength(1);
  });

  it("reports broken or empty plans in Japanese", () => {
    expect(parsePlannerReply("```json\n{oops\n```")).toMatchObject({ kind: "invalid", error: expect.stringMatching(/読み取れません/) });
    expect(parsePlannerReply('```json\n{"steps":[]}\n```')).toMatchObject({ kind: "invalid" });
  });
});
