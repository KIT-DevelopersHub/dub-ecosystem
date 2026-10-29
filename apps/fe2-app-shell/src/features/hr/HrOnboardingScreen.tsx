// 人事 → オンボーディング。参加が確定した新メンバーごとに、参加届アプリの「オンボーディング案内」
// の項目をチェックリストとして並べる (項目の編集は 参加届 → オンボーディング で行う＝重複させない)。
// チェックは楽観的 UI。全部チェックで「完了」。
import { Badge, Card, Checkbox, EmptyState, ErrorState, SkeletonLoader } from "@dub/ui";
import { useHrOnboarding, useSetOnboardingCheck } from "./hrHooks.ts";
import { HrFrame } from "./HrPipelineScreen.tsx";
import { formatDateTime, useHrCapability } from "./HrShared.tsx";
import styles from "./hr.module.css";

export function HrOnboardingScreen(): JSX.Element {
  const ob = useHrOnboarding();
  const { canWrite } = useHrCapability();
  const setCheck = useSetOnboardingCheck();

  let body: JSX.Element;
  if (ob.isLoading) {
    body = (
      <div className={styles.obGrid} data-testid="fe2-hr-onboarding-loading">
        {[0, 1, 2].map((i) => (
          <Card key={i}>
            <SkeletonLoader lines={5} />
          </Card>
        ))}
      </div>
    );
  } else if (ob.isError || !ob.data) {
    body = (
      <ErrorState
        testId="fe2-hr-onboarding-error"
        error={{ code: "INTERNAL", message: "オンボーディングを読み込めませんでした。" }}
        onRetry={() => void ob.refetch()}
      />
    );
  } else if (ob.data.members.length === 0) {
    body = (
      <EmptyState
        testId="fe2-hr-onboarding-empty"
        icon="check-square"
        title="オンボーディング中の新メンバーはいません"
        description="パイプラインで「参加を確定する」と、ここにチェックリストが出ます。"
      />
    );
  } else {
    const { items, members } = ob.data;
    body = (
      <>
        <span className={styles.note}>
          項目は 参加届 → オンボーディング の案内項目です（{items.length} 件）。項目の追加・並び替えはそちらで行います。
        </span>
        <div className={styles.obGrid}>
          {members.map((m) => (
            <Card
              key={m.memberId}
              testId={`fe2-hr-ob-${m.memberId}`}
              header={
                <div className={styles.obHeader}>
                  <span className={styles.cardName}>{m.name}</span>
                  {m.completed ? (
                    <Badge tone="success" testId={`fe2-hr-ob-${m.memberId}-done`}>
                      完了
                    </Badge>
                  ) : (
                    <Badge tone="info">
                      {m.done} / {m.total}
                    </Badge>
                  )}
                </div>
              }
            >
              <div className={styles.obItems}>
                <div className={styles.progress} aria-hidden>
                  <div className={styles.progressBar} style={{ width: `${m.total ? (m.done / m.total) * 100 : 0}%` }} />
                </div>
                {m.joinedAt ? <span className={styles.historyWhen}>参加確定 {formatDateTime(m.joinedAt)}</span> : null}
                {items.map((it) => (
                  <Checkbox
                    key={it.id}
                    id={`ob-${m.memberId}-${it.id}`}
                    testId={`fe2-hr-ob-${m.memberId}-${it.id}`}
                    checked={m.checkedItemIds.includes(it.id)}
                    disabled={!canWrite}
                    label={it.title}
                    onChange={(checked) => setCheck.mutate({ memberId: m.memberId, itemId: it.id, checked })}
                  />
                ))}
              </div>
            </Card>
          ))}
        </div>
      </>
    );
  }

  return <HrFrame active="onboarding">{body}</HrFrame>;
}
