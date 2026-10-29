// 人事 → オンボーディング。参加が確定した新メンバーごとに、参加届アプリの「オンボーディング案内」
// の項目をチェックリストとして並べる (項目の編集は 参加届 → オンボーディング で行う＝重複させない)。
// チェックは楽観的 UI (押した値を即座に重ねるので一瞬外れて見えることはない)。チェックを付けると
// ステータスが 採用 → オンボーディング調整、全部で → オンボーディング完了 に自動で進む。
import { Card, Checkbox, EmptyState, ErrorState, SkeletonLoader } from "@dub/ui";
import { useHrOnboarding, useSetOnboardingCheck } from "./hrHooks.ts";
import { HrFrame } from "./HrApplicantsScreen.tsx";
import { StageBadge, usePendingOverlay, useHrCapability } from "./HrShared.tsx";
import styles from "./hr.module.css";

export function HrOnboardingScreen(): JSX.Element {
  const ob = useHrOnboarding();
  const { canWrite } = useHrCapability();
  const setCheck = useSetOnboardingCheck();
  const overlay = usePendingOverlay<boolean>();

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
        description="応募者の一覧でステータスを「採用」にすると、ここにチェックリストが出ます。"
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
          {members.map((m) => {
            const isChecked = (itemId: string) => overlay.get(`${m.memberId}|${itemId}`) ?? m.checkedItemIds.includes(itemId);
            const done = items.filter((it) => isChecked(it.id)).length;
            const total = items.length;
            const completed = total > 0 && done === total;
            const pct = total ? Math.round((done / total) * 100) : 0;
            return (
              <Card
                key={m.memberId}
                testId={`fe2-hr-ob-${m.memberId}`}
                header={
                  <div className={styles.obHeader}>
                    <span className={styles.cardName}>{m.name}</span>
                    {m.stage ? <StageBadge stage={completed ? "onboarded" : m.stage} /> : null}
                  </div>
                }
              >
                <div className={styles.obItems}>
                  <div className={styles.obHeader}>
                    <span className={styles.note} data-testid={`fe2-hr-ob-${m.memberId}-count`}>
                      {done} / {total} 完了
                    </span>
                    {completed ? (
                      <span className={styles.note} data-testid={`fe2-hr-ob-${m.memberId}-done`}>
                        すべて完了
                      </span>
                    ) : null}
                  </div>
                  <div
                    className={styles.progress}
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={pct}
                    data-testid={`fe2-hr-ob-${m.memberId}-progress`}
                  >
                    <div className={`${styles.progressBar} ${completed ? styles.progressBarDone : ""}`} style={{ width: `${pct}%` }} />
                  </div>
                  {items.map((it) => {
                    const key = `${m.memberId}|${it.id}`;
                    return (
                      <Checkbox
                        key={it.id}
                        id={`ob-${m.memberId}-${it.id}`}
                        testId={`fe2-hr-ob-${m.memberId}-${it.id}`}
                        checked={isChecked(it.id)}
                        disabled={!canWrite}
                        label={it.title}
                        onChange={(checked) => {
                          overlay.set(key, checked);
                          setCheck.mutate(
                            { memberId: m.memberId, itemId: it.id, checked },
                            { onSettled: () => overlay.clear(key) },
                          );
                        }}
                      />
                    );
                  })}
                </div>
              </Card>
            );
          })}
        </div>
      </>
    );
  }

  return <HrFrame active="onboarding">{body}</HrFrame>;
}
