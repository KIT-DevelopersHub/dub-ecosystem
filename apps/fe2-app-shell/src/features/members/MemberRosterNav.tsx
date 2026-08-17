// 運営メンバー・名簿 — 統合アプリの共有サブナビ（横タブ帯）。
//
// 運営メンバー(member-service: チーム/組織/学科学年) と ユーザー名簿(identity-roster:
// ログイン/ロール/メールアドレス/表示名) は「使い分けが難しい」ため 1 アプリに統合した。
// ランチャーのタイルは 1 つ（運営メンバー・名簿）にまとめ、その中をこの共有サブナビで
// 横断する。各セクションは従来のルート/Provider をそのまま維持（additive・非破壊）:
//   運営メンバー → /members（内部に チーム別/組織図 タブ）
//   名簿         → /admin/users
//   ロール       → /admin/roles
//   アドレス発行 → /admin/email-routing
//   変更履歴     → /admin/history
// データ源は 2 つ（member-service / identity-roster）のままで、突合キーは
// member.identityUserId（＝メール一致で紐付く既存の仕組み）。表示の一貫性はこの共有
// サブナビ + 各セクション見出しで担保する。
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
// パス（例: /admin/users/:id）は親タブ（名簿）にハイライトが乗る。
// NOTE: アドレス発行(/admin/email-routing) は現状 FE7 の routes/nav から登録解除されている
// （main で撤去済み）。ルートが復活した時点でここに 1 行足せば統合ナビにも自動で出る。
const SECTIONS: SectionTab[] = [
  { id: "members", label: "運営メンバー", path: "/members", requiredPermissions: ["identity:read"] },
  { id: "roster", label: "名簿", path: "/admin/users", requiredPermissions: ["identity:read"] },
  { id: "roles", label: "ロール", path: "/admin/roles", requiredPermissions: ["identity:read"] },
  { id: "history", label: "変更履歴", path: "/admin/history", requiredPermissions: ["audit:read"] },
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
