// LP管理 のタブ帯（バージョン ⇄ ログ管理）。MailFolderTabs と同じ流儀で、@dub/ui の Tabs を
// シェルのルーター navigate に繋ぐ薄いラッパ。タブは URL（/lp・/lp/visits）に紐づくので
// deep link / リロード / 戻る が成立する（ローカル state のタブにしない）。
import { useNavigate } from "@tanstack/react-router";
import { Tabs } from "@dub/ui";

export type LpTabId = "versions" | "visits";

const TABS = [
  { id: "versions", label: "バージョン", path: "/lp" },
  { id: "visits", label: "ログ管理", path: "/lp/visits" },
] as const;

export function LpTabs({ active }: { active: LpTabId }): JSX.Element {
  const navigate = useNavigate();
  return (
    <Tabs
      testId="fe2-lp-tabs"
      activeId={active}
      items={TABS.map((t) => ({ id: t.id, label: t.label }))}
      onChange={(id) => {
        const target = TABS.find((t) => t.id === id);
        if (target && id !== active) void navigate({ to: target.path });
      }}
    />
  );
}
