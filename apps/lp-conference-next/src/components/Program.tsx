"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Reveal } from "@/components/Reveal";
import { SectionHead } from "@/components/SectionHead";
import { renderEmphasis } from "@/lib/markup";
import type { ProgramConfig } from "@/config/types";

// Program — reproduces goodpatch's "Design Platform" skeleton: a bold full-bleed
// blue block with a giant heading, then a stacked list of big-name rows, each
// with an index, an oversized name + description, a circular masked medallion
// that slides in on hover, and a circle-arrow affordance. Filled with the
// conference's 聴く / 体験する / 出会う pillars and original inline-SVG art —
// no goodpatch assets/copy.
//
// 各行はクリックでダイアログ（native <dialog>）を開く。内容はまだ作成中のため
// 「準備中｜内容は随時更新します」を上品に表示し、空振りにしない。
export function Program({ data, index }: { data: ProgramConfig; index?: string }) {
  const [open, setOpen] = useState<number | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  const close = useCallback(() => setOpen(null), []);

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open !== null && !d.open) d.showModal();
    else if (open === null && d.open) d.close();

    // A native <dialog> opened with showModal() lives in the top layer, above
    // the decorative custom cursor (z-index:9999) and any WebGL canvas. Without
    // this, over the dialog the native cursor is hidden (.has-lp-cursor sets
    // cursor:none) while the custom cursor dot renders BEHIND the dialog — so
    // the pointer appears to "go behind" and the dialog feels unusable. Toggling
    // this body flag restores the real cursor and hides the custom one while the
    // dialog is open; the 'lp:dialog' event lets MotionRoot pause Lenis so the
    // background no longer scrolls under the modal.
    const isOpen = open !== null;
    document.body.classList.toggle("has-open-dialog", isOpen);
    window.dispatchEvent(
      new CustomEvent("lp:dialog", { detail: { open: isOpen } }),
    );
  }, [open]);

  // Safety net: clear the flag if this component unmounts while open.
  useEffect(() => {
    return () => {
      document.body.classList.remove("has-open-dialog");
      window.dispatchEvent(
        new CustomEvent("lp:dialog", { detail: { open: false } }),
      );
    };
  }, []);

  const activeItem = open !== null ? data.items[open] : null;

  return (
    <section id="program" className="section program-block block-arc block-arc--top">
      <div className="container">
        <SectionHead
          eyebrow="PROGRAM"
          index={index}
          title={data.heading}
          lead={renderEmphasis(data.note)}
          light
          ghost="PROGRAM"
        />

        <div className="prow-list">
          {data.items.map((item, i) => (
            <Reveal
              as="button"
              type="button"
              className="prow prow--btn"
              key={item.name ?? i}
              variant="up"
              delay={90 * i}
              onClick={() => setOpen(i)}
              aria-haspopup="dialog"
              aria-label={`${item.name ?? "プログラム"}の詳細を開く`}
            >
              <span className="prow-idx" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
              <span className="prow-icon" aria-hidden="true">{pillarIcon(i)}</span>
              <span className="prow-copy">
                {item.name && <span className="prow-name">{item.name}</span>}
                {item.note && <span className="prow-note">{item.note}</span>}
              </span>
              <span className={`prow-medallion prow-medallion--${i + 1}`} aria-hidden="true">
                {pillarIcon(i)}
              </span>
              <span className="prow-arrow" aria-hidden="true">→</span>
            </Reveal>
          ))}
        </div>
      </div>

      <dialog
        ref={dialogRef}
        className="prog-dialog"
        aria-labelledby="prog-dialog-title"
        onClose={close}
        onClick={(e) => {
          // backdrop（カード外）クリックで閉じる
          if (e.target === dialogRef.current) close();
        }}
      >
        {activeItem && (
          <div className="prog-dialog-card">
            <button type="button" className="prog-dialog-close" onClick={close} aria-label="閉じる">
              <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
            <span className="prog-dialog-icon" aria-hidden="true">
              {open !== null && pillarIcon(open)}
            </span>
            <span className="prog-dialog-eyebrow">PROGRAM</span>
            <h3 className="prog-dialog-title" id="prog-dialog-title">{activeItem.name}</h3>
            {activeItem.note && <p className="prog-dialog-note">{activeItem.note}</p>}
            <div className="prog-dialog-status">
              <span className="prog-dialog-badge">
                <span className="prog-dialog-dot" aria-hidden="true" />
                準備中
              </span>
              <p className="prog-dialog-status-text">
                プログラムの詳細は現在準備中です。<br />
                内容は決まり次第、随時更新します。
              </p>
            </div>
          </div>
        )}
      </dialog>
    </section>
  );
}

// Line icons for the 聴く / 体験する / 出会う pillars (original art).
function pillarIcon(i: number) {
  const common = {
    width: 34,
    height: 34,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (i === 0) {
    return (
      <svg {...common}>
        <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
        <rect x="2.5" y="13.5" width="4" height="6.5" rx="1.6" />
        <rect x="17.5" y="13.5" width="4" height="6.5" rx="1.6" />
      </svg>
    );
  }
  if (i === 1) {
    return (
      <svg {...common}>
        <path d="M12 3v3M12 18v3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M3 12h3M18 12h3M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
        <circle cx="12" cy="12" r="3.2" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="8.5" cy="8" r="2.8" />
      <path d="M14.2 5.4a2.8 2.8 0 0 1 0 5.2" />
      <path d="M3.5 19.5c0-2.8 2.2-4.6 5-4.6s5 1.8 5 4.6" />
      <path d="M16 15.2c2.3.2 4.5 2 4.5 4.3" />
    </svg>
  );
}
