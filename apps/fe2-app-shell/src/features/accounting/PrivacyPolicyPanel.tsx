// 会計: 公式サイト（hokuriku-it-conf.com/privacy）のプライバシーポリシー本文。保存すると LP Worker が 1 分以内に読み直して出す。
import { useState, type FormEvent } from "react";
import { Badge, Button, ErrorState, FormField, SkeletonCard, Textarea } from "@dub/ui";
import { lpMarkdown, privacyPolicy, type accounting } from "@dub/types";
import { useAuth } from "../../auth/AuthProvider.tsx";
import { usePrivacyPolicy, useSavePrivacyPolicy } from "./accountingHooks.ts";
import styles from "./accounting.module.css";

const LP_PUBLIC_URL: string = (
  (import.meta.env.VITE_LP_PUBLIC_URL as string | undefined) || "https://hokuriku-it-conf.com"
).replace(/\/+$/, "");
export const PRIVACY_PAGE_URL = `${LP_PUBLIC_URL}/privacy`;

const formatDateTime = (iso: string): string => {
  const t = Date.parse(iso);
  return Number.isNaN(t)
    ? ""
    : new Date(t).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

export function PrivacyPolicyPanel({ canEdit }: { canEdit: boolean }): JSX.Element {
  const q = usePrivacyPolicy();
  if (q.isPending) {
    return (
      <div className={styles.form} data-testid="fe2-accounting-privacy-skeleton">
        <SkeletonCard lines={8} />
        <SkeletonCard lines={3} />
      </div>
    );
  }
  if (q.isError) {
    return (
      <ErrorState
        testId="fe2-accounting-privacy-error"
        error={{ code: "INTERNAL", message: "プライバシーポリシーを読み込めませんでした。" }}
        onRetry={() => void q.refetch()}
      />
    );
  }
  return <PolicyEditor data={q.data} canEdit={canEdit} />;
}

function PolicyEditor({ data, canEdit }: { data: accounting.GetPrivacyPolicyResponse; canEdit: boolean }): JSX.Element {
  const auth = useAuth();
  const me = auth.status === "authenticated" ? auth.me.user.displayName : null;
  const saved = data.policy?.body ?? privacyPolicy.DEFAULT_PRIVACY_POLICY;
  // 失敗してロールバックしても入力は消さない（サーバの値で上書きしない）。
  const [body, setBody] = useState(saved);
  const [submitted, setSubmitted] = useState(false);
  const save = useSavePrivacyPolicy(me);
  const parsed = privacyPolicy.parsePrivacyPolicyBody(body);
  const error = submitted && !parsed.ok ? privacyPolicy.privacyPolicyErrorMessage(parsed.reason) : undefined;
  const dirty = data.policy === null || body !== saved;
  const html = lpMarkdown.renderLpMarkdown(body, { max: privacyPolicy.PRIVACY_POLICY_MAX });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (!parsed.ok || !canEdit) return;
    setBody(parsed.value);
    save.mutate({ body: parsed.value, expectedVersion: data.policy?.version ?? 0 });
  };

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate data-testid="fe2-accounting-privacy-form">
      {!canEdit && (
        <p className={styles.note} data-testid="fe2-accounting-privacy-readonly">
          閲覧のみの権限です。変更するには会計アプリの「編集」権限が必要です。
        </p>
      )}
      <section className={styles.card} aria-label="プライバシーポリシー">
        <div className={styles.cardHead}>
          <h2 className={styles.sectionTitle}>公式サイトのプライバシーポリシー</h2>
          {data.policy ? <Badge tone="success">公開中</Badge> : <Badge tone="warning">初期文案を表示中</Badge>}
        </div>
        <p className={styles.note}>
          <a className={styles.link} href={PRIVACY_PAGE_URL} target="_blank" rel="noopener noreferrer" data-testid="fe2-accounting-privacy-link">
            {PRIVACY_PAGE_URL.replace(/^https?:\/\//, "")}
          </a>
          {" "}に表示されます（公式サイトのフッターからリンク）。保存すると 1 分ほどで反映されます。
        </p>
        {data.policy === null && (
          <p className={styles.note} data-testid="fe2-accounting-privacy-unset">
            まだ保存されていません。公式サイトには下の初期文案がそのまま出ています。内容を確かめて保存してください。
          </p>
        )}
        <FormField
          label="本文（Markdown）"
          htmlFor="fe2-accounting-privacy-body"
          error={error}
          help="「## 見出し」「- 箇条書き」「**太字**」「[文字](https://…)」が使えます。HTML は文字のまま出ます。"
        >
          <div className={styles.mdEditor}>
            <Textarea
              id="fe2-accounting-privacy-body"
              testId="fe2-accounting-privacy-body"
              value={body}
              rows={18}
              invalid={error !== undefined}
              disabled={!canEdit}
              onChange={setBody}
            />
            <section className={styles.mdPreviewPane} aria-label="プレビュー" data-testid="fe2-accounting-privacy-preview">
              <span className={styles.mdPreviewLabel}>プレビュー（公式サイトでの見え方）</span>
              {/* renderLpMarkdown は入力を全部エスケープし、決まったタグと http(s) の URL だけを出す（packages/types/test/lp-markdown.test.ts）。 */}
              <div className={styles.md} dangerouslySetInnerHTML={{ __html: html }} />
            </section>
          </div>
        </FormField>
        <div className={styles.actions}>
          {dirty && data.policy !== null && <span className={styles.note} data-testid="fe2-accounting-privacy-dirty">保存していない変更があります</span>}
          <Button
            type="button"
            variant="secondary"
            disabled={!canEdit || body === privacyPolicy.DEFAULT_PRIVACY_POLICY}
            onClick={() => setBody(privacyPolicy.DEFAULT_PRIVACY_POLICY)}
            testId="fe2-accounting-privacy-reset"
          >
            初期文案を入れる
          </Button>
          <Button type="submit" variant="primary" disabled={!canEdit || !dirty} testId="fe2-accounting-privacy-save">
            保存して公開
          </Button>
        </div>
      </section>

      <section className={styles.card} aria-label="変更履歴" data-testid="fe2-accounting-privacy-history">
        <h2 className={styles.sectionTitle}>変更履歴</h2>
        {data.history.length === 0 ? (
          <p className={styles.note}>まだ変更はありません。</p>
        ) : (
          <ol className={styles.history}>
            {data.history.map((h) => (
              <li key={h.version} className={styles.historyRow} data-testid={`fe2-accounting-privacy-rev-${h.version}`}>
                <span className={styles.historyVersion}>第 {h.version} 版</span>
                <span>{formatDateTime(h.updatedAt)}</span>
                <span className={styles.note}>{h.updatedByName ?? "（名前の無いユーザー）"}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </form>
  );
}
