// 運営メンバー・名簿 — 統合アプリの共有サブナビ（横タブ帯）。
//
// 運営メンバー(member-service: チーム/組織/学科学年) と ユーザー名簿(identity-roster:
// ログイン/メールアドレス/表示名) と 参加届(member-service: 届出→名簿反映) を 1 アプリに
// 統合する。ランチャーのタイルは 1 つ（運営メンバー・名簿）にまとめ、その中をこの共有
// サブナビで横断する。各セクションは従来のルート/Provider をそのまま維持（additive・非破壊）:
//   運営メンバー   → /members（内部に チーム別/組織図 タブ）
//   名簿           → /admin/users
//   参加届         → /participation（提出フォーム）
//   参加届の回答   → /participation/list（回答管理）
// データ源は member-service / identity-roster のままで、突合キーは member.identityUserId
// （＝メール一致で紐付く既存の仕組み）。表示の一貫性はこの共有サブナビ + 各セクション見出しで担保する。
//
// ロール管理(/admin/roles) は独立ランチャータイル「ロール管理」に切り出したのでこのサブナビには
// 載せない。変更履歴(/admin/history) の UI アプリは撤去済みなので同様に載せない。
//
// 各タブは対応ルートと同じ requiredPermissions で出し分ける（権限が無ければタブ自体を
// 出さない = ルートガードと二重で fail-closed）。
import type { ReactNode } from "react";
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
// パス（例: /admin/users/:id, /participation/list）は親タブにハイライトが乗る。
// 各タブの requiredPermissions は、対応ルートが registry.flatten で AND される実効権限と
// 一致させる = ドメイン権限（identity:read）＋ per-app view キー（app:members:view /
// app:admin:view / app:participation:view, withAppAccessGate 由来）。これでタブの表示可否が
// ルートガードと厳密に一致し、「見えるのに開くと 403」というデッドタブを作らない（fail-closed）。
// 参加届(提出) は openToAll（ドメイン権限なし）なので app:participation:view のみでガードする。
const SECTIONS: SectionTab[] = [
  { id: "members", label: "運営メンバー", path: "/members", requiredPermissions: ["identity:read", "app:members:view"] },
  { id: "roster", label: "名簿", path: "/admin/users", requiredPermissions: ["identity:read", "app:admin:view"] },
  { id: "participation", label: "参加届", path: "/participation", requiredPermissions: ["app:participation:view"] },
  { id: "participation-list", label: "参加届の回答", path: "/participation/list", requiredPermissions: ["identity:read", "app:participation:view"] },
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

/** 統合アプリの共有サブナビ帯 + セクション本体（children）。 */
export function MemberRosterNav({ children }: { children: ReactNode }): JSX.Element {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const visible = SECTIONS.filter((s) => s.requiredPermissions.every((p) => can(p)));
  const active = activeSectionId(pathname);
  const items = visible.map((s) => ({ id: s.id, label: s.label }));

  const onChange = (id: string): void => {
    const target = SECTIONS.find((s) => s.id === id);
    if (target) void navigate({ to: target.path });
  };

  return (
    <div data-testid="member-roster-app">
      <div className={styles.rosterSubnav}>
        <Tabs items={items} activeId={active ?? ""} onChange={onChange} testId="member-roster-subnav" />
      </div>
      {children}
    </div>
  );
}
