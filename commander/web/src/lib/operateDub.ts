// "Dubを操作する" — the planner. A claude run turns the operator's words into either a
// plan over the API catalog or a plain Japanese answer. What makes it reliable:
//   - every turn gets the WHOLE session (requests, plans, preview + execution results),
//     so "さっきのイベント" and "失敗した分だけ" resolve against what really happened;
//   - the run has NO tools (`--tools ""`) and runs outside the repo, so it cannot wander
//     into files such as an unrelated migration;
//   - the reply is fixed to Japanese + one fixed JSON schema; anything else is an answer.
// Plans are executed only by the daemon (/operate/*), never from here.

import type { ChatMessage } from "./commanderApi.ts";
import type { CatalogEntry } from "./operateApi.ts";

/** Neutral cwd for planner runs: no repo, no project CLAUDE.md. */
export const OPERATE_PLANNER_CWD =
  (import.meta.env?.VITE_OPERATE_PLANNER_CWD as string | undefined) ?? "/tmp";

/** No tools at all (no Bash/Read/Grep/Task/MCP) — the planner only writes text. */
export const OPERATE_PLANNER_ARGS = ["--tools", "", "--strict-mcp-config"];

/** Transcript budget: newest messages win when the session grows long. */
const MESSAGE_CHARS = 3000;
const TRANSCRIPT_CHARS = 40_000;

/** Prefixes of the assistant messages the console writes itself (not the planner). */
export const RESULT_PREFIX = { preview: "【確認結果】", execution: "【実行結果】" } as const;

const KIND_LABEL: Record<CatalogEntry["kind"], string> = { read: "読み取り", write: "書き込み", delete: "削除" };
const RISK_LABEL: Record<CatalogEntry["risk"], string> = { low: "低", mid: "中", high: "高" };

export function describeCatalog(entries: CatalogEntry[]): string {
  return entries
    .map((e) => {
      const tags = e.kind === "read" ? KIND_LABEL.read : `${KIND_LABEL[e.kind]}・リスク${RISK_LABEL[e.risk]}・${e.reversible ? "取り消し可" : "取り消し不可"}`;
      const extra = [
        e.hint ?? "",
        e.query?.length ? `条件: ${e.query.join(", ")}` : "",
        e.body ? `本文: ${e.body.allowed.join(", ")}（必須: ${e.body.required.join(", ")}）` : "",
      ].filter(Boolean);
      return `- ${e.id} [${tags}] ${e.method} ${e.path} — ${e.description}${extra.length ? ` / ${extra.join(" / ")}` : ""}`;
    })
    .join("\n");
}

function speaker(m: ChatMessage): string {
  if (m.role === "user") return "ユーザー";
  if (m.text.startsWith(RESULT_PREFIX.preview) || m.text.startsWith(RESULT_PREFIX.execution)) return "システム";
  return "アシスタント";
}

/** The session so far, oldest first, trimmed from the oldest end to the budget. */
export function buildTranscript(messages: ChatMessage[]): string {
  const lines = messages
    .filter((m) => m.text.trim() && m.status !== "streaming")
    .map((m) => {
      const text = m.text.length > MESSAGE_CHARS ? `${m.text.slice(0, MESSAGE_CHARS)}…（以下省略）` : m.text;
      return `[${speaker(m)}]\n${text}`;
    });
  const out: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    used += lines[i]!.length;
    if (used > TRANSCRIPT_CHARS) break;
    out.unshift(lines[i]!);
  }
  return out.join("\n\n") || "（まだありません）";
}

