// 公開設定の「LP のプレビュー | セクションの設定」を 1 枚にまとめたカード。左に縮小した LP、右に各セクションの設定。
// LP は全高で描き（iframe の中はスクロールしない）、ページと一緒にスクロールする。各セクションの設定は
// 縮小した LP の中のそのセクションの高さに置く（前の設定と重なるときだけ下へずらす）。背の高いセクションでは、
// そのセクションが画面にある間は設定が操作帯の下に貼り付いてついてくる（次のセクションの手前まで）。
// 位置は LP の橋渡し（v3.6 以降のプレビュー表示）が送る lp:sections（各セクションの top/height・全高）で決める。
// 橋渡しの無い LP（古い版・未デプロイ）は、プレビューを固定の高さの枠（中でスクロール）にして設定を縦に並べる。
// 狭い画面は設定を縦に並べ、プレビューは見出しのボタンで開く枠にする。
// 連動: 設定にホバー / フォーカス → LP のそのセクションに枠（lp:mark）/ LP でセクションをクリック（lp:select）→ その設定へ。
// 受け取るのはこの iframe の window から LP のオリジンで来たものだけ。送る宛先も LP のオリジン。
// 下書きは保存のたびに refreshKey（revision）が変わるので、少し待って（連続操作をまとめて）読み直す。
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, Card, Icon, Skeleton, Spinner } from "@dub/ui";
import styles from "./lp.module.css";

/** LP をこの幅のデスクトップ表示として描いてから縮める。 */
const FRAME_WIDTH = 1280;
/** LP の 1 画面ぶんの高さ。100svh のヒーロー等はこの高さに固定してもらう（全高に合わせて伸びないように）。 */
const VIEWPORT_HEIGHT = 900;
/** 橋渡しの無い LP / 狭い画面のプレビュー枠の高さ（中でスクロール）。 */
const SCROLL_BOX_HEIGHT = 480;
/** 縦にずらすときの設定どうしの間隔。 */
const BLOCK_GAP = 16;
/** 壊れた値で巨大な iframe を描かない上限。 */
const MAX_DOC_HEIGHT = 40000;
/** 連続して切り替えたときに読み直しを 1 回にまとめる待ち時間。 */
export const MINI_PREVIEW_DEBOUNCE_MS = 500;
/** 読み込み後この時間 lp:sections が来なければ「位置の分からない LP」とみなす。 */
export const BRIDGE_TIMEOUT_MS = 3000;

export type BridgeState = "waiting" | "ready" | "none";

export interface SectionBox {
  id: string;
  top: number;
  height: number;
}

export interface LpLayoutReport {
  sections: SectionBox[];
  docHeight: number;
}

