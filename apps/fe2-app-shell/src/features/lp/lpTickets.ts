// LP管理 → チケット の純粋関数。検証ルールは契約（lp-analytics 側の 400 判定）と同じ値で持つ:
// サーバーで弾かれる入力を先に画面で止め、楽観更新が即ロールバックされる体験を作らない。
import type {
  LpTicketCoupon,
  LpTicketCouponInput,
  LpTicketField,
  LpTicketFieldType,
  LpTicketOrderItem,
  LpTicketOrderStatus,
  LpTicketTypeInput,
  LpTicketTypeSummary,
} from "./lpApi.tsx";

export const TICKET_NAME_MAX = 60;
export const TICKET_DESCRIPTION_MAX = 300;
export const TICKET_PRICE_MAX = 1_000_000;
/** Stripe の JPY 最低決済額。1..49 円は作れない（0 円 = 無料は可）。 */
export const TICKET_PRICE_MIN_PAID = 50;
export const TICKET_CAPACITY_MAX = 100_000;
export const TICKET_DAY_LABEL_MAX = 30;
export const TICKET_MAX_PER_ORDER_MAX = 20;
export const TICKET_MAX_PER_ORDER_DEFAULT = 10;
export const TICKET_FIELDS_MAX = 20;
export const TICKET_FIELD_LABEL_MAX = 60;
export const TICKET_FIELD_OPTIONS_MAX = 20;
export const TICKET_FIELD_ID_RE = /^[a-z0-9_-]{1,40}$/;

export const FIELD_TYPE_LABELS: Record<LpTicketFieldType, string> = {
  text: "テキスト",
  textarea: "長文",
  select: "選択肢",
  checkbox: "チェック",
};

export const ORDER_STATUS: Record<LpTicketOrderStatus, { label: string; tone: "success" | "warning" | "neutral" }> = {
  paid: { label: "支払い済み", tone: "success" },
  pending: { label: "決済待ち", tone: "warning" },
  expired: { label: "期限切れ", tone: "neutral" },
  refunded: { label: "返金済み", tone: "neutral" },
  needs_review: { label: "要確認", tone: "warning" },
};

/** 要確認になった理由（サーバーの reviewReason）→ 平易な文言。 */
export const REVIEW_REASON: Record<string, string> = {
  amount_mismatch: "支払額が注文額と違う",
  currency_mismatch: "通貨が円ではない",
  oversold: "定員超過後に支払いが完了",
  dispute: "チャージバック（支払いへの異議）",
};

export function reviewReasonLabel(reason: string | null | undefined): string {
  return (reason && Object.hasOwn(REVIEW_REASON, reason) ? REVIEW_REASON[reason] : undefined) ?? "要確認";
}

export function formatYen(n: number): string {
  return `¥${n.toLocaleString("ja-JP")}`;
}

