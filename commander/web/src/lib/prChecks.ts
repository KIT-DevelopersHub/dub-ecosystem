// PR CI badge + 「確認」 — wire types (mirror services/commander-service/src/github.ts) and the
// pure view logic, kept here so the component stays thin and this stays unit-tested.
import type { Result } from "./commanderApi.ts";

export type CheckState = "pass" | "fail" | "pending" | "skipped";

export interface PrCheck {
  name: string;
  state: CheckState;
  url: string | null;
  required: boolean | null;
  /** prod-gate's confirm-gate (red until 確認した; not counted as CI). */
  labelGate: boolean;
}

export interface PrChecksSummary {
  state: "pass" | "fail" | "pending" | "none";
  passed: number;
  total: number;
  pending: number;
  failing: string[];
  requiredNotPassing: string[];
}

export interface PrChecks {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  headSha: string;
  mergeStateStatus: string | null;
  labels: string[];
  confirmed: boolean;
  staging: { stagingへ: boolean; staging2へ: boolean };
  checks: PrCheck[];
  summary: PrChecksSummary;
  viewerPermission: string | null;
  viewerLogin: string | null;
}

export interface ConfirmEligibility {
  allowed: boolean;
  reason: string | null;
  warnings: string[];
}

export interface PrChecksView {
  pr: PrChecks;
  confirm: ConfirmEligibility;
}

export interface PrRef {
  repo: string;
  number: number;
}

export interface PrChecksApi {
  getChecks(ref: PrRef, opts?: { fresh?: boolean }): Promise<Result<PrChecksView>>;
  /** Adds 確認した. `headSha` = the commit the operator looked at (refused if it moved). */
  confirm(ref: PrRef, headSha: string): Promise<Result<PrChecksView & { result: "labeled" | "already_confirmed" }>>;
}

const PR_URL_RE = /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/i;

export function parsePrRef(url: string | null | undefined): PrRef | null {
  const m = url ? PR_URL_RE.exec(url) : null;
  return m ? { repo: m[1]!, number: Number(m[2]) } : null;
}

export type BadgeTone = "success" | "danger" | "neutral" | "warning";

/** Compact badge text: 「5/5」 / 「3/5 · 2件失敗」 / 「実行中 2/5」 / 「CIなし」. */
export function badgeOf(s: PrChecksSummary): { tone: BadgeTone; text: string } {
  switch (s.state) {
    case "pass":
      return { tone: "success", text: `✓ ${s.passed}/${s.total}` };
    case "fail":
      return { tone: "danger", text: `✕ ${s.passed}/${s.total} · ${s.failing.length}件失敗` };
    case "pending":
      return { tone: "neutral", text: `実行中 ${s.passed}/${s.total}` };
    default:
      return { tone: "neutral", text: "CIなし" };
  }
}

const BLOCKER_TEXT: Record<string, string> = {
  confirm_disabled: "確認ボタンは無効です（GitHub トークン / COMMANDER_PR_CONFIRM_ENABLED）",
  pr_merged: "マージ済みの PR です",
  pr_closed: "クローズ済みの PR です",
  pr_draft: "Draft の PR です",
  already_confirmed: "確認済みです",
  token_insufficient: "GitHub トークンにラベル付与の権限がありません",
  checks_not_green: "必須の CI が通過していません",
  head_moved: "確認後に新しい commit が push されました。更新して確かめ直してください",
  github_not_configured: "GitHub トークンが設定されていません",
  github_unavailable: "GitHub に接続できません",
  github_unauthorized: "GitHub トークンが無効です",
  github_forbidden: "GitHub トークンに権限がありません",
  pr_not_found: "PR が見つかりません",
  repo_not_allowed: "このリポジトリの PR は扱えません",
};

export function blockerText(code: string | null | undefined): string {
  if (!code) return "";
  return BLOCKER_TEXT[code] ?? `確認できません (${code})`;
}

export const CHECK_ICON: Record<CheckState, string> = { pass: "✓", fail: "✕", pending: "●", skipped: "–" };
export const CHECK_LABEL: Record<CheckState, string> = { pass: "通過", fail: "失敗", pending: "実行中", skipped: "スキップ" };
