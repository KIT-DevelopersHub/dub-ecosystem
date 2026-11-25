// 人事のタブ帯 (応募者 ⇄ 申し込みフォーム ⇄ 面談 ⇄ 参加届の回答 ⇄ オンボーディング ⇄ オンボーディング案内 ⇄ 出席)。
// LpTabs と同じく URL に紐づける。参加届の回答 / オンボーディング案内 は参加届 (participation) の
// ルートをそのまま使う (URL・Provider・per-app ゲートは参加届のまま)。各タブは対応ルートの実効権限で
// 出し分ける = 「見えるのに開くと 403」のタブを作らない。
import { useNavigate } from "@tanstack/react-router";
import { Tabs } from "@dub/ui";
import type { identity } from "@dub/types";
import { usePermissions } from "../../auth/AuthProvider.tsx";

export type HrTabId = "applicants" | "form" | "interviews" | "participation" | "onboarding" | "guide" | "attendance";

const TABS: { id: HrTabId; label: string; path: string; requiredPermissions: identity.PermissionKey[] }[] = [
  { id: "applicants", label: "応募者", path: "/hr", requiredPermissions: ["app:hr:view"] },
  { id: "form", label: "申し込みフォーム", path: "/hr/form", requiredPermissions: ["app:hr:view"] },
  { id: "interviews", label: "面談", path: "/hr/interviews", requiredPermissions: ["app:hr:view"] },
  { id: "participation", label: "参加届の回答", path: "/participation/list", requiredPermissions: ["identity:read", "app:participation:view"] },
  { id: "onboarding", label: "オンボーディング", path: "/hr/onboarding", requiredPermissions: ["app:hr:view"] },
  { id: "guide", label: "オンボーディング案内", path: "/participation", requiredPermissions: ["app:participation:view"] },
  { id: "attendance", label: "出席", path: "/hr/attendance", requiredPermissions: ["app:hr:view"] },
];

export function HrTabs({ active }: { active: HrTabId }): JSX.Element {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const visible = TABS.filter((t) => t.id === active || t.requiredPermissions.every((p) => can(p)));
  return (
    <Tabs
      testId="fe2-hr-tabs"
      activeId={active}
      items={visible.map((t) => ({ id: t.id, label: t.label }))}
      onChange={(id) => {
        const target = TABS.find((t) => t.id === id);
        if (target && id !== active) void navigate({ to: target.path });
      }}
    />
  );
}
