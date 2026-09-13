import { cloneElement, isValidElement, useRef } from "react";
import type { ReactElement } from "react";
import type { FormFieldProps, FormProps } from "../types";
import styles from "./Form.module.css";
import { cx } from "../utils/cx";

export function Form({ onSubmit, testId, children }: FormProps) {
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form
      ref={formRef}
      className={cx(styles.form)}
      data-testid={testId}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
        // a11y: 送信失敗時は最初のエラー欄へフォーカス移動する。onSubmit() は
        // 同期的にバリデーションして FormField の aria-invalid を更新する想定
        // (このリポジトリの各フォームの流儀)。React の再描画後に見つけられる
        // よう rAF で1フレーム待ってから探す。非同期エラー(送信後にAPIが返す
        // トップレベルの failure banner 等)はこの限りではなく各画面側で対応する。
        requestAnimationFrame(() => {
          const firstInvalid = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
          firstInvalid?.focus();
        });
      }}
    >
      {children}
    </form>
  );
}

/**
 * Wraps a single control, wiring label/error/help to it a11y-wise: on error it
 * injects `aria-invalid` and appends the error id to the child's
 * `aria-describedby` (test matrix: error 時に aria-invalid / aria-describedby 連結).
 */
export function FormField({
  label,
  htmlFor,
  required,
  error,
  help,
  testId,
  children,
}: FormFieldProps) {
  const errorId = error ? `${htmlFor}-error` : undefined;
  const helpId = help ? `${htmlFor}-help` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(" ") || undefined;

  let control = children;
  if (isValidElement(children)) {
    const child = children as ReactElement<Record<string, unknown>>;
    const existing = child.props["aria-describedby"] as string | undefined;
    control = cloneElement(child, {
      "aria-describedby": [existing, describedBy].filter(Boolean).join(" ") || undefined,
      "aria-invalid": error ? true : (child.props["aria-invalid"] as boolean | undefined),
      invalid: error ? true : (child.props["invalid"] as boolean | undefined),
    });
  }

  return (
    <div className={cx(styles.field)} data-testid={testId} data-invalid={error ? true : undefined}>
      <label className={cx(styles.label)} htmlFor={htmlFor}>
        {label}
        {required && (
          <span className={cx(styles.required)} aria-hidden="true">
            {" *"}
          </span>
        )}
      </label>
      {control}
      {help && !error && (
        <p id={helpId} className={cx(styles.help)}>
          {help}
        </p>
      )}
      {error && (
        <p id={errorId} className={cx(styles.error)} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
