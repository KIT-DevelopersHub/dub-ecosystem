// lp — LP管理 (lp-analytics) shared constants + wire types (公開版切り替え・公開設定).
// The public LP Worker (lp-conference-next), lp-analytics and fe2 all read these, so the
// list of switchable versions has exactly one definition.

/** The public conference site whose live LP version is switchable from LP管理. */
export const LP_PUBLISH_SITE = "hokuriku-it-conf.com";

/** Versions that can be published (newest first). Must match apps/lp-conference-next/versions.json
 *  (v2.1 is not bundled: its deployed build came from an uncommitted tree). */
export const LP_PUBLISHABLE_VERSION_IDS = ["v3.6", "v3.5", "v3.4", "v3.3", "v3.2", "v3.1", "v3.0", "v2.0"] as const;

export type LpPublishableVersionId = (typeof LP_PUBLISHABLE_VERSION_IDS)[number];

/** Served when no publish row exists yet (and the LP Worker's fallback). */
export const LP_DEFAULT_PUBLISHED_VERSION: LpPublishableVersionId = "v3.4";

/** GET/POST /api/v1/lp/publish response. */
export interface LpPublishState {
  site: string;
  versionId: string;
  versions: string[];
  updatedAt: string | null;
  updatedBy: string | null;
}

// ---- 公開設定（セクションの切り替え・本番反映）----
// 登録簿は LP（lp-conference-next）・lp-analytics の検証・LP管理の UI がすべて読む唯一の定義。
// v1 はバリアント切り替え・表示/非表示・boolean/enum オプションだけ（文言は snapshot のまま）。

export interface LpOptionDef {
  kind: "boolean" | "enum";
  label: string;
  default: boolean | string;
  /** enum の値 → 表示名。 */
  values?: Readonly<Record<string, string>>;
}

export interface LpSectionDef {
  label: string;
  /** 「表示しない」を許すか。 */
  hideable: boolean;
  /** 書いていないときに表示するか（省略 = true）。false は新設のセクション用: 有効にするまで本番は変わらない。 */
  defaultVisible?: boolean;
  defaultVariant: string;
  /** variantId → 表示名。 */
  variants: Readonly<Record<string, string>>;
  options?: Readonly<Record<string, LpOptionDef>>;
}

export const LP_SECTION_REGISTRY = {
  header: {
    label: "ヘッダー",
    hideable: false,
    defaultVariant: "a",
    variants: { a: "標準" },
    options: { banner: { kind: "boolean", label: "帯（告知バナー）を表示", default: true } },
  },
  // 中身（項目の一覧）を LP管理で編集するセクション（LP_CONTENT_FIELDS）。既定は非表示・項目が 0 件のあいだも出ない。
  partners: { label: "協力団体ロゴ", hideable: true, defaultVisible: false, defaultVariant: "a", variants: { a: "ロゴの帯" } },
  news: { label: "お知らせ", hideable: true, defaultVisible: false, defaultVariant: "a", variants: { a: "一覧" } },
  speakers: { label: "登壇者情報", hideable: true, defaultVisible: false, defaultVariant: "a", variants: { a: "2列カード" } },
  join: { label: "参加・登壇 (Join)", hideable: true, defaultVariant: "a", variants: { a: "2カード" } },
  program: { label: "プログラム", hideable: true, defaultVariant: "a", variants: { a: "標準" } },
  about: { label: "とは？", hideable: true, defaultVariant: "a", variants: { a: "3点" } },
  crowdfunding: {
    label: "クラファン情報",
    hideable: true,
    defaultVariant: "a",
    variants: { a: "帯" },
    // パターンは 1 つの <section id="crowdfunding"> の中で切り替える（バリアントにするとアンカーの id が重複する）。
    options: {
      pattern: {
        kind: "enum",
        label: "パターン",
        default: "current",
        values: { current: "現状のページ", supporters: "支援者情報" },
      },
    },
  },
  vision: { label: "ビジョン", hideable: true, defaultVariant: "a", variants: { a: "標準" } },
  // お問い合わせ（CTA の帯）とフッターはページの締めなので、スポンサーはその手前に置く。
  sponsors: { label: "スポンサー", hideable: true, defaultVisible: false, defaultVariant: "a", variants: { a: "プラン別" } },
  contact: { label: "お問い合わせ", hideable: true, defaultVariant: "a", variants: { a: "標準" } },
  footer: { label: "フッター", hideable: false, defaultVariant: "a", variants: { a: "標準" } },
} as const satisfies Record<string, LpSectionDef>;

