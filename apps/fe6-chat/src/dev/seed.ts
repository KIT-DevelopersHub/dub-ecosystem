// Demo seed for standalone dev + tests. Two sample users and a few channels with
// messages so the mock server behaves like a populated workspace.
import type { identity } from "@dub/types";
import type { Channel, ChannelMember, Message } from "../api/contract";
import type { MockSeed } from "../api/mock-client";

const t = (n: number): string => new Date(Date.UTC(2026, 7, 9, 1, n, 0)).toISOString();

export const ME = "usr_me0000000000000000000000";
export const OTHER = "usr_other000000000000000000";

const users: identity.UserSummary[] = [
  { id: ME, displayName: "高岡 己太朗", avatarUrl: null },
  { id: OTHER, displayName: "運営メンバー", avatarUrl: null },
];

const channels: Channel[] = [
  { id: "chn_general00000000000000000", orgId: "org_devhub", type: "topic", name: "general", topic: "全体連絡", eventId: null, archived: false, memberCount: 2, version: 1, createdAt: t(0), updatedAt: t(0) },
  { id: "chn_conf0000000000000000000", orgId: "org_devhub", type: "event", name: "北陸ITカンファレンス", topic: "運営チャネル", eventId: "evt_conf000000000000000000", archived: false, memberCount: 2, version: 1, createdAt: t(0), updatedAt: t(0) },
  { id: "chn_archived0000000000000000", orgId: "org_devhub", type: "topic", name: "old-topic", topic: null, eventId: null, archived: true, memberCount: 1, version: 2, createdAt: t(0), updatedAt: t(0) },
];

const messages: Message[] = [
  { id: "msg_0001000000000000000000000", channelId: "chn_general00000000000000000", authorId: OTHER, body: "おはようございます", threadRootId: null, replyCount: 0, reactions: [], attachments: [], editedAt: null, deletedAt: null, version: 1, createdAt: t(1) },
  { id: "msg_0002000000000000000000000", channelId: "chn_general00000000000000000", authorId: ME, body: "よろしくお願いします `deploy` 完了しました", threadRootId: null, replyCount: 0, reactions: [{ emoji: "👍", userIds: [OTHER] }], attachments: [], editedAt: null, deletedAt: null, version: 1, createdAt: t(2) },
  { id: "msg_0003000000000000000000000", channelId: "chn_general00000000000000000", authorId: OTHER, body: `<@${ME}> 確認お願いします`, threadRootId: null, replyCount: 0, reactions: [], attachments: [], editedAt: null, deletedAt: null, version: 1, createdAt: t(3) },
];

const members: ChannelMember[] = [
  { channelId: "chn_general00000000000000000", userId: ME, role: "admin", joinedAt: t(0) },
  { channelId: "chn_conf0000000000000000000", userId: ME, role: "member", joinedAt: t(0) },
];

export function demoSeed(): MockSeed {
  return { currentUserId: ME, channels, messages, members, users };
}
