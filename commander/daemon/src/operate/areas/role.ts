// ロール (identity-roster): roles, their permission keys, and who holds which role.
import type { AreaSpec } from "../catalog-types.ts";
import { read } from "./helpers.ts";

const I = "identity-roster";
const ROSTER = { keys: ["identity:read"] } as const;
const ADMIN_EDIT = { keys: ["identity:admin"], appLevel: { app: "admin", level: "edit" } } as const;
const PERMS_HINT =
  "permissions は permissions.catalog の key の配列で、送った配列でロールの権限を丸ごと置き換える。" +
  "app:<アプリ>:edit を入れる時は app:<アプリ>:view も入れる（サービスが自動で足すため、入れないと読み直しが一致しない）";
const PROTECTED_ROLE = "オーナーと Commander ボット自身のロールは変更・付与できません";
const PROTECTED_USER = "オーナーと Commander ボット自身のロールは付け外しできません";

export const ROLE: AreaSpec = {
  area: "role",
  entries: [
    read({
      id: "roles.list",
      area: "role",
      path: "/identity/roles",
      service: I,
      requires: ROSTER,
      description: "ロールの一覧と各ロールの権限を取得する",
      hint: "items[].id・name・permissions[]・isSystem・memberCount",
      query: ["limit", "cursor"],
    }),
    read({
      id: "users.roles.list",
      area: "role",
      path: "/identity/users/:id/roles",
      service: I,
      requires: ROSTER,
      description: "メンバー1人に割り当てられたロールを取得する",
      hint: "配列 [{ id（割り当てid）, roleId, roleName, resourceType, resourceId }]",
    }),
    read({
      id: "permissions.catalog",
      area: "role",
      path: "/identity/permissions/catalog",
      service: I,
      requires: ROSTER,
      description: "付与できる権限の一覧を取得する",
      hint: "配列 [{ key, name, description, dangerous }]",
    }),
    {
      id: "roles.create",
      area: "role",
      method: "POST",
      path: "/identity/roles",
      service: I,
      requires: ADMIN_EDIT,
      kind: "write",
      reversible: false,
      risk: "mid",
      description: "ロールを作成する",
      hint: `作成後の id は応答の id。同じ名前のロールがあると409。${PERMS_HINT}。作っただけでは誰にも付かない（付けるのは roles.assign）`,
      impact: "{count}件のロールがロール管理に追加されます。誰にも付いていないので、この時点では誰の権限も変わりません。ロールは Commander からは削除できません（権限は後から編集できます）。",
      body: { allowed: ["name", "permissions"], required: ["name", "permissions"] },
      fieldLabels: { name: "ロール名", permissions: "権限" },
      verify: { read: "roles.list", query: { limit: "200" }, findIn: "items", findBy: ["id", "$result.id"], expectBody: { except: [] } },
    },
    {
      id: "roles.update",
      area: "role",
      method: "PATCH",
      path: "/identity/roles/:id",
      service: I,
      requires: ADMIN_EDIT,
      kind: "write",
      reversible: true,
      risk: "high",
      description: "ロールの名前と権限を編集する",
      hint: `params.id は roles.list の items[].id。直前に roles.list で現在の permissions を読み、足し引きした全体を送る（一部だけ送ると他の権限が消える）。${PERMS_HINT}。admin ロールから identity:admin は外せない（409）`,
      impact: "{count}件のロールの権限が変わり、そのロールを持つ全員が使える機能がすぐに変わります。元の権限で再度編集すれば戻せます。",
      body: { allowed: ["name", "permissions"], required: [] },
      fieldLabels: { name: "ロール名", permissions: "権限" },
      verify: { read: "roles.list", query: { limit: "200" }, findIn: "items", findBy: ["id", "$params.id"], expectBody: { except: [] } },
      deny: [{ field: "params.id", set: "roles", reason: PROTECTED_ROLE }],
    },
    {
      id: "roles.assign",
      area: "role",
      method: "POST",
      path: "/identity/users/:id/roles",
      service: I,
      requires: ADMIN_EDIT,
      kind: "write",
      reversible: true,
      risk: "high",
      description: "メンバーにロールを付与する",
      hint: "params.id は users.list の items[].id、body.roleId は roles.list の items[].id。組織全体に付けるなら resourceType / resourceId は送らない（イベント単位なら resourceType=event と resourceId を両方）。付与済みなら409。応答の id が割り当て id",
      impact: "{count}人にロールが付き、その人が使える機能がすぐに増えます。roles.revoke で外せば戻せます。",
      body: { allowed: ["roleId", "resourceType", "resourceId"], required: ["roleId"] },
      fieldLabels: { roleId: "ロール", resourceType: "対象の種類", resourceId: "対象" },
      // The response array is the root itself: findIn "." resolves to it.
      verify: { read: "users.roles.list", params: { id: "$params.id" }, findIn: ".", findBy: ["id", "$result.id"], expect: { roleId: "$body.roleId" } },
      deny: [
        { field: "params.id", set: "users", reason: PROTECTED_USER },
        { field: "body.roleId", set: "roles", reason: PROTECTED_ROLE },
      ],
    },
    {
      id: "roles.revoke",
      area: "role",
      method: "DELETE",
      path: "/identity/users/:id/roles/:assignmentId",
      service: I,
      requires: ADMIN_EDIT,
      kind: "delete",
      reversible: true,
      risk: "high",
      description: "メンバーからロールを外す",
      hint: "params.assignmentId は users.roles.list の [].id（割り当て id。ロール id ではない）。組織で最後の管理者権限は外せない（409）",
      impact: "{count}人からロールが外れ、その人が使える機能がすぐに減ります。roles.assign で同じロールを付け直せば戻せます。",
      verify: { read: "users.roles.list", params: { id: "$params.id" }, findIn: ".", findBy: ["id", "$params.assignmentId"], present: false },
      deny: [{ field: "params.id", set: "users", reason: PROTECTED_USER }],
    },
  ],
  excluded: [
    { service: I, route: "DELETE /identity/roles/:id", reason: "ロールを物理削除し、全員への割り当ても連鎖して消える（不可逆）" },
  ],
  pending: [],
  ownerOpenedIrreversible: {
    "roles.create": "依頼表の「ロールの作成」。ロールは消せないが、作っただけでは誰の権限も変わらず、名前と権限は roles.update で直せる",
  },
};
