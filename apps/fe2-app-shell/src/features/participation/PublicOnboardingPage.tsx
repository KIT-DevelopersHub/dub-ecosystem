// オンボーディング案内の PUBLIC ページ (/onboarding)。新しく入った人はまだアプリの
// アカウントを持っていないので、/participate と同じくシェルの外 (RequireAuth の外) に置き、
// 管理タブで並べた項目を番号付きで表示するだけの読み取り専用ページにする。
import { EmptyState, ErrorState, SkeletonList } from "@dub/ui";
import type { ApiClient } from "../../lib/api-client.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { ParticipationProvider } from "./ParticipationProvider.tsx";
import { usePublicOnboardingItems } from "./hooks.ts";
import styles from "./participation.module.css";

export function PublicOnboardingPage({ api }: { api: ApiClient }): JSX.Element {
  return (
    <ParticipationProvider api={api}>
      <div className={styles.publicPage} data-testid="onboarding-public-page">
        <div className={styles.publicInner}>
          <header className={styles.publicHeader}>
            <h1 className={styles.publicTitle}>はじめにやること</h1>
            <p className={styles.publicLead}>
              運営メンバーへようこそ。参加にあたって、次の項目を上から順に進めてください。
            </p>
          </header>
          <OnboardingSteps />
        </div>
      </div>
    </ParticipationProvider>
  );
}

function OnboardingSteps(): JSX.Element {
  const list = usePublicOnboardingItems();
  if (list.isLoading) return <SkeletonList rows={3} testId="onboarding-public-loading" />;
  if (list.isError) {
    const display = ApiError.isApiError(list.error)
      ? toDisplayableError(list.error)
      : { code: "UNKNOWN", message: "読み込みに失敗しました", retryable: true };
    return <ErrorState error={display} onRetry={() => void list.refetch()} />;
  }
  const items = list.data?.items ?? [];
  if (items.length === 0) {
    return (
      <EmptyState
        title="いまは案内する項目がありません"
        description="運営から連絡があるまでお待ちください"
        icon="check-square"
        testId="onboarding-public-empty"
      />
    );
  }
  return (
    <ol className={styles.publicSteps} data-testid="onboarding-public-steps">
      {items.map((item, i) => (
        <li key={item.id} className={styles.publicStep} data-testid={`onboarding-public-step-${item.id}`}>
          <span className={styles.stepNumber} aria-hidden>
            {i + 1}
          </span>
          <div className={styles.onboardingBody}>
            <h2 className={styles.publicStepTitle}>{item.title}</h2>
            {item.description ? <p className={styles.onboardingDescription}>{item.description}</p> : null}
            {item.url ? (
              <a className={styles.publicStepLink} href={item.url} target="_blank" rel="noreferrer noopener">
                {linkLabel(item.url)}
              </a>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** リンクの表示名: 「<ホスト名> を開く」（URL 全体は長くて読めないため）。 */
function linkLabel(url: string): string {
  try {
    return `${new URL(url).hostname} を開く`;
  } catch {
    return "開く";
  }
}
