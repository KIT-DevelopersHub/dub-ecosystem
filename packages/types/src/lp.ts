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
    visible: def.hideable ? (s?.visible ?? true) : true,
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
      visible: def.hideable && typeof v.visible === "boolean" ? v.visible : true,
      options,
    };
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
    let visible = true;
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
