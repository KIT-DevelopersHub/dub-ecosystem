// 運営メンバー・名簿 — 統合アプリの共有サブナビ（横タブ帯）。
//
// 運営メンバー(member-service: チーム/組織/学科学年) と ユーザー名簿(identity-roster:
// ログイン/メールアドレス/表示名) を 1 アプリに統合する。ランチャーのタイルは 1 つ（運営メンバー・名簿）にまとめ、その中をこの共有
// サブナビで横断する。各セクションは従来のルート/Provider をそのまま維持（additive・非破壊）:
//   運営メンバー   → 同じ人たちを 3 つの表示で切り替える（#901）。タブは 1 つ・表示は右の切り替え:
//                     チーム別 /members ・ 一覧表 /members/roster ・ 組織図 /members/org-chart
//   メール名簿     → /admin/users（Email Routing アドレス／メールアカウントの一覧・発行・同期）
// メール名簿はデータ源(identity-roster)・権限・操作(発行/同期)が別物なので表示切り替えに入れない。
// 参加届の回答(/participation/list) と オンボーディング案内(/participation) は人事アプリのタブ
// (features/hr/HrTabs) に移したのでこのサブナビには載せない。
// データ源は member-service / identity-roster のままで、突合キーは member.identityUserId
// （＝メール一致で紐付く既存の仕組み）。表示の一貫性はこの共有サブナビ + 各セクション見出しで担保する。
//
// ロール管理(/admin/roles) は独立ランチャータイル「ロール管理」に切り出したのでこのサブナビには
// 載せない。変更履歴(/admin/history) の UI アプリは撤去済みなので同様に載せない。
//
// 各タブは対応ルートと同じ requiredPermissions で出し分ける（権限が無ければタブ自体を
// 出さない = ルートガードと二重で fail-closed）。
import { useEffect, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { SegmentedControl, Tabs } from "@dub/ui";
import type { identity } from "@dub/types";
import { usePermissions } from "../../auth/AuthProvider.tsx";
import styles from "./members.module.css";

type PermissionKey = identity.PermissionKey;

interface SectionTab {
  id: string;
  label: string;
  path: string;
  requiredPermissions: PermissionKey[];
}

export type MembersView = "teams" | "table" | "org-chart";

interface ViewOption {
  id: MembersView;
  label: string;
  path: string;
  requiredPermissions: PermissionKey[];
}

// 運営メンバータブ内の表示。requiredPermissions は各ルートの実効権限と一致させる（出せない表示は選択肢に出さない）。
export const MEMBER_VIEWS: ViewOption[] = [
  { id: "teams", label: "チーム別", path: "/members", requiredPermissions: ["app:members:view"] },
  { id: "table", label: "一覧表", path: "/members/roster", requiredPermissions: ["app:members:view", "members:roster_view"] },
  { id: "org-chart", label: "組織図", path: "/members/org-chart", requiredPermissions: ["app:members:view"] },
];

// 順序 = 表示順。active 判定は「pathname が path で始まる最長一致」なので、より深い
// パス（例: /admin/users/:id）は親タブにハイライトが乗る。
// requiredPermissions は対応ルートの実効権限と一致させる（per-app view キー app:members:view が
// AUTHORITATIVE な有効化ゲート、メール名簿は identity:read + members:mail_view を重ねる）。
// 見えるのに開くと 403 というデッドタブを作らない（fail-closed）。
const SECTIONS: SectionTab[] = [
  { id: "members", label: "運営メンバー", path: "/members", requiredPermissions: ["app:members:view"] },
  { id: "roster", label: "メール名簿", path: "/admin/users", requiredPermissions: ["identity:read", "app:members:view", "members:mail_view"] },
];

/** pathname に最も長く前方一致するセクションの id（統合アプリ外なら null）。 */
export function activeSectionId(pathname: string): string | null {
  let best: { id: string; len: number } | null = null;
  for (const s of SECTIONS) {
    if (pathname === s.path || pathname.startsWith(s.path + "/")) {
      if (!best || s.path.length > best.len) best = { id: s.id, len: s.path.length };
    }
  }
  return best?.id ?? null;
}

/** 運営メンバータブ内で今出している表示（タブ外なら null）。 */
export function activeMembersView(pathname: string): MembersView | null {
  if (activeSectionId(pathname) !== "members") return null;
  let best: ViewOption | null = null;
  for (const v of MEMBER_VIEWS) {
    if ((pathname === v.path || pathname.startsWith(v.path + "/")) && (!best || v.path.length > best.path.length)) best = v;
  }
  return best?.id ?? null;
}

// 最後に選んだ表示（タブを押し直した時に戻す）。保存できない環境でも動く。
const VIEW_STORAGE_KEY = "dub.members.view";
export function readLastMembersView(): MembersView | null {
  try {
    const v = globalThis.localStorage?.getItem(VIEW_STORAGE_KEY);
    return MEMBER_VIEWS.some((o) => o.id === v) ? (v as MembersView) : null;
  } catch {
    return null;
  }
}
function writeLastMembersView(v: MembersView): void {
  try {
    globalThis.localStorage?.setItem(VIEW_STORAGE_KEY, v);
  } catch {
    // 保存できなくても切り替え自体は動く
  }
}

/** 統合アプリの共有サブナビ帯（タブ＋運営メンバーの表示切り替え）。
 *
 *  バーはシェルのレイアウト側（router.tsx）で 1 度だけマウントし、タブ下の本体だけ Outlet で
 *  差し替える（タブ切替でバーごとリフレッシュして見えない・下線/ピルがリセットされない）。
 *  表示切り替えは楽観的: 押した瞬間にピルを動かし、ルート遷移が追いつくのを待たない。
 *  統合アプリ外（active=null）では null を返す。 */
export function MemberRosterSubnav(): JSX.Element | null {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const routeView = activeMembersView(pathname);
  const [pendingView, setPendingView] = useState<MembersView | null>(null);
  // ルートが追いついたら（または別タブへ移ったら）楽観値を捨ててルートを正にする。
  useEffect(() => setPendingView(null), [pathname]);

  const active = activeSectionId(pathname);
  if (active == null) return null; // 統合アプリ外ではバーを出さない

  const allowed = (perms: PermissionKey[]) => perms.every((p) => can(p));
  const visible = SECTIONS.filter((s) => allowed(s.requiredPermissions));
  const items = visible.map((s) => ({ id: s.id, label: s.label }));
  const views = MEMBER_VIEWS.filter((v) => allowed(v.requiredPermissions));

  const goView = (id: MembersView): void => {
    const target = views.find((v) => v.id === id);
    if (!target) return;
    setPendingView(id);
    writeLastMembersView(id);
    void navigate({ to: target.path });
  };

  const onChange = (id: string): void => {
    if (id === "members") {
      // タブを押し直したら最後に選んだ表示へ（無い/権限外ならチーム別）。
      const last = readLastMembersView();
      const target = views.find((v) => v.id === last) ?? views[0];
      if (target) void navigate({ to: target.path });
      return;
    }
    const target = SECTIONS.find((s) => s.id === id);
    if (target) void navigate({ to: target.path });
  };

  const shownView = pendingView ?? routeView;

  return (
    <div data-testid="member-roster-app">
      <div className={styles.rosterSubnav}>
        <div className={styles.rosterSubnavTabs}>
          <Tabs items={items} activeId={active} onChange={onChange} testId="member-roster-subnav" />
        </div>
        {active === "members" && views.length > 1 ? (
          <div className={styles.rosterViewSwitch}>
            <SegmentedControl<MembersView>
              aria-label="表示の切り替え"
              size="sm"
              value={shownView}
              onChange={goView}
              testId="members-view-switch"
              options={views.map((v) => ({ value: v.id, label: v.label, testId: `members-view-switch-${v.id}` }))}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
