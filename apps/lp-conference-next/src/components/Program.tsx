"use client";

import { useEffect, useRef } from "react";
import Image from "next/image";
import { Reveal } from "@/components/Reveal";
import { renderEmphasis } from "@/lib/markup";
import type { ProgramConfig } from "@/config/types";

// Program — 横スクロールのカード列。先頭のみ写真＋社名、以降は空白カード。
// マウスホイール（縦→横に変換）／ポインタ ドラッグで横スクロールできる（正典と同挙動）。
// 端では通常のページスクロールへ委譲。ドラッグ直後の誤クリックは抑止。
export function Program({ data }: { data: ProgramConfig }) {
  const railRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;

    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const max = rail.scrollWidth - rail.clientWidth;
      if (max <= 0) return;
      const atStart = rail.scrollLeft <= 0 && e.deltaY < 0;
      const atEnd = rail.scrollLeft >= max - 1 && e.deltaY > 0;
      if (atStart || atEnd) return; // 端はページスクロールへ
      e.preventDefault();
      rail.scrollLeft += e.deltaY;
    };

    let down = false;
    let startX = 0;
    let startLeft = 0;
    let moved = false;

    const onPointerDown = (e: PointerEvent) => {
      down = true;
      moved = false;
      startX = e.clientX;
      startLeft = rail.scrollLeft;
      rail.classList.add("is-dragging");
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!down) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 4) moved = true;
      rail.scrollLeft = startLeft - dx;
    };
    const end = () => {
      down = false;
      rail.classList.remove("is-dragging");
    };
    const onClickCapture = (e: MouseEvent) => {
      if (moved) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    rail.addEventListener("wheel", onWheel, { passive: false });
    rail.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    rail.addEventListener("click", onClickCapture, true);

    return () => {
      rail.removeEventListener("wheel", onWheel);
      rail.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      rail.removeEventListener("click", onClickCapture, true);
    };
  }, []);

  return (
    <section id="program" className="section program section-center">
      <div className="container">
        <Reveal as="h2" className="section-title">
          {data.heading}
        </Reveal>
        <Reveal as="p" className="section-lead" delay={0.08}>
          {renderEmphasis(data.note)}
        </Reveal>
      </div>
      <div
        className="program-rail"
        ref={railRef}
        role="list"
        aria-label="プログラム枠"
      >
        {data.items.map((item, i) => (
          <article className="program-card" role="listitem" key={i}>
            {item.photo && (
              <Image
                className="program-card-photo"
                src={item.photo}
                alt={item.name ?? ""}
                width={389}
                height={376}
                loading="lazy"
              />
            )}
            {(item.name || item.note) && (
              <div className="program-card-body">
                {item.name && <h3 className="program-card-name">{item.name}</h3>}
                {item.note && <p className="program-card-note">{item.note}</p>}
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
