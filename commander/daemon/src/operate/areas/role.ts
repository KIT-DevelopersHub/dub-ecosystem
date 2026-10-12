// ロール (identity-roster): roles, their permission keys, and who holds which role.
import type { AreaSpec } from "../catalog-types.ts";
import { read } from "./helpers.ts";

const I = "identity-roster";
const ROSTER = { keys: ["identity:read"] } as const;

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
  ],
  excluded: [
    { service: I, route: "DELETE /identity/roles/:id", reason: "ロールを物理削除し、全員への割り当ても連鎖して消える（不可逆）" },
  ],
  pending: [
    { service: I, route: "POST /identity/roles" },
    { service: I, route: "PATCH /identity/roles/:id" },
    { service: I, route: "POST /identity/users/:id/roles" },
    { service: I, route: "DELETE /identity/users/:id/roles/:assignmentId" },
  ],
};
