// ログイン不要の公開ページ (/onboarding, /participate) の URL を見せ、コピー / 開く を置く
// カード。運営がその URL を新メンバーへ送るための導線で、オンボーディングと回答一覧が使う。
import { Button, Card, Icon, useToast } from "@dub/ui";
import styles from "./participation.module.css";

export function PublicUrlCard({
  title,
  hint,
  path,
  testId,
}: {
  title: string;
  hint: string;
  /** シェル外の公開ルート (例 "/onboarding")。今開いているオリジン基準で完全 URL にする。 */
  path: string;
  testId: string;
}): JSX.Element {
  const toast = useToast();
  const url = `${window.location.origin}${path}`;
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url);
      toast.show({ kind: "success", title: "URL をコピーしました" });
    } catch {
      toast.show({ kind: "error", title: "コピーできませんでした。URL を選択してコピーしてください" });
    }
  };
  return (
    <Card header={title} testId={testId}>
      <p className={styles.sectionHint}>{hint}</p>
      <div className={styles.shareRow}>
        <code className={styles.shareUrl} data-testid={`${testId}-url`}>
          {url}
        </code>
        <div className={styles.shareActions}>
          <Button size="sm" variant="secondary" onClick={() => void copy()} testId={`${testId}-copy`}>
            URL をコピー
          </Button>
          <a className={styles.shareOpen} href={path} target="_blank" rel="noreferrer" data-testid={`${testId}-open`}>
            ページを開く
            <Icon name="external-link" />
          </a>
        </div>
      </div>
    </Card>
  );
}
