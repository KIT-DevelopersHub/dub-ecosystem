// 運営メンバータブ（/members）。チーム別のカードと、運営名簿の表を 1 つのタブで切り替える。
// 以前は 運営メンバー(/members) と 運営名簿(/members/roster) が別タブで、同じ人の情報を
// 別の見せ方で出していただけだった（Issue #901）。表は members:roster_view がある人だけ選べる。
// 選んだ表示は URL (?view=table) と localStorage に残す（membersView.ts）。
import { useEffect, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { usePermissions } from "../../auth/AuthProvider.tsx";
import { MembersPage } from "./MembersPage.tsx";
import { MemberRosterPage } from "./MemberRosterPage.tsx";
import { MembersViewSwitch } from "./MembersViewSwitch.tsx";
import {
  MEMBERS_VIEW_PARAM,
  parseMembersView,
  readStoredMembersView,
  resolveMembersView,
  storeMembersView,
  type MembersView,
} from "./membersView.ts";

export function MembersHub({
  view,
  canTable,
  onChangeView,
}: {
  view: MembersView;
  canTable: boolean;
  onChangeView: (v: MembersView) => void;
}): JSX.Element {
  // 表を選べない人には切り替えを出さない（選択肢が 1 つだけのスイッチは置かない）。
  const viewSwitch = canTable ? <MembersViewSwitch value={view} onChange={onChangeView} /> : null;
  return view === "table" ? <MemberRosterPage viewSwitch={viewSwitch} /> : <MembersPage viewSwitch={viewSwitch} />;
}

export function MembersHubPage(): JSX.Element {
  const { can } = usePermissions();
  const navigate = useNavigate();
  const fromUrl = useRouterState({
    select: (s) => parseMembersView(new URLSearchParams(s.location.searchStr ?? "").get(MEMBERS_VIEW_PARAM)),
  });
  const [stored] = useState(readStoredMembersView);
  const view = resolveMembersView(fromUrl, stored, can("members:roster_view"));

  const onChangeView = (next: MembersView): void => {
    storeMembersView(next);
    void navigate({ to: "/members", search: { [MEMBERS_VIEW_PARAM]: next } as never, replace: true });
  };

  return <MembersHub view={view} canTable={can("members:roster_view")} onChangeView={onChangeView} />;
}

/** 旧 運営名簿タブ(/members/roster) の URL は、運営メンバータブの表へ置き換えて移す。 */
export function MemberRosterRedirect(): null {
  const navigate = useNavigate();
  useEffect(() => {
    void navigate({ to: "/members", search: { [MEMBERS_VIEW_PARAM]: "table" } as never, replace: true });
  }, [navigate]);
  return null;
}
