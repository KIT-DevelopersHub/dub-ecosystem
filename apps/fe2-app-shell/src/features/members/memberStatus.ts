// 運営メンバーのステータス表示・分類の「単一の真実 (SoT)」。
//
// 名簿のステータスは実質 2 つ(在籍中 / 休み中)＋辞退に整理した。DB / 契約(@dub/types)は
// 後方互換のため raw な MemberStatus (added|invited|considering|on_leave|declined) を保持
// するが、UI ではここで「表示グループ」に畳んで見せる:
//   - added / invited / considering → 「在籍中」(招待中と検討中は同義なので統合)
//   - on_leave                       → 「休み中」(一時離脱・休職とは別。名簿には残る)
//   - declined                       → 「辞退」(名簿一覧からは隠し、辞退者ビューだけで見せる)
//
// ★ラベル文言を変えたい時はこの MEMBER_STATUS_LABEL だけを直せば全画面(バッジ/フォーム/
//   フィルタ)に反映される。呼称は本人確認事項なので既定は「在籍中 / 休み中 / 辞退」。
import type { BadgeTone } from "@dub/ui";
import type { MemberStatus } from "./contracts.ts";

/** 表示グループ(畳んだ後のステータス)。 */
export type StatusGroup = "active" | "onLeave" | "declined";

// ---- ★ラベルの単一の真実 (ここだけ直せば全 UI に反映) --------------------------------
export const MEMBER_STATUS_LABEL: Record<StatusGroup, string> = {
  active: "在籍中",
  onLeave: "休み中",
  declined: "辞退",
};

const TONE: Record<StatusGroup, BadgeTone> = {
  active: "success",
  onLeave: "warning",
  declined: "neutral",
};

/** raw な MemberStatus を表示グループへ畳む。 */
export function statusGroup(s: MemberStatus): StatusGroup {
  if (s === "declined") return "declined";
  if (s === "on_leave") return "onLeave";
  return "active"; // added / invited / considering
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
/** 名簿(在籍者)に出す対象か。辞退だけを除外する(休み中は在籍者に含める)。 */
export function isOnRoster(s: MemberStatus): boolean {
  return s !== "declined";
}

// ---- フォームで「書き込める」正準ステータス --------------------------------------------
// 招待中/検討中の区別は書き込み UI からは無くし(＝在籍中に統合)、在籍中は正準値 "added"
// として保存する。休み中 = on_leave、辞退 = declined。既存の invited/considering 行は読取り
// では「在籍中」と表示され、編集して保存すると "added" に正準化される(＝統合される)。
export interface StatusOption {
  value: MemberStatus;
  label: string;
}
export const WRITE_STATUS_OPTIONS: StatusOption[] = [
  { value: "added", label: MEMBER_STATUS_LABEL.active },
  { value: "on_leave", label: MEMBER_STATUS_LABEL.onLeave },
  { value: "declined", label: MEMBER_STATUS_LABEL.declined },
];

/** 編集時の初期選択値: raw ステータスを書き込み正準値へ寄せる(在籍系→"added")。 */
export function toWriteStatus(s: MemberStatus): MemberStatus {
  return statusGroup(s) === "active" ? "added" : s;
}

// ---- 名簿(フラット一覧)の絞り込み ------------------------------------------------------
export type RosterStatusFilter = "roster" | "active" | "onLeave" | "declined";
export const ROSTER_FILTER_OPTIONS: { value: RosterStatusFilter; label: string }[] = [
  { value: "roster", label: "在籍者(辞退以外)" },
  { value: "active", label: MEMBER_STATUS_LABEL.active },
  { value: "onLeave", label: MEMBER_STATUS_LABEL.onLeave },
  { value: "declined", label: "辞退者" },
];

export function matchesRosterFilter(s: MemberStatus, f: RosterStatusFilter): boolean {
  switch (f) {
    case "roster":
      return isOnRoster(s);
    case "active":
      return statusGroup(s) === "active";
    case "onLeave":
      return statusGroup(s) === "onLeave";
    case "declined":
      return statusGroup(s) === "declined";
  }
}
