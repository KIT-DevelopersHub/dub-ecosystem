// Release gate for the event AI digest (#879). Not released to members yet: the panel
// renders only for full admins (identity:admin), mirroring fe2's releaseGate rule
// (unreleased = admin/dev only). Releasing it is this one line → `true`.
export const AI_DIGEST_RELEASED = false;

export function aiDigestVisible(isAdmin: boolean): boolean {
  return AI_DIGEST_RELEASED || isAdmin;
}

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
