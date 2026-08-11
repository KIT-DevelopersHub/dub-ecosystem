// TEST-ONLY fixtures. These demo threads/labels used to seed the shipped store
// (mailModel.ts); they were removed from the bundle so the real /mail route shows
// live gateway data, and now live here for unit tests only. Import ONLY from tests.
//
// Two flavours:
//   - Client model fixtures (DEMO_THREADS / DEMO_LABELS / DEMO_ME) for reducer tests.
//   - Gateway DTO fixtures (DEMO_INBOX_ITEMS / DEMO_SENT_ITEMS / DEMO_INBOX_THREAD)
//     for wiring tests that drive the store through a fake MailApi + useMailSync.
import type { mail } from "@dub/types";
import type { Label, MailPerson, MailThreadModel } from "./mailModel.ts";

export const DEMO_LABELS: Label[] = [
  { id: "work", name: "仕事", color: "var(--dub-color-brand-500)" },
  { id: "conf", name: "カンファレンス", color: "var(--dub-color-success-500)" },
  { id: "important", name: "重要", color: "var(--dub-color-danger-500)" },
];

const ME: MailPerson = { email: "you@developershub.jp", name: "あなた" };
export const DEMO_ME = ME;

function iso(daysAgo: number, h: number, m: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

export const DEMO_THREADS: MailThreadModel[] = [
  {
    id: "t-conf-kickoff",
    subject: "北陸ITカンファレンス 2026 キックオフのお知らせ",
    folder: "inbox",
    starred: true,
    labels: ["conf", "important"],
    messages: [
      {
        id: "m1",
        from: { email: "office@developershub.jp", name: "運営事務局" },
        to: [ME],
        date: iso(0, 9, 12),
        read: false,
        body: "運営メンバーのみなさん\n\n北陸ITカンファレンス 2026 のキックオフミーティングを今週金曜に開催します。",
      },
      {
        id: "m2",
        from: { email: "sato@developershub.jp", name: "佐藤 リード" },
        to: [ME, { email: "office@developershub.jp", name: "運営事務局" }],
        date: iso(0, 10, 3),
        read: false,
        body: "会場班の佐藤です。承知しました。金曜までに会場レイアウト案と必要備品リストを共有します。",
      },
    ],
  },
  {
    id: "t-sponsor",
    subject: "スポンサー協賛のご相談（株式会社ノースクラウド）",
    folder: "inbox",
    starred: false,
    labels: ["work"],
    messages: [
      {
        id: "m1",
        from: { email: "eigyo@northcloud.example.co.jp", name: "ノースクラウド 営業部" },
        to: [ME],
        date: iso(1, 14, 40),
        read: false,
        body: "DevelopersHub ご担当者様\n\n北陸ITカンファレンス 2026 のゴールドスポンサー枠についてご相談させてください。",
      },
    ],
  },
  {
    id: "t-venue",
    subject: "会場下見の日程調整",
    folder: "inbox",
    starred: true,
    labels: [],
    messages: [
      {
        id: "m1",
        from: { email: "sato@developershub.jp", name: "佐藤 リード" },
        to: [ME],
        date: iso(3, 16, 20),
        read: true,
        body: "会場の下見、候補日を3つ挙げます。8/18(火)午後 / 8/20(木)午前 / 8/22(土)午前。",
      },
      {
        id: "m2",
        from: ME,
        to: [{ email: "sato@developershub.jp", name: "佐藤 リード" }],
        date: iso(3, 17, 2),
        read: true,
        body: "8/20(木)午前で参加できます。配信班にも声をかけておきます。",
      },
    ],
  },
  {
    id: "t-sent-reply",
    subject: "Re: ボランティアスタッフ募集フォームの件",
    folder: "sent",
    starred: false,
    labels: [],
    messages: [
      {
        id: "m1",
        from: ME,
        to: [{ email: "volunteer@developershub.jp", name: "ボランティア窓口" }],
        date: iso(1, 18, 30),
        read: true,
        body: "フォームの項目案を確認しました。Tシャツサイズと担当希望の欄を追加してよいと思います。",
      },
    ],
  },
  {
    id: "t-draft",
    subject: "（下書き）スポンサー各社への御礼メール",
    folder: "drafts",
    starred: false,
    labels: [],
    messages: [
      {
        id: "m1",
        from: ME,
        to: [{ email: "eigyo@northcloud.example.co.jp", name: "ノースクラウド 営業部" }],
        date: iso(0, 20, 15),
        read: true,
        body: "この度は北陸ITカンファレンス 2026 へのご協賛を賜り、誠にありがとうございます。",
      },
    ],
  },
  {
    id: "t-trash",
    subject: "【自動送信】システムメンテナンスのお知らせ",
    folder: "trash",
    starred: false,
    labels: [],
    messages: [
      {
        id: "m1",
        from: { email: "no-reply@status.example.com", name: "ステータス通知" },
        to: [ME],
        date: iso(8, 3, 0),
        read: true,
        body: "定期メンテナンスを実施します。作業中は一部サービスがご利用いただけません。",
      },
    ],
  },
];

// ---- gateway DTO fixtures (drive the store through a fake MailApi + useMailSync) ----

export const DEMO_INBOX_ITEMS: mail.MailMessageListItem[] = [
  {
    id: "mailin_1",
    messageId: "<in1@developershub.jp>",
    threadId: "thr_in_1",
    from: { email: "hanako@example.com", name: "山田 花子" },
    to: [{ email: "info@developershub.jp" }],
    subject: "登壇のご相談",
    snippet: "カンファレンスでの登壇について相談させてください。",
    receivedAt: "2026-08-10T01:30:00.000Z",
    read: false,
  },
  {
    id: "mailin_2",
    messageId: "<in2@developershub.jp>",
    threadId: "thr_in_2",
    from: { email: "staff@developershub.jp", name: "運営スタッフ" },
    to: [{ email: "info@developershub.jp" }],
    subject: "会場下見の日程",
    snippet: "来週の下見日程を共有します。",
    receivedAt: "2026-08-09T08:00:00.000Z",
    read: true,
  },
];

export const DEMO_SENT_ITEMS: mail.MailSentListItem[] = [
  {
    id: "sent_1",
    from: { email: "alice@developershub.jp", name: "Alice" },
    to: [{ email: "hanako@example.com" }],
    subject: "こんばんは",
    snippet: "先日はありがとうございました。",
    sentAt: "2026-08-11T12:00:00.000Z",
    provider: "resend",
    status: "sent",
  },
];

export const DEMO_INBOX_THREAD: mail.MailThread = {
  id: "thr_in_1",
  messages: [
    {
      ...DEMO_INBOX_ITEMS[0]!,
      textBody: "お世話になっております。山田です。\n\nカンファレンスでの登壇について相談させてください。",
    },
  ],
};

export const DEMO_SENT_DETAIL: mail.MailSentDetail = {
  ...DEMO_SENT_ITEMS[0]!,
  textBody: "先日はありがとうございました。引き続きよろしくお願いします。",
};
