// LP管理 のタブ帯（バージョン ⇄ 本番公開 ⇄ プレビュー ⇄ 流入URL ⇄ ログ管理 ⇄ チケット ⇄ 登壇者募集）。MailFolderTabs と同じ流儀で、@dub/ui の
// Tabs をシェルのルーター navigate に繋ぐ薄いラッパ。タブは URL（/lp・/lp/links・/lp/visits）に
// 紐づくので deep link / リロード / 戻る が成立する（ローカル state のタブにしない）。
import { useNavigate } from "@tanstack/react-router";
import { Button, Icon, Tabs } from "@dub/ui";

export type LpTabId = "versions" | "publish" | "preview" | "links" | "visits" | "tickets" | "proposals";

/** 本番公開タブのパス（他タブの「本番公開タブで切り替え」リンクの行き先）。 */
export const LP_PUBLISH_PATH = "/lp/publish";

const TABS = [
  { id: "versions", label: "バージョン", path: "/lp" },
  { id: "publish", label: "本番公開", path: LP_PUBLISH_PATH },
  { id: "preview", label: "プレビュー", path: "/lp/preview" },
  { id: "links", label: "流入URL", path: "/lp/links" },
  { id: "visits", label: "ログ管理", path: "/lp/visits" },
  { id: "tickets", label: "チケット", path: "/lp/tickets" },
  { id: "proposals", label: "登壇者募集", path: "/lp/proposals" },
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

/**
 * 本番を変えるスイッチは「本番公開」タブに集約したので、他タブには状態バッジとこの導線だけを残す。
 */
export function GotoPublishButton({ testId }: { testId: string }): JSX.Element {
  const navigate = useNavigate();
  return (
    <Button
      variant="secondary"
      size="sm"
      iconRight={<Icon name="chevron-right" />}
      onClick={() => void navigate({ to: LP_PUBLISH_PATH })}
      testId={testId}
    >
      本番公開タブで切り替え
    </Button>
  );
}
