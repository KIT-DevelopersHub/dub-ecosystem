// 公開設定の右側に置く、LP を縮小して見せるミニプレビュー。
// LP は別オリジンなので中身には触れない。iframe を 1280px 幅で描き、CSS の transform で枠に合わせて縮める。
// 下書きを保存するたびに refreshKey（revision）が変わるので、少し待ってから（連続操作をまとめて）読み直す。
// src を差し替えるだけなので、次のページが出るまで前の表示は残る（真っ白にならない）。
import { useEffect, useRef, useState } from "react";
import { Card, Icon, Skeleton, Spinner } from "@dub/ui";
import styles from "./lp.module.css";

/** LP をこの幅のデスクトップ表示として描いてから縮める。 */
const FRAME_WIDTH = 1280;
/** 連続して切り替えたときに読み直しを 1 回にまとめる待ち時間。 */
export const MINI_PREVIEW_DEBOUNCE_MS = 500;

export function miniPreviewSrc(url: string, refreshKey: number): string {
  if (!refreshKey) return url;
  return `${url}${url.includes("?") ? "&" : "?"}_r=${refreshKey}`;
}

export function LpMiniPreview({
  url,
  refreshKey,
  title,
  note,
}: {
  url: string;
  refreshKey: number;
  title: string;
  note: string | null;
}): JSX.Element {
  const target = miniPreviewSrc(url, refreshKey);
  const [src, setSrc] = useState(target);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (target === src) return undefined;
    const t = setTimeout(() => {
      setRefreshing(true);
      setSrc(target);
    }, MINI_PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [target, src]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scale = box.width > 0 ? box.width / FRAME_WIDTH : 0.4;
  const frameHeight = box.height > 0 ? box.height / scale : 1600;

  return (
    <Card
      padded={false}
      testId="fe2-lp-config-mini"
      header={
        <div className={styles.miniHeader}>
          <span>{title}</span>
          {refreshing ? <Spinner size="sm" testId="fe2-lp-config-mini-refreshing" /> : null}
          <a className={styles.urlOpen} href={src} target="_blank" rel="noopener noreferrer" aria-label={`${title}を新しいタブで開く`}>
            <Icon name="external-link" />
          </a>
        </div>
      }
    >
      <div ref={boxRef} className={styles.miniBox}>
        {!loaded ? (
          <div className={styles.miniSkeleton} role="status" aria-label="プレビューを読み込み中">
            <Skeleton variant="rect" width="100%" height="100%" testId="fe2-lp-config-mini-loading" />
          </div>
        ) : null}
        <iframe
          src={src}
          title={title}
          tabIndex={-1}
          data-testid="fe2-lp-config-mini-frame"
          onLoad={() => {
            setLoaded(true);
            setRefreshing(false);
          }}
          className={styles.miniFrame}
          style={{ width: FRAME_WIDTH, height: frameHeight, transform: `scale(${scale})` }}
        />
      </div>
      {note ? (
        <p className={styles.miniNote} data-testid="fe2-lp-config-mini-note">
          <Icon name="info" />
          <span>{note}</span>
        </p>
      ) : null}
    </Card>
  );
}