export type LpSectionId = keyof typeof LP_SECTION_REGISTRY;

/** 登録簿の並び（= LP 上の並び）。 */
export const LP_SECTION_IDS = Object.keys(LP_SECTION_REGISTRY) as LpSectionId[];

export type LpOptionValue = boolean | string;

export interface LpSectionSetting {
  variant: string;
  visible: boolean;
  /** 書いていないオプションは既定値。 */
  options: Record<string, LpOptionValue>;
}

/** 見た目の設定（lp_site_config に保存）。 */
export interface LpLayout {
  schema: 1;
  /** 書いていないセクションは既定値。 */
  sections: Partial<Record<LpSectionId, LpSectionSetting>>;
  /** 項目の一覧（協力団体・お知らせ・登壇者・スポンサー）。書いていない一覧は 0 件。 */
  content?: Partial<LpContent>;
}

// ---- 公開設定の中身（項目の一覧）----
// セクションの表示/非表示と同じ下書き → 本番反映の流れに乗せるため、layout.content に持つ（同じ JSON 列・追加の表は無い）。
// 項目の欄は LP_CONTENT_FIELDS が唯一の定義: LP管理のフォーム・lp-analytics の検証・LP Worker の正規化が全部これを読む。
// 画像は URL（https:// か LP 内の /パス）。LP 用の画像アップロードの仕組みはまだ無い。

export const LP_CONTENT_SECTION_IDS = ["partners", "news", "speakers", "sponsors"] as const;
export type LpContentSectionId = (typeof LP_CONTENT_SECTION_IDS)[number];

export const LP_SPONSOR_TIERS = ["title", "gold", "silver", "bronze"] as const;
export type LpSponsorTier = (typeof LP_SPONSOR_TIERS)[number];
export const LP_SPONSOR_TIER_LABELS: Readonly<Record<LpSponsorTier, string>> = {
  title: "Title",
  gold: "Gold",
  silver: "Silver",
  bronze: "Bronze",
};

export interface LpPartnerItem {
  id: string;
  name: string;
  logoUrl: string;
  /** "" = リンクなし。 */
  url: string;
}

export interface LpNewsItem {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  text: string;
  url: string;
  /** 強調（目印と下線）。 */
  highlight: boolean;
}

export interface LpSpeakerItem {
  id: string;
  name: string;
  furigana: string;
  affiliation: string;
  photoUrl: string;
  /** 開くと見えるメッセージ（100〜150 文字程度）。"" ならボタンを出さない。 */
  message: string;
}

export interface LpSponsorItem {
  id: string;
  tier: LpSponsorTier;
  name: string;
  logoUrl: string;
  url: string;
  /** 短い説明。LP に出すのは Title プランだけ。 */
  description: string;
}

export interface LpContent {
  partners: LpPartnerItem[];
  news: LpNewsItem[];
  speakers: LpSpeakerItem[];
  sponsors: LpSponsorItem[];
}

export type LpContentFieldKind = "text" | "textarea" | "url" | "image" | "date" | "boolean" | "tier";

export interface LpContentFieldDef {
  key: string;
  label: string;
  kind: LpContentFieldKind;
  required: boolean;
  /** 文字数の上限（text / textarea）。 */
  max?: number;
  /** 入力欄の補足。 */
  hint?: string;
}

export const LP_CONTENT_URL_MAX = 500;
export const LP_CONTENT_ITEM_ID_RE = /^[a-z0-9_-]{1,40}$/;

/** セクション → 項目の欄（並び = フォームの並び）。 */
export const LP_CONTENT_FIELDS: { readonly [S in LpContentSectionId]: readonly LpContentFieldDef[] } = {
  partners: [
    { key: "name", label: "団体名", kind: "text", required: true, max: 80 },
    { key: "logoUrl", label: "ロゴ画像の URL", kind: "image", required: true, hint: "正方形の画像がきれいに収まります（円形に切り抜いて表示）。" },
    { key: "url", label: "リンク先 URL", kind: "url", required: false },
  ],
  news: [
    { key: "date", label: "日付", kind: "date", required: true },
    { key: "text", label: "本文", kind: "text", required: true, max: 120 },
    { key: "url", label: "リンク先 URL", kind: "url", required: false },
    { key: "highlight", label: "強調する", kind: "boolean", required: false, hint: "目印と下線で目立たせます。" },
  ],
  speakers: [
    { key: "name", label: "名前", kind: "text", required: true, max: 40 },
    { key: "furigana", label: "ふりがな", kind: "text", required: false, max: 60 },
    { key: "affiliation", label: "所属", kind: "text", required: false, max: 80 },
    { key: "photoUrl", label: "写真の URL", kind: "image", required: false, hint: "正方形の写真がきれいに収まります。" },
    { key: "message", label: "メッセージ", kind: "textarea", required: false, max: 200, hint: "100〜150 文字程度。▼ で開くと見えます。" },
  ],
  sponsors: [
    { key: "tier", label: "プラン", kind: "tier", required: true },
    { key: "name", label: "会社名", kind: "text", required: true, max: 80 },
    { key: "logoUrl", label: "ロゴ画像の URL", kind: "image", required: false, hint: "横長のロゴがきれいに収まります。" },
    { key: "url", label: "リンク先 URL", kind: "url", required: false },
    { key: "description", label: "説明", kind: "textarea", required: false, max: 120, hint: "LP に出るのは Title プランだけです。" },
  ],
};

