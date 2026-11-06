// SiteConfigService — LP の公開設定（セクションの layout + 本番反映の release）。
// 下書きは lp_site_config.draft_json。本番の layout は published_json、本番の release は既存テーブル
// （lp_publish / lp_proposal_settings）と lp-tickets（別 D1・s2s）が正本で、ここでは組み立てるだけ。
import { errors } from "@dub/errors";
import { lp } from "@dub/types";
import type { AppDeps, ReqCtx, SiteConfigRow } from "./types";

export const SITE_CONFIG_SITE = lp.LP_PUBLISH_SITE;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseJson(raw: string | null | undefined): unknown {
  try {
    return JSON.parse(raw ?? "{}") as unknown;
  } catch {
    return {};
  }
}

/** 保存済みの下書き。未保存（"{}"）・壊れている部分は本番の値に倒す。 */
function readDraft(row: SiteConfigRow | null, published: lp.LpSiteConfig): lp.LpSiteConfig {
  const raw = parseJson(row?.draftJson);
  if (!isRecord(raw) || !isRecord(raw.layout)) return structuredClone(published);
  return {
    layout: lp.normalizeLayout(raw.layout),
    release: lp.validateRelease(raw.release).release ?? structuredClone(published.release),
  };
}

function parseRevision(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw errors.validationFailed([{ field: "revision", reason: "required" }]);
  }
  return v;
}

function parseWrite(body: unknown): lp.LpSiteConfigWriteRequest {
  const b = isRecord(body) ? body : {};
  const { config, issues } = lp.validateSiteConfig(b.config);
  const revisionOk = typeof b.revision === "number" && Number.isInteger(b.revision) && b.revision >= 0;
  const all = revisionOk ? issues : [...issues, { field: "revision", reason: "required" }];
  if (all.length > 0 || !config) throw errors.validationFailed(all);
  return { config, revision: b.revision as number };
}

const stale = () => errors.conflict("公開設定が他の操作で更新されています。最新の内容を読み込んでからやり直してください");

export class SiteConfigService {
  constructor(private readonly deps: AppDeps) {}

  private async publishedRelease(): Promise<lp.LpRelease> {
    const repo = this.deps.repo;
    const [pub, tickets, proposals] = await Promise.all([
      repo.getPublish(SITE_CONFIG_SITE),
      this.deps.ticketRelease.get(),
      repo.getProposalSettings(SITE_CONFIG_SITE),
    ]);
    return {
      versionId: pub?.versionId ?? lp.LP_DEFAULT_PUBLISHED_VERSION,
      ticketsEnabled: tickets.ticketsEnabled,
      ticketsCtaEnabled: tickets.ticketsCtaEnabled,
      proposalsEnabled: proposals?.enabled ?? false,
    };
  }

  /** No row yet → every section at its default + the release from the existing tables (never 404). */
  async getState(): Promise<lp.LpSiteConfigState> {
    const [row, release] = await Promise.all([this.deps.repo.getSiteConfig(SITE_CONFIG_SITE), this.publishedRelease()]);
    const published: lp.LpSiteConfig = { layout: lp.normalizeLayout(parseJson(row?.publishedJson)), release };
    return {
      site: SITE_CONFIG_SITE,
      draft: readDraft(row, published),
      published,
      revision: row?.revision ?? 0,
      draftUpdatedAt: row?.draftUpdatedAt ?? null,
      draftUpdatedBy: row?.draftUpdatedBy ?? null,
      publishedAt: row?.publishedAt ?? null,
      publishedBy: row?.publishedBy ?? null,
    };
  }

  /** LP Worker 用: layout だけ（release は既存の /lp/internal/publish ほかで読む）。1 行読むだけ。 */
  async getInternal(): Promise<lp.LpInternalSiteConfig> {
    const row = await this.deps.repo.getSiteConfig(SITE_CONFIG_SITE);
    const published = lp.normalizeLayout(parseJson(row?.publishedJson));
    const draft = parseJson(row?.draftJson);
    return { published, draft: isRecord(draft) && isRecord(draft.layout) ? lp.normalizeLayout(draft.layout) : published };
  }

  async saveDraft(ctx: ReqCtx, body: unknown): Promise<lp.LpSiteConfigState> {
    const { config, revision } = parseWrite(body);
    const ok = await this.deps.repo.saveSiteConfigDraft(SITE_CONFIG_SITE, JSON.stringify(config), revision, ctx.userId, this.deps.now());
    if (!ok) throw stale();
    return this.getState();
  }

  /** 下書きを今の本番の内容にする。revision を付けたときだけ照合する。 */
  async resetDraft(ctx: ReqCtx, body: unknown): Promise<lp.LpSiteConfigState> {
    const raw = isRecord(body) ? body.revision : undefined;
    const revision = raw === undefined || raw === null ? null : parseRevision(raw);
    const { published } = await this.getState();
    const ok = await this.deps.repo.saveSiteConfigDraft(SITE_CONFIG_SITE, JSON.stringify(published), revision, ctx.userId, this.deps.now());
    if (!ok) throw stale();
    return this.getState();
  }

  /**
   * 本番反映（app.ts で lp:publish を検査）。layout と release を D1 batch 1 回で書き、履歴を 1 行残す。
   * チケットの販売状態だけは別 D1 なので同じトランザクションに入らない。revision を確かめた batch の
   * 成功後に書く: 先に書くと、競合で 409 になった古い操作が販売状態だけ変えてしまう。lp-tickets への
   * 書き込みが失敗すると 5xx を返し、販売状態は元のまま残る。getState は lp-tickets の実際の値を返すので、
   * 読み直して再度本番反映すれば揃う。
   */
  async publish(ctx: ReqCtx, body: unknown): Promise<lp.LpSiteConfigState> {
    const { config, revision } = parseWrite(body);
    const ok = await this.deps.repo.publishSiteConfig({
      site: SITE_CONFIG_SITE,
      expectedRevision: revision,
      layoutJson: JSON.stringify(config.layout),
      configJson: JSON.stringify(config),
      release: config.release,
      historyId: this.deps.newSiteConfigHistoryId(),
      updatedBy: ctx.userId,
      updatedAt: this.deps.now(),
    });
    if (!ok) throw stale();
    const { ticketsEnabled, ticketsCtaEnabled } = config.release;
    await this.deps.ticketRelease.set({ ticketsEnabled, ticketsCtaEnabled }, ctx.userId);
    return this.getState();
  }

}
