// Status pill for 運営メンバー. 表示ラベル/トーンは memberStatus.ts(単一の真実)に集約し、
// raw な MemberStatus を「在籍中 / 休み中 / 辞退」に畳んで見せる。ラベル文言を変えるときは
// memberStatus.ts の MEMBER_STATUS_LABEL だけを直せば全画面へ反映される。
import { Badge } from "@dub/ui";
import type { MemberStatus } from "./contracts.ts";
import { statusLabel, statusTone } from "./memberStatus.ts";

export function MemberStatusBadge({ status, testId }: { status: MemberStatus; testId?: string }): JSX.Element {
  return (
    <Badge tone={statusTone(status)} testId={testId}>
      {statusLabel(status)}
    </Badge>
  );
}
