// Zustand store for cross-channel unread (feeds the nav badge via
// useChatUnreadTotal). Per-channel timeline state lives in useChannelView; this
// store holds only what the shell/sidebar needs globally.
import { create } from "zustand";
import type { common } from "@dub/types";
import type { ChatRealtimeEvent, UnreadSummary } from "../api/contract";
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
  setUnread: (summaries: UnreadSummary[]) => void;
  setActiveChannel: (channelId: common.ChannelId | null) => void;
  applyEvent: (event: ChatRealtimeEvent, currentUserId: common.UserId) => void;
  markRead: (channelId: common.ChannelId, lastReadMessageId: common.MessageId) => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  unread: {},
  activeChannelId: null,
  setUnread: (summaries) => set({ unread: toUnreadMap(summaries) }),
  setActiveChannel: (channelId) => set({ activeChannelId: channelId }),
  applyEvent: (event, currentUserId) =>
    set((s) => ({ unread: applyUnreadEvent(s.unread, event, s.activeChannelId, currentUserId) })),
  markRead: (channelId, lastReadMessageId) =>
    set((s) => ({ unread: clearUnread(s.unread, channelId, lastReadMessageId) })),
}));

/** Nav badge source (design §2-3). Selector recomputes on unread changes. */
export function useChatUnreadTotal(): number {
  return useChatStore((s) => unreadTotal(s.unread));
}
