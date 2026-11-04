// 人事のタブ帯 (応募者 ⇄ 申し込みフォーム ⇄ オンボーディング ⇄ 出席)。LpTabs と同じく URL に紐づける。
import { useNavigate } from "@tanstack/react-router";
import { Tabs } from "@dub/ui";

export type HrTabId = "applicants" | "form" | "onboarding" | "attendance";

const TABS = [
  { id: "applicants", label: "応募者", path: "/hr" },
  { id: "form", label: "申し込みフォーム", path: "/hr/form" },
  { id: "onboarding", label: "オンボーディング", path: "/hr/onboarding" },
  { id: "attendance", label: "出席", path: "/hr/attendance" },
] as const;

export function HrTabs({ active }: { active: HrTabId }): JSX.Element {
  const navigate = useNavigate();
  return (
    <Tabs
      testId="fe2-hr-tabs"
      activeId={active}
      items={TABS.map((t) => ({ id: t.id, label: t.label }))}
      onChange={(id) => {
        const target = TABS.find((t) => t.id === id);
        if (target && id !== active) void navigate({ to: target.path });
      }}
    />
  );
}
