// Pure channel grouping for the sidebar (design §2-2: event/topic/dm groups).
// Archived channels sink to the bottom; each group sorts by name.
import type { Channel, ChannelType, ChatSection } from "../api/contract";

export interface ChannelGroup {
  type: ChannelType;
  label: string;
  channels: Channel[];
}

const ORDER: ChannelType[] = ["topic", "event", "dm"];
const LABELS: Record<ChannelType, string> = { topic: "チャンネル", event: "イベント", dm: "ダイレクト" };

function sortChannels(list: Channel[]): Channel[] {
  return list.sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    return a.name.localeCompare(b.name, "ja");
  });
}

export function groupChannels(channels: Channel[]): ChannelGroup[] {
  const byType = new Map<ChannelType, Channel[]>();
  for (const t of ORDER) byType.set(t, []);
  // Guard against a non-array slipping through (e.g. a Paginated envelope) so the
  // sidebar never throws "not iterable" and takes the whole app down (chat error-fix).
  for (const c of Array.isArray(channels) ? channels : []) {
    const bucket = byType.get(c.type);
    if (bucket) bucket.push(c);
  }
  const groups: ChannelGroup[] = [];
  for (const t of ORDER) {
    const list = byType.get(t)!;
    if (list.length === 0) continue;
    sortChannels(list);
    groups.push({ type: t, label: LABELS[t], channels: list });
  }
  return groups;
}

export interface SectionGroup {
  section: ChatSection;
  channels: Channel[];
}

export interface SidebarLayout {
  sections: SectionGroup[]; // user sections first, by position (empty ones kept)
  groups: ChannelGroup[]; // default groups for unassigned channels
}

/**
 * Sidebar = the user's own sections (any channel type) then the default type groups
 * for everything unassigned. An assignment to an unknown section falls back to the
 * default group so a stale map never hides a channel.
 */
export function buildSidebar(
  channels: Channel[],
  sections: ChatSection[],
  assignments: Record<string, string>,
): SidebarLayout {
  const list = Array.isArray(channels) ? channels : [];
  const ordered = [...sections].sort((a, b) => a.position - b.position);
  const bySection = new Map<string, Channel[]>(ordered.map((s) => [s.id, []]));
  const rest: Channel[] = [];
  for (const c of list) {
    const bucket = bySection.get(assignments[c.id] ?? "");
    if (bucket) bucket.push(c);
    else rest.push(c);
  }
  return {
    sections: ordered.map((section) => ({ section, channels: sortChannels(bySection.get(section.id)!) })),
    groups: groupChannels(rest),
  };
}
