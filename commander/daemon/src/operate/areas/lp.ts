// LP管理 (lp-analytics). This service has no policy-table.ts yet: its routes are gated in
// app.ts by requireAppAccess("lp", view|edit), which the catalog test reads instead.
// Every route needs query from/to (YYYY-MM-DD, JST, at most 92 days) — writes too, where
// they set the range of the stats in the response.
import type { AreaSpec } from "../catalog-types.ts";
import { read } from "./helpers.ts";

const S = "lp-analytics";
const VIEW = { keys: [], appLevel: { app: "lp", level: "view" } } as const;
const RANGE = "query.from・to 必須（YYYY-MM-DD・最大92日）";

export const LP: AreaSpec = {
  area: "lp",
  entries: [
    read({
      id: "lp.stats",
      area: "lp",
      path: "/lp/stats",
      service: S,
      requires: VIEW,
      description: "LP の訪問数を流入元・日別・端末別に集計して取得する",
      hint: `${RANGE}。totals・bySource[]・byDay[]・byDevice[]`,
      query: ["from", "to", "includeBots"],
    }),
    read({
      id: "lp.siteTraffic",
      area: "lp",
      path: "/lp/site-traffic",
      service: S,
      requires: VIEW,
      description: "LP のページビューを参照元別に取得する（Cloudflare の解析）",
      hint: `${RANGE}。configured=false なら未設定で 0`,
      query: ["from", "to"],
    }),
    read({
      id: "lp.visits",
      area: "lp",
      path: "/lp/visits",
      service: S,
      requires: VIEW,
      description: "LP のアクセスログ（訪問1件ずつ）を取得する",
      hint: `${RANGE}。items[].source・path・referrerHost・device・occurredAt`,
      query: ["from", "to", "source", "limit", "cursor"],
    }),
    read({
      id: "lp.links.list",
      area: "lp",
      path: "/lp/links",
      service: S,
      requires: VIEW,
      description: "流入 URL の一覧と期間内の訪問数を取得する",
      hint: `${RANGE}。items[].id・name・slug・url・active・stats.visits`,
      query: ["from", "to"],
    }),
  ],
  excluded: [],
  pending: [
    { service: S, route: "POST /lp/links" },
    { service: S, route: "PATCH /lp/links/:id" },
  ],
};
