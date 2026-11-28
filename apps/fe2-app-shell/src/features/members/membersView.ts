// 運営メンバータブの表示切り替え（カード = チーム別 / 表 = 運営名簿の一覧）。
// 選んだ表示は URL (?view=table) と localStorage の両方に残す。URL が優先で、
// URL に無ければ前回選んだ表示、それも無ければカード。表は members:roster_view が無いと出さない。
export type MembersView = "cards" | "table";

export const MEMBERS_VIEW_PARAM = "view";
export const MEMBERS_VIEW_STORAGE_KEY = "dub.members.view";

export function parseMembersView(raw: string | null | undefined): MembersView | null {
  return raw === "cards" || raw === "table" ? raw : null;
}

/** 実際に出す表示。表を見られない人はいつでもカード（fail-closed）。 */
export function resolveMembersView(fromUrl: MembersView | null, stored: MembersView | null, canTable: boolean): MembersView {
  const wanted = fromUrl ?? stored ?? "cards";
  return wanted === "table" && !canTable ? "cards" : wanted;
}

export function readStoredMembersView(): MembersView | null {
  try {
    return parseMembersView(globalThis.localStorage?.getItem(MEMBERS_VIEW_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function storeMembersView(view: MembersView): void {
  try {
    globalThis.localStorage?.setItem(MEMBERS_VIEW_STORAGE_KEY, view);
  } catch {
    // 保存できなくても URL で保持できるので無視する。
  }
}
