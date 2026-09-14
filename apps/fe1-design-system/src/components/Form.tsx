import { cloneElement, isValidElement, useRef } from "react";
import type { ReactElement } from "react";
import type { FormFieldProps, FormProps } from "../types";
import styles from "./Form.module.css";
import { cx } from "../utils/cx";

// a11y: 送信失敗時にフォーカスした欄を画面内へ確実にスクロールする。ブラウザの
// focus() 標準スクロールは「技術的にビューポート内(rect.top >= 0 等)」なら
// スキップすることがあり、sticky/fixed なヘッダーの裏に隠れていても動かない
// ケースがある(縦に長いフォームの下の方で発生・ユーザー指摘)。そのため常に
// 明示的に scrollIntoView する。
function scrollFieldIntoView(target: HTMLElement) {
  if (typeof window === "undefined" || typeof target.scrollIntoView !== "function") return;
  const reduceMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const behavior: ScrollBehavior = reduceMotion ? "auto" : "smooth";
  target.scrollIntoView({ behavior, block: "center", inline: "nearest" });

  // block: "center" は基本的に sticky ヘッダーの裏に隠れないが、フォーム先頭
  // 付近などページを上にスクロールする余地が無いケースでは欄が画面上端に寄り、
  // ビューポート上端に張り付いた sticky/fixed 要素(ヘッダー等)の裏に隠れうる。
  // そうした要素をビューポート上端の探査点から検出し、その高さぶん追加で
  // スクロールして確実に見える位置まで押し下げる。
  requestAnimationFrame(() => {
    if (typeof document.elementsFromPoint !== "function") return;
    const rect = target.getBoundingClientRect();
    const probeX = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1);
    const stickyBottom = document.elementsFromPoint(probeX, 1).reduce((max, el) => {
      if (!(el instanceof HTMLElement) || el.contains(target)) return max;
      const position = getComputedStyle(el).position;
      if (position !== "fixed" && position !== "sticky") return max;
      const elRect = el.getBoundingClientRect();
      return elRect.top <= 0 ? Math.max(max, elRect.bottom) : max;
    }, 0);
    if (rect.top < stickyBottom) {
      window.scrollBy({ top: rect.top - stickyBottom - 8, behavior });
    }
  });
}

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
          if (!firstInvalid) return;
          // scrollFieldIntoView 側で確実にスクロールするため、focus 自身の
          // (不完全な)自動スクロールは起こさせない。
          firstInvalid.focus({ preventScroll: true });
          scrollFieldIntoView(firstInvalid);
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
