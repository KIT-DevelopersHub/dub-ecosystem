"use client";

// お知らせの「ダイアログで詳細を表示」。項目は LP Worker が差し込む（worker/lp-content.ts）ので、
// ここはクリックを document で拾い（差し込まれた後の要素にも効く）、<template data-news-body> の中身を複製して出すだけ。
// 中身は Worker 側で renderLpMarkdown が作った安全な HTML（入力は全部エスケープ・決まったタグだけ）。
// native <dialog> + showModal(): 背面は inert・Esc で閉じる。Tab は中で回す・背景クリックで閉じる・閉じたら押したボタンへ戻す。
// 見た目は Program のダイアログ（.prog-dialog）にそろえる。長い本文はダイアログの中だけでスクロールする。
import { useCallback, useEffect, useRef, useState } from "react";

type Active = { id: string; title: string; date: string; dateTime: string };

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function NewsDialog() {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const [active, setActive] = useState<Active | null>(null);

  const close = useCallback(() => setActive(null), []);

  // 差し込まれたお知らせの「詳細を開く」ボタン
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const btn = (e.target as Element | null)?.closest?.<HTMLElement>("[data-news-open]");
      if (!btn) return;
      const id = btn.dataset.newsOpen ?? "";
      const tpl = Array.from(document.querySelectorAll<HTMLTemplateElement>("template[data-news-body]")).find(
        (t) => t.dataset.newsBody === id,
      );
      if (!tpl) return;
      e.preventDefault();
      const time = btn.closest(".lp-news-item")?.querySelector("time");
      openerRef.current = btn;
      setActive({ id, title: btn.textContent ?? "", date: time?.textContent ?? "", dateTime: time?.getAttribute("datetime") ?? "" });
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (active) {
      const tpl = Array.from(document.querySelectorAll<HTMLTemplateElement>("template[data-news-body]")).find(
        (t) => t.dataset.newsBody === active.id,
      );
      bodyRef.current?.replaceChildren(tpl ? tpl.content.cloneNode(true) : document.createTextNode(""));
      if (bodyRef.current) bodyRef.current.scrollTop = 0;
      if (!d.open) d.showModal();
    } else if (d.open) {
      d.close();
    }
    if (!active) {
      bodyRef.current?.replaceChildren();
      openerRef.current?.focus();
      openerRef.current = null;
    }
    // Program と同じ: カスタムカーソルを隠し、Lenis（なめらかスクロール）を止めて背面を動かさない。
    document.body.classList.toggle("has-open-dialog", !!active);
    window.dispatchEvent(new CustomEvent("lp:dialog", { detail: { open: !!active } }));
  }, [active]);

  useEffect(
    () => () => {
      document.body.classList.remove("has-open-dialog");
      window.dispatchEvent(new CustomEvent("lp:dialog", { detail: { open: false } }));
    },
    [],
  );

  // Tab / Shift+Tab をダイアログの中で回す（showModal の inert に加えて、ブラウザの枠へ抜けないように）。
  const onKeyDown = (e: React.KeyboardEvent<HTMLDialogElement>) => {
    if (e.key !== "Tab" || !dialogRef.current) return;
    const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="prog-dialog lp-news-dialog"
      aria-labelledby="lp-news-dialog-title"
      onClose={close}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        // 背景（カードの外）を押したら閉じる
        if (e.target === dialogRef.current) close();
      }}
    >
      <div className="lp-news-dialog-card">
        <div className="lp-news-dialog-head">
          <span className="prog-dialog-eyebrow">NEWS</span>
          {active?.date ? (
            <time className="lp-news-dialog-date" dateTime={active.dateTime}>
              {active.date}
            </time>
          ) : null}
          <h2 className="lp-news-dialog-title" id="lp-news-dialog-title">
            {active?.title}
          </h2>
          <button type="button" className="prog-dialog-close lp-news-dialog-close" onClick={close} aria-label="閉じる">
            <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        {/* 長い本文はここだけスクロール（data-lenis-prevent: なめらかスクロールに奪わせない） */}
        <div ref={bodyRef} className="lp-news-dialog-body lp-md" data-lenis-prevent="" tabIndex={0} />
      </div>
    </dialog>
  );
}
