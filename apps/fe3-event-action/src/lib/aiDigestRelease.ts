// Release state of the event AI digest (#879). The date / flag / 文言 live in @dub/app-ui
// (shared with the shell's AI side panel) — change them there, not here.
export { AI_RELEASE_DATE_LABEL, AI_CHAT_AVAILABLE, AI_UNAVAILABLE_MESSAGE } from "@dub/app-ui";

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
