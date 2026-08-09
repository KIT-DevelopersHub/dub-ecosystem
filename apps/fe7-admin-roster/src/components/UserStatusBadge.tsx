import type { identity } from "@dub/types";
import { Badge, type BadgeTone } from "../ui/primitives";

const TONE: Record<identity.UserStatus, BadgeTone> = {
  active: "success",
  invited: "warning",
  disabled: "neutral",
  rejected: "danger",
};
const LABEL: Record<identity.UserStatus, string> = {
  active: "在籍",
  invited: "招待中",
  disabled: "停止",
  rejected: "却下",
};

export function UserStatusBadge({ status, testId }: { status: identity.UserStatus; testId?: string }) {
  return <Badge tone={TONE[status]} testId={testId}>{LABEL[status]}</Badge>;
}
