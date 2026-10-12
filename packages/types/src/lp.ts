// lp — LP管理 (lp-analytics) shared constants + the 公開版切り替え wire type.
// The public LP Worker (lp-conference-next), lp-analytics and fe2 all read these, so the
// list of switchable versions has exactly one definition.

/** The public conference site whose live LP version is switchable from LP管理. */
export const LP_PUBLISH_SITE = "hokuriku-it-conf.com";

/** Versions that can be published (newest first). Must match apps/lp-conference-next/versions.json
 *  (v2.1 is not bundled: its deployed build came from an uncommitted tree). */
export const LP_PUBLISHABLE_VERSION_IDS = ["v3.4", "v3.3", "v3.2", "v3.1", "v3.0", "v2.0"] as const;

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
