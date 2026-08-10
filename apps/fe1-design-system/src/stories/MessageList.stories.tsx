import type { Meta, StoryObj } from "@storybook/react";
import { MessageList, Button } from "../index";
import type { ChatMessage } from "../index";

const messages: ChatMessage[] = [
  { id: "m1", authorName: "Ada Lovelace", body: "おはようございます！", timeLabel: "09:00", dayKey: "2026-01-05", dayLabel: "1月5日" },
  {
    id: "m2",
    authorName: "Alan Turing",
    body: "リリースの件、レビューお願いします 🙏",
    timeLabel: "09:02",
    dayKey: "2026-01-05",
    dayLabel: "1月5日",
    reactions: [
      { emoji: "👍", count: 3, mine: true },
      { emoji: "🎉", count: 1 },
    ],
  },
  { id: "m3", authorName: "Ada Lovelace", body: "了解です！", timeLabel: "09:03", dayKey: "2026-01-05", dayLabel: "1月5日", edited: true },
  { id: "m4", authorName: "Grace Hopper", body: "（削除済み）", timeLabel: "10:10", dayKey: "2026-01-06", dayLabel: "1月6日", deleted: true },
  { id: "m5", authorName: "You", body: "送信中のメッセージ…", timeLabel: "10:12", state: "pending" },
  { id: "m6", authorName: "You", body: "失敗したメッセージ", timeLabel: "10:13", state: "failed" },
];

const meta = {
  title: "Chat/MessageList",
  component: MessageList,
  tags: ["autodocs"],
  args: { messages, unreadBeforeId: "m4", hasOlder: true },
} satisfies Meta<typeof MessageList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithActions: Story = {
  args: {
    renderActions: () => (
      <>
        <Button variant="ghost" size="sm">
          編集
        </Button>
        <Button variant="ghost" size="sm">
          削除
        </Button>
      </>
    ),
    renderFailedActions: () => (
      <>
        <Button variant="secondary" size="sm">
          再送
        </Button>
        <Button variant="ghost" size="sm">
          破棄
        </Button>
      </>
    ),
  },
};
