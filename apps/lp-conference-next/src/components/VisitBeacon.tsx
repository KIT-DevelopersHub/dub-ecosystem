"use client";

// LP管理「ログ管理 / 流入URL」の計測タグ。ページを開いたら 1 回だけ、流入元（utm_source）を
// Dub の公開ビーコン（POST /api/v1/public/lp-visits）へ送る。
// - sendBeacon + text/plain = CORS の simple request（プリフライト無し・応答は読まない）。
// - 識別子は送らない（端末に長く残る訪問者 ID は使わない）。同じタブでの再読み込みは、タブの中だけで
//   有効な sessionStorage の印で 2 回目以降を送らない（印は送らない）。
// - Do Not Track / Global Privacy Control が有効なら何もしない（api-gateway も同じ条件で捨てる）。
// - 計測の失敗は LP の表示に一切影響させない（例外は握りつぶす）。
import { useEffect } from "react";

const API_BASE = process.env.NEXT_PUBLIC_DUB_API_BASE ?? "https://dub-api-gateway.developershub-site.workers.dev";
const LP_VERSION = process.env.NEXT_PUBLIC_LP_VERSION ?? "v3.4";
const SENT_PREFIX = "dub_lp_v:";

function optedOut(): boolean {
  const n = navigator as Navigator & { globalPrivacyControl?: boolean };
  const w = window as Window & { doNotTrack?: string };
  return n.doNotTrack === "1" || w.doNotTrack === "1" || n.globalPrivacyControl === true;
}

/** このタブで同じ（流入元・ページ）をもう送ったか。送っていなければ印を付ける。 */
function alreadySent(source: string | null, path: string): boolean {
  try {
    const key = `${SENT_PREFIX}${source ?? ""}|${path}`;
    if (window.sessionStorage.getItem(key)) return true;
    window.sessionStorage.setItem(key, "1");
  } catch {
    // private mode 等。毎回送る。
  }
  return false;
}

export function VisitBeacon() {
  useEffect(() => {
    try {
      if (optedOut()) return;
      const source = new URLSearchParams(window.location.search).get("utm_source");
      const path = window.location.pathname;
      if (alreadySent(source, path)) return;
      const body = JSON.stringify({
        source,
        path,
        lpVersion: LP_VERSION,
        referrer: document.referrer || null,
      });
      const url = `${API_BASE}/api/v1/public/lp-visits`;
      const blob = new Blob([body], { type: "text/plain" });
      if (!navigator.sendBeacon?.(url, blob)) {
        void fetch(url, { method: "POST", body, keepalive: true, mode: "no-cors" }).catch(() => undefined);
      }
    } catch {
      // 計測は best-effort。
    }
  }, []);
  return null;
}
