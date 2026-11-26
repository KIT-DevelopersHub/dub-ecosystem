// demo (VITE_DEMO=1) の LP管理 > スポンサー募集。本番の lp-analytics /lp/sponsor-inquiries* の代わりにメモリ上で答える。
// 企業・アドレスはすべて架空 (example.jp)。リロードで消える。
import { lpSponsor } from "@dub/types";

type Item = lpSponsor.LpSponsorInquiry;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function problem(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

export function createDemoLpSponsorStore(lpPublicUrl: string) {
  const settings = {
    enabled: false,
    notifyEmail: null as string | null,
    updatedAt: null as string | null,
    updatedBy: null as string | null,
  };
  const seed: [string, string, string, string, lpSponsor.LpSponsorInquiryStatus, Item["notifiedVia"], string][] = [
    ["株式会社カナザワソフト", "金沢 花子", "hanako@example.jp", "ゴールドプランの詳細を知りたいです。", "new", "both", "2026-11-20T02:10:00Z"],
    ["", "", "info@example.jp", "", "new", "app", "2026-11-19T08:30:00Z"],
    ["北陸クラウド株式会社", "富山 次郎", "jiro@example.jp", "ブース出展は可能でしょうか。", "sent", "both", "2026-11-15T05:00:00Z"],
  ];
  const items: Item[] = seed.map(([companyName, contactName, email, message, status, notifiedVia, createdAt], i) => ({
    id: `lps_demo_${i + 1}`,
    companyName,
    contactName,
    email,
    message,
    status,
    notifiedVia,
    updatedBy: status === "new" ? null : "デモ 管理者",
    createdAt,
    updatedAt: createdAt,
  }));
  const state = (): lpSponsor.LpSponsorInquiriesState => ({
    site: "hokuriku-it-conf.com",
    ...settings,
    publicUrl: `${lpPublicUrl.replace(/\/+$/, "")}/sponsors`,
    defaultNotifyEmail: null,
    totals: { total: items.length, open: items.filter((x) => x.status === "new").length },
  });
  const touch = () => {
    settings.updatedAt = new Date().toISOString();
    settings.updatedBy = "デモ 管理者";
  };

  function handle(method: string, pathname: string, url: URL, body: unknown): Response | null {
    if (!pathname.startsWith("/api/v1/lp/sponsor-inquiries")) return null;
    const req = (body ?? {}) as Record<string, unknown>;
    if (method === "GET" && pathname === "/api/v1/lp/sponsor-inquiries") return json(state());
    if (method === "POST" && pathname === "/api/v1/lp/sponsor-inquiries/enabled") {
      if (typeof req.enabled !== "boolean") return problem("VALIDATION_FAILED", "enabled を指定してください", 400);
      settings.enabled = req.enabled;
      touch();
      return json(state());
    }
    if (method === "POST" && pathname === "/api/v1/lp/sponsor-inquiries/notify") {
      const { input, issues } = lpSponsor.parseLpSponsorNotify(req);
      if (issues.length > 0) return problem("VALIDATION_FAILED", "通知先の形式が正しくありません", 400);
      Object.assign(settings, input);
      touch();
      return json(state());
    }
    if (method === "GET" && pathname === "/api/v1/lp/sponsor-inquiries/items") {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 25)));
      const cursor = url.searchParams.get("cursor");
      const sorted = [...items].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      const start = cursor ? sorted.findIndex((x) => x.id === cursor) + 1 : 0;
      const page = sorted.slice(start, start + limit);
      return json({ items: page, nextCursor: start + limit < sorted.length ? (page[page.length - 1]?.id ?? null) : null });
    }
    const m = /^\/api\/v1\/lp\/sponsor-inquiries\/items\/([^/]+)$/.exec(pathname);
    if (method === "PATCH" && m) {
      const it = items.find((x) => x.id === decodeURIComponent(m[1]!));
      if (!it) return problem("NOT_FOUND", "その資料請求は見つかりません", 404);
      if (typeof req.status !== "string" || !lpSponsor.LP_SPONSOR_INQUIRY_STATUSES.includes(req.status as lpSponsor.LpSponsorInquiryStatus)) {
        return problem("VALIDATION_FAILED", "対応状況が正しくありません", 400);
      }
      it.status = req.status as lpSponsor.LpSponsorInquiryStatus;
      it.updatedBy = "デモ 管理者";
      it.updatedAt = new Date().toISOString();
      return json(it);
    }
    return null;
  }
  return { handle };
}
