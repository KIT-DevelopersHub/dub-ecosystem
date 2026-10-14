// LP管理 のタブ帯（バージョン ⇄ プレビュー ⇄ 流入URL ⇄ ログ管理 ⇄ チケット）。MailFolderTabs と同じ流儀で、@dub/ui の
// Tabs をシェルのルーター navigate に繋ぐ薄いラッパ。タブは URL（/lp・/lp/links・/lp/visits）に
// 紐づくので deep link / リロード / 戻る が成立する（ローカル state のタブにしない）。
import { useNavigate } from "@tanstack/react-router";
import { Tabs } from "@dub/ui";

export type LpTabId = "versions" | "preview" | "links" | "visits" | "tickets";

const TABS = [
  { id: "versions", label: "バージョン", path: "/lp" },
  { id: "preview", label: "プレビュー", path: "/lp/preview" },
  { id: "links", label: "流入URL", path: "/lp/links" },
  { id: "visits", label: "ログ管理", path: "/lp/visits" },
  { id: "tickets", label: "チケット", path: "/lp/tickets" },
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
