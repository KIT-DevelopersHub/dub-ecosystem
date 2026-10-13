// LP管理 (lp-analytics). This service has no policy-table.ts yet: its routes are gated in
// app.ts by requireAppAccess("lp", view|edit), which the catalog test reads instead.
// Every route needs query from/to (YYYY-MM-DD, JST, at most 92 days) — writes too, where
// they set the range of the stats in the response.
import type { AreaSpec } from "../catalog-types.ts";
import { read } from "./helpers.ts";

const S = "lp-analytics";
const VIEW = { keys: [], appLevel: { app: "lp", level: "view" } } as const;
const EDIT = { keys: [], appLevel: { app: "lp", level: "edit" } } as const;
const RANGE = "query.from・to 必須（YYYY-MM-DD・最大92日）";
// The write's own from/to: lp.links.list cannot be read without a range.
const LINKS_READ = { read: "lp.links.list", query: { from: "$query.from", to: "$query.to" }, findIn: "items" } as const;

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
    {
      id: "lp.links.create",
      area: "lp",
      method: "POST",
      path: "/lp/links",
      service: S,
      requires: EDIT,
      kind: "write",
      reversible: false,
      risk: "mid",
      description: "LP の流入 URL を新しく発行する",
      hint: `${RANGE}（応答の訪問数の集計範囲）。body.name（40字以内・前後の空白は除かれる）・slug（小文字英数と _ - だけ・32字以内・direct は予約・発行済みは409）。正規化された値で渡す。応答 id・url（utm_source=slug 付きの LP の URL）`,
      impact: "{count}件の流入 URL が発行され、LP管理の一覧に載ります。削除はできず、同じ値は二度と発行できません（停止にはできます）。",
      query: ["from", "to"],
      body: { allowed: ["name", "slug"], required: ["name", "slug"] },
      fieldLabels: { name: "名前", slug: "URL に付く値" },
      verify: { ...LINKS_READ, findBy: ["id", "$result.id"], expect: { name: "$body.name", slug: "$body.slug", active: true } },
    },
    {
      id: "lp.links.setActive",
      area: "lp",
      method: "PATCH",
      path: "/lp/links/:id",
      service: S,
      requires: EDIT,
      kind: "write",
      reversible: true,
      risk: "mid",
      description: "流入 URL を停止／再開する",
      hint: `${RANGE}。body.active=false で停止、true で再開。名前や値は変えられない。params.id は lp.links.list の items[].id`,
      impact: "{count}件の流入 URL の停止・再開が切り替わります（LP管理の一覧の表示が変わります）。もう一度切り替えれば元に戻せます。",
      query: ["from", "to"],
      body: { allowed: ["active"], required: ["active"] },
      fieldLabels: { active: "有効" },
      verify: { ...LINKS_READ, findBy: ["id", "$params.id"], expect: { active: "$body.active" } },
    },
  ],
  excluded: [],
  // 公開版の切り替えとチケット販売は未開放（POST /lp/publish・/lp/tickets/enabled・/lp/tickets/cta は
  // lp:publish 付きのため抽出対象外）。
  pending: [
    { service: S, route: "GET /lp/publish" },
    { service: S, route: "GET /lp/tickets" },
    { service: S, route: "POST /lp/tickets/fields" },
    { service: S, route: "POST /lp/tickets/types" },
    { service: S, route: "PATCH /lp/tickets/types/:id" },
    { service: S, route: "GET /lp/tickets/orders" },
  ],
  ownerOpenedIrreversible: {
    "lp.links.create": "削除 API が無く発行した URL は一覧に残り同じ値も再発行できないが、停止はできる。オーナーが「流入 URL の発行」を名指しで開放",
  },
};
