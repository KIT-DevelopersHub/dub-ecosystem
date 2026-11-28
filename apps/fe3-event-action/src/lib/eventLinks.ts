// Links from an event to the other Dub apps (#879 redesign proposal). Existing routes
// only. `scoped` = the destination already narrows to this event; the others open the
// app as a whole (event scoping there is a follow-up, not invented here).
import type { common } from "@dub/types";
import type { IconName } from "@dub/ui";
import { chatHref, eventRoutes } from "./routes";

export interface EventAppLink {
  id: "gantt" | "tasks" | "chat" | "calendar" | "mail" | "members";
  label: string;
  desc: string;
  icon: IconName;
  href: string;
  scoped: boolean;
}

export function eventAppLinks(eventId: common.EventId): EventAppLink[] {
  return [
    {
      id: "gantt",
      label: "ガント",
      desc: "日程と進み具合",
      icon: "clock",
      href: `${eventRoutes.tasks(eventId)}/gantt`,
      scoped: true,
    },
    {
      id: "tasks",
      label: "タスク",
      desc: "担当と期限",
      icon: "check-square",
      href: eventRoutes.tasks(eventId),
      scoped: true,
    },
    {
      id: "chat",
      label: "チャット",
      desc: "運営のやりとり",
      icon: "message-square",
      href: chatHref(eventId),
      scoped: true,
    },
    {
      id: "calendar",
      label: "カレンダー",
      desc: "運営全体の予定",
      icon: "calendar",
      href: "/calendar",
      scoped: false,
    },
    {
      id: "mail",
      label: "メール",
      desc: "運営メールの送受信",
      icon: "inbox",
      href: "/mail",
      scoped: false,
    },
    {
      id: "members",
      label: "運営メンバー",
      desc: "メンバーとチーム",
      icon: "users",
      href: "/members",
      scoped: false,
    },
  ];
}

/** Whole days from `now` until the event starts (negative once past); null when unknown. */
export function daysUntil(startsAt: string | null, now: Date = new Date()): number | null {
  if (!startsAt) return null;
  const t = new Date(startsAt).getTime();
  if (Number.isNaN(t)) return null;
  const diff = t - now.getTime();
  return diff < 0 ? Math.floor(diff / 86_400_000) : Math.ceil(diff / 86_400_000);
}
