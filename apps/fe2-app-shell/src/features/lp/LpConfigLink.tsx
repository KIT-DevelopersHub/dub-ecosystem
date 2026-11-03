// 「公開設定で切り替え」ボタン。チケット販売・登壇者募集の on/off は公開設定（本番）にまとめたので、
// 各タブには状態バッジとこの導線だけを置く。
import { useNavigate } from "@tanstack/react-router";
import { Button, Icon } from "@dub/ui";

export function LpConfigLink({ testId }: { testId: string }): JSX.Element {
  const navigate = useNavigate();
  return (
    <Button
      variant="secondary"
      size="sm"
      iconRight={<Icon name="chevron-right" />}
      onClick={() => void navigate({ to: "/lp", search: { env: "live" } })}
      testId={testId}
    >
      公開設定で切り替え
    </Button>
  );
}
