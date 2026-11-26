// Release state of the event AI digest (#879). The panel is shown to every member who can
// see the event. The AI chat stays closed until the release date below; change the date
// here only, and flip AI_CHAT_AVAILABLE when the Mac mini is live.
export const AI_RELEASE_DATE_LABEL = "12/3";
export const AI_CHAT_AVAILABLE = false;
export const AI_UNAVAILABLE_MESSAGE = `現在は利用できません。${AI_RELEASE_DATE_LABEL} 公開予定です。`;

const SOURCE_LABELS: Record<string, string> = {
  event: "イベント",
  actions: "アクション",
  tasks: "タスク",
  tickets: "チケット",
  lp: "LP",
  sponsors: "協賛",
  meetings: "会議",
  chat: "チャット",
  mail: "メール",
  drive: "ドライブ",
};
export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

const FIELD_LABELS: Record<string, string> = { startsAt: "開催日", venue: "会場", capacity: "定員" };
export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

/** In-app paths go through the shell navigator; https URLs open in a new tab. */
export function isExternalLink(link: string): boolean {
  return /^https:\/\//.test(link);
}
