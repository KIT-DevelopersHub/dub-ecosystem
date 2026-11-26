// Per-metric playbook catalog (#902): where the runbook lives, the short mitigation list
// copied into the GitHub Issue, how to find the top consumers, and what paying would cost.
// The runbooks themselves are docs/runbooks/11-usage-free-tier/*.md — keep the two in step.
//
// !! Prices are the 2026 public list prices (USD) and need periodic re-checking, same as
// the ceilings in limits.ts. Paying is ALWAYS a human decision: nothing here upgrades a plan.

export const REPO = "KIT-DevelopersHub/dub-ecosystem";
export const RUNBOOK_DIR = "docs/runbooks/11-usage-free-tier";
const RUNBOOK_BASE = `https://github.com/${REPO}/blob/main/${RUNBOOK_DIR}`;

/** Which top-consumer breakdown applies (see consumers.ts). */
export type ConsumerKind =
  | "d1_rows_read"
  | "d1_rows_written"
  | "d1_storage"
  | "workers"
  | "durable_objects"
  | "kv"
  | "r2_ops"
  | "r2_storage"
  | "email"
  | "google";

export interface PaidPlan {
  /** Plan name as shown on the provider's pricing page. */
  name: string;
  /** One-line price (fixed fee + what it includes + overage). */
  price: string;
  /** What else changes when paying (e.g. the hard stop becomes metered billing). */
  note: string;
}

export interface Playbook {
  /** Runbook file under RUNBOOK_DIR. */
  file: string;
  /** Anchor title inside the runbook (for the link text). */
  title: string;
  consumers: ConsumerKind;
  /** Short mitigations, most effective first (the runbook has the detail). */
  mitigations: string[];
  paid: PaidPlan;
}

// Workers Paid is one $5/month subscription per account and covers Workers, D1, KV, DO and
// Queues together — so "pay" for any of those is the same decision.
const WORKERS_PAID_NOTE =
  "Workers Paid にすると Workers / D1 / KV / Durable Objects / Queues がまとめて従量課金になり、上限で止まらなくなる（=使った分だけ請求）。アカウントに 1 契約。課金後は limits.ts の overflowBehavior を bill に変える";