/** 1 セクションの項目数の上限。 */
export const LP_CONTENT_MAX_ITEMS: Readonly<Record<LpContentSectionId, number>> = {
  partners: 40,
  news: 50,
  speakers: 60,
  sponsors: 80,
};

export type LpContentItem<S extends LpContentSectionId> = LpContent[S][number];

export function isLpContentSection(id: string): id is LpContentSectionId {
  return (LP_CONTENT_SECTION_IDS as readonly string[]).includes(id);
}

/** 画像・リンクの URL として受け付けるか: http(s) の絶対 URL か、LP 内の /パス（// は不可）。 */
export function isLpContentUrl(v: string): boolean {
  if (v.length > LP_CONTENT_URL_MAX || /\s/.test(v)) return false;
  if (v.startsWith("/")) return !v.startsWith("//") && !v.startsWith("/\\");
  // この package は DOM / Workers の型を持たないので URL クラスではなく形で検める。
  return /^https?:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?([/?#]\S*)?$/i.test(v);
}

function isRealDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().startsWith(v);
}

/** 欄 1 つの値を検める（文字列は前後の空白を落とす）。 */
function contentFieldValue(f: LpContentFieldDef, raw: unknown): { value: string | boolean; reason: string | null } {
  if (f.kind === "boolean") return raw === undefined ? { value: false, reason: null } : typeof raw === "boolean" ? { value: raw, reason: null } : { value: false, reason: "invalid" };
  if (raw !== undefined && typeof raw !== "string") return { value: "", reason: "invalid" };
  const v = (raw ?? "").trim();
  if (v === "") return { value: "", reason: f.required ? "required" : null };
  if (f.kind === "tier") return { value: v, reason: (LP_SPONSOR_TIERS as readonly string[]).includes(v) ? null : "invalid" };
  if (f.kind === "date") return { value: v, reason: isRealDate(v) ? null : "invalid" };
  if (f.kind === "url" || f.kind === "image") return { value: v, reason: isLpContentUrl(v) ? null : "invalid_url" };
  if (f.max !== undefined && v.length > f.max) return { value: v, reason: "too_long" };
  return { value: v, reason: null };
}

/** 1 項目を検める。issues が空なら item は欄が全部そろった正規形。 */
export function validateContentItem<S extends LpContentSectionId>(
  section: S,
  raw: unknown,
  path = "item",
): { item: LpContentItem<S> | null; issues: LpConfigIssue[] } {
  if (!isRecord(raw)) return { item: null, issues: [{ field: path, reason: "invalid" }] };
  const issues: LpConfigIssue[] = [];
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!LP_CONTENT_ITEM_ID_RE.test(id)) issues.push({ field: `${path}.id`, reason: "invalid" });
  const out: Record<string, string | boolean> = { id };
  for (const f of LP_CONTENT_FIELDS[section]) {
    const { value, reason } = contentFieldValue(f, raw[f.key]);
    if (reason) issues.push({ field: `${path}.${f.key}`, reason });
    out[f.key] = value;
  }
  return { item: issues.length === 0 ? (out as unknown as LpContentItem<S>) : null, issues };
}

/** 書いていない一覧を 0 件で埋めた中身。 */
export function resolveContent(layout: LpLayout): LpContent {
  const c = layout.content ?? {};
  return { partners: c.partners ?? [], news: c.news ?? [], speakers: c.speakers ?? [], sponsors: c.sponsors ?? [] };
}

