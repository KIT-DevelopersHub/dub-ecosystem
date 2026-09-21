// Lightweight, LOCAL intent classification for the chat capture bar. The whole point
// of this module is to decide — without spawning a single claude (＄0 / 非力PC) — whether
// a line the operator typed is a *task* ("〜を作って/直して/調べて" = a request to do work)
// or just *chat* (a greeting, a thank-you, an info question). Anything genuinely unclear
// is returned as "ambiguous" so the UI can ask instead of guessing. Pure + unit-tested so
// the rule can't silently drift.

export type IntentKind = "task" | "chat" | "ambiguous";

export interface Intent {
  kind: IntentKind;
  /** A short task title derived from the input (used when kind !== "chat"). */
  title: string;
  /** Which signal decided it (for debugging / tests). */
  reason: string;
}

// Strong request / imperative markers → this is work to be done.
const TASK_MARKERS: RegExp[] = [
  // 依頼表現: 〜してほしい / してください / お願い / 頼む
  /(して|やって)(ほしい|くれ|ください|くれる|もらえ|ちょうだい)/,
  /(お願い|おねがい|頼み|頼む|たのむ|依頼)/,
  // 動作動詞（テ形・命令・辞書形の依頼）: 作る/直す/修正/実装/追加/変更/削除/調べる/生成/対応/用意/セットアップ/デプロイ/レビュー
  /(作|つく|創|直|なお|修正|実装|追加|変更|削除|消|調べ|調査|生成|対応|用意|準備|セットアップ|デプロイ|レビュー|リファクタ|書い|書き|直し)(って|て|る|して|し|を|た)/,
  // English imperative verbs
  /\b(build|make|create|fix|add|implement|refactor|write|generate|update|delete|remove|deploy|set\s?up|investigate|research|design)\b/i,
];

// Info-question markers that OVERRIDE a task marker ("Reactって何？" is chat, not work).
const INFO_QUESTION: RegExp[] = [
  /(とは|って(何|なに)|の意味|どういう意味|何ですか|なにですか|説明して?)[\s。.!！?？]*$/,
  /^(なぜ|なんで|どうして|why)\b/i,
];

// Pure chat: greetings, thanks, acknowledgements.
const CHAT_MARKERS: RegExp[] = [
  /^(こんにちは|こんばんは|おはよう|やあ|よろ|よろしく|hi|hello|hey|hiya|お疲れ|おつかれ)/i,
  /(ありがとう|thanks|thank\s?you|thx|助かった|感謝)/i,
  /^(ok|okay|オッケー|おっけー|了解|わかった|なるほど|うん|はい|いいね|👍)[\s。.!！]*$/i,
];

const QUESTION_TAIL = /[?？]\s*$/;

/** Trim a freeform line into a short, readable task title. */
export function deriveTaskTitle(text: string, max = 48): string {
  let s = text.trim().replace(/\s+/g, " ");
  // Drop a trailing polite request suffix so the title reads as a thing, not a plea.
  s = s.replace(
    /(を)?(して)?(ほしい|ください|くれ|くれる?|お願いします?|おねがいします?|頼む|たのむ)[。.!！?？]*$/,
    "",
  );
  s = s.replace(/[。.!！]+$/, "").trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s || text.trim().slice(0, max);
}

/**
 * Classify one line of chat input. Precedence:
 *  1. empty / very short filler       → chat
 *  2. explicit info-question ("とは？") → chat (even if a verb appears)
 *  3. pure greeting / thanks           → chat
 *  4. any task/imperative marker       → task
 *  5. otherwise                        → ambiguous (UI asks the operator)
 */
export function classifyIntent(raw: string): Intent {
  const text = raw.trim();
  const title = deriveTaskTitle(text);

  if (text === "") return { kind: "chat", title: "", reason: "empty" };

  if (INFO_QUESTION.some((re) => re.test(text))) {
    return { kind: "chat", title, reason: "info-question" };
  }

  const hasTaskMarker = TASK_MARKERS.some((re) => re.test(text));
  const isChat = CHAT_MARKERS.some((re) => re.test(text));

  // A greeting/thanks with no work verb is chat.
  if (isChat && !hasTaskMarker) return { kind: "chat", title, reason: "greeting-or-thanks" };

  if (hasTaskMarker) return { kind: "task", title, reason: "task-marker" };

  // A bare question with no work verb → chat.
  if (QUESTION_TAIL.test(text)) return { kind: "chat", title, reason: "bare-question" };

  // Long-ish declarative text with no clear signal → ask.
  return { kind: "ambiguous", title, reason: "no-clear-signal" };
}
