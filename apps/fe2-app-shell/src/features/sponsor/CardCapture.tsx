// 名刺の撮影: 背面カメラのライブ映像に名刺比率 (91:55) の枠を重ね、シャッターで枠の範囲を切り出す →
// プレビューで「撮り直す / この写真を使う」。カメラが使えない (拒否・非対応・PC) ときは「写真を選ぶ」だけ。
// 「写真を選ぶ」はカメラが使えるときも常に出す。カメラはプレビュー中・アンマウントで必ず止める。
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, EmptyState, Skeleton } from "@dub/ui";
import { FormError } from "@dub/app-ui";
import { CardImageError, cameraSupported, captureFrame, fileToCardImage } from "./cardImage.ts";
import { useObjectUrl } from "./sponsorHooks.ts";
import styles from "./sponsor.module.css";

type CameraState = { kind: "starting" } | { kind: "live" } | { kind: "unavailable"; message: string };

function cameraErrorMessage(err: unknown): string {
  const name = err instanceof Error || (typeof err === "object" && err !== null && "name" in err) ? String((err as { name: unknown }).name) : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "カメラの使用が許可されていません。ブラウザの設定で許可するか、「写真を選ぶ」から選んでください。";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "この端末ではカメラが見つかりません。「写真を選ぶ」から選んでください。";
  }
  return "カメラを起動できませんでした。「写真を選ぶ」から選んでください。";
}

const UNSUPPORTED = "このブラウザではカメラを使えません。「写真を選ぶ」から選んでください。";

function useCamera(active: boolean): { videoRef: React.RefObject<HTMLVideoElement>; state: CameraState } {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<CameraState>(() =>
    cameraSupported() ? { kind: "starting" } : { kind: "unavailable", message: UNSUPPORTED },
  );
  useEffect(() => {
    if (!active) return;
    if (!cameraSupported()) {
      setState({ kind: "unavailable", message: UNSUPPORTED });
      return;
    }
    let stream: MediaStream | null = null;
    let cancelled = false;
    const stop = () => stream?.getTracks().forEach((t) => t.stop());
    setState({ kind: "starting" });
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then(async (s) => {
        stream = s;
        if (cancelled) return stop();
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = s;
        try {
          await video.play();
        } catch {
          // autoplay 拒否でも muted + playsInline なら映像は出る。
        }
        if (!cancelled) setState({ kind: "live" });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ kind: "unavailable", message: cameraErrorMessage(err) });
      });
    return () => {
      cancelled = true;
      stop();
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [active]);
  return { videoRef, state };
}

export function CardCapture({
  onConfirm,
  extraAction,
  confirmLabel = "この写真を使う",
}: {
  onConfirm: (image: Blob) => void;
  /** 「写真なしで入力」など、撮影の下に並べる追加の操作。 */
  extraAction?: ReactNode;
  confirmLabel?: string;
}): JSX.Element {
  const [shot, setShot] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { videoRef, state } = useCamera(shot === null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const previewUrl = useObjectUrl(shot);

  const shoot = useCallback(async () => {
    const video = videoRef.current;
    const vp = viewportRef.current;
    const frame = frameRef.current;
    if (!video || !vp || !frame) return;
    try {
      setShot(await captureFrame(video, vp.getBoundingClientRect(), frame.getBoundingClientRect()));
      setError(null);
    } catch {
      setError("撮影できませんでした。もう一度試すか、「写真を選ぶ」から選んでください。");
    }
  }, [videoRef]);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    try {
      setShot(await fileToCardImage(file));
      setError(null);
    } catch (e) {
      setError(e instanceof CardImageError ? e.message : "写真を読み込めませんでした。別の写真を選んでください。");
    }
  };

  const fileInput = (
    <>
      {/* capture は付けない: 付けると端末のカメラ専用になり、撮影済みの写真を選べなくなる
          (付けなくても iOS / Android はカメラかライブラリかを選ぶシートを出す)。 */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className={styles.hiddenInput}
        data-testid="fe2-sponsor-file"
        aria-label="写真を選ぶ"
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <Button variant={state.kind === "unavailable" ? "primary" : "secondary"} size="lg" testId="fe2-sponsor-pick" onClick={() => fileRef.current?.click()}>
        写真を選ぶ
      </Button>
    </>
  );

  if (shot) {
    return (
      <div className={styles.capture} data-testid="fe2-sponsor-preview">
        <div className={styles.previewBox}>
          {previewUrl ? <img src={previewUrl} alt="撮影した名刺" className={styles.previewImg} /> : <Skeleton variant="rect" height="100%" />}
        </div>
        <div className={styles.actionRow}>
          <Button variant="secondary" size="lg" testId="fe2-sponsor-retake" onClick={() => setShot(null)}>
            撮り直す
          </Button>
          <Button size="lg" testId="fe2-sponsor-use-photo" onClick={() => onConfirm(shot)}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.capture} data-testid="fe2-sponsor-capture">
      {state.kind === "unavailable" ? (
        <EmptyState testId="fe2-sponsor-no-camera" icon="info" title="カメラを使えません" description={state.message} />
      ) : (
        <div ref={viewportRef} className={styles.viewport}>
          <video ref={videoRef} className={styles.video} autoPlay muted playsInline aria-label="カメラの映像" />
          {state.kind === "starting" ? <div className={styles.viewportLoading} aria-label="カメラを起動しています" /> : null}
          <div ref={frameRef} className={styles.frame} aria-hidden="true" />
          <p className={styles.frameHint}>枠に名刺を合わせて撮影</p>
        </div>
      )}
      <FormError testId="fe2-sponsor-capture-error">{error}</FormError>
      {state.kind !== "unavailable" ? (
        <div className={styles.shutterRow}>
          <button
            type="button"
            className={styles.shutter}
            data-testid="fe2-sponsor-shutter"
            aria-label="撮影する"
            disabled={state.kind !== "live"}
            onClick={() => void shoot()}
          />
        </div>
      ) : null}
      <div className={styles.actionRow}>
        {fileInput}
        {extraAction}
      </div>
    </div>
  );
}
