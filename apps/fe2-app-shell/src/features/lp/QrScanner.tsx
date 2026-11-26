// 受付の QR 読み取り。背面カメラの映像を BarcodeDetector（Chrome / Android）で読み、無いブラウザ
// （iOS Safari など）は @zxing/browser を必要な時だけ読み込んで使う。カメラが使えない時は何も描かず
// onUnavailable で知らせる（画面側の手入力が出口）。カメラはアンマウント・paused で必ず止める。
import { useEffect, useRef, useState } from "react";
import { Skeleton } from "@dub/ui";
import styles from "./lpCheckin.module.css";

type ScanState = { kind: "starting" } | { kind: "live" } | { kind: "unavailable"; message: string };

interface Detector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}
type DetectorCtor = new (opts: { formats: string[] }) => Detector;

function cameraMessage(err: unknown): string {
  const name = typeof err === "object" && err !== null && "name" in err ? String((err as { name: unknown }).name) : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "カメラの使用が許可されていません。ブラウザの設定で許可するか、下の欄に入力してください。";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "この端末ではカメラが見つかりません。下の欄に入力してください。";
  return "カメラを起動できませんでした。下の欄に入力してください。";
}

export function cameraAvailable(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

const SCAN_INTERVAL_MS = 250;

export function QrScanner({ paused, onCode }: { paused: boolean; onCode: (code: string) => void }): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;
  const [state, setState] = useState<ScanState>(() =>
    cameraAvailable() ? { kind: "starting" } : { kind: "unavailable", message: "このブラウザではカメラを使えません。下の欄に入力してください。" },
  );

  useEffect(() => {
    if (paused || !cameraAvailable()) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let zxingStop: (() => void) | null = null;
    const stop = () => {
      if (timer) clearInterval(timer);
      zxingStop?.();
      stream?.getTracks().forEach((t) => t.stop());
    };
    setState({ kind: "starting" });
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then(async (s) => {
        stream = s;
        const video = videoRef.current;
        if (cancelled || !video) return stop();
        video.srcObject = s;
        try {
          await video.play();
        } catch {
          // muted + playsInline なら autoplay 拒否でも映像は出る。
        }
        if (cancelled) return stop();
        setState({ kind: "live" });
        const Native = (globalThis as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
        if (Native) {
          const detector = new Native({ formats: ["qr_code"] });
          let busy = false;
          timer = setInterval(() => {
            if (busy || video.readyState < 2) return;
            busy = true;
            detector
              .detect(video)
              .then((codes) => {
                const v = codes[0]?.rawValue;
                if (v && !cancelled) onCodeRef.current(v);
              })
              .catch(() => undefined)
              .finally(() => {
                busy = false;
              });
          }, SCAN_INTERVAL_MS);
          return;
        }
        const { BrowserQRCodeReader } = await import("@zxing/browser");
        if (cancelled) return stop();
        const controls = await new BrowserQRCodeReader(undefined, { delayBetweenScanAttempts: SCAN_INTERVAL_MS }).decodeFromVideoElement(
          video,
          (result) => {
            if (result && !cancelled) onCodeRef.current(result.getText());
          },
        );
        zxingStop = () => controls.stop();
        if (cancelled) stop();
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ kind: "unavailable", message: cameraMessage(err) });
      });
    return () => {
      cancelled = true;
      stop();
    };
  }, [paused]);

  if (state.kind === "unavailable") {
    return (
      <p className={styles.cameraNote} data-testid="fe2-lp-checkin-camera-unavailable">
        {state.message}
      </p>
    );
  }
  return (
    <div className={styles.viewfinder} data-testid="fe2-lp-checkin-camera">
      {state.kind === "starting" && !paused ? (
        <div className={styles.viewfinderLoading}>
          <Skeleton height="100%" />
        </div>
      ) : null}
      <video ref={videoRef} className={styles.video} muted playsInline aria-label="QR コードを読むカメラ" />
      <div className={styles.frame} aria-hidden="true" />
      {paused ? <div className={styles.pausedMask}>一時停止中</div> : null}
    </div>
  );
}
