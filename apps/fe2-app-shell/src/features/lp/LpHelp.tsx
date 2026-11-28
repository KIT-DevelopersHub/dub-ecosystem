// 画面に常時出すほどではない補足を「i」ボタンの中に畳む（#905: 説明文を減らして一覧性を上げる）。
import type { ReactNode } from "react";
import { Icon, Popover } from "@dub/ui";
import styles from "./lpHelp.module.css";

export function LpHelp({ label, testId, children }: { label: string; testId: string; children: ReactNode }): JSX.Element {
  return (
    <Popover testId={testId} placement="bottom" trigger={<Icon name="info" aria-label={label} />}>
      <div className={styles.panel} data-testid={`${testId}-body`}>
        {children}
      </div>
    </Popover>
  );
}

/** カード見出し + 補足の「i」。 */
export function LpTitleWithHelp({ title, titleClassName, help }: { title: string; titleClassName?: string; help: ReactNode }): JSX.Element {
  return (
    <span className={styles.titleRow}>
      <span className={titleClassName}>{title}</span>
      {help}
    </span>
  );
}
