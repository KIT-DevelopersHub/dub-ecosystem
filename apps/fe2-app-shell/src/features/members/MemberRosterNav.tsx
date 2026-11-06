// 運営メンバー・名簿 — 統合アプリの共有サブナビ（横タブ帯）。
//
// 運営メンバー(member-service: チーム/組織/学科学年) と ユーザー名簿(identity-roster:
// ログイン/メールアドレス/表示名) を 1 アプリに統合する。ランチャーのタイルは 1 つ（運営メンバー・名簿）にまとめ、その中をこの共有
// サブナビで横断する。各セクションは従来のルート/Provider をそのまま維持（additive・非破壊）:
//   運営メンバー   → /members（チーム別）
//   組織図         → /members/org-chart（チームとリーダーの上下関係）
//   運営名簿       → /members/roster（運営メンバー全員の情報をフラットな一覧で並べる）
//   メール名簿     → /admin/users（Email Routing アドレス／メールアカウントの一覧・発行・同期）
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
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Tabs } from "@dub/ui";
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

// 順序 = 表示順。active 判定は「pathname が path で始まる最長一致」なので、より深い
// パス（例: /admin/users/:id）は親タブにハイライトが乗る。
// 各タブの requiredPermissions は、対応ルートが registry.flatten で AND される実効権限と
// 一致させる = per-app view キー（app:members:view, withAppAccessGate 由来）が AUTHORITATIVE な
// 有効化ゲートで、タブごとの範囲は ロール管理の 組織図まで / メール名簿以外 / 全て（policy.MembersScope）
// が決める。運営メンバー/組織図タブは app:members:view だけ、運営名簿は members:roster_view、
// メール名簿は members:mail_view を重ねる（メール名簿のルートは identity:read も AND する）。これで
// タブの表示可否がルートガードと厳密に一致し、「見えるのに開くと 403」というデッドタブを作らない（fail-closed）。
const SECTIONS: SectionTab[] = [
  { id: "members", label: "運営メンバー", path: "/members", requiredPermissions: ["app:members:view"] },
  { id: "org-chart", label: "組織図", path: "/members/org-chart", requiredPermissions: ["app:members:view"] },
  { id: "member-roster", label: "運営名簿", path: "/members/roster", requiredPermissions: ["app:members:view", "members:roster_view"] },
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

/** 統合アプリの共有サブナビ帯（バーのみ）。
 *
 *  以前は各ルートを個別に包む wrapper（rosterChromeWrapper）としてバー＋本体(children)を一緒に
 *  描画していたため、タブ切替のたびに Tabs ごと unmount/remount され、キャッシュ未取得のタブへ
 *  移ると「バーごとリフレッシュ」して見えた（＋スライド下線もリセット）。これを解消するため、バーは
 *  シェルのレイアウト側（router.tsx）で永続的に1度だけマウントし、タブ下の本体だけ Outlet で差し替える。
 *  このコンポーネントは pathname 由来で active タブを描くだけの純粋なバーで、remount されない。
 *  統合アプリ外（active=null）では null を返す。 */
export function MemberRosterSubnav(): JSX.Element | null {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const active = activeSectionId(pathname);
  if (active == null) return null; // 統合アプリ外ではバーを出さない

  const visible = SECTIONS.filter((s) => s.requiredPermissions.every((p) => can(p)));
  const items = visible.map((s) => ({ id: s.id, label: s.label }));

  const onChange = (id: string): void => {
    const target = SECTIONS.find((s) => s.id === id);
    if (target) void navigate({ to: target.path });
  };

  return (
    <div data-testid="member-roster-app">
      <div className={styles.rosterSubnav}>
        <Tabs items={items} activeId={active} onChange={onChange} testId="member-roster-subnav" />
      </div>
    </div>
  );
}
