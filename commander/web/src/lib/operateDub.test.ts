import { describe, it, expect } from "vitest";
import type { ChatMessage } from "./commanderApi.ts";
import {
  buildAnswerPrompt,
  buildNarrowPrompt,
  buildPlannerPrompt,
  buildTranscript,
  describeCatalog,
  OPERATE_PLANNER_ARGS,
  OPERATE_PLANNER_CWD,
  DATA_MARKER,
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

  it("teaches filtering by catalog conditions, id reuse and name selectors", () => {
    const p = buildPlannerPrompt({ catalog: FAKE_CATALOG, history: [], request: "x" });
    expect(p).toMatch(/条件」（teamId・assigneeId・status・eventId など）があれば、それで API 側で絞る/);
    expect(p).toMatch(/id（チーム id・イベント id・ユーザー id など）は、そのまま値として再利用する/);
    expect(p).toContain('"teamId":"{{teams.teams[name~法人].id}}"');
    expect(p).toMatch(/担当分はチームをまたぐので teamId では絞らず/);
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

describe("buildTranscript keeps read results whole", () => {
  const rows = Array.from({ length: 300 }, (_, i) => `| task_${i} | タスク${i} | todo |`).join("\n");
  const note = (i: number) => msg("assistant", `${RESULT_PREFIX.preview}読み取り1件を実行${DATA_MARKER}items（300件）\n${rows}`, i);

  it("never cuts a message mid-text (the old 3000-char cut kept 1-2 rows)", () => {
    const tr = buildTranscript([msg("user", "タスクある？", 1), note(2)]);
    expect(tr).toContain("| task_0 |");
    expect(tr).toContain("| task_299 | タスク299 | todo |");
  });

  it("an older note that does not fit loses only its tables, never its facts", () => {
    const history = Array.from({ length: 12 }, (_, i) => note(i + 1));
    const tr = buildTranscript(history);
    expect(tr).toContain("（読み取りデータは会話が長いため省略");
    expect(tr.split("【確認結果】").length - 1).toBe(12);
    expect(tr.endsWith("| task_299 | タスク299 | todo |")).toBe(true);
  });
});

describe("buildAnswerPrompt / buildNarrowPrompt", () => {
  it("gives the answerer every row once, outside the transcript budget", () => {
    const data = Array.from({ length: 500 }, (_, i) => `| task_${i} |`).join("\n");
    const n = msg("assistant", `${RESULT_PREFIX.preview}読み取り1件を実行${DATA_MARKER}${data}`, 5);
    const p = buildAnswerPrompt({ catalog: FAKE_CATALOG, history: [n], readData: data, noteId: n.id });
    expect(p).toContain("# 読み取りデータ（全行）");
    expect(p.split("| task_499 |").length - 1).toBe(1);
    expect(p).toMatch(/件数で言い切る/);
  });

  it("tells the planner the size and filters, read ops only, and when it is the last round", () => {
    const plan = { type: "plan" as const, summary: "", steps: [{ id: "t", op: "tasks.list" }] };
    const p = buildNarrowPrompt({ catalog: FAKE_CATALOG, history: [], plan, facts: "- 手順 t: 400行・約 30.0 KB・使える絞り込み: teamId", last: true });
    expect(p).toContain("使える絞り込み: teamId");
    expect(p).toContain('{"type":"needsFull"');
    expect(p).toMatch(/書き込み・削除の op は使わない/);
    expect(p).toMatch(/これが最後の差し戻し/);
  });

  it("an empty match asks for a corrected read plan only (no needsFull)", () => {
    const plan = { type: "plan" as const, summary: "", steps: [{ id: "t", op: "tasks.list" }] };
    const p = buildNarrowPrompt({ catalog: FAKE_CATALOG, history: [], plan, facts: "- 手順 t: 2件中 0件", last: false, why: "empty" });
    expect(p).toMatch(/対象が見つかりませんでした/);
    expect(p).not.toContain("needsFull");
  });

  it("tells the planner never to translate names from the request", () => {
    expect(buildPlannerPrompt({ catalog: FAKE_CATALOG, history: [], request: "x" })).toMatch(/訳したり言い換えたりせず依頼文の表記のまま/);
  });
});

describe("parsePlannerReply", () => {
  it("parses needsFull with its narrowing options", () => {
    const r = parsePlannerReply(
      '```json\n{"type":"needsFull","reason":"全員分が要ります","options":[{"label":"法人チームだけ","plan":{"summary":"s","steps":[{"id":"a","op":"tasks.list"}]}},{"label":"空","plan":{"steps":[]}}]}\n```',
    );
    expect(r).toMatchObject({ kind: "needsFull", reason: "全員分が要ります", options: [{ label: "法人チームだけ", plan: { summary: "s" } }] });
    if (r.kind === "needsFull") expect(r.options).toHaveLength(1);
  });

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
