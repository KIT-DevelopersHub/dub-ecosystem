// LP管理 のタブ帯（公開設定 ⇄ 流入URL ⇄ ログ管理 ⇄ チケット ⇄ 受付 ⇄ 登壇者募集）。受付は lp:checkin がある時だけ出す。MailFolderTabs と同じ流儀で、@dub/ui の
// Tabs をシェルのルーター navigate に繋ぐ薄いラッパ。タブは URL（/lp・/lp/links・/lp/visits）に
// 紐づくので deep link / リロード / 戻る が成立する（ローカル state のタブにしない）。
import { useNavigate } from "@tanstack/react-router";
import { Tabs } from "@dub/ui";
import { useOptionalCan } from "../../auth/AuthProvider.tsx";

export type LpTabId = "config" | "links" | "visits" | "tickets" | "checkin" | "proposals";

const TABS = [
  { id: "config", label: "公開設定", path: "/lp" },
  { id: "links", label: "流入URL", path: "/lp/links" },
  { id: "visits", label: "ログ管理", path: "/lp/visits" },
  { id: "tickets", label: "チケット", path: "/lp/tickets" },
  { id: "checkin", label: "受付", path: "/lp/checkin" },
  { id: "proposals", label: "登壇者募集", path: "/lp/proposals" },
] as const;

export function LpTabs({ active }: { active: LpTabId }): JSX.Element {
  const navigate = useNavigate();
  const canCheckin = useOptionalCan("lp:checkin") === true;
  const tabs = TABS.filter((t) => t.id !== "checkin" || canCheckin || active === "checkin");
  return (
    <Tabs
      testId="fe2-lp-tabs"
      activeId={active}
      items={tabs.map((t) => ({ id: t.id, label: t.label }))}
      onChange={(id) => {
        const target = tabs.find((t) => t.id === id);
        if (target && id !== active) void navigate({ to: target.path });
      }}
    />
  );
}
