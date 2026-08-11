// Client-side mail model for the Gmail-style UI (demo). This is a UI-only,
// in-memory model: folders, stars, labels, read-state and multi-message
// conversations that power the 3-pane experience without any backend. The real
// gateway (MailApi) persists a subset (received messages, thread bodies, read,
// send); star / archive / trash / label / reply persistence lands in a later
// slice and can hydrate this model. Nothing here is a Google asset — it is our
// own generic data shape, seeded with DevHub-flavoured sample threads.

export type FolderId = "inbox" | "starred" | "sent" | "drafts" | "trash" | "archive";

/** Folders that appear in the left nav (archive is Gmail's "All Mail"-ish sink). */
export const NAV_FOLDERS: { id: FolderId; label: string; icon: string }[] = [
  { id: "inbox", label: "受信トレイ", icon: "inbox" },
  { id: "starred", label: "スター付き", icon: "star" },
  { id: "sent", label: "送信済み", icon: "send" },
  { id: "drafts", label: "下書き", icon: "draft" },
  { id: "trash", label: "ゴミ箱", icon: "trash" },
];

export interface Label {
  id: string;
  name: string;
  color: string; // token var or hex accent for the label chip/dot
}

export const DEMO_LABELS: Label[] = [
  { id: "work", name: "仕事", color: "var(--dub-color-brand-500)" },
  { id: "conf", name: "カンファレンス", color: "var(--dub-color-success-500)" },
  { id: "important", name: "重要", color: "var(--dub-color-danger-500)" },
];

export interface MailPerson {
  email: string;
  name?: string;
}

export interface MailMsg {
  id: string;
  from: MailPerson;
  to: MailPerson[];
  cc?: MailPerson[];
  date: string; // ISO
  body: string; // plain text (pre-wrap)
  read: boolean;
}

export interface MailThreadModel {
  id: string;
  subject: string;
  messages: MailMsg[];
  folder: FolderId;
  starred: boolean;
  labels: string[]; // Label ids
  apiThreadId?: string; // gateway thread id (inbox) — used to fetch full bodies on open
  hydrated?: boolean; // true once the full body has been loaded from the gateway
}

// ---- pure helpers ----

export function displayName(p: MailPerson): string {
  return p.name && p.name.trim().length > 0 ? p.name : p.email;
}

/** First grapheme-ish char, upper-cased, for the round avatar. */
export function initial(p: MailPerson): string {
  const src = (p.name && p.name.trim()) || p.email;
  return src.slice(0, 1).toUpperCase();
}

/** A thread is unread when any of its messages is unread. */
export function threadUnread(t: MailThreadModel): boolean {
  return t.messages.some((m) => !m.read);
}

/** Newest message drives the row's timestamp + preview. */
export function latest(t: MailThreadModel): MailMsg {
  return t.messages[t.messages.length - 1]!;
}

/** Gmail-style compact timestamp: today -> time, this year -> M/D, else Y/M/D. */
export function relativeDate(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** Full timestamp for the reading pane. */
export function fullDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ja-JP");
}

/** One-line preview snippet from a body. */
export function snippet(body: string, max = 100): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Deterministic pastel-ish avatar hue from an email, so each sender is stable. */
export function avatarColor(p: MailPerson): string {
  const src = p.email;
  let h = 0;
  for (let i = 0; i < src.length; i++) h = (h * 31 + src.charCodeAt(i)) % 360;
  return `hsl(${h} 55% 45%)`;
}

/** Does a thread belong to the given folder view? */
export function inFolder(t: MailThreadModel, folder: FolderId): boolean {
  if (folder === "starred") return t.starred && t.folder !== "trash";
  return t.folder === folder;
}

/** Free-text search across subject / participants / bodies (excludes trash). */
export function matchesQuery(t: MailThreadModel, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (needle.length === 0) return true;
  if (t.subject.toLowerCase().includes(needle)) return true;
  return t.messages.some(
    (m) =>
      m.body.toLowerCase().includes(needle) ||
      displayName(m.from).toLowerCase().includes(needle) ||
      m.from.email.toLowerCase().includes(needle),
  );
}

// ---- demo seed (DevHub / 北陸ITカンファレンス flavour) ----

