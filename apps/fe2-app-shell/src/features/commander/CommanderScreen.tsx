// Commander — the Dub app wrapper around @dub/commander-web's reusable console + phase
// board (SoT: all logic lives in commander/web; this only supplies shell chrome). The
// run console drives the operator's LOCAL Claude Code exec bridge (commander-daemon on
// 127.0.0.1), so it only works on the operator's own machine; the phase board talks to
// commander-service. Admin-only (identity:admin + app:commander:view), member-hidden.
import { Card, Icon, PageHeader, Stack } from "@dub/ui";
import { CommanderConsole, FeatureBoard } from "@dub/commander-web";

export function CommanderScreen(): JSX.Element {
  return (
    <Stack gap={5} testId="fe2-commander">
      <PageHeader
        title="Commander"
        description="ローカルの Claude Code を Web から駆動し、demo→staging→本番 のフェーズ遷移を段飛ばし/自己承認なしでゲートする司令コンソール（管理者用）。"
      />

      <Card testId="fe2-commander-daemon-note">
        <Stack direction="row" gap={3} align="center" wrap>
          <Icon name="info" aria-label="注意" />
          <span style={{ opacity: 0.85, fontSize: 13 }}>
            実行コンソールは<strong>あなたのマシン上のローカル daemon</strong>（127.0.0.1）に接続します。
            daemon を起動していない場合は Run が失敗します（起動手順: commander/README.md）。
          </span>
        </Stack>
      </Card>

      <Card testId="fe2-commander-console">
        <Stack gap={3}>
          <strong style={{ fontWeight: 700 }}>実行コンソール</strong>
          <CommanderConsole />
        </Stack>
      </Card>

      <Card testId="fe2-commander-board">
        <FeatureBoard />
      </Card>
    </Stack>
  );
}