/** 中身の 1 セクションを差し替えた layout（ほかはそのまま）。 */
export function setContent<S extends LpContentSectionId>(layout: LpLayout, section: S, items: LpContent[S]): LpLayout {
  return { ...layout, content: { ...layout.content, [section]: items } };
}

/** 寛容: 壊れた項目・重複 ID・上限を超えた分は捨てる。 */
function normalizeContent(raw: unknown): Partial<LpContent> {
  const out: Partial<Record<LpContentSectionId, unknown[]>> = {};
  if (!isRecord(raw)) return out as Partial<LpContent>;
  for (const id of LP_CONTENT_SECTION_IDS) {
    const list = raw[id];
    if (!Array.isArray(list)) continue;
    const seen = new Set<string>();
    const items: unknown[] = [];
    for (const r of list) {
      const { item } = validateContentItem(id, r);
      if (!item || seen.has(item.id) || items.length >= LP_CONTENT_MAX_ITEMS[id]) continue;
      seen.add(item.id);
      items.push(item);
    }
    out[id] = items;
  }
  return out as Partial<LpContent>;
}

/** 厳格: 書き込み API 用。 */
function validateContent(raw: unknown, path: string): { content: Partial<LpContent>; issues: LpConfigIssue[] } {
  const issues: LpConfigIssue[] = [];
  const out: Partial<Record<LpContentSectionId, unknown[]>> = {};
  if (!isRecord(raw)) return { content: {}, issues: [{ field: path, reason: "invalid" }] };
  for (const [key, list] of Object.entries(raw)) {
    const at = `${path}.${key}`;
    if (!isLpContentSection(key)) {
      issues.push({ field: at, reason: "unknown_section" });
      continue;
    }
    if (!Array.isArray(list)) {
      issues.push({ field: at, reason: "invalid" });
      continue;
    }
    if (list.length > LP_CONTENT_MAX_ITEMS[key]) {
      issues.push({ field: at, reason: "too_many" });
      continue;
    }
    const seen = new Set<string>();
    const items: unknown[] = [];
    list.forEach((r, i) => {
      const v = validateContentItem(key, r, `${at}[${i}]`);
      issues.push(...v.issues);
      if (!v.item) return;
      if (seen.has(v.item.id)) issues.push({ field: `${at}[${i}].id`, reason: "duplicate" });
      seen.add(v.item.id);
      items.push(v.item);
    });
    out[key] = items;
  }
  return { content: out as Partial<LpContent>, issues };
}

/** その中身のセクションに LP に出す項目があるか（0 件のあいだは表示にしても出さない）。 */
export function hasContentItems(layout: LpLayout, section: LpContentSectionId): boolean {
  return resolveContent(layout)[section].length > 0;
}

/** 本番反映の設定。本番の値は既存テーブル（lp_publish / lp_ticket_settings / lp_proposal_settings）が正本。 */
export interface LpRelease {
  versionId: string;
  ticketsEnabled: boolean;
  ticketsCtaEnabled: boolean;
  proposalsEnabled: boolean;
}

export interface LpSiteConfig {
  layout: LpLayout;
  release: LpRelease;
}

/** GET /api/v1/lp/site-config（PUT draft・reset・publish も同じ形を返す）。 */
export interface LpSiteConfigState {
  site: string;
  /** プレビュー（下書き）。保存したことが無ければ published と同じ。 */
  draft: LpSiteConfig;
  /** 本番。release は既存テーブルから組み立てる。 */
  published: LpSiteConfig;
  /** 楽観ロック。下書き保存・リセット・本番反映のたびに 1 増える。 */
  revision: number;
  draftUpdatedAt: string | null;
  draftUpdatedBy: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
}

/** PUT /api/v1/lp/site-config/draft・POST /api/v1/lp/site-config/publish。revision が違えば 409。 */
export interface LpSiteConfigWriteRequest {
  config: LpSiteConfig;
  revision: number;
}

/** POST /api/v1/lp/site-config/draft/reset。revision を付けたときだけ照合する。 */
export interface LpSiteConfigResetRequest {
  revision?: number;
}

/** GET /lp/internal/site-config（LP Worker 用・service binding のみ）。 */
export interface LpInternalSiteConfig {
  published: LpLayout;
  draft: LpLayout;
}