export function miniPreviewSrc(url: string, refreshKey: number): string {
  if (!refreshKey) return url;
  return `${url}${url.includes("?") ? "&" : "?"}_r=${refreshKey}`;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** lp:sections の中身を検める。height / docHeight の無い古い橋渡しは null（並べるだけにする）。 */
export function parseLayoutReport(d: { sections?: unknown; docHeight?: unknown }): LpLayoutReport | null {
  if (!Array.isArray(d.sections) || !num(d.docHeight)) return null;
  const sections: SectionBox[] = [];
  for (const s of d.sections as { id?: unknown; top?: unknown; height?: unknown }[]) {
    if (!s || typeof s.id !== "string" || !num(s.top) || !num(s.height)) return null;
    sections.push({ id: s.id, top: s.top, height: s.height });
  }
  return { sections, docHeight: Math.min(d.docHeight, MAX_DOC_HEIGHT) };
}

/**
 * 設定ブロックの縦位置（px・縮小後）。各ブロックはそのセクションの上端に置き、前のブロックと重なるなら下へずらす。
 * LP に無い（非表示の）セクションは、直前に見えているセクションの位置に置く（=その設定のすぐ下に並ぶ）。
 */
export function placeBlocks(
  ids: readonly string[],
  report: LpLayoutReport,
  scale: number,
  heights: Readonly<Record<string, number>>,
  gap = BLOCK_GAP,
): Record<string, number> {
  const byId = new Map(report.sections.map((s) => [s.id, s]));
  const out: Record<string, number> = {};
  let anchor = 0;
  let bottom = -gap;
  for (const id of ids) {
    const s = byId.get(id);
    if (s) anchor = s.top * scale;
    const y = Math.max(anchor, bottom + gap);
    out[id] = Math.round(y);
    bottom = y + (heights[id] ?? 0);
  }
  return out;
}

/** いちばん近いスクロール領域（シェルの本文）。scrollIntoView はルートまで動かしてしまうので使わない。 */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/** 要素の幅（ResizeObserver）。 */
function useWidth(ref: React.RefObject<HTMLElement>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

export function LpSectionEditor({
  url,
  refreshKey,
  title,
  notes,
  sectionIds,
  sectionLabel,
  renderSection,
  narrow = false,
}: {
  url: string;
  refreshKey: number;
  title: string;
  /** プレビューについての注記（版が古い・本番は反映後に映る 等）。 */
  notes: string[];
  sectionIds: readonly string[];
  sectionLabel: (id: string) => string;
  renderSection: (id: string) => ReactNode;
  /** 狭い画面: 設定を縦に並べ、プレビューは開閉する枠にする。 */
  narrow?: boolean;
}): JSX.Element {
  const target = miniPreviewSrc(url, refreshKey);
  const [src, setSrc] = useState(target);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const showPreview = !narrow || previewOpen;

  const frameRef = useRef<HTMLIFrameElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const width = useWidth(previewRef);
  const scale = width > 0 ? width / FRAME_WIDTH : 0.4;
  const lpOrigin = useMemo(() => {
    try {
      return new URL(src).origin;
    } catch {
      return null;
    }
  }, [src]);

  const [bridge, setBridge] = useState<BridgeState>("waiting");
  const [report, setReport] = useState<LpLayoutReport | null>(null);
  const gotReport = useRef(false);
  const [active, setActive] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = active;
  const blockRefs = useRef(new Map<string, HTMLDivElement>());

  const post = (msg: Record<string, unknown>): void => {
    const w = frameRef.current?.contentWindow;
    if (!w || !lpOrigin) return;
    try {
      w.postMessage(msg, lpOrigin);
    } catch {
      // LP 内で別サイトへ移動した等: 連動しない。
    }
  };
  const postRef = useRef(post);
  postRef.current = post;

  // 狭い画面（設定を縦に並べる）と、全高を測れない LP では、ブロックを位置合わせしない。
  const aligned = !narrow && bridge !== "none" && report !== null;

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      if (!lpOrigin || e.origin !== lpOrigin || !frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const d = e.data as { type?: unknown; section?: unknown; sections?: unknown; docHeight?: unknown } | null;
      if (!d || typeof d !== "object") return;
      if (d.type === "lp:sections") {
        gotReport.current = true;
        setBridge("ready");
        setReport(parseLayoutReport(d));
        // 読み直し（保存のたび）で枠が消えるので、選んでいたセクションに付け直す。
        if (activeRef.current) postRef.current({ type: "lp:mark", section: activeRef.current });
      }
      if (d.type === "lp:select" && typeof d.section === "string" && sectionIds.includes(d.section)) {
        setActive(d.section);
        // 貼り付く中身ではなく、そのセクションの位置にある帯で測る。
        const el = blockRefs.current.get(d.section)?.parentElement ?? null;
        const scroller = el ? scrollParent(el) : null;
        if (el && scroller) {
          const r = el.getBoundingClientRect();
          const box = scroller.getBoundingClientRect();
          // 見えていないときだけ、その設定が画面の中ほどに来るように動かす。
          if (r.top < box.top + 80 || r.bottom > box.bottom) {
            scroller.scrollTo({ top: scroller.scrollTop + r.top - box.top - box.height / 3, behavior: "smooth" });
          }
        }
        blockRefs.current.get(d.section)?.querySelector<HTMLElement>("button, select, input, [role='radio']")?.focus({ preventScroll: true });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [lpOrigin, sectionIds]);

  const onFrameLoad = (): void => {
    setLoaded(true);
    setRefreshing(false);
    gotReport.current = false;
    // select: クリックでセクションを選べる / fit: 全高で描くので 1 画面ぶんの高さを固定してもらう。
    post({ type: "lp:hello", select: true, fit: VIEWPORT_HEIGHT });
    setTimeout(() => {
      if (gotReport.current) return;
      setBridge("none");
      setReport(null);
    }, BRIDGE_TIMEOUT_MS);
  };

  useEffect(() => {
    if (target === src) return undefined;
    const t = setTimeout(() => {
      setRefreshing(true);
      setSrc(target);
    }, MINI_PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [target, src]);

  // ブロックの高さを測って置き直す（高さが変わったら＝切り替えでラベルが変わった等、もう一度）。
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [measureTick, setMeasureTick] = useState(0);
  useLayoutEffect(() => {
    if (!aligned) return;
    const next: Record<string, number> = {};
    for (const [id, el] of blockRefs.current) next[id] = el.offsetHeight;
    setHeights((prev) => (sectionIds.every((id) => prev[id] === next[id]) ? prev : next));
  }, [aligned, measureTick, sectionIds, width]);
  useEffect(() => {
    if (!aligned || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(() => setMeasureTick((n) => n + 1));
    for (const el of blockRefs.current.values()) ro.observe(el);
    return () => ro.disconnect();
  }, [aligned]);

  const tops = aligned && report ? placeBlocks(sectionIds, report, scale, heights) : null;
  const previewHeight = report && bridge !== "none" && !narrow ? Math.round(report.docHeight * scale) : null;
  const lastBottom = tops ? Math.max(0, ...sectionIds.map((id) => (tops[id] ?? 0) + (heights[id] ?? 0))) : 0;
  const columnHeight = Math.max(previewHeight ?? 0, lastBottom);
  /** 各設定の帯の高さ（次の設定の手前まで）。この中で貼り付く。 */
  const bandHeight = (id: string, i: number): number | undefined => {
    if (!tops) return undefined;
    const next = sectionIds[i + 1];
    const end = next !== undefined ? (tops[next] ?? columnHeight) - BLOCK_GAP : columnHeight;
    return Math.max(heights[id] ?? 0, end - (tops[id] ?? 0));
  };
  const frameHeight = previewHeight !== null && report ? report.docHeight : narrow || bridge === "none" ? SCROLL_BOX_HEIGHT / scale : VIEWPORT_HEIGHT;
  const boxHeight = previewHeight ?? (narrow || bridge === "none" ? SCROLL_BOX_HEIGHT : Math.round(VIEWPORT_HEIGHT * scale));

  const focusSection = (id: string): void => {
    if (id === activeRef.current) return;
    setActive(id);
    if (bridge === "ready") post({ type: "lp:mark", section: id });
  };

  const allNotes = [
    bridge === "none" ? "この LP はセクションの位置を返さないので、設定は順に並べています（位置がそろうのは v3.6 以降の版のプレビュー表示です）。" : null,
    ...notes,
  ].filter((n): n is string => !!n);

  return (
    <div className={styles.lpEditorCard}>
      <Card
        padded={false}
        testId="fe2-lp-config-editor"
        header={
          <div className={styles.miniHeader}>
            <span>{title}</span>
            {refreshing ? <Spinner size="sm" testId="fe2-lp-config-mini-refreshing" /> : null}
            {narrow ? (
              <Button variant="ghost" size="sm" onClick={() => setPreviewOpen((v) => !v)} testId="fe2-lp-config-mini-toggle">
                {previewOpen ? "プレビューを隠す" : "プレビューを見る"}
              </Button>
            ) : null}
            <a className={styles.urlOpen} href={src} target="_blank" rel="noopener noreferrer" aria-label={`${title}を新しいタブで開く`}>
              <Icon name="external-link" />
            </a>
          </div>
        }
      >
        {allNotes.map((text, i) => (
          <p key={text} className={styles.miniNote} data-testid={i === 0 && bridge === "none" ? "fe2-lp-config-mini-nosync" : "fe2-lp-config-mini-note"}>
            <Icon name="info" />
            <span>{text}</span>
          </p>
        ))}
        <div className={styles.lpEditor} data-narrow={narrow} data-sync={bridge}>
          <div ref={previewRef} className={styles.lpEditorPreview} hidden={!showPreview} data-testid="fe2-lp-config-mini">
            <div className={styles.miniBox} style={{ height: boxHeight }} data-fit={previewHeight !== null} data-testid="fe2-lp-config-mini-box">
              {!loaded ? (
                <div className={styles.miniSkeleton} role="status" aria-label="プレビューを読み込み中">
                  <Skeleton variant="rect" width="100%" height="100%" testId="fe2-lp-config-mini-loading" />
                </div>
              ) : null}
              <iframe
                src={src}
                title={title}
                data-testid="fe2-lp-config-mini-frame"
                ref={frameRef}
                onLoad={onFrameLoad}
                scrolling={previewHeight !== null ? "no" : undefined}
                className={styles.miniFrame}
                style={{ width: FRAME_WIDTH, height: frameHeight, transform: `scale(${scale})` }}
              />
            </div>
          </div>
          <div
            className={styles.lpEditorSettings}
            data-layout={tops ? "aligned" : "stacked"}
            data-active-section={active ?? ""}
            style={tops ? { height: columnHeight } : undefined}
            data-testid="fe2-lp-config-settings"
          >
            {tops && report
              ? report.sections
                  .filter((s) => sectionIds.includes(s.id))
                  .map((s) => (
                    <span
                      key={s.id}
                      className={styles.lpEditorRange}
                      data-active={active === s.id}
                      style={{ top: Math.round(s.top * scale), height: Math.max(8, Math.round(s.height * scale)) }}
                      aria-hidden="true"
                    />
                  ))
              : null}
            {sectionIds.map((id, i) => (
              <div key={id} className={styles.lpEditorBand} data-lp-block={id} style={tops ? { top: tops[id], height: bandHeight(id, i) } : undefined}>
                <div
                  ref={(el) => {
                    if (el) blockRefs.current.set(id, el);
                    else blockRefs.current.delete(id);
                  }}
                  className={styles.lpEditorBlock}
                  data-active={active === id}
                  onMouseEnter={() => focusSection(id)}
                  onFocus={() => focusSection(id)}
                  aria-label={sectionLabel(id)}
                  role="group"
                >
                  {renderSection(id)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Card>
    </div>
  );
}
