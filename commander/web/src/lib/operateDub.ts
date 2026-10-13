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

/**
 * Transcript budget: newest messages win when the session grows long. Messages are never
 * cut mid-text; an older 【確認結果】 that does not fit loses only its read tables.
 */
const TRANSCRIPT_CHARS = 60_000;

/** Prefixes of the assistant messages the console writes itself (not the planner). */
export const RESULT_PREFIX = { preview: "【確認結果】", execution: "【実行結果】" } as const;

/** Splits a 【確認結果】 into its facts and the read tables (folded under 詳細 in the UI). */
export const DATA_MARKER = "\n---読み取りデータ---\n";
const DATA_DROPPED = "\n（読み取りデータは会話が長いため省略。必要なら絞り込んで読み直す）";

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

/**
 * The session so far, oldest first, trimmed from the oldest end to the budget.
 * `dropDataOf` = a message whose read tables are passed separately (the answer prompt).
 */
export function buildTranscript(messages: ChatMessage[], opts: { dropDataOf?: string } = {}): string {
  const out: string[] = [];
  let used = 0;
  const kept = messages.filter((m) => m.text.trim() && m.status !== "streaming");
  for (let i = kept.length - 1; i >= 0; i--) {
    const m = kept[i]!;
    const cut = m.text.indexOf(DATA_MARKER);
    const facts = cut < 0 ? m.text : m.text.slice(0, cut);
    const full = `[${speaker(m)}]\n${m.id === opts.dropDataOf ? facts : m.text}`;
    const line = used + full.length <= TRANSCRIPT_CHARS || cut < 0 ? full : `[${speaker(m)}]\n${facts}${DATA_DROPPED}`;
    used += line.length;
    if (used > TRANSCRIPT_CHARS) break;
    out.unshift(line);
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
  "- 取り消せない操作（物理削除など）と一括エンドポイントは無い。1回の書き込みは20件まで（10件を超えると確認フレーズが要る）。超えるなら条件で絞る案を文章で返す。",
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
  "- 依頼文にある名前（イベント名・チーム名・人名）は、訳したり言い換えたりせず依頼文の表記のまま where やセレクタに使う（例「Hokuriku IT Conference 2026」を「北陸ITカンファレンス2026」にしない）。",
  "- 名前から id を引くときは {{手順id.配列[name~法人].id}}（部分一致の最初の1件）か [name=法人チーム]（完全一致）を使う。見つからなければ実行前に止まる。",
  "",
  "# 読み取りの計画",
  "- 読むのは答えに必要な分だけ。カタログの「条件」（teamId・assigneeId・status・eventId など）があれば、それで API 側で絞る。全件を読んでから頭の中で絞らない。",
  "- これまでの［システム］確認結果の表に出た id（チーム id・イベント id・ユーザー id など）は、そのまま値として再利用する。同じ一覧を読み直さない。",
  "- 読み取り結果は主要項目だけの表（全行）に整形されて回答に使われる。大きすぎると差し戻されるので、そのときは指示どおり絞った計画を返す。",
  "",
  "# 例",
  "依頼「北陸ITカンファレンス2027 の概要を『…』に差し替えて」:",
  '{"type":"plan","summary":"イベント「北陸ITカンファレンス2027」1件の概要を差し替えます","steps":[{"id":"list","op":"events.list","query":{"limit":"100"}},{"id":"ev","op":"events.get","forEach":"list.items","where":[{"field":"title","op":"contains","value":"北陸ITカンファレンス2027"}],"params":{"id":"{{item.id}}"}},{"id":"upd","op":"events.update","forEach":"ev","params":{"id":"{{item.id}}"},"body":{"description":"…","version":"{{item.version}}"},"label":"{{item.title}}"}]}',
  "依頼「法人メンバーのタスクって今何かある？」（チームのタスクと、そのメンバーの担当分の両方に答える。担当分はチームをまたぐので teamId では絞らず、名簿と全タスクを読む）:",
  '{"type":"plan","summary":"名簿と全イベントのタスクを読み、法人チームのタスクと法人メンバーの担当分を確認します（読み取りのみ）","steps":[{"id":"roster","op":"members.overview"},{"id":"events","op":"events.list","query":{"limit":"100"}},{"id":"tasks","op":"tasks.list","forEach":"events.items","query":{"eventId":"{{item.id}}","limit":"200"},"label":"{{item.title}}"}]}',
  "依頼「法人チームのタスクだけ見せて」（チーム名から id を引き、条件 teamId で絞る）:",
  '{"type":"plan","summary":"法人チームのタスクを全イベント分読み取ります（読み取りのみ）","steps":[{"id":"teams","op":"members.teams.list"},{"id":"events","op":"events.list","query":{"limit":"100"}},{"id":"tasks","op":"tasks.list","forEach":"events.items","query":{"eventId":"{{item.id}}","teamId":"{{teams.teams[name~法人].id}}","limit":"200"},"label":"{{item.title}}"}]}',
  "続けて「その中で未着手のものは？」（前の確認結果の表に出た id。この例では event_A と member_team_corp。それをそのまま使い、status で絞る）:",
  '{"type":"plan","summary":"法人チームの未着手タスクを読み取ります（読み取りのみ）","steps":[{"id":"tasks","op":"tasks.list","query":{"eventId":"event_A","teamId":"member_team_corp","status":"todo","limit":"200"}}]}',
  "依頼「メールアドレスが無い人全員に発行して」:",
  '{"type":"plan","summary":"受信アドレスが未発行の在籍メンバーにアドレスを発行します","steps":[{"id":"users","op":"users.list","query":{"status":"active","limit":"200"}},{"id":"issued","op":"mail.issued.list"},{"id":"issue","op":"mail.issued.create","forEach":"users.items","where":[{"field":"email","op":"endsWith","value":"@developershub.jp"},{"field":"email","op":"notIn","value":"{{issued.items[*].address}}"}],"body":{"localPart":"{{item.email|localPart}}"},"label":"{{item.displayName}}"}]}',
  "依頼「通知『デプロイ完了』を削除して」:",
  '{"type":"plan","summary":"通知「デプロイ完了」をメンバー全員の受信箱から取り下げます","steps":[{"id":"n","op":"notifications.manage.list","query":{"limit":"200"}},{"id":"del","op":"notifications.unpublish","forEach":"n.items","where":[{"field":"title","op":"contains","value":"デプロイ完了"},{"field":"publishedBroadcastId","op":"notEmpty"}],"params":{"id":"{{item.id}}"},"label":"{{item.title}}"}]}',
].join("\n");

export function buildPlannerPrompt(input: {
  catalog: CatalogEntry[];
  history: ChatMessage[];
  request: string;
  /** Message whose read tables are given in full elsewhere in the prompt. */
  dropDataOf?: string;
}): string {
  return [
    RULES,
    "",
    "# 操作カタログ",
    describeCatalog(input.catalog),
    "",
    "# これまでの会話",
    buildTranscript(input.history, { dropDataOf: input.dropDataOf }),
    "",
    "# 今回の依頼",
    input.request,
  ].join("\n");
}

/**
 * After a read-only preview: answer the question from the reads, in prose. `readData` =
 * every row of every read (compacted), given whole here rather than through the transcript
 * budget; `noteId` = the 【確認結果】 carrying the same tables (not repeated).
 */
export function buildAnswerPrompt(input: { catalog: CatalogEntry[]; history: ChatMessage[]; readData?: string; noteId?: string }): string {
  return buildPlannerPrompt({
    catalog: input.catalog,
    history: input.history,
    dropDataOf: input.noteId,
    request: [
      "直前の［システム］確認結果の読み取りデータを使って、ユーザーの最後の依頼に日本語の文章で答えてください。",
      "- 読み取りデータは省略なしの全行です。「省略されていて分からない」とは書かない。数えて件数で言い切る（例「法人チームのタスクは N 件／法人メンバーの担当分は M 件」）。",
      "- 結論を先に書き、該当するものは表（Markdown）で全件を並べる。id は名簿・一覧の表で名前に置き換えられるなら名前で書く。",
      "- 計画や JSON は書かないこと。それでも分からないことがあれば、何が分からなかったかを書くこと。",
      ...(input.readData ? ["", "# 読み取りデータ（全行）", input.readData] : []),
    ].join("\n"),
  });
}

/**
 * Send a read back to the planner: over budget (op, rows, size, the op's filters) or a where
 * that matched nothing ("empty"). Read-only by construction: the console drops any reply
 * that contains a write before previewing it.
 */
export function buildNarrowPrompt(input: {
  catalog: CatalogEntry[];
  history: ChatMessage[];
  plan: PlannerPlan;
  /** describeOverBudget / describeEmptyMatch. */
  facts: string;
  last: boolean;
  why?: "over" | "empty";
}): string {
  const planBlock = ["直前の計画:", "```json", JSON.stringify(input.plan), "```", ""];
  const request =
    input.why === "empty"
      ? [
          "直前の計画の読み取りで、対象が見つかりませんでした（ユーザーへの確認は不要。読み取りだけなので自動で読み直します）。",
          input.facts,
          "",
          ...planBlock,
          '直した読み取り計画を ```json のブロック1つで返してください（{"type":"plan",...}）。読み取りの op だけを使うこと（書き込み・削除の op は使わない）。',
        ]
      : [
          "直前の計画の読み取り結果が大きすぎて、回答に渡せませんでした（ユーザーへの確認は不要。読み取りだけなので自動で読み直します）。",
          input.facts,
          "",
          ...planBlock,
          "ユーザーの最後の依頼に答えられる範囲で、次のどちらかを ```json のブロック1つで返してください。読み取りの op だけを使うこと（書き込み・削除の op は使わない）。",
          '(1) 条件（上の「使える絞り込み」）で絞った読み取り計画: {"type":"plan","summary":"…","steps":[…]}。直前と同じ計画は返さない。',
          '(2) 絞ると答えられない（全件が本当に要る）とき: {"type":"needsFull","reason":"全件が要る理由を日本語1文","options":[{"label":"ユーザーが選べる絞り込み案を日本語で短く","plan":{"summary":"…","steps":[…]}}]}。options には読み取り計画を1〜3個入れる。',
          ...(input.last ? ["これが最後の差し戻しです。絞っても収まる見込みが無ければ (2) を返してください。"] : []),
        ];
  return buildPlannerPrompt({ catalog: input.catalog, history: input.history, request: request.join("\n") });
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

/** A narrowing the planner offers when it says the full read is needed. */
export interface NarrowOption {
  label: string;
  plan: PlannerPlan;
}

export type PlannerReply =
  | { kind: "plan"; plan: PlannerPlan; intro: string }
  | { kind: "needsFull"; reason: string; options: NarrowOption[]; intro: string }
  | { kind: "answer"; text: string }
  | { kind: "invalid"; error: string };

const asPlan = (v: unknown): PlannerPlan | null => {
  const o = v as Partial<PlannerPlan> | null;
  if (!o || typeof o !== "object" || !Array.isArray(o.steps) || o.steps.length === 0) return null;
  return { type: "plan", summary: typeof o.summary === "string" ? o.summary : "", steps: o.steps as PlanStep[] };
};

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
  const intro = text.slice(0, last.index).replace(FENCE_RE, "").trim();
  const obj = data as { type?: unknown; reason?: unknown; options?: unknown } | null;
  if (obj?.type === "needsFull") {
    const options = (Array.isArray(obj.options) ? obj.options : [])
      .map((o) => ({ label: String((o as { label?: unknown })?.label ?? ""), plan: asPlan((o as { plan?: unknown })?.plan) }))
      .filter((o): o is NarrowOption => !!o.label && !!o.plan);
    return { kind: "needsFull", reason: typeof obj.reason === "string" ? obj.reason : "", options, intro };
  }
  const plan = asPlan(data);
  if (!plan) return { kind: "invalid", error: "計画に手順が含まれていませんでした。もう一度お願いします" };
  return { kind: "plan", plan, intro };
}
