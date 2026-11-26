// 右側の AI パネル (Dia のチャットのように画面の横に常にいる AI)。データは注入のみ:
// 今見ている画面の文脈・本文 (children)・送信関数を呼び出し側が渡す。送信関数を差し替えれば
// どの AI API にもつなげられる。AI が使えない間は入力欄を無効にして公開予定を案内する。
// 広い画面では本文の右に並び (呼び出し側が AppShell の aside に置く)、狭い画面では全画面のシート。
import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button, Icon, IconButton, Skeleton, Textarea } from "@dub/ui";
import styles from "./AiSidePanel.module.css";

/** パネル上部に出す「今見ているもの」。title が null なら label だけを出す。 */
export interface AiPanelContext {
  /** 種類の見出し (例: 「イベント」「アプリ」)。 */
  label: string;
  /** 対象の名前 (例: イベント名)。読み込み中は loading を true に。 */
  title: string | null;
  loading?: boolean;
}

/** 質問を送る関数。AI が ON になった時に呼び出し側が API につないで渡す。 */
export type AiChatSend = (question: string) => Promise<void> | void;

export interface AiSidePanelProps {
  onClose: () => void;
  context: AiPanelContext | null;
  /** 文脈に応じた中身 (例: イベントの「AI のまとめ」)。 */
  children?: ReactNode;
  /** AI チャットが使えるか。false の間は入力欄を無効にして unavailableMessage を出す。 */
  chatAvailable: boolean;
  unavailableMessage: string;
  /** chatAvailable かつこれがある時だけ送信できる。 */
  onSend?: AiChatSend;
  sending?: boolean;
  /** 入力欄の例文 (使える時だけ表示)。 */
  placeholder?: string;
  testId?: string;
}

export function AiSidePanel({
  onClose,
  context,
  children,
  chatAvailable,
  unavailableMessage,
  onSend,
  sending = false,
  placeholder = "この画面について質問する",
  testId = "ai-side-panel",
}: AiSidePanelProps): JSX.Element {
  const [question, setQuestion] = useState("");
  const inputId = useId();
  const titleId = useId();
  const canSend = chatAvailable && onSend !== undefined;
  const trimmed = question.trim();

  const submit = (): void => {
    if (!canSend || trimmed === "" || sending) return;
    void Promise.resolve(onSend(trimmed)).then(() => setQuestion(""));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <aside className={styles.panel} aria-labelledby={titleId} data-testid={testId} onKeyDown={onKeyDown}>
      <header className={styles.header}>
        <span className={styles.mark} aria-hidden="true">
          <Icon name="sparkles" />
        </span>
        <h2 id={titleId} className={styles.title}>
          AI アシスタント
        </h2>
        <IconButton name="x" aria-label="AI パネルを閉じる" onClick={onClose} testId={`${testId}-close`} />
      </header>

      <div className={styles.body}>
        {context ? (
          <div className={styles.context} data-testid={`${testId}-context`}>
            <span className={styles.contextLabel}>{context.label}</span>
            {context.loading ? (
              <Skeleton width="60%" height={18} testId={`${testId}-context-skeleton`} />
            ) : context.title ? (
              <span className={styles.contextTitle}>{context.title}</span>
            ) : null}
          </div>
        ) : null}
        {children}
      </div>

      <form
        className={styles.composer}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {!chatAvailable ? (
          <div className={styles.notice} role="status" data-testid={`${testId}-unavailable`}>
            <Icon name="clock" />
            <span>{unavailableMessage}</span>
          </div>
        ) : null}
        <label className={styles.srOnly} htmlFor={inputId}>
          AI に質問する
        </label>
        <div className={styles.inputRow}>
          <div className={styles.input}>
            <Textarea
              id={inputId}
              value={question}
              onChange={setQuestion}
              rows={1}
              autoGrow
              placeholder={chatAvailable ? placeholder : "AI に質問する"}
              disabled={!canSend || sending}
              testId={`${testId}-input`}
            />
          </div>
          <Button
            type="submit"
            variant="primary"
            iconLeft={<Icon name="send" />}
            disabled={!canSend || trimmed === ""}
            loading={sending}
            testId={`${testId}-send`}
          >
            送信
          </Button>
        </div>
      </form>
    </aside>
  );
}
