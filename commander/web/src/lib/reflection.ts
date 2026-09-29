// Reflection status — "この版は実際に <env> に反映されたのか?" — derived purely from a
// task's feature phase + its latest run status. It answers requirement #2: in the 確認待ち
// zone (and elsewhere) the operator must tell at a glance whether a deploy is 反映済み /
// 反映中 / 反映失敗, instead of guessing from the lane after pushing 「stagingに反映して」.
//
// Kept pure + separately tested (like lanes.ts) so the board's reflection cue can't drift
// from the run/phase truth.
import type { BoardItem } from "./commanderApi.ts";

export type ReflectionState = "reflected" | "reflecting" | "failed";
export type ReflectionEnv = "demo" | "staging" | "prod";

/**
 * Dub の staging は単一の共有スロット（固定ホスト）。run 出力から staging URL を拾えなくても、
 * staging に反映済み＝この URL で必ず開ける。バッジ（phase 由来）が「stagingに反映済み」なのに
 * URL が demo に降格する不整合を防ぐためのフォールバック先。commander は自分の判断ループ用途なので
 * Dub 固定 staging ホストを既定にしてよい。
 */
export const DUB_STAGING_URL =
  "https://dub-fe2-app-shell-staging.developershub-site.workers.dev";

export interface Reflection {
  state: ReflectionState;
  env: ReflectionEnv;
  /** Click-through to confirm the reflected artifact (env-appropriate; null until captured). */
  url: string | null;
}

const ENV_LABEL: Record<ReflectionEnv, string> = {
  demo: "demo",
  staging: "staging",
  prod: "本番",
};

export const REFLECTION_ICON: Record<ReflectionState, string> = {
  reflected: "✅",
  reflecting: "🔄",
  failed: "⚠️",
};

export const REFLECTION_COLOR: Record<ReflectionState, string> = {
  reflected: "var(--dub-color-success-500, #30a46c)",
  reflecting: "var(--dub-color-info-500, #3b82f6)",
  failed: "var(--dub-color-danger-500, #e5484d)",
};

/** Map a run status to a reflection state (in-flight run = 反映中, failed = 反映失敗, else 反映済み). */
function fromRun(status: string | undefined): ReflectionState {
  if (status === "pending" || status === "running") return "reflecting";
  if (status === "failed") return "failed";
  return "reflected";
}

/**
 * Derive the reflection descriptor for one task, or null when nothing has been reflected
 * yet (freshly queued). The `env` is whichever environment the current phase targets:
 * demo while in the demo phases, staging once demo is approved, 本番 once staging is.
 */
export function reflectionOf(item: BoardItem): Reflection | null {
  const status = item.latestRun?.status;
  switch (item.featurePhase) {
    case "prod_shipped":
      // 本番反映: run in flight = 反映中, failed = 反映失敗, else = 反映済み.
      return { state: fromRun(status), env: "prod", url: item.prUrl ?? item.stagingUrl };
    case "staging_deployed":
      return { state: fromRun(status), env: "staging", url: item.stagingUrl ?? DUB_STAGING_URL };
    case "staging_review":
      // 確認待ち: the staging反映 run has succeeded (=反映済み). Defensive on running/failed.
      // staging_url 未取得でも固定 staging ホストで必ず開ける（バッジ=URL 一致）。
      return { state: fromRun(status), env: "staging", url: item.stagingUrl ?? DUB_STAGING_URL };
    case "staging_rejected":
      return { state: "failed", env: "staging", url: item.stagingUrl ?? DUB_STAGING_URL };
    case "demo_review":
      return { state: fromRun(status), env: "demo", url: item.demoUrl };
    case "demo_rejected":
      return { state: "failed", env: "demo", url: item.demoUrl };
    case "demo_building":
      if (!item.latestRun) return null; // queued — nothing reflected yet
      return { state: fromRun(status), env: "demo", url: item.demoUrl };
    default:
      return null;
  }
}

/** Short human label, e.g. 「stagingに反映済み」「本番に反映中」「staging反映失敗」. */
export function reflectionLabel(r: Reflection): string {
  const env = ENV_LABEL[r.env];
  if (r.state === "reflected") return `${env}に反映済み`;
  if (r.state === "reflecting") return `${env}に反映中`;
  return `${env}反映失敗`;
}
