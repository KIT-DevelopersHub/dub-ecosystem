// Commander — the Dub app wrapper around @dub/commander-web's CommanderWorkspace, the same
// body (ボード / Dubに聞く / Dubを操作) the standalone page renders (SoT: all logic lives in
// commander/web; this only supplies shell chrome). It drives the operator's LOCAL
// commander-daemon / commander-service on 127.0.0.1, so it only works on the operator's own
// machine. Admin-only (identity:admin + app:commander:view), member-hidden.
import { PageHeader, Stack } from "@dub/ui";
import { CommanderWorkspace } from "@dub/commander-web";

// 停止時の案内はボード側(daemon-down-hint)が出すので、ここは1行の説明に留める。
const NOTE =
  "あなたのマシン上のローカル Commander（127.0.0.1 の daemon / service）に接続します。起動手順: commander/README.md";

export function CommanderScreen(): JSX.Element {
  return (
    <Stack gap={4} testId="fe2-commander">
      <PageHeader title="Commander" description={NOTE} testId="fe2-commander-daemon-note" />

      <div data-testid="fe2-commander-workspace">
        <CommanderWorkspace />
      </div>
    </Stack>
  );
}
