// スポンサーのタブ帯 (名刺 ⇄ 企業)。HrTabs と同じく URL に紐づける。
import { useNavigate } from "@tanstack/react-router";
import { Tabs } from "@dub/ui";

export type SponsorTabId = "cards" | "companies";

export const CARDS_PATH = "/sponsor";
export const COMPANIES_PATH = "/sponsor/companies";

const TABS = [
  { id: "cards", label: "名刺", path: CARDS_PATH },
  { id: "companies", label: "企業", path: COMPANIES_PATH },
] as const;

export function SponsorTabs({ active }: { active: SponsorTabId }): JSX.Element {
  const navigate = useNavigate();
  return (
    <Tabs
      testId="fe2-sponsor-tabs"
      activeId={active}
      items={TABS.map((t) => ({ id: t.id, label: t.label }))}
      onChange={(id) => {
        const target = TABS.find((t) => t.id === id);
        if (target && id !== active) void navigate({ to: target.path });
      }}
    />
  );
}
