// Commander — the Dub app wrapper around @dub/commander-web's CommanderWorkspace, the same
// body (ボード / Dubに聞く / Dubを操作) the standalone page renders (SoT: all logic lives in
// commander/web; this only supplies shell chrome). It drives the operator's LOCAL
// commander-daemon / commander-service on 127.0.0.1, so it only works on the operator's own
// machine. Admin-only (identity:admin + app:commander:view), member-hidden.
import { Card, Icon, PageHeader, Stack } from "@dub/ui";
import { CommanderWorkspace } from "@dub/commander-web";

export function CommanderScreen(): JSX.Element {
  return (
    <Stack gap={5} testId="fe2-commander">
      <PageHeader title="Commander" />

      <Card testId="fe2-commander-daemon-note">
        <Stack direction="row" gap={3} align="center" wrap>
          <Icon name="info" aria-label="注意" />
          <span style={{ opacity: 0.85, fontSize: 13 }}>
            この画面は<strong>あなたのマシン上のローカル Commander</strong>（127.0.0.1 の daemon /
            service）に接続します。起動していない場合は表示・操作が失敗します（起動手順:
            commander/README.md）。
          </span>
        </Stack>
      </Card>

      <div data-testid="fe2-commander-workspace">
        <CommanderWorkspace />
      </div>
    </Stack>
  );
}
