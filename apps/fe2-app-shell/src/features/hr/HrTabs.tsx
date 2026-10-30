// 人事のタブ帯 (応募者 ⇄ オンボーディング)。LpTabs と同じく URL に紐づける。
import { useNavigate } from "@tanstack/react-router";
import { Tabs } from "@dub/ui";

export type HrTabId = "applicants" | "onboarding";

const TABS = [
  { id: "applicants", label: "応募者", path: "/hr" },
  { id: "onboarding", label: "オンボーディング", path: "/hr/onboarding" },
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
