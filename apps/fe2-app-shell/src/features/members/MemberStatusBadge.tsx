// Status pill for 運営メンバー. Maps each invite/participation status to a JP label +
// a colored @dub/ui Badge tone (token-driven, dark-mode-safe). Mirrors fe7's
// UserStatusBadge pattern.
import { Badge, type BadgeTone } from "@dub/ui";
import type { MemberStatus } from "./contracts.ts";

const TONE: Record<MemberStatus, BadgeTone> = {
  added: "success",
  invited: "warning",
  considering: "info",
  declined: "danger",
  deleted: "neutral",
};

export const STATUS_LABEL: Record<MemberStatus, string> = {
  added: "追加済",
  invited: "招待中",
  considering: "検討中",
  declined: "辞退",
  deleted: "削除済み",
};

export function MemberStatusBadge({ status, testId }: { status: MemberStatus; testId?: string }): JSX.Element {
  return (
    <Badge tone={TONE[status]} testId={testId}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}