export interface LpConfigIssue {
  field: string;
  reason: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sectionDef = (id: string): LpSectionDef | undefined =>
  Object.prototype.hasOwnProperty.call(LP_SECTION_REGISTRY, id)
    ? (LP_SECTION_REGISTRY as Record<string, LpSectionDef>)[id]
    : undefined;
const hasKey = (o: Readonly<Record<string, unknown>> | undefined, k: string): boolean =>
  o !== undefined && Object.prototype.hasOwnProperty.call(o, k);

function optionValueOk(def: LpOptionDef, v: unknown): v is LpOptionValue {
  return def.kind === "boolean" ? typeof v === "boolean" : typeof v === "string" && hasKey(def.values, v);
}

export function defaultLayout(): LpLayout {
  return { schema: 1, sections: {} };
}

/** セクションの実効値（書いていない値は既定値で埋める）。 */
export function resolveSection(layout: LpLayout, id: LpSectionId): LpSectionSetting {
  const def: LpSectionDef = LP_SECTION_REGISTRY[id];
  const s = layout.sections[id];
  const options: Record<string, LpOptionValue> = {};
  for (const [k, o] of Object.entries(def.options ?? {})) options[k] = s && hasKey(s.options, k) ? s.options[k]! : o.default;
  return {
    variant: s && hasKey(def.variants, s.variant) ? s.variant : def.defaultVariant,
    visible: def.hideable ? (s?.visible ?? def.defaultVisible ?? true) : true,
    options,
  };
}

/**
 * 寛容な正規化: 未知のセクション・バリアント・オプション・型違いは捨てる（= 既定値）。
 * 保存済みの値を読むとき（登録簿からバリアントを外した後など）に LP・サーバー・UI で共用する。
 */
export function normalizeLayout(raw: unknown): LpLayout {
  const out = defaultLayout();
  const sections = isRecord(raw) && isRecord(raw.sections) ? raw.sections : {};
  for (const [id, v] of Object.entries(sections)) {
    const def = sectionDef(id);
    if (!def || !isRecord(v)) continue;
    const options: Record<string, LpOptionValue> = {};
    if (isRecord(v.options)) {
      for (const [k, ov] of Object.entries(v.options)) {
        const od = def.options?.[k];
        if (od && hasKey(def.options, k) && optionValueOk(od, ov)) options[k] = ov;
      }
    }
    out.sections[id as LpSectionId] = {
      variant: typeof v.variant === "string" && hasKey(def.variants, v.variant) ? v.variant : def.defaultVariant,
      visible: def.hideable ? (typeof v.visible === "boolean" ? v.visible : (def.defaultVisible ?? true)) : true,
      options,
    };
  }
  if (isRecord(raw) && raw.content !== undefined) out.content = normalizeContent(raw.content);
  return out;
}

// <html> の data-lp-* 属性。LP Worker（読み込み時に付ける）と LP管理のミニプレビュー（postMessage で即時に
// 付け替える）が共用する。LP のビルドの CSS（siteConfigCss）も同じ名前を使う。

/** <html> 上のセクションの属性名。値はバリアント ID か LP_HIDDEN。 */
export const lpSectionAttr = (section: string): string => `data-lp-s-${section}`;
/** <html> 上のオプションの属性名。boolean は "on" / "off"、enum は値そのもの。 */
export const lpOptionAttr = (section: string, option: string): string => `data-lp-o-${section}-${option}`;
export const LP_HIDDEN = "off";
/** 公開設定の属性として受け付ける名前と値（postMessage で来たものを当てる前に検める）。 */
export const LP_ATTR_NAME = /^data-lp-[so]-[a-z0-9_-]{1,64}$/;
export const LP_ATTR_VALUE = /^[a-z0-9_]{1,40}$/;

/**
 * 正規化済みの layout（normalizeLayout の結果）→ <html> に付ける属性。既定値と同じものは付けない
 * （既定の設定なら属性ゼロ = 静的 HTML のまま）。登録簿は引数（テストで差し替える）。
 */
export function layoutAttributes(registry: Readonly<Record<string, LpSectionDef>>, layout: LpLayout): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, def] of Object.entries(registry)) {
    const s = (layout.sections as Record<string, LpSectionSetting | undefined>)[id];
    if (!s) continue;
    const shownByDefault = def.defaultVisible ?? true;
    // 中身のセクションは項目が 0 件なら表示にしても出さない（見出しだけの空の帯を出さない）。
    const visible = s.visible !== false && (!isLpContentSection(id) || hasContentItems(layout, id));
    if (def.hideable && !visible) {
      if (shownByDefault) out[lpSectionAttr(id)] = LP_HIDDEN;
    } else if (hasKey(def.variants, s.variant) && (s.variant !== def.defaultVariant || !shownByDefault)) {
      // 既定で隠れるセクションは、表示のときに属性（バリアント）を付けて出す。
      out[lpSectionAttr(id)] = s.variant;
    }
    for (const [k, o] of Object.entries(def.options ?? {})) {
      if (!hasKey(s.options, k)) continue;
      const v = s.options[k];
      if (v === o.default) continue;
      if (o.kind === "boolean" && typeof v === "boolean") out[lpOptionAttr(id, k)] = v ? "on" : "off";
      else if (o.kind === "enum" && typeof v === "string" && hasKey(o.values, v)) out[lpOptionAttr(id, k)] = v;
    }
  }
  return out;
}

