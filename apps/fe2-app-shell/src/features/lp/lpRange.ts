// LP流入ログ の純粋関数（期間計算・整形）。UI から切り離して単体テストする。
//
// 期間は「日（YYYY-MM-DD）の閉区間」で扱う。タイムスタンプにしないのは、レンダー毎に
// from/to が動いて react-query のキーが変わり無限に再フェッチするのを防ぐため（無料枠保護）。

export const LP_RANGE_DAYS = [7, 30, 90] as const;
export type LpRangeDays = (typeof LP_RANGE_DAYS)[number];

/** 既定の期間。直近1か月が「広報の手応え」を見る最小単位。 */
export const LP_DEFAULT_RANGE_DAYS: LpRangeDays = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** ローカル日付を YYYY-MM-DD に。UTC 変換はしない（運営は JST で日をまたぐ感覚で見る）。 */
export function toDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 直近 `days` 日間の閉区間（to = 今日 / from = 今日を含めて days 日前）。 */
export function rangeForDays(days: LpRangeDays, now: Date = new Date()): { from: string; to: string } {
  const to = toDayKey(now);
  const from = toDayKey(new Date(now.getTime() - (days - 1) * DAY_MS));
  return { from, to };
}

export function rangeLabel(days: LpRangeDays): string {
  return `直近${days}日間`;
}

/** 1 回に指定できる最長の日数。lp-analytics の MAX_RANGE_DAYS と一致させる（超えると 400）。 */
export const LP_MAX_RANGE_DAYS = 92;

/** 閉区間の日数（from=to なら 1）。 */
export function rangeDayCount(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

/** 日キーに n 日足す（負も可）。 */
export function addDays(dayKey: string, n: number): string {
  return new Date(Date.parse(`${dayKey}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** カレンダーで選んだ期間の検証。問題なければ null、あれば画面に出す文言。 */
export function customRangeError(from: string | null, to: string | null, today: string): string | null {
  if (!from || !to) return "開始日と終了日を選んでください。";
  if (from > to) return "開始日は終了日より前にしてください。";
  if (to > today) return "未来の日付は選べません。";
  if (rangeDayCount(from, to) > LP_MAX_RANGE_DAYS) return `一度に見られるのは${LP_MAX_RANGE_DAYS}日間までです。`;
  return null;
}

/** 期間の表示（2026-09-01〜2026-09-30 → 9/1〜9/30）。年をまたぐ/今年でない時は年も出す。 */
export function formatRangeLabel(range: { from: string; to: string }, today: string): string {
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4) && range.to.slice(0, 4) === today.slice(0, 4);
  const fmt = (d: string): string => (sameYear ? formatDayLabel(d) : `${d.slice(0, 4)}/${formatDayLabel(d)}`);
  return range.from === range.to ? fmt(range.from) : `${fmt(range.from)}〜${fmt(range.to)}`;
}

/** 日キー（2026-09-28）→ 表示（9/28）。不正値はそのまま返す（落とさない）。 */
export function formatDayLabel(dayKey: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!m) return dayKey;
  return `${Number(m[2])}/${Number(m[3])}`;
}

/** ISO 時刻 → 「9/28 14:03」。不正値はそのまま返す。 */
export function formatVisitTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

const DEVICE_LABEL: Record<string, string> = {
  mobile: "スマホ",
  desktop: "PC",
  bot: "bot",
  unknown: "不明",
};

/** デバイス表示名。未知の値は素のキーを出す（無言で落とさない）。 */
export function deviceLabel(device: string): string {
  return DEVICE_LABEL[device] ?? device;
}

const SOURCE_LABEL: Record<string, string> = {
  instagram: "Instagram",
  x: "X(旧Twitter)",
  line: "LINE",
  google: "Google検索",
  flyer: "チラシQR",
  poster: "ポスターQR",
  direct: "直接アクセス",
  mail: "案内メール",
};

/** 流入元表示名。未登録の流入元はキーをそのまま出す（新しい流入元が消えない）。 */
export function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source;
}

/** 3桁区切り。0 も "0" を返す（空欄にしない＝データ無しと 0 を混同させない）。 */
export function formatCount(n: number): string {
  return n.toLocaleString("ja-JP");
}

/** 横棒の幅(%)。max<=0 は 0 を返し、値があるなら最低 2% は見せる（1件が消えない）。 */
export function barPercent(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  return Math.max(2, Math.round((value / max) * 100));
}

/** 全体に対する構成比(%)。小数1桁。分母 0 は 0。 */
export function sharePercent(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((value / total) * 1000) / 10;
}

/** 国コード → 表示名。未知は素のコード。null は「不明」。 */
const COUNTRY_LABEL: Record<string, string> = { JP: "日本", US: "米国", TW: "台湾", KR: "韓国", CN: "中国" };
export function countryLabel(code: string | null): string {
  if (!code) return "不明";
  return COUNTRY_LABEL[code] ?? code;
}