const ME: MailPerson = { email: "you@developershub.jp", name: "あなた" };

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
        body: "運営メンバーのみなさん\n\n北陸ITカンファレンス 2026 のキックオフミーティングを今週金曜に開催します。会場・配信・スポンサー各班のリードは事前に担当タスクの棚卸しをお願いします。\n\nアジェンダと当日の役割分担は追ってこのスレッドに共有します。\n\n運営事務局",
      },
      {
        id: "m2",
        from: { email: "sato@developershub.jp", name: "佐藤 リード" },
        to: [ME, { email: "office@developershub.jp", name: "運営事務局" }],
        date: iso(0, 10, 3),
        read: false,
        body: "会場班の佐藤です。承知しました。金曜までに会場レイアウト案と必要備品リストを共有します。配信班と回線要件をすり合わせたいので、担当の方いれば教えてください。",
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
        body: "DevelopersHub ご担当者様\n\nいつもお世話になっております。北陸ITカンファレンス 2026 のゴールドスポンサー枠について、協賛内容とロゴ掲出のレギュレーションをご相談させてください。来週前半でオンライン打ち合わせは可能でしょうか。\n\n株式会社ノースクラウド 営業部",
      },
    ],
  },
  {
    id: "t-cfp",
    subject: "【登壇者募集】セッション CFP のレビュー依頼",
    folder: "inbox",
    starred: false,
    labels: ["conf"],
    messages: [
      {
        id: "m1",
        from: { email: "program@developershub.jp", name: "プログラム委員会" },
        to: [ME],
        date: iso(2, 11, 5),
        read: true,
        body: "CFP に 42 件の応募が集まりました。一次レビューの担当割り当てを共有します。各自 7〜8 件、今週末までに評価コメントをスプレッドシートへ記入してください。採否は来週の委員会で最終決定します。",
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
        body: "会場の下見、候補日を3つ挙げます。8/18(火)午後 / 8/20(木)午前 / 8/22(土)午前。参加できる日に○を付けて返信ください。当日は動線と電源位置を重点的に確認します。",
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
    id: "t-newsletter",
    subject: "週刊デブハブ — 今週の運営ダイジェスト",
    folder: "inbox",
    starred: false,
    labels: [],
    messages: [
      {
        id: "m1",
        from: { email: "news@developershub.jp", name: "週刊デブハブ" },
        to: [ME],
        date: iso(4, 8, 0),
        read: true,
        body: "今週のハイライト: 参加登録が 300 名を突破しました / スポンサー枠の残りわずか / ボランティアスタッフ説明会は 8/25 開催。詳細は各チャンネルをご確認ください。",
      },
    ],
  },
  {
    id: "t-invoice",
    subject: "請求書送付のご案内（印刷物）",
    folder: "inbox",
    starred: false,
    labels: ["work"],
    messages: [
      {
        id: "m1",
        from: { email: "billing@print-hokuriku.example.jp", name: "北陸プリント 経理" },
        to: [ME],
        date: iso(6, 13, 45),
        read: true,
        body: "パンフレット・ポスター印刷分の請求書をお送りします。お支払い期限は月末です。ご不明点があればお問い合わせください。",
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
        body: "フォームの項目案を確認しました。Tシャツサイズと担当希望の欄を追加してよいと思います。締切は 8/25 で問題ありません。よろしくお願いします。",
      },
    ],
  },
  {
    id: "t-sent-thanks",
    subject: "登壇のお礼と当日の流れ",
    folder: "sent",
    starred: false,
    labels: ["conf"],
    messages: [
      {
        id: "m1",
        from: ME,
        to: [{ email: "speaker@example.com", name: "登壇者A" }],
        date: iso(5, 12, 10),
        read: true,
        body: "この度はご登壇をお引き受けいただきありがとうございます。当日のタイムテーブルと控室のご案内を添付します。リハーサルは開演1時間前を予定しています。",
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
        body: "この度は北陸ITカンファレンス 2026 へのご協賛を賜り、誠にありがとうございます。当日のロゴ掲出位置と",
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
        body: "定期メンテナンスを実施します。作業中は一部サービスがご利用いただけません。ご了承ください。",
      },
    ],
  },
];

export const DEMO_ME = ME;