/**
 * 厳格な検証（書き込み API 用）: 未知のセクション・バリアント・オプション、型違い、
 * hideable でないセクションの非表示は issue にする。variant / visible / options は省略可（既定値）。
 * issue が無いときの layout は正規化済み（省略した値は既定値で埋めてある）。
 */
export function validateLayout(raw: unknown, path = "layout"): { layout: LpLayout; issues: LpConfigIssue[] } {
  const issues: LpConfigIssue[] = [];
  const layout = defaultLayout();
  if (!isRecord(raw)) return { layout, issues: [{ field: path, reason: "required" }] };
  if (raw.schema !== 1) issues.push({ field: `${path}.schema`, reason: "unsupported" });
  if (raw.content !== undefined) {
    const c = validateContent(raw.content, `${path}.content`);
    issues.push(...c.issues);
    layout.content = c.content;
  }
  if (raw.sections === undefined) return { layout, issues };
  if (!isRecord(raw.sections)) return { layout, issues: [...issues, { field: `${path}.sections`, reason: "invalid" }] };
  for (const [id, v] of Object.entries(raw.sections)) {
    const at = `${path}.sections.${id}`;
    const def = sectionDef(id);
    if (!def) {
      issues.push({ field: at, reason: "unknown_section" });
      continue;
    }
    if (!isRecord(v)) {
      issues.push({ field: at, reason: "invalid" });
      continue;
    }
    let variant = def.defaultVariant;
    if (v.variant !== undefined) {
      if (typeof v.variant === "string" && hasKey(def.variants, v.variant)) variant = v.variant;
      else issues.push({ field: `${at}.variant`, reason: "unknown_variant" });
    }
    let visible = def.hideable ? (def.defaultVisible ?? true) : true;
    if (v.visible !== undefined) {
      if (typeof v.visible !== "boolean") issues.push({ field: `${at}.visible`, reason: "invalid" });
      else if (!v.visible && !def.hideable) issues.push({ field: `${at}.visible`, reason: "not_hideable" });
      else visible = v.visible;
    }
    const options: Record<string, LpOptionValue> = {};
    if (v.options !== undefined) {
      if (!isRecord(v.options)) issues.push({ field: `${at}.options`, reason: "invalid" });
      else {
        for (const [k, ov] of Object.entries(v.options)) {
          const od = hasKey(def.options, k) ? def.options![k] : undefined;
          if (!od) issues.push({ field: `${at}.options.${k}`, reason: "unknown_option" });
          else if (!optionValueOk(od, ov)) issues.push({ field: `${at}.options.${k}`, reason: "invalid" });
          else options[k] = ov;
        }
      }
    }
    layout.sections[id as LpSectionId] = { variant, visible, options };
  }
  return { layout, issues };
}

/** 厳格な検証: release（版は LP_PUBLISHABLE_VERSION_IDS のどれか・3 つのフラグは boolean 必須）。 */
export function validateRelease(raw: unknown, path = "release"): { release: LpRelease | null; issues: LpConfigIssue[] } {
  if (!isRecord(raw)) return { release: null, issues: [{ field: path, reason: "required" }] };
  const issues: LpConfigIssue[] = [];
  const versions: readonly string[] = LP_PUBLISHABLE_VERSION_IDS;
  if (typeof raw.versionId !== "string" || !versions.includes(raw.versionId)) {
    issues.push({ field: `${path}.versionId`, reason: "not_publishable" });
  }
  for (const k of ["ticketsEnabled", "ticketsCtaEnabled", "proposalsEnabled"] as const) {
    if (typeof raw[k] !== "boolean") issues.push({ field: `${path}.${k}`, reason: "required" });
  }
  if (issues.length > 0) return { release: null, issues };
  return {
    release: {
      versionId: raw.versionId as string,
      ticketsEnabled: raw.ticketsEnabled as boolean,
      ticketsCtaEnabled: raw.ticketsCtaEnabled as boolean,
      proposalsEnabled: raw.proposalsEnabled as boolean,
    },
    issues,
  };
}

