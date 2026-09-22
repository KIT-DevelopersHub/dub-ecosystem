// Status pill for 運営メンバー. 表示ラベル/トーンは memberStatus.ts(単一の真実)に集約し、
// raw な MemberStatus を「打診中 / 休み中 / 辞退」に畳んで見せる。通常メンバー(added)は
// バッジを出さない(「在籍中」バッジは廃止)。ラベル文言を変えるときは memberStatus.ts の
// MEMBER_STATUS_LABEL だけを直せば全画面へ反映される。
import { Badge } from "@dub/ui";
import type { MemberStatus } from "./contracts.ts";
import { hasStatusBadge, statusLabel, statusTone } from "./memberStatus.ts";

export function MemberStatusBadge({ status, testId }: { status: MemberStatus; testId?: string }): JSX.Element | null {
  // 通常メンバー(added)はバッジ無し。打診中/休み中/辞退のみバッジで区別する。
  if (!hasStatusBadge(status)) return null;
  return (
    <Badge tone={statusTone(status)} testId={testId}>
      {statusLabel(status)}
    </Badge>
  );
}