const RULES = [
  "あなたは Dub（DevelopersHub の業務アプリ）のデータ操作アシスタントです。",
  "",
  "# 守ること",
  "- 返答は必ず日本語。英語の文や生の JSON をユーザー向けの文章に混ぜない。",
  "- 使える操作は「操作カタログ」の op だけ。SQL・curl・ファイル・カタログに無い API は使わないし提案もしない。",
  "- あなたはリポジトリもファイルも見られない。ID・version・メールアドレスを推測で書かない。必ず読み取り手順の結果を {{手順id.パス}} で参照する。<EVENT_ID> のような仮の値は禁止（残っていると実行されない）。",
  "- 読み取り手順は承認前に自動で実行され、その結果が後の手順に入る。",
  "- 物理削除と一括エンドポイントは無い。1回の書き込みは20件まで。超えるなら条件で絞る案を文章で返す。",
  "- これまでの会話と［システム］の確認結果・実行結果を必ず踏まえる。「さっきの」「それ」は会話から特定する。直前の実行が一部失敗なら、失敗した対象だけをやり直す計画にする。",
  "- 依頼が Dub のデータを読む・変える内容なら計画を返す。雑談・使い方の質問・相談には計画を作らず、普通の日本語の文章だけで答える（JSON もコードブロックも書かない）。",
  "- 対象が会話からも読み取りからも特定できないときは、計画を作らずに確認の質問を文章で返す。",
  "",
  "# 計画の形式",
  "冒頭に何をするかを日本語1〜2文で書き、続けて ```json のコードブロックを1つだけ書く。形式:",
  '{"type":"plan","summary":"何を・何件・誰に を日本語1文で","steps":[{"id":"英字で始まるid","op":"カタログのid","params":{},"query":{},"body":{},"forEach":"前の手順id.配列のパス","where":[{"field":"項目","op":"eq|ne|contains|endsWith|in|notIn|empty|notEmpty","value":"値"}],"label":"{{item.title}}"}]}',
  "- 参照: {{手順id.items[0].id}}、配列の全要素は {{手順id.items[*].address}}。forEach 中の各要素は {{item.項目}}。{{item.email|localPart}} で @ より前。",
  "- 値が参照1つだけなら元の型（数値など）のまま入る。forEach を付けた読み取りの結果は配列になる。",
  "- label には対象を人が見て分かる名前（イベント名・氏名など）を入れる。",
  "",
  "# 例",
  "依頼「北陸ITカンファレンス2027 の概要を『…』に差し替えて」:",
  '{"type":"plan","summary":"イベント「北陸ITカンファレンス2027」1件の概要を差し替えます","steps":[{"id":"list","op":"events.list","query":{"limit":"100"}},{"id":"ev","op":"events.get","forEach":"list.items","where":[{"field":"title","op":"contains","value":"北陸ITカンファレンス2027"}],"params":{"id":"{{item.id}}"}},{"id":"upd","op":"events.update","forEach":"ev","params":{"id":"{{item.id}}"},"body":{"description":"…","version":"{{item.version}}"},"label":"{{item.title}}"}]}',
  "依頼「メールアドレスが無い人全員に発行して」:",
  '{"type":"plan","summary":"受信アドレスが未発行の在籍メンバーにアドレスを発行します","steps":[{"id":"users","op":"users.list","query":{"status":"active","limit":"200"}},{"id":"issued","op":"mail.issued.list"},{"id":"issue","op":"mail.issued.create","forEach":"users.items","where":[{"field":"email","op":"endsWith","value":"@developershub.jp"},{"field":"email","op":"notIn","value":"{{issued.items[*].address}}"}],"body":{"localPart":"{{item.email|localPart}}"},"label":"{{item.displayName}}"}]}',
  "依頼「通知『デプロイ完了』を削除して」:",
  '{"type":"plan","summary":"通知「デプロイ完了」をメンバー全員の受信箱から取り下げます","steps":[{"id":"n","op":"notifications.manage.list","query":{"limit":"200"}},{"id":"del","op":"notifications.unpublish","forEach":"n.items","where":[{"field":"title","op":"contains","value":"デプロイ完了"},{"field":"publishedBroadcastId","op":"notEmpty"}],"params":{"id":"{{item.id}}"},"label":"{{item.title}}"}]}',
].join("\n");

export function buildPlannerPrompt(input: { catalog: CatalogEntry[]; history: ChatMessage[]; request: string }): string {
  return [
    RULES,
    "",
    "# 操作カタログ",
    describeCatalog(input.catalog),
    "",
    "# これまでの会話",
    buildTranscript(input.history),
    "",
    "# 今回の依頼",
    input.request,
  ].join("\n");
}

/** After a read-only preview: answer the question from the reads, in prose. */
export function buildAnswerPrompt(input: { catalog: CatalogEntry[]; history: ChatMessage[] }): string {
  return buildPlannerPrompt({
    ...input,
    request:
      "直前の［システム］確認結果の読み取りデータを使って、ユーザーの最後の依頼に日本語の文章で答えてください。" +
      "計画や JSON は書かないこと。データが足りなければ、何が分からなかったかを書くこと。",
  });
}

// ---- reply parsing ------------------------------------------------------------------

export interface PlanStep {
  id: string;
  op: string;
  [key: string]: unknown;
}
export interface PlannerPlan {
  type: "plan";
  summary: string;
  steps: PlanStep[];
}

export type PlannerReply =
  | { kind: "plan"; plan: PlannerPlan; intro: string }
  | { kind: "answer"; text: string }
  | { kind: "invalid"; error: string };

const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/gi;

/** A fenced block wins; else the reply is prose (an answer / a clarifying question). */
export function parsePlannerReply(text: string): PlannerReply {
  const blocks = [...text.matchAll(FENCE_RE)];
  const last = blocks.at(-1);
  if (!last) return { kind: "answer", text: text.trim() };
  let data: unknown;
  try {
    data = JSON.parse(last[1]!.trim());
  } catch {
    return { kind: "invalid", error: "計画の形式が読み取れませんでした。言い方を変えてもう一度お願いします" };
  }
  const obj = data as Partial<PlannerPlan> | null;
  if (!obj || !Array.isArray(obj.steps) || obj.steps.length === 0) {
    return { kind: "invalid", error: "計画に手順が含まれていませんでした。もう一度お願いします" };
  }
  const intro = text.slice(0, last.index).replace(FENCE_RE, "").trim();
  return {
    kind: "plan",
    plan: { type: "plan", summary: typeof obj.summary === "string" ? obj.summary : "", steps: obj.steps as PlanStep[] },
    intro,
  };
}