/** 厳格な検証: LpSiteConfig 全体。 */
export function validateSiteConfig(raw: unknown, path = "config"): { config: LpSiteConfig | null; issues: LpConfigIssue[] } {
  if (!isRecord(raw)) return { config: null, issues: [{ field: path, reason: "required" }] };
  const l = validateLayout(raw.layout, `${path}.layout`);
  const r = validateRelease(raw.release, `${path}.release`);
  const issues = [...l.issues, ...r.issues];
  return { config: issues.length === 0 && r.release ? { layout: l.layout, release: r.release } : null, issues };
}

// ---- Custom form fields (チケット / 登壇者募集で共用). lp-analytics, fe2 and the LP Worker share this vocabulary ----

export const LP_FIELD_TYPES = ["text", "textarea", "radio", "multiselect", "select", "checkbox", "date", "email", "phone"] as const;
export type LpFieldType = (typeof LP_FIELD_TYPES)[number];

export const LP_FIELD_TYPE_LABELS: Record<LpFieldType, string> = {
  text: "記述式（短文）",
  textarea: "段落（長文）",
  radio: "ラジオボタン（1つ選ぶ）",
  multiselect: "チェックボックス（複数選ぶ）",
  select: "プルダウン",
  checkbox: "同意チェック",
  date: "日付",
  email: "メールアドレス",
  phone: "電話番号",
};

export const LP_FIELD_DESCRIPTION_MAX = 200;
/** Separator of a multiselect answer between the LP Worker and lp-analytics (options cannot contain it). */
export const LP_MULTISELECT_SEPARATOR = "\n";

const LP_CHOICE_FIELD_TYPES: readonly string[] = ["radio", "multiselect", "select"];
export const LP_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LP_PHONE_RE = /^[0-9+\-() ]{6,30}$/;
const LP_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isLpFieldType(v: unknown): v is LpFieldType {
  return typeof v === "string" && (LP_FIELD_TYPES as readonly string[]).includes(v);
}

export function isLpChoiceField(type: string): boolean {
  return LP_CHOICE_FIELD_TYPES.includes(type);
}

/** What is wrong with a non-empty answer (shown on the public form), or null when it is valid. */
export function lpFieldAnswerProblem(f: { type: LpFieldType; options: readonly string[] }, value: string): string | null {
  if (f.type === "multiselect") {
    const picked = value.split(LP_MULTISELECT_SEPARATOR);
    const known = picked.every((v) => f.options.includes(v)) && new Set(picked).size === picked.length;
    return known ? null : "選択肢から選んでください";
  }
  if (f.type === "radio" || f.type === "select") return f.options.includes(value) ? null : "選択肢から選んでください";
  if (f.type === "email") return LP_EMAIL_RE.test(value) ? null : "メールアドレスの形式が正しくありません";
  if (f.type === "phone") return LP_PHONE_RE.test(value) ? null : "電話番号の形式が正しくありません";
  if (f.type === "date") {
    const time = Date.parse(`${value}T00:00:00Z`);
    const real = LP_DATE_RE.test(value) && !Number.isNaN(time) && new Date(time).toISOString().startsWith(value);
    return real ? null : "日付を選び直してください";
  }
  return null;
}

// ---- Form parsing shared by lp-tickets and lp-analytics (proposals). No @dub/errors here: this file
// also runs in the LP Worker, so problems come back as issues and each service throws its own 400. ----

export const LP_FIELDS_MAX = 20;
export const LP_FIELD_LABEL_MAX = 60;
export const LP_FIELD_OPTIONS_MAX = 20;
export const LP_FIELD_OPTION_MAX = 60;
export const LP_CHECKBOX_YES = "はい";
export const LP_BUYER_NAME_MAX = 100;
export const LP_BUYER_EMAIL_MAX = 254;
/** Hashed sender IP from the public LP Worker (clientKeyFor). Anything else is treated as absent. */
export const LP_CLIENT_KEY_RE = /^[a-f0-9]{16,64}$/;

const LP_FIELD_ID_RE = /^[a-z0-9_-]{1,40}$/;
const LP_ANSWER_MAX: Record<LpFieldType, number> = {
  text: 200,
  textarea: 2000,
  radio: LP_FIELD_OPTION_MAX,
  multiselect: (LP_FIELD_OPTION_MAX + 1) * LP_FIELD_OPTIONS_MAX,
  select: LP_FIELD_OPTION_MAX,
  checkbox: 10,
  date: 10,
  email: LP_BUYER_EMAIL_MAX,
  phone: 30,
};

