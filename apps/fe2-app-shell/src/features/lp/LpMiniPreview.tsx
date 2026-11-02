// 公開設定の右側に置く、LP を縮小して見せるミニプレビュー。
// LP は別オリジンなので中身には触れない。iframe を 1280px 幅で描き、CSS の transform で枠に合わせて縮める。
// 下書きを保存するたびに refreshKey（revision）が変わるので、少し待ってから（連続操作をまとめて）読み直す。
// src を差し替えるだけなので、次のページが出るまで前の表示は残る（真っ白にならない）。
// iframe は枠の高さいっぱい（枠の高さ / 縮尺）に描くので、中でホイールを回すと LP 全体をスクロールできる。
// 別オリジンなのでスクロール位置は読めず、保存後の読み直しで先頭に戻る（注記で伝える）。
//
// スクロール連動: LP（v3.6 以降のプレビュー表示）が注入する橋渡し script と postMessage でやり取りする。
//  LP → ここ: lp:sections（準備完了）/ lp:scroll（LP の中で一番上に来たセクション）
//  ここ → LP: lp:hello（読み込み後に再送を頼む）/ lp:scrollTo（設定側で上に来たセクションへ移動）
// 受け取るのはこの iframe の window から、LP のオリジンで来たものだけ。送るときも宛先は LP のオリジン。
// こちらから scrollTo を送った直後の lp:scroll はエコーなので 600ms 無視する。
// 読み込み後 3 秒たっても lp:sections が来なければ、連動しない LP（古い版・橋渡しの無い LP）として注記を出す。
import { useEffect, useMemo, useRef, useState } from "react";
import { Card, Icon, Skeleton, Spinner } from "@dub/ui";
import styles from "./lp.module.css";

/** LP をこの幅のデスクトップ表示として描いてから縮める。 */
const FRAME_WIDTH = 1280;
/** 連続して切り替えたときに読み直しを 1 回にまとめる待ち時間。 */
export const MINI_PREVIEW_DEBOUNCE_MS = 500;
/** こちらから scrollTo を送ったあと、LP からの lp:scroll をエコーとして無視する時間。 */
export const SYNC_ECHO_MS = 600;
/** 読み込み後この時間 lp:sections が来なければ「連動しない LP」とみなす。 */
export const BRIDGE_TIMEOUT_MS = 3000;

export type BridgeState = "waiting" | "ready" | "none";

/** 設定側からの「このセクションへ」の依頼。seq は同じセクションへの再依頼を区別する。 */
export interface ScrollRequest {
  section: string;
  seq: number;
}

export function miniPreviewSrc(url: string, refreshKey: number): string {
  if (!refreshKey) return url;
  return `${url}${url.includes("?") ? "&" : "?"}_r=${refreshKey}`;
}

export function LpMiniPreview({
  url,
  refreshKey,
  title,
  note,
  scrollRequest = null,
  onActiveSection,
}: {
  url: string;
  refreshKey: number;
  title: string;
  note: string | null;
  scrollRequest?: ScrollRequest | null;
  onActiveSection?: (section: string) => void;
}): JSX.Element {
  const target = miniPreviewSrc(url, refreshKey);
  const [src, setSrc] = useState(target);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const frameRef = useRef<HTMLIFrameElement>(null);
  const lpOrigin = useMemo(() => {
    try {
      return new URL(src).origin;
    } catch {
      return null;
    }
  }, [src]);
  const [bridge, setBridge] = useState<BridgeState>("waiting");
  const bridgeRef = useRef<BridgeState>("waiting");
  const quietUntil = useRef(0);
  const requestRef = useRef<ScrollRequest | null>(scrollRequest);
  const onActiveRef = useRef(onActiveSection);
  onActiveRef.current = onActiveSection;
  const markBridge = (next: BridgeState): void => {
    bridgeRef.current = next;
    setBridge(next);
  };

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      if (!lpOrigin || e.origin !== lpOrigin || !frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const d = e.data as { type?: unknown; activeSection?: unknown } | null;
      if (!d || typeof d !== "object") return;
      if (d.type === "lp:sections") {
        markBridge("ready");
        // 読み直し（保存のたび）で LP は先頭に戻るので、設定側で見ているセクションへ戻す。
        const req = requestRef.current;
        if (req) sendRef.current(req.section);
      }
      if (d.type === "lp:scroll" && typeof d.activeSection === "string") {
        markBridge("ready");
        if (Date.now() >= quietUntil.current) onActiveRef.current?.(d.activeSection);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [lpOrigin]);

  const sendScrollTo = (section: string): void => {
    const w = frameRef.current?.contentWindow;
    if (!w || !lpOrigin) return;
    quietUntil.current = Date.now() + SYNC_ECHO_MS;
    w.postMessage({ type: "lp:scrollTo", section }, lpOrigin);
  };
  const sendRef = useRef(sendScrollTo);
  sendRef.current = sendScrollTo;

  useEffect(() => {
    requestRef.current = scrollRequest;
    if (scrollRequest && bridgeRef.current === "ready") sendRef.current(scrollRequest.section);
  }, [scrollRequest]);

  const onFrameLoad = (): void => {
    setLoaded(true);
    setRefreshing(false);
    if (bridgeRef.current !== "ready") markBridge("waiting");
    const w = frameRef.current?.contentWindow;
    if (w && lpOrigin) {
      try {
        w.postMessage({ type: "lp:hello" }, lpOrigin);
      } catch {
        // 宛先のオリジンが違う（LP 内で別サイトへ移動した等）: 連動しない。
      }
    }
    setTimeout(() => {
      if (bridgeRef.current === "waiting") markBridge("none");
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
      <div ref={boxRef} className={styles.miniBox} data-sync={bridge} data-testid="fe2-lp-config-mini-box">
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
          className={styles.miniFrame}
          style={{ width: FRAME_WIDTH, height: frameHeight, transform: `scale(${scale})` }}
        />
      </div>
      <p className={styles.miniNote} data-testid="fe2-lp-config-mini-hint">
        <Icon name="info" />
        <span>
          {bridge === "ready"
            ? "プレビューと右の設定はスクロールが連動します（保存して読み直しても、見ていたセクションに戻ります）。"
            : "プレビューの上でスクロールすると LP 全体を見られます（保存して読み直すと先頭に戻ります）。"}
        </span>
      </p>
      {bridge === "none" ? (
        <p className={styles.miniNote} data-testid="fe2-lp-config-mini-nosync">
          <Icon name="info" />
          <span>この LP はスクロールの連動に対応していません（連動するのは v3.6 以降の版のプレビュー表示です）。</span>
        </p>
      ) : null}
      {note ? (
        <p className={styles.miniNote} data-testid="fe2-lp-config-mini-note">
          <Icon name="info" />
          <span>{note}</span>
        </p>
      ) : null}
    </Card>
  );
}
