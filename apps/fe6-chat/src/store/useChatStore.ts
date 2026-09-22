// Zustand store for cross-channel unread (feeds the nav badge via
// useChatUnreadTotal). Per-channel timeline state lives in useChannelView; this
// store holds only what the shell/sidebar needs globally.
import { create } from "zustand";
import type { common } from "@dub/types";
import type { ChatRealtimeEvent, TeamSummary, UnreadSummary } from "../api/contract";
import {
  applyUnreadEvent,
  clearUnread,
  toUnreadMap,
  unreadTotal,
  type UnreadMap,
} from "./unread";

interface ChatStore {
  unread: UnreadMap;
  activeChannelId: common.ChannelId | null;
  /** 運営チーム一覧 (チーム単位メンションの候補・表示名解決). Loaded once by ChatApp. */
  teams: TeamSummary[];
  /** 自分が所属するチーム id — チーム経由の自分宛メンション判定. */
  myTeamIds: string[];
  /** false = まだ読み込み中 (チーム名の代わりに生 id を出さないための区別). */
  teamsLoaded: boolean;
  setUnread: (summaries: UnreadSummary[]) => void;
  setActiveChannel: (channelId: common.ChannelId | null) => void;
  setTeams: (teams: TeamSummary[], myTeamIds: string[]) => void;
  applyEvent: (event: ChatRealtimeEvent, currentUserId: common.UserId) => void;
  markRead: (channelId: common.ChannelId, lastReadMessageId: common.MessageId) => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  unread: {},
  activeChannelId: null,
  teams: [],
  myTeamIds: [],
  teamsLoaded: false,
  setUnread: (summaries) => set({ unread: toUnreadMap(summaries) }),
  setActiveChannel: (channelId) => set({ activeChannelId: channelId }),
  setTeams: (teams, myTeamIds) => set({ teams, myTeamIds, teamsLoaded: true }),
  applyEvent: (event, currentUserId) =>
    set((s) => ({ unread: applyUnreadEvent(s.unread, event, s.activeChannelId, currentUserId, s.myTeamIds) })),
  markRead: (channelId, lastReadMessageId) =>
    set((s) => ({ unread: clearUnread(s.unread, channelId, lastReadMessageId) })),
}));

/** Nav badge source (design §2-3). Selector recomputes on unread changes. */
export function useChatUnreadTotal(): number {
  return useChatStore((s) => unreadTotal(s.unread));
}