const PB: Record<string, Playbook> = {
  workers_requests_day: {
    file: "workers-requests.md",
    title: "Workers リクエスト",
    consumers: "workers",
    mitigations: [
      "上位の Worker を特定し、ポーリング間隔を延ばす（fe2 の refetchInterval・SW の定期同期）",
      "静的アセットは Workers Assets / CDN キャッシュで返す（Worker を通さない）",
      "Service Binding の連鎖呼び出しをまとめる（1 リクエストで複数 Worker を叩かない）",
      "bot・監視からのアクセスを WAF / レート制限で落とす",
    ],
    paid: {
      name: "Workers Paid",
      price: "$5/月（1,000 万リクエスト/月込み、超過 $0.30/100 万）",
      note: WORKERS_PAID_NOTE,
    },
  },
  d1_rows_read_day: {
    file: "d1-rows-read.md",
    title: "D1 行読み取り",
    consumers: "d1_rows_read",
    mitigations: [
      "上位クエリを d1QueriesAdaptiveGroups で特定し、WHERE / ORDER BY に合うインデックスを足す（#911 の型）",
      "件数だけ欲しい COUNT(*) を減らす・使い回す（一覧のたびに数えない）",
      "相関サブクエリ・全件 GROUP BY を、範囲を絞った JOIN に書き換える",
      "未読数などの頻繁なポーリングは間隔を延ばすか、変化時だけ取りに行く",
    ],
    paid: {
      name: "Workers Paid",
      price: "$5/月（250 億行読み取り/月込み、超過 $0.001/100 万行）",
      note: WORKERS_PAID_NOTE,
    },
  },
  d1_rows_written_day: {
    file: "d1-rows-written.md",
    title: "D1 行書き込み",
    consumers: "d1_rows_written",
    mitigations: [
      "上位の書き込みクエリを特定する（outbox・ログ・同期の UPSERT が多い）",
      "変わっていない行を UPDATE しない（WHERE で差分だけ）",
      "インデックスの数を見直す（書き込み 1 行 = テーブル + 各インデックス分の行）",
      "ログ・計測系は日次集計にまとめる / 古い行の削除をまとめて行う",
    ],
    paid: {
      name: "Workers Paid",
      price: "$5/月（5,000 万行書き込み/月込み、超過 $1.00/100 万行）",
      note: WORKERS_PAID_NOTE,
    },
  },
  d1_storage: {
    file: "d1-storage.md",
    title: "D1 ストレージ",
    consumers: "d1_storage",
    mitigations: [
      "大きいテーブルを特定し、本文・添付など大きい値は R2 に逃がす",
      "ログ・送信履歴・生 webhook など古い行に保持期限を設けて消す",
      "使っていない staging / demo の D1 を消す",
    ],
    paid: {
      name: "Workers Paid",
      price: "$5/月（5 GB 込み、超過 $0.75/GB-月。1 DB 上限は 10 GB）",
      note: WORKERS_PAID_NOTE,
    },
  },
  kv_reads_day: {
    file: "kv.md",
    title: "KV 読み取り",
    consumers: "kv",
    mitigations: [
      "同じキーをリクエストごとに読まない（isolate 内のメモリキャッシュ・cacheTtl を使う）",
      "設定値は KV ではなく vars / 定数にする",
      "上位の namespace を特定し、読み方を変える",
    ],
    paid: {
      name: "Workers Paid",
      price: "$5/月（1,000 万読み取り/月込み、超過 $0.50/100 万）",
      note: WORKERS_PAID_NOTE,
    },
  },
  kv_writes_day: {
    file: "kv.md",
    title: "KV 書き込み",
    consumers: "kv",
    mitigations: [
      "書き込みの多い namespace を特定する（無料枠は 1,000 回/日と小さい）",
      "頻繁に変わる値は KV ではなく D1 か Durable Object に置く",
      "同じ値の上書きを止める（変わった時だけ put）",
    ],
    paid: {
      name: "Workers Paid",
      price: "$5/月（100 万書き込み/月込み、超過 $5.00/100 万）",
      note: WORKERS_PAID_NOTE,
    },
  },
  r2_storage: {
    file: "r2.md",
    title: "R2 ストレージ",
    consumers: "r2_storage",
    mitigations: [
      "大きい bucket を特定し、不要なオブジェクトを消す（生 webhook・古い添付）",
      "ライフサイクルルールで一定日数後に自動削除する",
      "画像は縮小・圧縮してから保存する",
    ],
    paid: {
      name: "R2 従量課金（プラン契約なし）",
      price: "無料枠 10 GB を超えた分だけ $0.015/GB-月",
      note: "R2 は支払い方法を登録すると無料枠を超えた分だけ請求される（月額固定なし）。上限で止まらなくなる",
    },
  },
  r2_class_a_month: {
    file: "r2.md",
    title: "R2 Class A 操作",
    consumers: "r2_ops",
    mitigations: [
      "書き込み・一覧（PUT / LIST）の多い bucket と操作を特定する",
      "list をキャッシュする・ページングを減らす",
      "小さいファイルを大量に PUT せずまとめる",
    ],
    paid: {
      name: "R2 従量課金（プラン契約なし）",
      price: "無料枠 100 万/月を超えた分だけ $4.50/100 万",
      note: "R2 は支払い方法を登録すると無料枠を超えた分だけ請求される（月額固定なし）",
    },
  },
  r2_class_b_month: {
    file: "r2.md",
    title: "R2 Class B 操作",
    consumers: "r2_ops",
    mitigations: [
      "読み取り（GET / HEAD）の多い bucket を特定する",
      "公開してよいものは Cache API / カスタムドメインのキャッシュで返す",
      "同じオブジェクトを何度も HEAD しない",
    ],
    paid: {
      name: "R2 従量課金（プラン契約なし）",
      price: "無料枠 1,000 万/月を超えた分だけ $0.36/100 万",
      note: "R2 は支払い方法を登録すると無料枠を超えた分だけ請求される（月額固定なし）",
    },
  },
  do_requests_day: {
    file: "queues-do.md",
    title: "Durable Objects",
    consumers: "durable_objects",
    mitigations: [
      "上位の Worker / namespace を特定する（alarm の間隔・WebSocket のメッセージ数）",
      "alarm の再設定間隔を延ばす・不要な alarm を止める",
      "WebSocket は Hibernation API を使い、ping を DO に届けない",
      "freeq（D1 outbox）の drain 間隔を見直す",
    ],
    paid: {
      name: "Workers Paid",
      price: "$5/月（100 万リクエスト/月込み、超過 $0.15/100 万。実行時間 40 万 GB-s 込み）",
      note: WORKERS_PAID_NOTE,
    },
  },
  gcp_calendar_requests_peak_minute: {
    file: "google-apis.md",
    title: "Google Calendar API",
    consumers: "google",
    mitigations: [
      "同じ分に集中する呼び出し（一斉同期・再試行の嵐）をずらす",
      "差分同期（syncToken）を使い、全件取得を減らす",
      "429 のときは指数バックオフで待つ",
    ],
    paid: {
      name: "課金プランなし（クォータ引き上げ申請）",
      price: "$0（GCP コンソールから引き上げを申請）",
      note: "Google Calendar API は使用料がかからない。上限を上げたい時は GCP のクォータ申請",
    },
  },
  gcp_meet_requests_peak_minute: {
    file: "google-apis.md",
    title: "Google Meet API",
    consumers: "google",
    mitigations: [
      "同じ分に集中する呼び出しをずらす",
      "参加者・録画の取得をポーリングではなく必要な時だけにする",
      "429 のときは指数バックオフで待つ",
    ],
    paid: {
      name: "課金プランなし（クォータ引き上げ申請）",
      price: "$0（GCP コンソールから引き上げを申請）",
      note: "Google Meet REST API は使用料がかからない。上限を上げたい時は GCP のクォータ申請",
    },
  },
  resend_emails_day: {
    file: "email-sending.md",
    title: "メール送信（日）",
    consumers: "email",
    mitigations: [
      "送信の多い種類を mail_send_log で特定する（通知・ダイジェスト・canary）",
      "通知メールをまとめる（ダイジェスト化）・アプリ内通知に寄せる",
      "canary の送信間隔を延ばす（MAIL_CANARY_INTERVAL_MIN）",
      "再送ループ（同じ宛先への連続送信）を止める",
    ],
    paid: {
      name: "Resend Pro",
      price: "$20/月（5 万通/月、日次上限なし）",
      note: "Resend は月額固定のプラン。Pro にすると 1 日 100 通の上限がなくなる",
    },
  },
  resend_emails_month: {
    file: "email-sending.md",
    title: "メール送信（月）",
    consumers: "email",
    mitigations: [
      "送信の多い種類を mail_send_log で特定する",
      "通知メールをダイジェスト化・アプリ内通知に寄せる",
      "テスト・canary の送信を減らす",
    ],
    paid: {
      name: "Resend Pro",
      price: "$20/月（5 万通/月）",
      note: "Resend は月額固定のプラン",
    },
  },
};

const FALLBACK: Playbook = {
  file: "README.md",
  title: "無料枠の手順書",
  consumers: "workers",
  mitigations: ["手順書の「調べ方」から使っている所を特定する"],
  paid: { name: "（手順書を参照）", price: "手順書を参照", note: "" },
};

export function playbookFor(metricKey: string): Playbook {
  return PB[metricKey] ?? FALLBACK;
}

export function playbookUrl(metricKey: string): string {
  return `${RUNBOOK_BASE}/${playbookFor(metricKey).file}`;
}

/** Every metric that has its own playbook entry (tests check MASTER is covered). */
export const PLAYBOOK_KEYS: readonly string[] = Object.keys(PB);