export interface LpFormField {
  id: string;
  label: string;
  /** 回答者に見せる補足説明（無ければキーごと持たない）。 */
  description?: string;
  type: LpFieldType;
  required: boolean;
  options: string[];
}

export interface LpFormAnswer {
  fieldId: string;
  label: string;
  value: string;
}

/** `reserved` = fixed-field ids the caller's form already has (custom fields must not reuse them). */
export function parseLpFields(body: unknown, reserved: ReadonlySet<string>): { fields: LpFormField[]; issues: LpConfigIssue[] } {
  const raw = (body as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(raw)) return { fields: [], issues: [{ field: "fields", reason: "required" }] };
  if (raw.length > LP_FIELDS_MAX) return { fields: [], issues: [{ field: "fields", reason: "too_many" }] };
  const bad: LpConfigIssue[] = [];
  const seen = new Set<string>();
  const out: LpFormField[] = [];
  raw.forEach((f0, i) => {
    const f = (f0 ?? {}) as Record<string, unknown>;
    const at = (k: string) => `fields[${i}].${k}`;
    const before = bad.length;
    const id = typeof f.id === "string" ? f.id : "";
    if (!LP_FIELD_ID_RE.test(id) || reserved.has(id)) bad.push({ field: at("id"), reason: "invalid" });
    else if (seen.has(id)) bad.push({ field: at("id"), reason: "duplicate" });
    seen.add(id);
    const label = typeof f.label === "string" ? f.label.trim() : "";
    if (label.length === 0) bad.push({ field: at("label"), reason: "required" });
    else if (label.length > LP_FIELD_LABEL_MAX) bad.push({ field: at("label"), reason: "too_long" });
    const description = typeof f.description === "string" ? f.description.trim() : "";
    if (description.length > LP_FIELD_DESCRIPTION_MAX) bad.push({ field: at("description"), reason: "too_long" });
    const type = f.type as LpFieldType;
    if (!isLpFieldType(type)) bad.push({ field: at("type"), reason: "invalid" });
    if (typeof f.required !== "boolean") bad.push({ field: at("required"), reason: "invalid" });
    let options: string[] = [];
    if (isLpChoiceField(type)) {
      const opts = Array.isArray(f.options) ? f.options : [];
      options = opts.map((o) => (typeof o === "string" ? o.trim() : ""));
      if (options.length < 1 || options.length > LP_FIELD_OPTIONS_MAX) bad.push({ field: at("options"), reason: "invalid_count" });
      else if (options.some((o) => o.length === 0 || o.length > LP_FIELD_OPTION_MAX || o.includes(LP_MULTISELECT_SEPARATOR))) {
        bad.push({ field: at("options"), reason: "invalid" });
      }
      else if (new Set(options).size !== options.length) bad.push({ field: at("options"), reason: "duplicate" });
    }
    if (bad.length === before) {
      out.push({ id, label, ...(description ? { description } : {}), type, required: f.required as boolean, options });
    }
  });
  return { fields: bad.length > 0 ? [] : out, issues: bad };
}

/** Answers to the configured custom fields (label snapshot kept). Problems go to `bad`. */
export function parseLpAnswers(raw: unknown, fields: readonly LpFormField[], bad: LpConfigIssue[]): LpFormAnswer[] {
  const rawAnswers = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const answers: LpFormAnswer[] = [];
  for (const f of fields) {
    const v0 = rawAnswers[f.id];
    const value = typeof v0 === "string" ? v0.trim() : "";
    const key = `answers.${f.id}`;
    if (f.required && value === "") bad.push({ field: key, reason: "required" });
    else if (value.length > LP_ANSWER_MAX[f.type]) bad.push({ field: key, reason: "too_long" });
    else if (value !== "" && lpFieldAnswerProblem(f, value)) bad.push({ field: key, reason: "invalid" });
    else if (value !== "" && f.type === "checkbox" && value !== LP_CHECKBOX_YES) bad.push({ field: key, reason: "invalid" });
    // 回答は表示用の 1 文字列で持つ（一覧・CSV はこのまま出す）。
    const shown = f.type === "multiselect" ? value.split(LP_MULTISELECT_SEPARATOR).join("、") : value;
    answers.push({ fieldId: f.id, label: f.label, value: shown });
  }
  return answers;
}
