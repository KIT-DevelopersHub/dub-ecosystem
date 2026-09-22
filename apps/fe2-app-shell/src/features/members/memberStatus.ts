// 運営メンバーのステータス表示・分類の「単一の真実 (SoT)」。
//
// 名簿の表示ステータスは「打診中 / 休み中 / (通常=バッジなし)」＋辞退に整理した。DB / 契約
// (@dub/types) は後方互換のため raw な MemberStatus (added|invited|considering|on_leave|
// declined) を保持するが、UI ではここで「表示グループ」に畳んで見せる:
//   - added                          → 通常メンバー(バッジを出さない = 在籍中の既定状態)
//   - invited / considering          → 「打診中」(招待中と検討中は同義なので統合)
//   - on_leave                       → 「休み中」(一時離脱・休職とは別。名簿には残る)
//   - declined                       → 「辞退」(名簿一覧からは隠し、辞退者ビューだけで見せる)
//
// ★「在籍中」バッジは廃止した。通常メンバー(added)はバッジ無しで、打診中/休み中/辞退だけを
//   バッジで区別する。ラベル文言を変えたい時はこの MEMBER_STATUS_LABEL だけを直せば全画面
//   (バッジ/フォーム/フィルタ)に反映される。
import type { BadgeTone } from "@dub/ui";
import type { MemberStatus } from "./contracts.ts";

/** 表示グループ(畳んだ後のステータス)。member = 通常(バッジなし)。 */
export type StatusGroup = "member" | "pending" | "onLeave" | "declined";

// ---- ★ラベルの単一の真実 (ここだけ直せば全 UI に反映) --------------------------------
// member(通常)はバッジを出さないのでラベルは空文字。フォーム/フィルタ用の呼称は別に持つ。
export const MEMBER_STATUS_LABEL: Record<StatusGroup, string> = {
  member: "",
  pending: "打診中",
  onLeave: "休み中",
  declined: "辞退",
};

const TONE: Record<StatusGroup, BadgeTone> = {
  member: "neutral",
  pending: "warning",
  onLeave: "neutral",
  declined: "neutral",
};

/** raw な MemberStatus を表示グループへ畳む。 */
export function statusGroup(s: MemberStatus): StatusGroup {
  if (s === "declined") return "declined";
  if (s === "on_leave") return "onLeave";
  if (s === "invited" || s === "considering") return "pending";
  return "member"; // added(通常)
}

/** バッジを表示するか。通常メンバー(added)は false(バッジなし)。 */
export function hasStatusBadge(s: MemberStatus): boolean {
  return statusGroup(s) !== "member";
}

export function statusLabel(s: MemberStatus): string {
  return MEMBER_STATUS_LABEL[statusGroup(s)];
}
export function statusTone(s: MemberStatus): BadgeTone {
  return TONE[statusGroup(s)];
}

export function isDeclined(s: MemberStatus): boolean {
  return s === "declined";
}
/** 名簿(在籍者)に出す対象か。辞退だけを除外する(打診中・休み中は在籍者に含める)。 */
export function isOnRoster(s: MemberStatus): boolean {
  return s !== "declined";
}

// ---- フォームで「書き込める」正準ステータス --------------------------------------------
// 通常メンバー = "added"、打診中 = "invited"(検討中は打診中へ統合)、休み中 = "on_leave"、
// 辞退 = "declined"。既存の considering 行は読取りでは「打診中」と表示され、編集して保存すると
// "invited" に正準化される。
export interface StatusOption {
  value: MemberStatus;
  label: string;
}
export const WRITE_STATUS_OPTIONS: StatusOption[] = [
  { value: "added", label: "通常メンバー" },
  { value: "invited", label: MEMBER_STATUS_LABEL.pending },
  { value: "on_leave", label: MEMBER_STATUS_LABEL.onLeave },
  { value: "declined", label: MEMBER_STATUS_LABEL.declined },
];

/** 編集時の初期選択値: raw ステータスを書き込み正準値へ寄せる(通常→"added"・打診系→"invited")。 */
export function toWriteStatus(s: MemberStatus): MemberStatus {
  const g = statusGroup(s);
  if (g === "member") return "added";
  if (g === "pending") return "invited";
  return s;
}

// ---- 名簿(フラット一覧)の絞り込み ------------------------------------------------------
export type RosterStatusFilter = "roster" | "member" | "pending" | "onLeave" | "declined";
export const ROSTER_FILTER_OPTIONS: { value: RosterStatusFilter; label: string }[] = [
  { value: "roster", label: "在籍者(辞退以外)" },
  { value: "member", label: "通常メンバー" },
  { value: "pending", label: MEMBER_STATUS_LABEL.pending },
  { value: "onLeave", label: MEMBER_STATUS_LABEL.onLeave },
  { value: "declined", label: "辞退者" },
];

export function matchesRosterFilter(s: MemberStatus, f: RosterStatusFilter): boolean {
  switch (f) {
    case "roster":
      return isOnRoster(s);
    case "member":
      return statusGroup(s) === "member";
    case "pending":
      return statusGroup(s) === "pending";
    case "onLeave":
      return statusGroup(s) === "onLeave";
    case "declined":
      return statusGroup(s) === "declined";
  }
}
