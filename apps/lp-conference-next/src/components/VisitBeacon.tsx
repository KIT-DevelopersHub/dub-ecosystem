"use client";

// LP管理「ログ管理 / 流入URL」の計測タグ。ページを開いたら 1 回だけ、流入元（utm_source）
// と匿名の訪問者 ID を Dub の公開ビーコン（POST /api/v1/public/lp-visits）へ送る。
// - sendBeacon + text/plain = CORS の simple request（プリフライト無し・応答は読まない）。
// - 訪問者 ID は端末内の乱数（localStorage）。氏名・メール等の個人情報は一切送らない。
// - 計測の失敗は LP の表示に一切影響させない（例外は握りつぶす）。
import { useEffect } from "react";

const API_BASE = process.env.NEXT_PUBLIC_DUB_API_BASE ?? "https://dub-api-gateway.developershub-site.workers.dev";
const LP_VERSION = process.env.NEXT_PUBLIC_LP_VERSION ?? "v3.4";
const VID_KEY = "dub_lp_vid";

function visitorId(): string | null {
  try {
    let vid = window.localStorage.getItem(VID_KEY);
    if (!vid) {
      vid = crypto.randomUUID().replace(/-/g, "");
      window.localStorage.setItem(VID_KEY, vid);
    }
    return vid;
  } catch {
    return null; // private mode 等。サーバー側が日単位の代替キーで数える。
  }
}

export function VisitBeacon() {
  useEffect(() => {
    try {
      const body = JSON.stringify({
        source: new URLSearchParams(window.location.search).get("utm_source"),
        path: window.location.pathname,
        lpVersion: LP_VERSION,
        referrer: document.referrer || null,
        vid: visitorId(),
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