export function formatPrice(priceJpy: number): string {
  return priceJpy === 0 ? "無料" : formatYen(priceJpy);
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** 券種フォームの入力値（数値欄は文字列のまま持ち、検証でだけ数にする）。 */
export interface TicketTypeDraft {
  name: string;
  description: string;
  price: string;
  /** 空 = 無制限 */
  capacity: string;
  /** 空 = 通し/共通（日付なし） */
  dayLabel: string;
  maxPerOrder: string;
  active: boolean;
}

export type TicketTypeDraftErrors = Partial<
  Record<"name" | "description" | "price" | "capacity" | "dayLabel" | "maxPerOrder", string>
>;

const INT_RE = /^\d+$/;

export function validateTicketType(draft: TicketTypeDraft): {
  errors: TicketTypeDraftErrors;
  input: LpTicketTypeInput | null;
} {
  const errors: TicketTypeDraftErrors = {};
  const name = draft.name.trim();
  const description = draft.description.trim();
  if (name.length === 0) errors.name = "券種名を入力してください";
  else if (name.length > TICKET_NAME_MAX) errors.name = `券種名は${TICKET_NAME_MAX}文字以内にしてください`;
  if (description.length > TICKET_DESCRIPTION_MAX) errors.description = `説明は${TICKET_DESCRIPTION_MAX}文字以内にしてください`;

  const priceText = draft.price.trim();
  const price = Number(priceText);
  if (!INT_RE.test(priceText) || price > TICKET_PRICE_MAX) {
    errors.price = `価格は 0〜${TICKET_PRICE_MAX.toLocaleString("ja-JP")} の整数（円）で入力してください`;
  } else if (price > 0 && price < TICKET_PRICE_MIN_PAID) {
    errors.price = `有料の場合は${TICKET_PRICE_MIN_PAID}円以上にしてください（Stripe の最低決済額）。無料にするなら 0`;
  }

  const capText = draft.capacity.trim();
  let capacity: number | null = null;
  if (capText.length > 0) {
    const cap = Number(capText);
    if (!INT_RE.test(capText) || cap < 1 || cap > TICKET_CAPACITY_MAX) {
      errors.capacity = `定員は 1〜${TICKET_CAPACITY_MAX.toLocaleString("ja-JP")} の整数で入力してください（空欄 = 無制限）`;
    } else {
      capacity = cap;
    }
  }

  const dayLabel = draft.dayLabel.trim();
  if (dayLabel.length > TICKET_DAY_LABEL_MAX) errors.dayLabel = `対象日は${TICKET_DAY_LABEL_MAX}文字以内にしてください`;

  const maxText = draft.maxPerOrder.trim();
  const maxPerOrder = Number(maxText);
  if (!INT_RE.test(maxText) || maxPerOrder < 1 || maxPerOrder > TICKET_MAX_PER_ORDER_MAX) {
    errors.maxPerOrder = `1 回の購入上限は 1〜${TICKET_MAX_PER_ORDER_MAX} の整数（枚）で入力してください`;
  }

  if (Object.keys(errors).length > 0) return { errors, input: null };
  return {
    errors,
    input: { name, description, priceJpy: price, capacity, dayLabel, maxPerOrder, active: draft.active },
  };
}

export const NO_DAY_LABEL = "通し・共通";

export interface TicketTypeGroup {
  /** "" = 日付なし */
  dayLabel: string;
  types: LpTicketTypeSummary[];
  sold: number;
  revenueJpy: number;
}

/** 券種を対象日でまとめる。グループの並びは各日の最初の券種の並び順（sortOrder 順の入力を前提）。 */
export function groupTicketTypesByDay(types: LpTicketTypeSummary[]): TicketTypeGroup[] {
  const groups = new Map<string, TicketTypeGroup>();
  for (const t of types) {
    const key = t.dayLabel.trim();
    let g = groups.get(key);
    if (!g) {
      g = { dayLabel: key, types: [], sold: 0, revenueJpy: 0 };
      groups.set(key, g);
    }
    g.types.push(t);
    g.sold += t.stats.sold;
    g.revenueJpy += t.stats.revenueJpy;
  }
  return [...groups.values()];
}

/** 注文明細 1 行の表示名（例「一般 · Day 1」）。 */
export function orderItemLabel(item: LpTicketOrderItem): string {
  return item.dayLabel ? `${item.ticketTypeName} · ${item.dayLabel}` : item.ticketTypeName;
}

/** 項目ごとのエラー（id → 文言）。空なら保存できる。 */
export function validateTicketFields(fields: LpTicketField[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const seen = new Set<string>();
  for (const f of fields) {
    const label = f.label.trim();
    if (!TICKET_FIELD_ID_RE.test(f.id) || seen.has(f.id)) errors[f.id] = "項目 ID が不正です（作り直してください）";
    else if (label.length === 0) errors[f.id] = "項目名を入力してください";
    else if (label.length > TICKET_FIELD_LABEL_MAX) errors[f.id] = `項目名は${TICKET_FIELD_LABEL_MAX}文字以内にしてください`;
    else if (f.type === "select") {
      if (f.options.length === 0) errors[f.id] = "選択肢を 1 つ以上入力してください（1 行に 1 つ）";
      else if (f.options.length > TICKET_FIELD_OPTIONS_MAX) errors[f.id] = `選択肢は${TICKET_FIELD_OPTIONS_MAX}個までです`;
      else if (f.options.some((o) => o.length > TICKET_FIELD_LABEL_MAX))
        errors[f.id] = `選択肢は 1 つ${TICKET_FIELD_LABEL_MAX}文字以内にしてください`;
      else if (new Set(f.options).size !== f.options.length) errors[f.id] = "同じ選択肢が重複しています";
    }
    seen.add(f.id);
  }
  return errors;
}

/** 保存前の正規化: label の前後空白を落とし、select 以外は options を空にする。 */
export function normalizeTicketFields(fields: LpTicketField[]): LpTicketField[] {
  return fields.map((f) => ({
    ...f,
    label: f.label.trim(),
    options: f.type === "select" ? f.options.map((o) => o.trim()).filter((o) => o.length > 0) : [],
  }));
}

/** 選択肢テキスト（1 行 1 つ）→ 配列。空行は捨てる。 */
export function parseOptions(text: string): string[] {
  return text
    .split("\n")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

export function newFieldId(): string {
  return `f_${Math.random().toString(36).slice(2, 10)}`;
}

export function moveItem<T>(list: T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (to < 0 || to >= list.length) return list;
  const next = list.slice();
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item!);
  return next;
}

// ── 無料券のクーポン（lp-analytics parseCouponInput と同じ上限） ──
export const COUPON_LABEL_MAX = 60;
export const COUPON_MAX_USES_MAX = 1000;
/** 画面の固定文言（demo の verify:live マーカーも兼ねる）。 */
export const COUPON_ISSUE_LABEL = "クーポンを発行";
/** 券種編集で 0 円のときの補足。 */
export const COUPON_ONLY_NOTE = "0 円の券種はクーポンコードでのみ申し込めます";

/** 使えるか: 停止 > 期限切れ > 上限到達 の順で 1 つに決める（手で止めたものを最優先で見せる）。 */
export type CouponState = "active" | "paused" | "expired" | "used_up";

export const COUPON_STATE: Record<CouponState, { label: string; tone: "success" | "warning" | "neutral" | "danger" }> = {
  active: { label: "使用可", tone: "success" },
  used_up: { label: "上限に達した", tone: "warning" },
  expired: { label: "期限切れ", tone: "danger" },
  paused: { label: "停止中", tone: "neutral" },
};

export function couponState(c: Pick<LpTicketCoupon, "active" | "expiresAt" | "used" | "maxUses">, now: Date = new Date()): CouponState {
  if (!c.active) return "paused";
  if (c.expiresAt !== null && Date.parse(c.expiresAt) <= now.getTime()) return "expired";
  if (c.used >= c.maxUses) return "used_up";
  return "active";
}

export function isCouponExpired(c: Pick<LpTicketCoupon, "expiresAt">, now: Date = new Date()): boolean {
  return c.expiresAt !== null && Date.parse(c.expiresAt) <= now.getTime();
}

/** 日本時間の今日（YYYY-MM-DD）。期限の日付入力の下限に使う。 */
export function todayJst(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** 期限の日付 → その日の終わり（日本時間 23:59:59）の ISO。「その日まで使える」と読めるように。 */
export function couponExpiryIso(day: string): string {
  return new Date(`${day}T23:59:59+09:00`).toISOString();
}

export interface CouponDraft {
  ticketTypeId: string;
  maxUses: string;
  label: string;
  /** YYYY-MM-DD / null = 期限なし */
  expiresOn: string | null;
}

export type CouponDraftErrors = Partial<Record<"ticketTypeId" | "maxUses" | "label" | "expiresOn", string>>;

export function validateCouponDraft(
  draft: CouponDraft,
  now: Date = new Date(),
): { errors: CouponDraftErrors; input: LpTicketCouponInput | null } {
  const errors: CouponDraftErrors = {};
  if (!draft.ticketTypeId) errors.ticketTypeId = "対象の券種を選んでください";
  const maxText = draft.maxUses.trim();
  const maxUses = Number(maxText);
  if (!INT_RE.test(maxText) || maxUses < 1 || maxUses > COUPON_MAX_USES_MAX) {
    errors.maxUses = `使える枚数は 1〜${COUPON_MAX_USES_MAX.toLocaleString("ja-JP")} の整数で入力してください`;
  }
  const label = draft.label.trim();
  if (label.length > COUPON_LABEL_MAX) errors.label = `用途メモは${COUPON_LABEL_MAX}文字以内にしてください`;
  let expiresAt: string | undefined;
  if (draft.expiresOn) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.expiresOn) || Number.isNaN(Date.parse(couponExpiryIso(draft.expiresOn)))) {
      errors.expiresOn = "期限の日付が正しくありません";
    } else if (draft.expiresOn < todayJst(now)) {
      errors.expiresOn = "期限は今日以降の日付にしてください";
    } else {
      expiresAt = couponExpiryIso(draft.expiresOn);
    }
  }
  if (Object.keys(errors).length > 0) return { errors, input: null };
  return {
    errors,
    input: { ticketTypeId: draft.ticketTypeId, maxUses, ...(label ? { label } : {}), ...(expiresAt ? { expiresAt } : {}) },
  };
}
