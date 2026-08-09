// Pure channel grouping for the sidebar (design §2-2: event/topic/dm groups).
// Archived channels sink to the bottom; each group sorts by name.
import type { Channel, ChannelType } from "../api/contract";

export interface ChannelGroup {
  type: ChannelType;
  label: string;
  channels: Channel[];
}

const ORDER: ChannelType[] = ["topic", "event", "dm"];
const LABELS: Record<ChannelType, string> = { topic: "チャンネル", event: "イベント", dm: "ダイレクト" };

export function groupChannels(channels: Channel[]): ChannelGroup[] {
  const byType = new Map<ChannelType, Channel[]>();
  for (const t of ORDER) byType.set(t, []);
  for (const c of channels) {
    const bucket = byType.get(c.type);
    if (bucket) bucket.push(c);
  }
  const groups: ChannelGroup[] = [];
  for (const t of ORDER) {
    const list = byType.get(t)!;
    if (list.length === 0) continue;
    list.sort((a, b) => {
      if (a.archived !== b.archived) return a.archived ? 1 : -1;
      return a.name.localeCompare(b.name, "ja");
    });
    groups.push({ type: t, label: LABELS[t], channels: list });
  }
  return groups;
}
